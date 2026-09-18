// ---------------------------------------------------------------------------
// assistant.js — the AI panel: a person's own Claude or GPT, editing their map
// ---------------------------------------------------------------------------
// The person brings an API key from Anthropic or OpenAI, and the browser
// talks to that provider directly — the same shape as the mod.io sign-in:
// there is no OpsForge server for the key or the map to pass through. Both
// providers answer browsers from any origin (Anthropic once the request says
// it knows it is in one, with `anthropic-dangerous-direct-browser-access`),
// and the page's Content-Security-Policy names exactly those two hosts, so a
// key can go to its own provider and nowhere else.
//
// The key is kept for this tab in sessionStorage unless the person ticks
// "remember", and never enters a map, a checkpoint, a prefab or a log.
//
// What the model can do is exactly `AI_TOOLS` from ai.js, run through
// `applyAiTool` against a snapshot of the map; `host.apply` then mirrors the
// changes onto the scene as one undo step. Everything the model says is put on
// the page as text, never as HTML.
//
// People on a Claude subscription rather than the API use the third "service",
// the link: the model runs in their own Claude Desktop, which hands its tool
// calls to this tab through tools/opsforge-link.mjs on the same computer (see
// link.js). The calls go through the same `runTool` below,
// so the rules, the refusals and the one-undo-per-call are identical.
//
// Raw `fetch` rather than a provider SDK: the editor has no npm dependencies
// and no bundler by design, and a second CDN script would be one more thing
// the CSP has to trust.
// ---------------------------------------------------------------------------

import { AI_TOOLS, AI_MUTATING_TOOLS, aiIndexText, applyAiTool } from './ai.js';
import { createLink } from './link.js';

const SETTINGS_KEY = 'opsforge.ai.settings';
const keyName = (provider) => `opsforge.ai.${provider}.key`;
const MAX_STEPS = 30;          // model turns per prompt before the assistant stops to ask
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Claude Opus 5 can decline a request on safety grounds; `fallbacks: "default"`
 * has the API re-run a declined request on Anthropic's recommended fallback
 * model rather than hand back a refusal. Map editing should never trip it, so
 * it is sent only for the models that document it and dropped if refused.
 */
const FALLBACK_MODELS = new Set(['claude-opus-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const PROVIDERS = {
  anthropic: {
    label: 'Claude (Anthropic)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    prefer: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
  },
  openai: {
    label: 'GPT (OpenAI)',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    prefer: [],
  },
  link: {
    label: 'Claude Desktop',
  },
};

// -- storage ------------------------------------------------------------------

function store(kind) {
  try { return globalThis[kind] || null; } catch { return null; }
}

function loadSettings() {
  try { return JSON.parse(store('localStorage')?.getItem(SETTINGS_KEY) || '{}') || {}; } catch { return {}; }
}

function saveSettings(s) {
  try { store('localStorage')?.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* fine */ }
}

export function loadKey(provider) {
  try {
    return store('sessionStorage')?.getItem(keyName(provider))
      || store('localStorage')?.getItem(keyName(provider)) || '';
  } catch {
    return '';
  }
}

function keyRemembered(provider) {
  try { return !!store('localStorage')?.getItem(keyName(provider)); } catch { return false; }
}

function saveKey(provider, key, remember) {
  forgetKey(provider);
  try { store(remember ? 'localStorage' : 'sessionStorage')?.setItem(keyName(provider), key); } catch { /* fine */ }
}

function forgetKey(provider) {
  for (const kind of ['localStorage', 'sessionStorage']) {
    try { store(kind)?.removeItem(keyName(provider)); } catch { /* fine */ }
  }
}

// -- providers ------------------------------------------------------------------

async function providerError(res, provider) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || '';
  } catch { /* not JSON */ }
  const who = PROVIDERS[provider].label;
  if (res.status === 401) return new Error(`${who} did not accept that API key.`);
  if (res.status === 403) return new Error(`${who} refused: ${detail || 'this key cannot use that model'}.`);
  if (res.status === 429) return new Error(`${who} rate limit or quota reached. ${detail}`.trim());
  const err = new Error(`${who} error ${res.status}${detail ? `: ${detail}` : ''}`);
  err.status = res.status;
  err.detail = detail;
  return err;
}

function anthropicHeaders(key, extra = {}) {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
    ...extra,
  };
}

