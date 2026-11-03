// ---------------------------------------------------------------------------
// version.js — which build this is
// ---------------------------------------------------------------------------
// Shown in the corner of the status bar, so anyone reporting a problem can say
// which editor they saw it in. `release` follows the numbering of the GitHub
// releases (OpsForge_v12 was the last before this file existed); `commit` and
// `date` say "dev" and nothing here, and build.mjs writes the real ones into the
// bundle — the short git hash it was built from, with "+" when the working
// tree had changes not yet committed, and the day.
// ---------------------------------------------------------------------------

export const BUILD = { release: 13, commit: 'dev', date: '' };

/** "v13 · build 1a2b3c4 · 2026-11-03", or "v13 · dev" straight from src/. */
export function buildLabel(b = BUILD) {
  return b.commit === 'dev'
    ? `v${b.release} · dev`
    : `v${b.release} · build ${b.commit}${b.date ? ` · ${b.date}` : ''}`;
}
