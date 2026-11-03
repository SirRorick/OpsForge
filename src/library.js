// ---------------------------------------------------------------------------
// library.js — the community prefab library, the editor's half
// ---------------------------------------------------------------------------
// Browse what other people have shared, place it, share your own selection,
// and report what should not be there. The server half is api/; the rules both
// halves keep are prefablib.js.
//
// Nothing here needs an account to look. Sharing and reporting need a mod.io
// sign-in — the same one Export uses to publish maps — because that is what
// gives a contributor an identity that can be barred without an email address
// ever reaching OpsForge. The token goes to this editor's own /api, which asks
// mod.io who it belongs to and forgets it.
//
// Wired in by app.js with the handful of things it owns — dialogs, toasts,
// the selection, placing a prefab, the mod.io sign-in — so this module never
// reaches into the scene.
// ---------------------------------------------------------------------------

import { defFor } from './catalog.js';
import {
  TAG_PRESETS, LIMITS, REPORT_REASONS, UGC_NOTICE, SPIN_FRAMES,
  normalizeTag, suggestTag, searchPrefabs, didYouMean, validatePrefab, prefabSize,
  suggestedThemeTags, suggestedSizeTag, isPresetTag, PrefabError,
} from './prefablib.js';

const NOTICE_KEY = 'opsforge.prefablib.notice.v1';
const LIBRARY_API = 'api/';
const PAGE = 60;

const lookupDef = (type, props) => defFor({ type, props });

class SignInNeeded extends Error {}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function storedFlag(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function storeFlag(key) {
  try { localStorage.setItem(key, '1'); } catch { /* a private window forgets; it asks again */ }
}

const metres = (size) => size.map((n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1))).join(' × ');

/**
 * `host` is { toast, openDialog, closeDialog, selection, prefabFrom,
 * renderImages, place, signIn, token, forgetToken }.
 */