/** Model ids this key can use, best first. Doubles as the key check. */
export async function listModels(provider, key, signal) {
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: anthropicHeaders(key), signal });
    if (!res.ok) throw await providerError(res, provider);
    const ids = ((await res.json()).data || []).map((m) => m.id).filter((id) => /^claude-/.test(id));
    return rank(ids, PROVIDERS.anthropic.prefer);
  }
  const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw await providerError(res, provider);
  const ids = ((await res.json()).data || []).map((m) => m.id)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
    .filter((id) => !/(audio|realtime|image|tts|transcribe|search|embedding|instruct|moderation|codex|computer)/.test(id));
  return rankOpenAI(ids);
}

function rank(ids, prefer) {
  const known = prefer.filter((p) => ids.includes(p));
  return [...known, ...ids.filter((id) => !known.includes(id)).sort()];
}

/**
 * OpenAI's list is long and unordered. The newest full-size GPT model is the
 * sensible default for tool use, so versions are ranked newest first with the
 * mini/nano variants after the full ones.
 */
function rankOpenAI(ids) {
  const score = (id) => {
    const m = /^gpt-(\d+(?:\.\d+)?)/.exec(id);
    const version = m ? parseFloat(m[1]) : 0;
    const small = /(mini|nano)/.test(id) ? 1 : 0;
    const dated = /\d{4}-\d{2}-\d{2}|\d{4}$/.test(id) ? 1 : 0;
    return [-version, small, dated, id.length];
  };
  return [...ids].sort((a, b) => {
    const sa = score(a); const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return a.localeCompare(b);
  });
}

/**
 * One conversation with one provider. `send` runs a whole prompt: it calls the
 * model, runs whatever tools it asks for, and goes round again until the model
 * stops asking, reporting each step through `on`.
 */
class Conversation {
  constructor(provider, key, model) {
    this.provider = provider;
    this.key = key;
    this.model = model;
    this.messages = [];
    this.system = aiIndexText();
    this.useFallbacks = FALLBACK_MODELS.has(model);
    this.useTopCache = true;
  }

  async send(text, { runTool, on, signal }) {
    this.messages.push({ role: 'user', content: text });
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const more = this.provider === 'anthropic'
        ? await this._anthropicStep({ runTool, on, signal })
        : await this._openaiStep({ runTool, on, signal });
      if (!more) return;
    }
    on.note(`Stopped after ${MAX_STEPS} steps. Say "continue" to let it carry on.`);
  }

  /** Close off a turn cut short, so the history stays one the API accepts. */
  settleAfterAbort() {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    if (this.provider === 'anthropic') {
      const uses = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_use') : [];
      if (uses.length) {
        this.messages.push({
          role: 'user',
          content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Stopped by the person before this ran.', is_error: true })),
        });
      }
    } else {
      for (const call of last.tool_calls || []) {
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Stopped by the person before this ran.' });
      }
    }
  }

  async _anthropicStep({ runTool, on, signal }) {
    const body = {
      model: this.model,
      max_tokens: 16000,
      system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
      tools: AI_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
      messages: this.messages,
    };
    // Caches the conversation so far as well as the index, so each step of a
    // long tool loop pays for the new part only.
    if (this.useTopCache) body.cache_control = { type: 'ephemeral' };
    const extra = {};
    if (this.useFallbacks) {
      body.fallbacks = 'default';
      extra['anthropic-beta'] = FALLBACK_BETA;
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: anthropicHeaders(this.key, extra), body: JSON.stringify(body), signal,
    });
    if (!res.ok) {
      const err = await providerError(res, 'anthropic');
      // Two optional extras; an account or model that will not take one of
      // them should still get an answer. Drop it and go again, once.
      if (err.status === 400 && this.useFallbacks && /fallback/i.test(err.detail)) {
        this.useFallbacks = false;
        return true;
      }
      if (err.status === 400 && this.useTopCache && /cache_control/i.test(err.detail)) {
        this.useTopCache = false;
        return true;
      }
      throw err;
    }
    const msg = await res.json();
    on.usage({ input: msg.usage?.input_tokens, output: msg.usage?.output_tokens, cached: msg.usage?.cache_read_input_tokens });
    // The whole content goes back, thinking and fallback blocks included:
    // the API expects to see its own turn again unchanged.
    this.messages.push({ role: 'assistant', content: msg.content });
    for (const b of msg.content || []) if (b.type === 'text' && b.text.trim()) on.text(b.text);

    if (msg.stop_reason === 'refusal') {
      on.note('The model declined that request.');
      return false;
    }
    if (msg.stop_reason === 'max_tokens') {
      on.note('The reply hit its length limit and was cut short.');
    }
    const uses = (msg.content || []).filter((b) => b.type === 'tool_use');
    if (msg.stop_reason === 'pause_turn') return true;
    if (!uses.length) return false;
    const results = [];
    for (const u of uses) {
      const r = runTool(u.name, u.input);
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(r.result), ...(r.ok ? {} : { is_error: true }) });
    }
    // All results in one user turn, which is what keeps the model willing to
    // make several calls at once.
    this.messages.push({ role: 'user', content: results });
    return true;
  }

  async _openaiStep({ runTool, on, signal }) {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: this.system }, ...this.messages],
      tools: AI_TOOLS.map(({ name, description, input_schema }) => ({
        type: 'function', function: { name, description, parameters: input_schema },
      })),
      tool_choice: 'auto',
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await providerError(res, 'openai');
    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message || {};
    on.usage({ input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens, cached: data.usage?.prompt_tokens_details?.cached_tokens });
    const turn = { role: 'assistant', content: msg.content ?? null };
    if (msg.tool_calls?.length) turn.tool_calls = msg.tool_calls;
    this.messages.push(turn);
    if (msg.refusal) on.note(`The model declined: ${msg.refusal}`);
    if (typeof msg.content === 'string' && msg.content.trim()) on.text(msg.content);
    if (choice?.finish_reason === 'length') on.note('The reply hit its length limit and was cut short.');
    if (!msg.tool_calls?.length) return false;
    for (const call of msg.tool_calls) {
      let input = {};
      let r;
      try {
        input = JSON.parse(call.function?.arguments || '{}');
        r = runTool(call.function?.name, input);
      } catch {
        r = { ok: false, result: { error: 'The arguments were not valid JSON. Send them again.' } };
      }
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r.result) });
    }
    return true;
  }
}

