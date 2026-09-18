#!/usr/bin/env node
// ---------------------------------------------------------------------------
// mcp-server.mjs — OpsForge as a Model Context Protocol server
// ---------------------------------------------------------------------------
// Lets an MCP client — Claude Desktop, Claude Code, VS Code, Cursor, anything
// that speaks MCP over stdio — open Spatial Ops map files on this machine,
// change them with the same tools and the same rules as the assistant panel in
// the editor, save them, and write prefabs. The editing is src/ai.js, the
// reading and writing is src/format.js, so a map saved from here is
// byte-faithful exactly as an export from the editor is: objects nobody
// touched go back as the bytes they came in as.
//
//   node tools/mcp-server.mjs --root "C:\Users\me\Maps"
//
// Client configuration (Claude Desktop's claude_desktop_config.json, or the
// equivalent for any other client):
//
//   { "mcpServers": { "opsforge": {
//       "command": "node",
//       "args": ["C:/path/to/OpsForge/tools/mcp-server.mjs", "--root", "C:/Users/me/Maps"] } } }
//
// Claude Code: claude mcp add opsforge -- node C:/path/to/OpsForge/tools/mcp-server.mjs --root C:/Users/me/Maps
//
// Every path is resolved inside --root (default: the working directory) and
// anything that leaves it is refused, so a model cannot be talked into reading
// or writing elsewhere on the disk. Nothing here opens a network connection.
//
// Transport is newline-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP
// stdio transport. stdout carries protocol messages only; logging goes to
// stderr. No dependencies — Node 18 or newer.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, extname, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (name) => new URL(`../src/${name}`, import.meta.url).href;
const { parseMap, serializeMap, newMap, mapFileName, nowStamp } = await import(src('format.js'));
const {
  AI_TOOLS, AI_MUTATING_TOOLS, aiIndex, aiIndexText, applyAiTool, aiDocFromMap, aiDocToMap,
} = await import(src('ai.js'));

const PACKAGE = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const ROOT = resolve(rootArg >= 0 && args[rootArg + 1] ? args[rootArg + 1] : process.cwd());
const MAX_MAP_BYTES = 32 * 1048576;

const log = (...a) => process.stderr.write(`[opsforge-mcp] ${a.join(' ')}\n`);

// -- the open map ---------------------------------------------------------------

let open = null;   // { map, doc, path, dirty }

/** A path inside ROOT, or a refusal. */
function inRoot(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('A path is required.');
  const full = resolve(ROOT, p);
  const rel = relative(ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`That path is outside the maps folder (${ROOT}).`);
  return full;
}

function requireOpen() {
  if (!open) throw new Error('No map is open. Use open_map or new_map first.');
  return open;
}

function looksLikeMapFile(full) {
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size > MAX_MAP_BYTES || st.size < 20) return false;
    const head = readFileSync(full, { encoding: 'utf8' }).slice(0, 4096);
    return head.trimStart().startsWith('{') && head.includes('"guid"') && head.includes('"version"');
  } catch {
    return false;
  }
}

// -- file tools, on top of the ai.js set --------------------------------------

