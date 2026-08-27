// ---------------------------------------------------------------------------
// Autosave checkpoints
// ---------------------------------------------------------------------------
// A ring of recent snapshots of the map, kept so that closing the tab is not
// the same as losing the afternoon.
//
// **Where they live.** In the browser's `localStorage`, against the address the
// editor is served from. Not next to the build on disk: a page cannot write to
// the folder it was served from, and the one API that could (File System
// Access) needs a folder picked by hand every session and does not exist in
// every browser. Storage keyed to the origin is the version of "along with the
// build" that a web page can actually keep — serve the editor from the same
// address each time and the checkpoints are waiting.
//
// This is a safety net, not a save file. `Export` writes the real map the game
// reads; a checkpoint is a copy of that same text, and restoring one loads it
// back into the editor. Nothing here reaches the game on its own, which is why
// restoring leaves you looking at a map that still needs exporting.
//
// **Layout.** One key per checkpoint plus a small index, rather than one blob:
// the index is read on every page load to draw the list, and it has no business
// dragging a megabyte of map text along with it.
//
//   spatialops.checkpoints          the index, newest first
//   spatialops.checkpoint.<id>      one map's serialised text
//   spatialops.checkpoint.<id>.ed   the editor state that has no home in it
//
// **The sidecar.** Grouping, locking and what has been put away with Hide are
// the editor's, not the map's: the game's format has no room for any of them,
// so a checkpoint that is only the exported text brings a map back with every
// group dissolved. Which is precisely the wrong moment for it — nobody restores
// a checkpoint on a good day, and an afternoon's arena arrives as four hundred
// loose objects. So those three travel in a second key beside the text, sparse
// and indexed by position in `mapObjects`, and a checkpoint written before this
// existed simply has none and restores the way it always did.
//
// Every name here is prefixed or compounded on purpose. `build.mjs` flattens
// the modules into one scope, so a bare `list` or `save` would collide with
// something in app.js the moment the bundle is built.
// ---------------------------------------------------------------------------

const CHECKPOINT_INDEX_KEY = 'spatialops.checkpoints';
const CHECKPOINT_PREFIX = 'spatialops.checkpoint.';
const CHECKPOINT_EDITOR_SUFFIX = '.ed';
const CHECKPOINT_LIMIT = 12;

/**
 * localStorage, or null where there is none.
 *
 * Private browsing and `file://` pages can both make `localStorage` throw on
 * access rather than merely be empty, so every entry point goes through here
 * and the feature turns itself off rather than taking the editor down with it.
 */
function checkpointStore() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__spatialops_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export const checkpointsAvailable = () => checkpointStore() !== null;

function readCheckpointIndex(s) {
  try {
    const raw = s.getItem(CHECKPOINT_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCheckpointIndex(s, entries) {
  s.setItem(CHECKPOINT_INDEX_KEY, JSON.stringify(entries));
}

function dropCheckpoint(s, entry) {
  if (!entry) return;
  s.removeItem(CHECKPOINT_PREFIX + entry.id);
  s.removeItem(CHECKPOINT_PREFIX + entry.id + CHECKPOINT_EDITOR_SUFFIX);
}

/** Every checkpoint, newest first. Metadata only — the map text stays put. */
export function checkpointList() {
  const s = checkpointStore();
  if (!s) return [];
  const all = readCheckpointIndex(s);
  // Drop any entry whose payload has gone: site data cleared by hand, or an
  // eviction, leaves the index describing something that is no longer there.
  const kept = all.filter((e) => s.getItem(CHECKPOINT_PREFIX + e.id) !== null);
  if (kept.length !== all.length) writeCheckpointIndex(s, kept);
  return kept;
}

export function checkpointText(id) {
  const s = checkpointStore();
  return s ? s.getItem(CHECKPOINT_PREFIX + id) : null;
}

/**
 * The grouping, locks and hidden flags stored beside a checkpoint, or null.
 *
 * Null for a checkpoint written before the sidecar existed, for one whose
 * sidecar was evicted on its own, and for a map that had none of the three to
 * record — all of which mean the same thing to the caller and none of which is
 * an error.
 */
export function checkpointEditorState(id) {
  const s = checkpointStore();
  if (!s) return null;
  try {
    const raw = s.getItem(CHECKPOINT_PREFIX + id + CHECKPOINT_EDITOR_SUFFIX);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Add a checkpoint, evicting the oldest to stay under the limit and under
 * whatever quota this browser hands out.
 *
 * Returns the entry written, or null when the map is unchanged since the last
 * one — an idle timer firing over an untouched map must not push twelve
 * identical copies through the ring and throw away the history that mattered.
 */
export function saveCheckpoint({ text, editor, name, author, guid, objects, reason = 'auto' }) {
  const s = checkpointStore();
  if (!s) return null;

  const index = readCheckpointIndex(s);
  const newest = index[0];
  if (newest && newest.bytes === text.length && checkpointText(newest.id) === text) return null;

  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    name: name || 'Untitled',
    author: author || '',
    guid,
    objects,
    bytes: text.length,
    reason,
  };

  const next = [entry, ...index];
  // Trim to the limit first, then keep dropping the oldest for as long as the
  // browser refuses the write. Losing the oldest checkpoint is the right thing
  // to fail into; losing the newest is not.
  while (next.length > CHECKPOINT_LIMIT) dropCheckpoint(s, next.pop());
  for (;;) {
    try {
      s.setItem(CHECKPOINT_PREFIX + entry.id, text);
      writeCheckpointIndex(s, next);
      // Last and separately: the map text is the checkpoint and the sidecar is
      // a convenience, so a quota that will take one and not the other must
      // keep the one that matters. Restoring simply finds no grouping.
      if (editor) {
        try {
          s.setItem(CHECKPOINT_PREFIX + entry.id + CHECKPOINT_EDITOR_SUFFIX, JSON.stringify(editor));
        } catch { /* the map is stored; the grouping is not. */ }
      }
      return entry;
    } catch {
      if (next.length <= 1) {
        // Even on its own it will not fit. Leave what is stored already intact.
        s.removeItem(CHECKPOINT_PREFIX + entry.id);
        return null;
      }
      dropCheckpoint(s, next.pop());
    }
  }
}

export function removeCheckpoint(id) {
  const s = checkpointStore();
  if (!s) return;
  writeCheckpointIndex(s, readCheckpointIndex(s).filter((e) => e.id !== id));
  dropCheckpoint(s, { id });
}

export function clearCheckpoints() {
  const s = checkpointStore();
  if (!s) return;
  for (const e of readCheckpointIndex(s)) dropCheckpoint(s, e);
  s.removeItem(CHECKPOINT_INDEX_KEY);
}

/** Total bytes of map text held, for the panel's summary line. */
export function checkpointBytes() {
  return checkpointList().reduce((n, e) => n + e.bytes, 0);
}

/** "just now", "6 min ago", "12 Aug 14:03" — the list is read at a glance. */
export function timeAgo(iso) {
  const then = new Date(iso);
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const clock = then.toTimeString().slice(0, 5);
  if (then.toDateString() === new Date().toDateString()) return `${Math.floor(mins / 60)} h ago, ${clock}`;
  return `${then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clock}`;
}