// -- the panel ------------------------------------------------------------------

/** A one-line account of a tool call, for the transcript. */
function describeCall(name, r) {
  if (!r.ok) return `${name}: ${r.result.error}`;
  const x = r.result;
  switch (name) {
    case 'add_objects': return `Added ${x.added.length} object${x.added.length === 1 ? '' : 's'}${x.group ? ' as a group' : ''}.`;
    case 'update_objects': return `Changed ${x.updated.length} object${x.updated.length === 1 ? '' : 's'}.`;
    case 'delete_objects': return `Deleted ${x.removed.length} object${x.removed.length === 1 ? '' : 's'}.`;
    case 'group_objects': return `Grouped ${x.ids.length} objects.`;
    case 'ungroup_objects': return `Ungrouped ${x.ungrouped.length} objects.`;
    case 'set_map_info': return 'Updated the map details.';
    case 'add_rule_set': return `Added the ${x.name} rule set.`;
    case 'set_rule_values': return `Updated rules in ${x.name}.`;
    case 'remove_rule_set': return `Removed the ${x.removed} rule set.`;
    case 'make_prefab': return `Saved ${x.file_name} (${x.object_count} objects).`;
    case 'get_map': return 'Read the map.';
    case 'list_objects': return `Looked at ${x.objects.length} of ${x.total} objects.`;
    case 'find_catalog': return `Searched the catalog (${x.total} found).`;
    default: return name;
  }
}

/**
 * Wire the panel in index.html.
 *
 * `host` is how the panel reaches the editor, and all it can do:
 *   snapshot()            -> an ai.js document of the map as it stands
 *   apply(doc, changes)   -> mirror a call's changes onto the scene, one undo step
 *   blocked()             -> a reason the map cannot be edited right now, or null
 *   saveFile(name, text)  -> hand the person a file
 *   onToggle(open)        -> the panel opened or closed
 */
