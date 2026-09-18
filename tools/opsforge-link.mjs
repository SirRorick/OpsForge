// ---------------------------------------------------------------------------
// opsforge-link.mjs — Claude Desktop or Codex, editing the map open in the browser
// ---------------------------------------------------------------------------
// The AI panel in the editor needs an API key, because a web page may only
// reach Claude or GPT through the paid API. People on a Claude or ChatGPT
// subscription already have an app that can use tools under that
// subscription — Claude Desktop, or Codex for ChatGPT — and this is the tool
// they give it. It is an MCP server over stdio like tools/mcp-server.mjs, with
// the same tools, but instead of editing files it hands every call to the
// editor tab, which runs it exactly as it runs a call from its own panel: the
// same `applyAiTool`, the same refusals, one undo step per call, drawn as it
// happens.
//
// The tab reaches this process over plain HTTP on the loopback interface. The
// tab asks, never the other way round — a page cannot be called into — so the
// tab long-polls /next for the next call and posts the answer to /result.
// Nothing listens beyond 127.0.0.1, and nothing leaves this machine: the model
// is talking to its own app, and the app is talking to this.
//
// Who may connect. Any web page the person has open can send a request to
// 127.0.0.1, so every request has to prove it came from the editor:
//   - `Origin` is the page's own origin, which a browser sets and a page
//     cannot. It has to be the published editor, a loopback page (a copy served
//     on this machine), or one named in OPSFORGE_LINK_ORIGINS.
//   - `Host` has to be the loopback address, so a hostile DNS name pointed at
//     127.0.0.1 cannot get a same-origin foothold (DNS rebinding).
//   - One tab at a time holds the link, by a session id it made up when it
//     linked; a second tab linking takes over and the first is told so.
//
// Built by `npm run package` into one file with src/ai.js and what it needs
// inlined (see `buildLink` in build.mjs), because the people running it have
// the one file and not this repository. From a checkout it runs as it is:
//
//   node tools/opsforge-link.mjs
//
// No dependencies; Node 18 or newer. stdout carries protocol messages only.
// ---------------------------------------------------------------------------

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { AI_TOOLS, AI_MUTATING_TOOLS, aiIndex, aiIndexText } from '../src/ai.js';

const LINK_VERSION = '1.0.0';
const LINK_PROTOCOL = 1;
const LINK_EDITOR_URL = 'https://opsforge.roricktech.com';
const LINK_PORT = Number(process.env.OPSFORGE_LINK_PORT) || 47615;   // LINK_PORT in src/link.js
const LINK_POLL_MS = 25000;       // how long a /next is held open with nothing to hand over
const LINK_ALIVE_MS = 40000;      // a tab not heard from for this long is gone
const LINK_CALL_MS = 60000;       // how long a call may take in the tab
const LINK_MAX_BODY = 16 * 1048576;
const LINK_SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const linkLog = (...a) => process.stderr.write(`[opsforge-link] ${a.join(' ')}\n`);

// -- who may connect -------------------------------------------------------------

const LINK_ORIGINS = new Set([
  LINK_EDITOR_URL,
  ...String(process.env.OPSFORGE_LINK_ORIGINS || '').split(/[\s,]+/).filter(Boolean).map((o) => o.replace(/\/+$/, '')),
]);

