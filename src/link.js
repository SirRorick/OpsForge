// ---------------------------------------------------------------------------
// link.js — the editor's end of the OpsForge link
// ---------------------------------------------------------------------------
// tools/opsforge-link.mjs runs inside Claude Desktop or Codex, on the person's
// own subscription, and listens on the loopback interface. This asks it for
// the next tool call, runs the call through the same `runTool` the AI panel
// uses, and posts back what happened. The page always asks — nothing can call
// into a web page — so it holds a long poll open while linked.
//
// Nothing here touches the DOM or three.js; the panel in assistant.js decides
// what to show, and `fetchImpl` lets a test stand in for the browser.
// ---------------------------------------------------------------------------

export const LINK_PORT = 47615;   // LINK_PORT in tools/opsforge-link.mjs
export const LINK_BASE = `http://127.0.0.1:${LINK_PORT}`;
const LINK_RETRY_MAX_MS = 10000;

function linkSession() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A link that, once started, keeps trying until stopped.
 *
 *   runTool(name, input)  -> { ok, result }, as the panel's own
 *   onState({ state, client? })
 *     'waiting'   nothing answering on this computer yet
 *     'linked'    the app is there; `client` says which ('Claude', 'Codex')
 *     'replaced'  another tab took the link over, and this one has stopped
 *     'stopped'   stopped from here
 */
export function createLink({ runTool, onState, base = LINK_BASE, fetchImpl = (...a) => fetch(...a) }) {
  let session = null;
  let running = false;
  let abort = null;
  let wake = null;
  let generation = 0;

  const post = async (path, body, signal) => {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res;
  };

  const pause = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => { clearTimeout(t); resolve(); };
  });

  async function loop(me) {
    // A stop and a start in quick succession must not leave two loops polling.
    const alive = () => running && generation === me;
    let linked = false;
    let delay = 1000;
    while (alive()) {
      abort = new AbortController();
      try {
        if (!linked) {
          const res = await post('/hello', { session, app: 'opsforge' }, abort.signal);
          if (!res.ok) throw new Error(`hello ${res.status}`);
          const hello = await res.json();
          if (hello?.app !== 'opsforge-link') throw new Error('not the OpsForge link');
          linked = true;
          delay = 1000;
          onState({ state: 'linked', client: String(hello.client || '').slice(0, 60) });
        }
        const res = await fetchImpl(`${base}/next?session=${session}`, { signal: abort.signal });
        if (res.status === 204) continue;
        if (res.status === 409) {
          if (!alive()) return;
          running = false;
          onState({ state: 'replaced' });
          return;
        }
        if (!res.ok) throw new Error(`next ${res.status}`);
        const call = await res.json();
        let r;
        try {
          r = await runTool(String(call?.name || ''), call?.input && typeof call.input === 'object' ? call.input : {});
        } catch (err) {
          r = { ok: false, result: { error: `The editor failed to run that: ${err?.message || err}` } };
        }
        const done = await post('/result', { session, id: call?.id, ok: !!r?.ok, result: r?.result ?? {} }, abort.signal);
        if (done.status === 409) {
          if (!alive()) return;
          running = false;
          onState({ state: 'replaced' });
          return;
        }
      } catch {
        if (!alive()) return;
        // Once on losing the app, not on every retry after.
        if (linked || delay === 1000) onState({ state: 'waiting' });
        linked = false;
        await pause(delay);
        delay = Math.min(delay * 2, LINK_RETRY_MAX_MS);
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      session = linkSession();
      loop(++generation);
    },
    stop() {
      if (!running) return;
      running = false;
      abort?.abort();
      wake?.();
      onState({ state: 'stopped' });
    },
    get running() { return running; },
  };
}