export function wireAssistant(host) {
  const $ = (id) => document.getElementById(id);
  const panel = $('ai-panel');
  if (!panel) return;
  const settings = loadSettings();
  let provider = PROVIDERS[settings.provider] ? settings.provider : 'anthropic';
  let conversation = null;
  let running = null;   // AbortController while a prompt is in flight

  const log = $('ai-log');
  const add = (cls, text) => {
    const el = document.createElement('div');
    el.className = `ai-msg ${cls}`;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  // -- connection ---------------------------------------------------------------
  const providerSel = $('ai-provider');
  const keyInput = $('ai-key');
  const remember = $('ai-remember');
  const modelSel = $('ai-model');
  const status = $('ai-status');
  const keyLink = $('ai-key-link');

  const setStatus = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('bad', bad);
  };

  const fillModels = (ids, chosen) => {
    modelSel.innerHTML = '';
    for (const id of ids) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      modelSel.appendChild(o);
    }
    if (chosen && ids.includes(chosen)) modelSel.value = chosen;
    modelSel.disabled = !ids.length;
  };

  const showProvider = () => {
    const p = PROVIDERS[provider];
    providerSel.value = provider;
    $('ai-keyed').hidden = provider === 'link';
    $('ai-linked').hidden = provider !== 'link';
    $('ai-key-hint').hidden = provider === 'link';
    if (provider === 'link') {
      conversation = null;
      showLinkState();
      refreshReady();
      return;
    }
    keyInput.value = loadKey(provider);
    keyInput.placeholder = p.keyPlaceholder;
    remember.checked = keyRemembered(provider);
    keyLink.href = p.keyUrl;
    keyLink.textContent = `Get a ${p.label.split(' ')[0]} API key`;
    const saved = settings.models?.[provider];
    fillModels(saved ? [saved] : [], saved);
    conversation = null;
    setStatus(keyInput.value ? 'Key on hand. Connect to check it and pick a model.' : 'Not connected.');
    refreshReady();
  };

  const connected = () => provider !== 'link' && !!(loadKey(provider) && modelSel.value);

  const refreshReady = () => {
    const ok = connected();
    const viaApp = provider === 'link';
    $('ai-send').disabled = !ok || !!running;
    // With the link the conversation happens in the person's own app, so there
    // is nothing to type here — the log shows what that app does to the map.
    panel.querySelector('.ai-input').hidden = viaApp;
    $('ai-prompt').placeholder = ok
      ? 'Describe what to build or change…'
      : 'Connect an AI service above to start.';
    $('ai-connect').classList.toggle('done', ok || (viaApp && linkState === 'linked'));
    $('ai-model-tag').textContent = viaApp
      ? (linkState === 'linked' ? `via ${linkClient || 'app'}` : '')
      : (ok ? modelSel.value : '');
  };

  // -- the link: Claude Desktop on the person's subscription -------------------
  let linkState = 'stopped';
  let linkClient = '';
  const linkBtn = $('ai-link-btn');

  const showLinkState = () => {
    const who = linkClient || 'the app';
    const text = {
      stopped: 'Not linked. Install the extension in Claude Desktop, then press Link.',
      waiting: 'Looking for Claude Desktop on this computer… Open Claude Desktop with the OpsForge extension installed and turned on. If the browser asks whether this page may reach apps on this device, allow it.',
      linked: `Linked to ${who}. Ask for changes in a Claude Desktop chat; they appear here, each one a single Undo.`,
      replaced: 'Another OpsForge tab took the link. Press Link to take it back here.',
    }[linkState];
    if (provider === 'link') setStatus(text, linkState === 'replaced');
    linkBtn.textContent = link.running ? 'Unlink' : 'Link';
    $('b-ai').classList.toggle('linked', linkState === 'linked');
  };

  const link = createLink({
    runTool: (name, input) => runTool(name, input),
    onState: ({ state, client }) => {
      if (state === 'linked' && linkState !== 'linked') add('ai-note', `Linked to ${client || 'the app'}. Changes it makes appear below.`);
      if (state === 'waiting' && linkState === 'linked') add('ai-note', 'The app went away. Waiting for it to come back…');
      if (state === 'replaced') add('ai-note', 'Another OpsForge tab took the link.');
      linkState = state;
      if (client) linkClient = client;
      showLinkState();
      refreshReady();
    },
  });

  linkBtn.onclick = () => {
    if (link.running) link.stop();
    else link.start();
    settings.linkOn = link.running;
    saveSettings(settings);
    showLinkState();
  };

  providerSel.onchange = () => {
    // Leaving the link lets the app go, so a person switching to a key is not
    // also being edited from elsewhere.
    if (provider === 'link' && providerSel.value !== 'link' && link.running) {
      link.stop();
      settings.linkOn = false;
    }
    provider = providerSel.value;
    settings.provider = provider;
    saveSettings(settings);
    showProvider();
  };

  $('ai-connect-btn').onclick = async () => {
    const key = keyInput.value.trim();
    if (!key) return setStatus('Paste an API key first.', true);
    setStatus('Checking the key…');
    $('ai-connect-btn').disabled = true;
    try {
      const ids = await listModels(provider, key);
      if (!ids.length) throw new Error('That key works but has no chat models available.');
      saveKey(provider, key, remember.checked);
      const chosen = settings.models?.[provider] && ids.includes(settings.models[provider])
        ? settings.models[provider] : ids[0];
      fillModels(ids, chosen);
      settings.models = { ...(settings.models || {}), [provider]: modelSel.value };
      saveSettings(settings);
      conversation = null;
      setStatus(`Connected to ${PROVIDERS[provider].label}. ${remember.checked ? 'Key remembered on this computer.' : 'Key kept for this tab only.'}`);
    } catch (err) {
      setStatus(err.message || String(err), true);
    } finally {
      $('ai-connect-btn').disabled = false;
      refreshReady();
    }
  };

  $('ai-forget').onclick = () => {
    forgetKey(provider);
    keyInput.value = '';
    fillModels([], null);
    conversation = null;
    setStatus('Key forgotten.');
    refreshReady();
  };

  remember.onchange = () => {
    const key = loadKey(provider);
    if (key) saveKey(provider, key, remember.checked);
  };

  modelSel.onchange = () => {
    settings.models = { ...(settings.models || {}), [provider]: modelSel.value };
    saveSettings(settings);
    conversation = null;
    refreshReady();
  };

  $('ai-toggle-connect').onclick = () => $('ai-connect').classList.toggle('open');

  // -- chat -------------------------------------------------------------------
  const runTool = (name, input) => {
    const reason = host.blocked();
    if (reason && AI_MUTATING_TOOLS.has(name)) {
      const r = { ok: false, result: { error: reason } };
      add('ai-tool bad', describeCall(name, r));
      return r;
    }
    const doc = host.snapshot();
    const r = applyAiTool(doc, name, input);
    if (r.ok && AI_MUTATING_TOOLS.has(name)) host.apply(doc, r.changes);
    if (r.ok && name === 'make_prefab') {
      host.saveFile(r.result.file_name, JSON.stringify(r.result.prefab, null, 1));
      // The model does not need the file back — it has just described it.
      r.result = { file_name: r.result.file_name, object_count: r.result.object_count, saved: true, ...(r.result.notes ? { notes: r.result.notes } : {}) };
    }
    add(r.ok ? 'ai-tool' : 'ai-tool bad', describeCall(name, r));
    return r;
  };

  let spent = { input: 0, output: 0 };
  const usage = $('ai-usage');
  const on = {
    text: (t) => add('ai-bot', t),
    note: (t) => add('ai-note', t),
    usage: (u) => {
      spent = { input: spent.input + (u.input || 0), output: spent.output + (u.output || 0) };
      usage.textContent = `${spent.input.toLocaleString()} in · ${spent.output.toLocaleString()} out tokens this chat`;
    },
  };

  const send = async () => {
    const prompt = $('ai-prompt');
    const text = prompt.value.trim();
    if (!text || running || !connected()) return;
    if (!conversation || conversation.model !== modelSel.value || conversation.provider !== provider) {
      conversation = new Conversation(provider, loadKey(provider), modelSel.value);
    }
    prompt.value = '';
    add('ai-user', text);
    running = new AbortController();
    $('ai-stop').hidden = false;
    refreshReady();
    const thinking = add('ai-note working', 'Working…');
    try {
      await conversation.send(text, { runTool, on, signal: running.signal });
    } catch (err) {
      conversation.settleAfterAbort();
      if (err?.name === 'AbortError') add('ai-note', 'Stopped.');
      else add('ai-note bad', err?.message || String(err));
    } finally {
      thinking.remove();
      running = null;
      $('ai-stop').hidden = true;
      refreshReady();
      log.scrollTop = log.scrollHeight;
    }
  };

  $('ai-send').onclick = send;
  $('ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('ai-stop').onclick = () => running?.abort();
  $('ai-new').onclick = () => {
    running?.abort();
    conversation = null;
    log.innerHTML = '';
    spent = { input: 0, output: 0 };
    usage.textContent = '';
  };

  // -- open / close -------------------------------------------------------------
  const setOpen = (open) => {
    panel.hidden = !open;
    host.onToggle?.(open);
    if (open) {
      const ready = connected() || (provider === 'link' && linkState === 'linked');
      if (!ready) $('ai-connect').classList.add('open');
      if (provider === 'link') linkBtn.focus();
      else (ready ? $('ai-prompt') : keyInput).focus();
    }
  };
  $('ai-close').onclick = () => setOpen(false);
  $('b-ai').onclick = () => setOpen(panel.hidden);

  showProvider();
  // Linked last time: pick it back up, so a reload does not drop the app.
  if (provider === 'link' && settings.linkOn) link.start();
}