/** The editor, a copy of it served on this machine, or one the person named. */
export function linkOriginAllowed(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  if (LINK_ORIGINS.has(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
}

function linkHostAllowed(host) {
  return new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${LINK_PORT}$`).test(String(host || ''));
}

// -- the tab ------------------------------------------------------------------

let mcpClient = '';          // clientInfo from initialize: which app is driving
let tab = null;              // { session, seen, waiter, waitTimer }
let linkDown = null;         // why the HTTP side is not listening, if it is not
let callSeq = 0;
const outbox = [];           // calls waiting for the tab to ask
const inflight = new Map();  // id -> { resolve, timer }

function clientLabel() {
  if (/claude/i.test(mcpClient)) return 'Claude';
  if (/codex|openai|chatgpt/i.test(mcpClient)) return 'Codex';
  return mcpClient.slice(0, 60) || 'an MCP app';
}

const tabAlive = () => !!tab && (!!tab.waiter || Date.now() - tab.seen < LINK_ALIVE_MS);

function notLinked() {
  if (linkDown) return { ok: false, result: { error: linkDown } };
  return {
    ok: false,
    result: {
      error: `The OpsForge editor is not linked. Ask the person to open ${LINK_EDITOR_URL} in Chrome, Edge or Firefox, `
        + 'open the AI panel, choose "Claude Desktop (subscription)" as the service and press Link. '
        + 'If the browser asks whether the page may reach apps on this device, they need to allow it.',
    },
  };
}

function flush() {
  if (!tab?.waiter || !outbox.length) return;
  const res = tab.waiter;
  tab.waiter = null;
  clearTimeout(tab.waitTimer);
  sendJson(res, 200, outbox.shift());
}

/** Hand one call to the tab and wait for what it made of it. */
function forward(name, input) {
  if (!tabAlive()) return Promise.resolve(notLinked());
  return new Promise((resolve) => {
    const id = ++callSeq;
    const timer = setTimeout(() => {
      inflight.delete(id);
      const queued = outbox.findIndex((c) => c.id === id);
      if (queued >= 0) outbox.splice(queued, 1);
      resolve({
        ok: false,
        result: { error: 'The editor did not answer within a minute. The tab may be closed, asleep or busy; ask the person to check it and try again.' },
      });
    }, LINK_CALL_MS);
    inflight.set(id, { resolve, timer });
    outbox.push({ id, name, input });
    flush();
  });
}

// -- HTTP, for the tab ----------------------------------------------------------

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > LINK_MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(new Error('not JSON')); }
    });
    req.on('error', reject);
  });
}

const validSession = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

export async function handleLinkRequest(req, res) {
  const origin = req.headers.origin;
  if (!linkHostAllowed(req.headers.host) || !linkOriginAllowed(origin)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type',
      // Chrome's older Private Network Access preflight; its newer Local
      // Network Access asks the person instead and ignores this.
      'access-control-allow-private-network': 'true',
      'access-control-max-age': '600',
    }).end();
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${LINK_PORT}`);

  if (req.method === 'POST' && url.pathname === '/hello') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'bad request' }); }
    if (!validSession(body.session)) return sendJson(res, 400, { error: 'bad session' });
    if (tab && tab.session !== body.session && tab.waiter) {
      const old = tab.waiter;
      clearTimeout(tab.waitTimer);
      sendJson(old, 409, { error: 'replaced' });
    }
    if (!tab || tab.session !== body.session) linkLog('editor tab linked');
    tab = { session: body.session, seen: Date.now(), waiter: null, waitTimer: null };
    return sendJson(res, 200, { app: 'opsforge-link', protocol: LINK_PROTOCOL, version: LINK_VERSION, client: clientLabel() });
  }

  if (req.method === 'GET' && url.pathname === '/next') {
    if (!tab || tab.session !== url.searchParams.get('session')) return sendJson(res, 409, { error: 'replaced' });
    tab.seen = Date.now();
    if (tab.waiter) sendJson(tab.waiter, 204);
    clearTimeout(tab.waitTimer);
    tab.waiter = res;
    const mine = tab;
    mine.waitTimer = setTimeout(() => {
      if (mine.waiter === res) { mine.waiter = null; sendJson(res, 204); }
    }, LINK_POLL_MS);
    res.on('close', () => {
      if (mine.waiter === res) { mine.waiter = null; clearTimeout(mine.waitTimer); mine.seen = Date.now(); }
    });
    flush();
    return undefined;
  }

  if (req.method === 'POST' && url.pathname === '/result') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'bad request' }); }
    if (!tab || tab.session !== body.session) return sendJson(res, 409, { error: 'replaced' });
    tab.seen = Date.now();
    const waiting = inflight.get(body.id);
    if (waiting) {
      inflight.delete(body.id);
      clearTimeout(waiting.timer);
      const result = body.result && typeof body.result === 'object' ? body.result : { error: 'The editor sent back nothing.' };
      waiting.resolve({ ok: body.ok === true, result });
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}

export function startLinkServer(port = LINK_PORT) {
  const server = createServer((req, res) => {
    handleLinkRequest(req, res).catch((err) => {
      linkLog('request failed:', err.message);
      sendJson(res, 500, { error: 'internal' });
    });
  });
  server.on('error', (err) => {
    linkDown = err.code === 'EADDRINUSE'
      ? `Port ${port} on this computer is already taken, most likely by another copy of the OpsForge link running in a different app. Close the other one, then restart this app.`
      : `The OpsForge link could not start: ${err.message}`;
    linkLog(linkDown);
  });
  server.listen(port, '127.0.0.1', () => linkLog(`listening on 127.0.0.1:${port}`));
  return server;
}

// -- MCP, for the app ------------------------------------------------------------