export function wirePrefabLibrary(host) {
  let index = null;
  let indexAt = 0;
  // Set by this person's own share or report: the next listing goes past the
  // edge's few seconds of cache, so they see what they just did.
  let mine = false;

  async function api(route, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const t = host.token();
      if (!t) throw new SignInNeeded();
      headers.authorization = `Bearer ${t}`;
    }
    let res;
    try {
      res = await fetch(`${LIBRARY_API}${route}`, {
        method, headers, credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('The prefab library could not be reached.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON: an HTML 404 from a host with no library */ }
    if (res.status === 401 && auth) { host.forgetToken(); throw new SignInNeeded(data?.error); }
    if (!res.ok) {
      if (!data) throw new Error('This copy of OpsForge has no prefab library behind it.');
      throw new Error(data.error || `The library answered ${res.status}.`);
    }
    return data;
  }

  async function loadIndex(force = false) {
    if (!force && index && Date.now() - indexAt < 30_000) return index;
    index = await api(mine ? `library?fresh=${Date.now()}` : 'library');
    indexAt = Date.now();
    mine = false;
    return index;
  }

  // -- the notice ------------------------------------------------------------------

  function showNotice(then) {
    const body = el('div', 'ugc');
    for (const para of UGC_NOTICE) body.appendChild(el('p', null, para));
    host.openDialog({
      title: 'The community prefab library',
      body,
      actions: [
        { label: 'Not now', ghost: true, run: () => {} },
        { label: then ? 'I understand' : 'Close', run: () => { storeFlag(NOTICE_KEY); then?.(); } },
      ],
    });
  }

  function open() {
    if (!storedFlag(NOTICE_KEY)) return showNotice(browse);
    browse();
  }

  /** Run `fn`, sending the person through the mod.io sign-in first if they need it. */
  function signedIn(fn, why) {
    const go = () => fn().catch((err) => {
      if (err instanceof SignInNeeded) host.signIn(go, err.message || why);
      else host.toast(err.message, true);
    });
    if (!host.token()) return host.signIn(go, why);
    return go();
  }

  // -- browsing --------------------------------------------------------------------

  function browse() {
    const body = el('div', 'plib');
    const top = el('div', 'plib-top');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search — building, bunker, camo, wild west…';
    search.setAttribute('aria-label', 'Search the prefab library');
    const shareBtn = el('button', 'btn ghost', 'Share selection…');
    shareBtn.title = 'Share what is selected in the map to the library';
    shareBtn.onclick = () => share();
    top.append(search, shareBtn);
    const chips = el('div', 'plib-chips');
    const status = el('p', 'hint plib-status', 'Loading the library…');
    const grid = el('div', 'plib-grid');
    const more = el('button', 'btn ghost plib-more', 'Show more');
    more.hidden = true;
    const foot = el('p', 'hint plib-foot');
    const about = el('a', null, 'About the library');
    about.href = '#';
    about.onclick = (e) => { e.preventDefault(); showNotice(null); };
    foot.append('Made and shared by the community, not by OpsForge. ', about, '.');
    body.append(top, chips, status, grid, more, foot);

    const active = new Set();
    let shown = PAGE;
    let results = [];

    function renderChips() {
      chips.innerHTML = '';
      if (!index) return;
      const usage = index.tags.usage || {};
      const top = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);
      for (const t of new Set([...active, ...top])) {
        const c = el('button', `chip${active.has(t) ? ' on' : ''}`, t);
        c.type = 'button';
        const n = usage[t];
        if (n) c.appendChild(el('span', 'n', String(n)));
        c.onclick = () => { if (active.has(t)) active.delete(t); else active.add(t); shown = PAGE; render(); };
        chips.appendChild(c);
      }
    }

    function render() {
      renderChips();
      if (!index) return;
      const pool = index.prefabs.filter((p) => [...active].every((t) => p.tags.includes(t)));
      results = searchPrefabs(pool, search.value);
      grid.innerHTML = '';
      for (const p of results.slice(0, shown)) grid.appendChild(card(p));
      more.hidden = results.length <= shown;
      if (!index.prefabs.length) {
        status.textContent = 'Nothing has been shared yet. Select something you built and press Share selection to be the first.';
      } else if (!results.length) {
        status.textContent = 'No prefabs match.';
        const known = [...Object.keys(index.tags.usage || {})];
        const guess = didYouMean(search.value, known);
        if (guess) {
          status.append(' Did you mean ');
          const a = el('a', null, guess);
          a.href = '#';
          a.onclick = (e) => { e.preventDefault(); search.value = guess; render(); };
          status.append(a, '?');
        }
      } else {
        status.textContent = `${results.length} prefab${results.length === 1 ? '' : 's'}`
          + (search.value || active.size ? ` of ${index.prefabs.length}` : '')
          + '. Click one to place it; hover to turn it round.';
      }
    }

    let debounce = null;
    search.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { shown = PAGE; render(); }, 120);
    });
    more.onclick = () => { shown += PAGE; render(); };

    host.openDialog({ title: 'Prefab library', body, wide: 'x', actions: [{ label: 'Close', ghost: true, run: () => {} }] });
    search.focus();
    loadIndex(true).then(render).catch((err) => { status.textContent = err.message; });
  }

  function card(p) {
    const c = el('div', 'pcard');
    const pic = el('button', 'pthumb');
    pic.type = 'button';
    pic.title = `Place ${p.title}`;
    pic.style.backgroundImage = `url("${encodeURI(p.files.thumb)}")`;
    // Turn it round while the pointer is over it: the strip of frames is one
    // image, stepped through by moving which slice of it is showing.
    let timer = null;
    pic.addEventListener('pointerenter', () => {
      const frames = p.frames || SPIN_FRAMES;
      const img = new Image();
      img.onload = () => {
        if (!pic.matches(':hover')) return;
        pic.style.backgroundImage = `url("${encodeURI(p.files.spin)}")`;
        pic.style.backgroundSize = `${frames * 100}% 100%`;
        let i = 0;
        clearInterval(timer);
        timer = setInterval(() => {
          i = (i + 1) % frames;
          pic.style.backgroundPosition = `${(i / (frames - 1)) * 100}% 0`;
        }, 70);
      };
      img.src = p.files.spin;
    });
    pic.addEventListener('pointerleave', () => {
      clearInterval(timer);
      pic.style.backgroundImage = `url("${encodeURI(p.files.thumb)}")`;
      pic.style.backgroundSize = '';
      pic.style.backgroundPosition = '';
    });
    pic.onclick = () => placeFromLibrary(p, c);

    const title = el('div', 'ptitle', p.title);
    title.title = p.description || p.title;
    const meta = el('div', 'pmeta', `${p.author.name} · ${metres(p.size)} m · ${p.objects} piece${p.objects === 1 ? '' : 's'}`);
    const tags = el('div', 'ptags');
    for (const t of p.tags.slice(0, 6)) tags.appendChild(el('span', isPresetTag(t) ? 'ptag' : 'ptag own', t));
    const acts = el('div', 'pacts');
    const place = el('button', 'btn', 'Place');
    place.onclick = () => placeFromLibrary(p, c);
    const flag = el('button', 'btn ghost', 'Report');
    flag.title = 'Report this prefab, or one of the tags people wrote for it';
    flag.onclick = () => report(p);
    acts.append(place, flag);
    c.append(pic, title, meta, tags, acts);
    return c;
  }

  async function placeFromLibrary(p, cardEl) {
    if (cardEl.classList.contains('busy')) return;
    cardEl.classList.add('busy');
    try {
      const res = await fetch(p.files.prefab);
      if (!res.ok) throw new Error(`the file could not be fetched (${res.status})`);
      // Checked again here, by the same rules the server checked it with on the
      // way in: a library is somebody else's file, and the editor takes nothing
      // on trust that it would not take from a file on disk.
      const doc = validatePrefab(await res.json(), lookupDef);
      doc.name = p.title;
      host.closeDialog();
      host.place(doc);
    } catch (err) {
      cardEl.classList.remove('busy');
      host.toast(`Could not place "${p.title}": ${err.message}`, true);
    }
  }

  // -- sharing --------------------------------------------------------------------

  function share() {
    const meshes = host.selection();
    if (!meshes.length) return host.toast('Select what you want to share first — a building, a wall run, a set of cover.');
    if (meshes.length > LIMITS.objects) {
      return host.toast(`A library prefab holds at most ${LIMITS.objects} objects; ${meshes.length} are selected.`, true);
    }
    signedIn(() => openShare(meshes), 'Sharing to the prefab library needs a mod.io account — the same one you publish maps with.');
  }

  async function openShare(meshes) {
    let doc;
    try {
      doc = validatePrefab(host.prefabFrom('Prefab', meshes), lookupDef);
    } catch (err) {
      if (err instanceof PrefabError) return host.toast(err.message, true);
      throw err;
    }
    // Asked first, so a barred account hears it before filling the form in.
    const me = await api('whoami', { auth: true });
    if (me.banned) return host.toast('This mod.io account can no longer share to the library.', true);
    const lib = await loadIndex();
    const size = prefabSize(doc, lookupDef);
    const usage = lib.tags.usage || {};
    const customKnown = (lib.tags.custom || []).map((t) => t.tag);
    const chosen = new Set([...suggestedThemeTags(doc, lookupDef), suggestedSizeTag(size)]);

    const body = el('div', 'pshare');
    const preview = el('div', 'pshare-pic');
    const picEl = el('div', 'pthumb big');
    const picNote = el('p', 'hint', 'Drawing the pictures…');
    preview.append(picEl, picNote);

    const form = el('div', 'pshare-form');
    const titleRow = el('div', 'field');
    const titleIn = el('input');
    titleIn.type = 'text';
    // Empty rather than "4 objects": a library is browsed by its titles, and a
    // name nobody chose is a card nobody can tell from the next one.
    titleIn.placeholder = 'Name it — e.g. Sandbag bunker';
    titleIn.maxLength = LIMITS.title;
    titleRow.append(el('span', null, 'Title'), titleIn);
    const descRow = el('div', 'field');
    const descIn = el('textarea');
    descIn.rows = 2;
    descIn.maxLength = LIMITS.description;
    descIn.placeholder = 'Optional — what it is, how to use it';
    descRow.append(el('span', null, 'About'), descIn);
    const facts = el('p', 'hint', `${doc.objects.length} piece${doc.objects.length === 1 ? '' : 's'}, ${metres(size)} m. `
      + 'Everyone sees it as soon as it is shared; you are named as the author.');

    const tagHead = el('div', 'pshare-taghead');
    const tagCount = el('span', 'cnt');
    tagHead.append(el('b', null, 'Tags'), tagCount, el('span', 'hint', ' — how people will find it. Pick a few.'));
    const picked = el('div', 'plib-chips picked');
    const groups = el('div', 'pshare-groups');
    const customRow = el('div', 'pshare-custom');
    const customIn = el('input');
    customIn.type = 'text';
    customIn.placeholder = 'Your own tag';
    customIn.maxLength = LIMITS.tagMax + 4;
    const list = el('datalist');
    list.id = 'plib-known-tags';
    for (const t of customKnown) list.appendChild(Object.assign(el('option'), { value: t }));
    customIn.setAttribute('list', list.id);
    const addBtn = el('button', 'btn ghost', 'Add');
    const typo = el('p', 'hint pshare-typo');
    customRow.append(customIn, addBtn, list);

    const rights = el('label', 'flagopt');
    const rightsIn = el('input');
    rightsIn.type = 'checkbox';
    rights.append(rightsIn, document.createTextNode(' This is my own work, and anybody may use it in their maps.'));

    form.append(titleRow, descRow, facts, tagHead, picked, groups, customRow, typo, rights);
    body.append(preview, form);

    function renderTags() {
      picked.innerHTML = '';
      for (const t of chosen) {
        const c = el('button', 'chip on', t);
        c.type = 'button';
        c.title = 'Remove';
        c.onclick = () => { chosen.delete(t); renderTags(); };
        picked.appendChild(c);
      }
      if (!chosen.size) picked.appendChild(el('span', 'hint', 'No tags yet.'));
      tagCount.textContent = ` ${chosen.size}/${LIMITS.tags}`;
      groups.innerHTML = '';
      const sets = [...TAG_PRESETS];
      if (customKnown.length) sets.push({ group: 'From the community', tags: customKnown.slice(0, 40) });
      for (const g of sets) {
        const row = el('div', 'pshare-group');
        row.appendChild(el('span', 'g', g.group));
        for (const t of g.tags) {
          if (chosen.has(t)) continue;
          const c = el('button', 'chip', t);
          c.type = 'button';
          c.onclick = () => add(t);
          row.appendChild(c);
        }
        groups.appendChild(row);
      }
      validate();
    }

    function add(raw, { force = false } = {}) {
      const t = normalizeTag(raw);
      typo.textContent = '';
      if (!t) { typo.textContent = `A tag is ${LIMITS.tagMin}–${LIMITS.tagMax} letters, numbers or spaces.`; return; }
      if (chosen.size >= LIMITS.tags) { typo.textContent = `At most ${LIMITS.tags} tags.`; return; }
      const guess = force ? null : suggestTag(t, customKnown, usage);
      if (guess && !chosen.has(guess)) {
        typo.append(`Did you mean “${guess}”? `);
        const use = el('button', 'btn ghost', `Use “${guess}”`);
        use.onclick = () => { add(guess, { force: true }); customIn.value = ''; };
        const keep = el('button', 'btn ghost', `Keep “${t}”`);
        keep.onclick = () => { add(t, { force: true }); customIn.value = ''; };
        typo.append(use, ' ', keep);
        return;
      }
      chosen.add(t);
      customIn.value = '';
      renderTags();
    }
    addBtn.onclick = () => add(customIn.value);
    customIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(customIn.value); }
    });

    let images = null;
    let ui = null;
    function validate() {
      const ok = images && titleIn.value.trim().length >= 3 && chosen.size > 0 && rightsIn.checked;
      ui?.enable('Share', !!ok);
    }
    titleIn.addEventListener('input', validate);
    rightsIn.addEventListener('change', validate);

    ui = host.openDialog({
      title: 'Share to the prefab library',
      body,
      wide: true,
      actions: [
        { label: 'Cancel', ghost: true, run: () => {} },
        {
          label: 'Share',
          disabled: true,
          keepOpen: true,
          run: async (_v, dlg) => {
            dlg.busy(true);
            dlg.enable('Share', false);
            dlg.status('Sharing…');
            try {
              const out = await api('submit', {
                method: 'POST',
                auth: true,
                body: {
                  title: titleIn.value, description: descIn.value, tags: [...chosen],
                  prefab: doc, thumb: images.thumb, spin: images.spin,
                },
              });
              index = null;
              mine = true;
              dlg.busy(false);
              dlg.close();
              host.toast(`Shared “${out.prefab.title}” to the prefab library.`);
            } catch (err) {
              dlg.busy(false);
              if (err instanceof SignInNeeded) { dlg.close(); host.signIn(() => share(), err.message); return; }
              dlg.status(err.message, true);
              dlg.enable('Share', true);
            }
          },
        },
      ],
    });
    renderTags();

    try {
      images = await host.renderImages(doc);
      picEl.style.backgroundImage = `url("${images.thumb}")`;
      picNote.textContent = 'Every prefab is pictured the same way. Hover to see it turn.';
      let timer = null;
      picEl.addEventListener('pointerenter', () => {
        picEl.style.backgroundImage = `url("${images.spin}")`;
        picEl.style.backgroundSize = `${SPIN_FRAMES * 100}% 100%`;
        let i = 0;
        timer = setInterval(() => {
          i = (i + 1) % SPIN_FRAMES;
          picEl.style.backgroundPosition = `${(i / (SPIN_FRAMES - 1)) * 100}% 0`;
        }, 70);
      });
      picEl.addEventListener('pointerleave', () => {
        clearInterval(timer);
        picEl.style.backgroundImage = `url("${images.thumb}")`;
        picEl.style.backgroundSize = '';
        picEl.style.backgroundPosition = '';
      });
      validate();
    } catch (err) {
      console.error(err);
      picNote.textContent = `The pictures could not be drawn: ${err.message}`;
    }
  }

  // -- reporting -------------------------------------------------------------------

  function report(p) {
    signedIn(async () => openReport(p), 'Reporting needs a mod.io account, so one person counts once.');
  }

  async function openReport(p) {
    const body = el('div', 'preport');
    body.appendChild(el('p', null, `What is wrong with “${p.title}”?`));
    const targets = el('div', 'preport-targets');
    const radio = (value, label, checked) => {
      const l = el('label', 'flagopt');
      const r = el('input');
      r.type = 'radio';
      r.name = 'preport-target';
      r.value = value;
      r.checked = checked;
      l.append(r, document.createTextNode(` ${label}`));
      return l;
    };
    targets.appendChild(radio('prefab', 'The prefab itself', true));
    for (const t of p.tags.filter((x) => !isPresetTag(x))) targets.appendChild(radio(`tag:${t}`, `Its tag “${t}”`, false));
    const reason = el('select');
    for (const r of REPORT_REASONS) reason.appendChild(Object.assign(el('option', null, r.label), { value: r.id }));
    const reasonRow = el('div', 'field');
    reasonRow.append(el('span', null, 'Why'), reason);
    const note = el('textarea');
    note.rows = 2;
    note.maxLength = LIMITS.reportNote;
    note.placeholder = 'Optional — anything that would help whoever reviews it';
    const noteRow = el('div', 'field');
    noteRow.append(el('span', null, 'Note'), note);
    body.append(targets, reasonRow, noteRow,
      el('p', 'hint', `Each account counts once. ${index?.threshold ?? 3} reports hide it until it has been reviewed.`));

    host.openDialog({
      title: 'Report',
      body,
      actions: [
        { label: 'Cancel', ghost: true, run: () => {} },
        {
          label: 'Report',
          keepOpen: true,
          run: async (_v, dlg) => {
            const target = body.querySelector('input[name=preport-target]:checked')?.value || 'prefab';
            const isTag = target.startsWith('tag:');
            dlg.busy(true);
            try {
              const out = await api('report', {
                method: 'POST',
                auth: true,
                body: isTag
                  ? { kind: 'tag', tag: target.slice(4), reason: reason.value, note: note.value }
                  : { kind: 'prefab', id: p.id, reason: reason.value, note: note.value },
              });
              index = null;
              mine = true;
              dlg.busy(false);
              dlg.close();
              host.toast(out.already ? 'You have already reported that.'
                : out.hidden ? 'Reported. It is hidden until it has been reviewed — thank you.'
                  : 'Reported — thank you.');
            } catch (err) {
              dlg.busy(false);
              if (err instanceof SignInNeeded) { dlg.close(); host.signIn(() => report(p), err.message); return; }
              dlg.status(err.message, true);
            }
          },
        },
      ],
    });
  }

  return { open, share, notice: () => showNotice(null) };
}