const FILE_TOOLS = [
  {
    name: 'get_editor_guide',
    description: 'The full OpsForge guide: coordinates, the rules the editor enforces, every catalog piece with its size, prop values and rule settings. Read it before building if it is not already in your context.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_map_files',
    description: 'List Spatial Ops map files (no extension) and .opsprefab files in the maps folder or a folder inside it.',
    input_schema: { type: 'object', properties: { folder: { type: 'string', description: 'Relative to the maps folder. Default: the maps folder itself.' } } },
  },
  {
    name: 'open_map',
    description: 'Open a map file from the maps folder. Unsaved changes to the map already open are discarded.',
    input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  },
  {
    name: 'new_map',
    description: 'Start a new, empty map. Save it with save_map.',
    input_schema: {
      type: 'object', required: ['name'],
      properties: { name: { type: 'string', maxLength: 80 }, author: { type: 'string', maxLength: 80 } },
    },
  },
  {
    name: 'save_map',
    description: 'Write the open map. Without a path it overwrites the file it came from, or for a new map writes Name_guid (no extension — that is what the game reads) in the maps folder.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

const ALL_TOOLS = [...FILE_TOOLS, ...AI_TOOLS];

function fileTool(name, input) {
  switch (name) {
    case 'get_editor_guide':
      return { text: aiIndexText() };
    case 'list_map_files': {
      const dir = input.folder ? inRoot(input.folder) : ROOT;
      const out = { folder: relative(ROOT, dir) || '.', maps: [], prefabs: [], folders: [] };
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        const rel = relative(ROOT, full).split(sep).join('/');
        if (e.isDirectory()) out.folders.push(rel);
        else if (extname(e.name).toLowerCase() === '.opsprefab') out.prefabs.push(rel);
        else if (!extname(e.name) && looksLikeMapFile(full)) out.maps.push(rel);
      }
      return out;
    }
    case 'open_map': {
      const full = inRoot(input.path);
      if (!existsSync(full)) throw new Error(`No file at ${input.path}.`);
      if (statSync(full).size > MAX_MAP_BYTES) throw new Error('That file is far too large to be a map.');
      const map = parseMap(readFileSync(full, 'utf8'));
      open = { map, doc: aiDocFromMap(map), path: full, dirty: false };
      return { opened: relative(ROOT, full), name: map.name, objects: map.mapObjects.length };
    }
    default:
      return null;
  }
}

async function asyncFileTool(name, input) {
  if (name === 'new_map') {
    const name_ = String(input.name || '').trim().slice(0, 80) || 'New Map';
    const map = await newMap({ name: name_, author: String(input.author || '').slice(0, 80) });
    open = { map, doc: aiDocFromMap(map), path: null, dirty: true };
    return { created: map.name, guid: map.guid, note: 'Not on disk yet — save_map writes it.' };
  }
  if (name === 'save_map') {
    const o = requireOpen();
    aiDocToMap(o.doc, o.map);
    // Stamped only when something changed, as an export from the editor is;
    // an untouched map goes back exactly as it came.
    if (o.dirty) o.map.editedTime = nowStamp();
    const full = input.path ? inRoot(input.path) : o.path || inRoot(mapFileName(o.map.name, o.map.guid));
    // A real extension (".exe", ".bat"), not the tail of a dotted map name.
    const ext = extname(full).toLowerCase();
    if (input.path && /^\.[a-z0-9]{1,5}$/.test(ext) && !/\d/.test(ext) && ext !== '.json') {
      throw new Error('Map files have no extension (or .json for a copy to read). Pick another path.');
    }
    const text = serializeMap(o.map);
    writeFileSync(full, text, 'utf8');
    o.path = full;
    o.dirty = false;
    // The saved text is now the source, so what was written is what the next
    // untouched-object passthrough copies.
    o.map = parseMap(text);
    o.doc = aiDocFromMap(o.map);
    return { saved: relative(ROOT, full), bytes: Buffer.byteLength(text), objects: o.map.mapObjects.length, note: 'Object ids were renumbered in file order.' };
  }
  return null;
}

async function callTool(name, input = {}) {
  if (!ALL_TOOLS.some((t) => t.name === name)) return { ok: false, result: { error: `Unknown tool ${name}.` } };
  try {
    const sync = fileTool(name, input);
    if (sync) return { ok: true, result: sync };
    const later = await asyncFileTool(name, input);
    if (later) return { ok: true, result: later };
  } catch (err) {
    return { ok: false, result: { error: err.message } };
  }
  let o;
  try { o = requireOpen(); } catch (err) { return { ok: false, result: { error: err.message } }; }
  const r = applyAiTool(o.doc, name, input);
  if (r.ok && AI_MUTATING_TOOLS.has(name)) o.dirty = true;
  if (r.ok && name === 'make_prefab') {
    try {
      const full = inRoot(r.result.file_name);
      writeFileSync(full, JSON.stringify(r.result.prefab, null, 1), 'utf8');
      r.result = { saved: relative(ROOT, full), object_count: r.result.object_count, ...(r.result.notes ? { notes: r.result.notes } : {}) };
    } catch (err) {
      return { ok: false, result: { error: `Could not write the prefab: ${err.message}` } };
    }
  }
  if (r.ok && o.dirty) r.result = { ...r.result, unsaved_changes: true };
  return r;
}

// -- JSON-RPC --------------------------------------------------------------------

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const RESOURCES = [
  { uri: 'opsforge://guide', name: 'OpsForge guide', description: 'Rules, coordinates, the whole catalog and every rule setting.', mimeType: 'text/markdown' },
  { uri: 'opsforge://index.json', name: 'OpsForge index (JSON)', description: 'The same facts as data.', mimeType: 'application/json' },
  { uri: 'opsforge://map', name: 'Open map', description: 'Summary of the map that is open, if any.', mimeType: 'application/json' },
];

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'opsforge', title: 'OpsForge — Spatial Ops map editor', version: PACKAGE.version },
        // The whole guide rather than a pointer to it: clients that pass server
        // instructions to the model then start every session knowing the
        // catalog and the rules, which is the point of connecting.
        instructions: `Maps folder: ${ROOT}. Open or create a map, edit it with the tools, then save_map.\n\n${aiIndexText()}`,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: ALL_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
          annotations: {
            readOnlyHint: !(AI_MUTATING_TOOLS.has(t.name) || ['save_map', 'make_prefab', 'new_map', 'open_map'].includes(t.name)),
            destructiveHint: ['delete_objects', 'remove_rule_set', 'save_map'].includes(t.name),
            openWorldHint: false,
          },
        })),
      });
    case 'tools/call': {
      const r = await callTool(params?.name, params?.arguments || {});
      return reply(id, {
        content: [{ type: 'text', text: typeof r.result.text === 'string' ? r.result.text : JSON.stringify(r.result, null, 1) }],
        ...(r.ok && !r.result.text ? { structuredContent: r.result } : {}),
        isError: !r.ok,
      });
    }
    case 'resources/list':
      return reply(id, { resources: RESOURCES });
    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] });
    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'opsforge://guide') return reply(id, { contents: [{ uri, mimeType: 'text/markdown', text: aiIndexText() }] });
      if (uri === 'opsforge://index.json') return reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(aiIndex(), null, 1) }] });
      if (uri === 'opsforge://map') {
        const summary = open ? applyAiTool(open.doc, 'get_map', {}).result : { open: false };
        return reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(summary, null, 1) }] });
      }
      return error(id, -32002, `Resource not found: ${uri}`);
    }
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      if (method?.startsWith('notifications/')) return undefined;
      if (isRequest) return error(id, -32601, `Method not found: ${method}`);
      return undefined;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return error(null, -32700, 'Parse error');
  }
  try {
    await handle(msg);
  } catch (err) {
    log('internal error:', err.stack || err.message);
    if (msg.id !== undefined) error(msg.id, -32603, 'Internal error');
  }
});
rl.on('close', () => process.exit(0));
log(`ready; maps folder ${ROOT}`);