const LINK_TOOLS = [
  {
    name: 'get_editor_guide',
    description: 'The full OpsForge guide: coordinates, the rules the editor enforces, every catalog piece with its size, prop values and rule settings. Read it before building if it is not already in your context.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_link_status',
    description: 'Whether the OpsForge editor tab is linked and ready for edits. Every other tool needs it linked.',
    input_schema: { type: 'object', properties: {} },
  },
];
const LINK_ALL_TOOLS = [...LINK_TOOLS, ...AI_TOOLS];

async function callLinkTool(name, input) {
  if (name === 'get_editor_guide') return { ok: true, result: { text: aiIndexText() } };
  if (name === 'get_link_status') {
    return {
      ok: true,
      result: tabAlive()
        ? { linked: true, note: 'The editor is linked. Changes appear on the person\'s screen as they are made, and each call is one Undo there.' }
        : { linked: false, ...notLinked().result },
    };
  }
  if (!AI_TOOLS.some((t) => t.name === name)) return { ok: false, result: { error: `Unknown tool ${name}.` } };
  return forward(name, input && typeof input === 'object' ? input : {});
}

const mcpSend = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const mcpReply = (id, result) => mcpSend({ jsonrpc: '2.0', id, result });
const mcpError = (id, code, message) => mcpSend({ jsonrpc: '2.0', id, error: { code, message } });

const LINK_RESOURCES = [
  { uri: 'opsforge://guide', name: 'OpsForge guide', description: 'Rules, coordinates, the whole catalog and every rule setting.', mimeType: 'text/markdown' },
  { uri: 'opsforge://index.json', name: 'OpsForge index (JSON)', description: 'The same facts as data.', mimeType: 'application/json' },
];

const LINK_INSTRUCTIONS = `You are editing a Spatial Ops map that is open in the OpsForge editor in the person's web browser. `
  + `Every tool call is carried out in that tab as if the person had done it: they see each change as it lands, `
  + `and each call is one step they can undo. There is no file to open or save here — the map is whatever the editor has open, `
  + `and the person exports it from the editor when they are happy. Prefabs you make are downloaded by their browser. `
  + `If a tool says the editor is not linked, tell the person how to link it rather than retrying.\n\n`;

async function handleMcp(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      mcpClient = String(params?.clientInfo?.title || params?.clientInfo?.name || '');
      return mcpReply(id, {
        protocolVersion: LINK_SUPPORTED_VERSIONS.includes(asked) ? asked : LINK_SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'opsforge', title: 'OpsForge — Spatial Ops map editor', version: LINK_VERSION },
        instructions: LINK_INSTRUCTIONS + aiIndexText(),
      });
    }
    case 'ping':
      return mcpReply(id, {});
    case 'tools/list':
      return mcpReply(id, {
        tools: LINK_ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
          annotations: {
            readOnlyHint: !(AI_MUTATING_TOOLS.has(t.name) || t.name === 'make_prefab'),
            destructiveHint: ['delete_objects', 'remove_rule_set'].includes(t.name),
            openWorldHint: false,
          },
        })),
      });
    case 'tools/call': {
      const r = await callLinkTool(params?.name, params?.arguments || {});
      return mcpReply(id, {
        content: [{ type: 'text', text: typeof r.result.text === 'string' ? r.result.text : JSON.stringify(r.result, null, 1) }],
        ...(r.ok && !r.result.text ? { structuredContent: r.result } : {}),
        isError: !r.ok,
      });
    }
    case 'resources/list':
      return mcpReply(id, { resources: LINK_RESOURCES });
    case 'resources/templates/list':
      return mcpReply(id, { resourceTemplates: [] });
    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'opsforge://guide') return mcpReply(id, { contents: [{ uri, mimeType: 'text/markdown', text: aiIndexText() }] });
      if (uri === 'opsforge://index.json') return mcpReply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(aiIndex(), null, 1) }] });
      return mcpError(id, -32002, `Resource not found: ${uri}`);
    }
    case 'prompts/list':
      return mcpReply(id, { prompts: [] });
    default:
      if (method?.startsWith('notifications/')) return undefined;
      if (isRequest) return mcpError(id, -32601, `Method not found: ${method}`);
      return undefined;
  }
}

export function startMcp() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return mcpError(null, -32700, 'Parse error');
    }
    try {
      await handleMcp(msg);
    } catch (err) {
      linkLog('internal error:', err.stack || err.message);
      if (msg.id !== undefined) mcpError(msg.id, -32603, 'Internal error');
    }
  });
  rl.on('close', () => process.exit(0));
}

if (!process.env.OPSFORGE_LINK_NO_START) {
  startLinkServer();
  startMcp();
  linkLog(`ready, version ${LINK_VERSION}`);
}
