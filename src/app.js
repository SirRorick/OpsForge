// ---------------------------------------------------------------------------
// Spatial Ops map editor — application wiring
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Viewport } from './scene.js';
import {
  parseMap, serializeMap, newMap, newGuid, nowStamp, mapFileName,
  buildNavMask, encodeNavCloud, MAP_VERSION,
} from './format.js';
import { getPacks, registerPack, categoriesOf, packsInGroup, getByKey, iconUrl } from './catalog.js';
import {
  PACK_GROUPS, WEAPONS, WEAPON_ICONS, WEAPON_ANY, parseWeapons, formatWeapons,
} from './packs.js';
import {
  fieldsFor, unknownKeys, setValue, parseFlags, joinFlags, overrideCount,
  INT, BOOL, ENUM, FLAGS,
} from './rules.js';
import { unityEulerToQuat } from './unity.js';
import { geometryFor } from './placeholders.js';

const $ = (id) => document.getElementById(id);
const vp = new Viewport($('view'));

let map = null;             // everything except mapObjects, which live in the viewport
let activePack = 'default';                 // theme shown inside Virtual Objects
let openGroups = new Set(['virtual']);      // expanded top-level library sections
let activeMode = 0;                         // rule set tab
let undoStack = [], redoStack = [], current = null;
let groupSeq = 1;
let clipboard = [];         // copied objects as values, independent of the meshes
let placeReturn = [];       // selection to fall back to if a placement is cancelled
let placingLabel = null;    // set while a library pick-up is following the cursor

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  map = await newMap({ name: 'New Map' });
  applyMapMeta();
  await tryLoadDiskPacks();
  buildLibrary();
  buildRules();
  wireToolbar();
  wireInspector();
  wireKeyboard();
  wireDragDrop();
  wireViewport();
  resize();
  addEventListener('resize', resize);
  current = snapshot();
  refreshAll();
  toast('Ready. Open a map file, or drag objects in from the library.');
})();

function resize() {
  vp.resize();
}

/**
 * Extra packs sitting next to index.html, when the editor is served over http.
 * The packs the game ships with are built in; this is only for adding more.
 */
async function tryLoadDiskPacks() {
  try {
    const res = await fetch('./packs/index.json', { cache: 'no-store' });
    if (!res.ok) return;
    const list = await res.json();
    for (const file of list) {
      try {
        const p = await (await fetch(`./packs/${file}`, { cache: 'no-store' })).json();
        registerPack(p);
      } catch (e) { console.warn(`Pack ${file} failed to load`, e); }
    }
  } catch { /* file:// or no packs folder — the built-in packs are enough */ }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    objects: vp.objects.map((m) => {
      m.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.matrixWorld.decompose(p, q, s);
      return {
        type: m.userData.def.type,
        $type: m.userData.objectType,
        props: { ...m.userData.props },
        p: p.toArray(), q: q.toArray(), s: s.toArray(),
        dirty: m.userData.dirty, raw: m.userData.raw, group: m.userData.group,
      };
    }),
    selection: vp.objects.map((m) => vp.selection.has(m)),
    bounds: { ...map.mapBoundsSize },
  };
}

function restore(snap) {
  vp.clearObjects();
  const picked = [];
  snap.objects.forEach((rec, i) => {
    const mesh = vp.addObject({
      type: rec.type, $type: rec.$type, props: rec.props,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      raw: rec.raw, dirty: rec.dirty,
    });
    mesh.position.fromArray(rec.p);
    mesh.quaternion.fromArray(rec.q);
    mesh.scale.fromArray(rec.s);
    mesh.userData.group = rec.group;
    if (snap.selection[i]) picked.push(mesh);
  });
  map.mapBoundsSize = { ...snap.bounds };
  vp.setBounds(map.mapBoundsSize);
  vp.setSelection(picked);
  refreshAll();
}

function commit() {
  if (current) undoStack.push(current);
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  current = snapshot();
  touchEdited();
  refreshAll();
}

function undo() {
  if (!undoStack.length) return toast('Nothing left to undo.');
  redoStack.push(current);
  current = undoStack.pop();
  restore(current);
}

function redo() {
  if (!redoStack.length) return toast('Nothing to redo.');
  undoStack.push(current);
  current = redoStack.pop();
  restore(current);
}

function touchEdited() {
  if (map) map.editedTime = nowStamp();
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/**
 * Three collapsible sections matching the in-game library: Virtual Objects,
 * which holds a pack per theme, then Gameplay Objects and Mode Objectives.
 * Only an open section renders thumbnails, which is what keeps a 178-object
 * library from spinning up 178 WebGL renders on boot.
 */
function buildLibrary() {
  const q = $('q').value.trim().toLowerCase();
  const host = $('lib-list');
  host.innerHTML = '';
  let shown = 0;

  // Filtering is a search across the whole library, so a hit in a collapsed
  // section opens it rather than hiding behind a closed twisty.
  const open = (id) => openGroups.has(id) || !!q;

  for (const group of PACK_GROUPS) {
    const packs = packsInGroup(group.id);
    if (!packs.length) continue;

    const section = document.createElement('div');
    section.className = 'libsec' + (open(group.id) ? ' open' : '');

    const head = document.createElement('button');
    head.className = 'libsec-h';
    head.innerHTML =
      `<span class="tw">${open(group.id) ? '&#9660;' : '&#9654;'}</span>` +
      `<span>${escapeHtml(group.name)}</span><span class="n"></span>`;
    head.onclick = () => {
      if (openGroups.has(group.id)) openGroups.delete(group.id);
      else openGroups.add(group.id);
      buildLibrary();
    };
    section.appendChild(head);

    const body = document.createElement('div');
    body.className = 'libsec-body';
    section.appendChild(body);

    // A theme picker only makes sense where there is more than one pack.
    const visible = packs.length > 1 && !q
      ? [packs.find((p) => p.id === activePack) || packs[0]]
      : packs;
    if (packs.length > 1) {
      const bar = document.createElement('div');
      bar.id = group.id === 'virtual' ? 'packbar' : '';
      bar.className = 'packbar';
      bar.style.cssText = 'display:flex;gap:4px;padding:4px 12px 9px;flex-wrap:wrap';
      for (const p of packs) {
        const b = document.createElement('button');
        b.className = 'pill' + (p.id === activePack ? ' on' : '');
        b.textContent = p.name;
        b.onclick = () => { activePack = p.id; buildLibrary(); };
        bar.appendChild(b);
      }
      body.appendChild(bar);
    }

    let inGroup = 0;
    for (const pack of visible) {
      // With a filter running, several packs show at once, so say which is which.
      let heading = null;
      if (visible.length > 1) {
        heading = document.createElement('div');
        heading.className = 'cat';
        heading.style.color = 'var(--accent-dim)';
        heading.textContent = pack.name;
      }
      let inPack = 0;

      for (const [cat, defs] of categoriesOf(pack)) {
        const matching = defs.filter(
          (d) => !q || d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q)
        );
        if (!matching.length) continue;
        if (heading && !inPack) body.appendChild(heading);

        const h = document.createElement('div');
        h.className = 'cat';
        h.textContent = cat;
        body.appendChild(h);

        const grid = document.createElement('div');
        grid.className = 'items';
        for (const def of matching) {
          inPack++;
          inGroup++;
          shown++;
          grid.appendChild(libraryItem(def));
        }
        body.appendChild(grid);
      }
    }

    head.querySelector('.n').textContent = inGroup || '';
    if (open(group.id) && !inGroup) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '4px 12px 12px';
      p.textContent = 'Nothing here matches that filter.';
      body.appendChild(p);
    }
    host.appendChild(section);
  }

  $('lib-count').textContent = `${shown}`;
}

function libraryItem(def) {
  const el = document.createElement('div');
  el.className = 'item';
  el.draggable = true;
  el.title = def.uncertain
    ? `${def.type} — placeholder size is an estimate`
    : def.type;
  el.appendChild(thumbnail(def));
  const nm = document.createElement('div');
  nm.className = 'nm';
  nm.textContent = def.label;
  if (def.uncertain) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = ' ~';
    w.title = 'Placeholder dimensions are inferred, not confirmed';
    nm.appendChild(w);
  }
  el.appendChild(nm);
  el.onclick = () => pickUpNew(def);
  el.ondragstart = (ev) => {
    ev.dataTransfer.setData('text/spatial-ops-key', def.key);
    ev.dataTransfer.effectAllowed = 'copy';
  };
  return el;
}

// -- thumbnails -------------------------------------------------------------
// Rendered from the same geometry the viewport uses, so when real models drop
// in the library updates itself.

let thumbRenderer = null, thumbScene = null, thumbCam = null;
const thumbCache = new Map();

function thumbnail(def) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  // Keyed on `key`, not `type`: ten weapon spawners share one type and must
  // not share one picture.
  if (thumbCache.has(def.key)) {
    c.getContext('2d').drawImage(thumbCache.get(def.key), 0, 0);
    return c;
  }
  // The game's own library icon, when the asset dump is present. It is
  // gitignored and optional, so the render below stays as the fallback and
  // draws immediately; the sprite replaces it once it decodes.
  const sprite = iconUrl(def);
  if (sprite) {
    const img = new Image();
    img.onload = () => {
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, 128, 128);
      ctx.drawImage(img, 0, 0, 128, 128);
      const store = document.createElement('canvas');
      store.width = store.height = 128;
      store.getContext('2d').drawImage(c, 0, 0);
      thumbCache.set(def.key, store);
    };
    img.src = sprite;
  }
  try {
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      thumbRenderer.setSize(128, 128);
      thumbScene = new THREE.Scene();
      thumbScene.add(new THREE.HemisphereLight(0xbfd8ea, 0x1a2028, 2.4));
      const d = new THREE.DirectionalLight(0xffffff, 2.2);
      d.position.set(3, 5, 4);
      thumbScene.add(d);
      thumbCam = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    }
    const mesh = new THREE.Mesh(geometryFor(def), vp.materialFor(def));
    thumbScene.add(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.2);
    thumbCam.position.set(center.x + radius * 1.9, center.y + radius * 1.5, center.z + radius * 2.3);
    thumbCam.lookAt(center);
    thumbRenderer.render(thumbScene, thumbCam);
    const ctx = c.getContext('2d');
    ctx.drawImage(thumbRenderer.domElement, 0, 0);
    thumbScene.remove(mesh);
    const store = document.createElement('canvas');
    store.width = store.height = 128;
    store.getContext('2d').drawImage(c, 0, 0);
    thumbCache.set(def.key, store);
  } catch (e) {
    console.warn('Thumbnail render failed', e);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Placing, duplicating, grouping
// ---------------------------------------------------------------------------

function newObject(def, worldPoint) {
  vp.cancelPlacement();   // reaching for the library abandons a pending paste
  // The scale a piece is placed at comes from the catalog, not from 1,1,1: a
  // solid cylinder is 0.5 x 2 x 0.5 in every map the game wrote, and a tunnel
  // is 1 x 2 x 1.
  const [sx, sy, sz] = def.defaultScale;
  const y = def.pivot === 'center' ? (def.size[1] * sy) / 2 : 0;
  return vp.addObject({
    $type: def.objectType,
    type: def.type,
    props: def.props ? { ...def.props } : undefined,
    position: { x: round(worldPoint.x), y, z: round(-worldPoint.z) },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: sx, y: sy, z: sz },
    dirty: true,
  });
}

/** Dropped onto a spot in the view: it lands there and stays. */
function placeNew(def, worldPoint) {
  const mesh = newObject(def, worldPoint);
  vp.setSelection([mesh]);
  commit();
  toast(`Placed ${def.label}.`);
}

/**
 * Clicked in the library: the piece comes out on the cursor and follows it
 * until a click drops it, the same as a paste. Dropping it in the middle of the
 * view and making the user drag it there was the odd one out.
 */
function pickUpNew(def) {
  const mesh = newObject(def, vp.orbit.target.clone().setY(0));
  placeReturn = [...vp.selection];
  placingLabel = def.label;
  vp.beginPlacement([mesh]);
  toast(`Click to place ${def.label}. Esc cancels.`);
}

function round(v) {
  const s = vp.snap.translate;
  return s ? Math.round(v / s) * s : v;
}

function duplicate() {
  if (!vp.selection.size) return;
  const source = [...vp.selection];
  const remap = new Map();
  const made = [];
  for (const m of source) {
    m.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.matrixWorld.decompose(p, q, s);
    const copy = vp.addObject({
      type: m.userData.def.type,
      $type: m.userData.objectType,
      props: { ...m.userData.props },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    copy.position.copy(p).add(new THREE.Vector3(vp.snap.translate || 0.25, 0, 0));
    copy.quaternion.copy(q);
    copy.scale.copy(s);
    // A cloned group becomes its own group, so moving the copy leaves the
    // original alone.
    if (m.userData.group) {
      if (!remap.has(m.userData.group)) remap.set(m.userData.group, `g${groupSeq++}`);
      copy.userData.group = remap.get(m.userData.group);
    }
    made.push(copy);
  }
  vp.setSelection(made);
  commit();
  toast(`Duplicated ${made.length} object${made.length === 1 ? '' : 's'}.`);
}

/**
 * Copy is plain data, not mesh references, so it survives deleting the
 * originals, undo, and loading a different map. `raw` is deliberately dropped:
 * a pasted object is a new object and has to be serialised from its values.
 */
function copySelection() {
  if (!vp.selection.size) return toast('Nothing to copy.');
  clipboard = [...vp.selection].map((m) => {
    m.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.matrixWorld.decompose(p, q, s);
    return {
      type: m.userData.def.type,
      $type: m.userData.objectType,
      props: { ...m.userData.props },
      p: p.toArray(), q: q.toArray(), s: s.toArray(),
      group: m.userData.group,
    };
  });
  toast(`Copied ${clipboard.length} object${clipboard.length === 1 ? '' : 's'}.`);
}

function paste() {
  if (!clipboard.length) return toast('Nothing copied yet.');
  const remap = new Map();
  const made = clipboard.map((rec) => {
    const mesh = vp.addObject({
      type: rec.type, $type: rec.$type, props: rec.props,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    mesh.position.fromArray(rec.p);
    mesh.quaternion.fromArray(rec.q);
    mesh.scale.fromArray(rec.s);
    // A pasted group becomes its own group, as a duplicate does.
    if (rec.group) {
      if (!remap.has(rec.group)) remap.set(rec.group, `g${groupSeq++}`);
      mesh.userData.group = remap.get(rec.group);
    }
    return mesh;
  });
  placeReturn = [...vp.selection];
  placingLabel = null;
  vp.beginPlacement(made);
  toast('Click to place. Esc cancels.');
}

function groupSelection() {
  if (vp.selection.size < 2) return toast('Select at least two objects to group.');
  const id = `g${groupSeq++}`;
  for (const m of vp.selection) m.userData.group = id;
  commit();
  toast(`Grouped ${vp.selection.size} objects.`);
}

function ungroupSelection() {
  let n = 0;
  for (const m of vp.selection) if (m.userData.group) { m.userData.group = null; n++; }
  if (!n) return toast('Nothing in the selection is grouped.');
  commit();
  toast('Ungrouped.');
}

function deleteSelection() {
  if (!vp.selection.size) return;
  const n = vp.selection.size;
  vp.removeObjects([...vp.selection]);
  commit();
  toast(`Deleted ${n} object${n === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function wireToolbar() {
  $('b-new').onclick = async () => {
    if (vp.objects.length && !confirm('Start a new map? Anything unexported is lost.')) return;
    map = await newMap({ name: 'New Map', author: map?.author || '' });
    vp.clearObjects();
    applyMapMeta();
    activeMode = 0;
    buildRules();
    undoStack = []; redoStack = []; current = snapshot();
    refreshAll();
    toast('New map started.');
  };
  $('b-open').onclick = () => $('filepick').click();
  $('filepick').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('b-save').onclick = exportMap;

  for (const mode of ['translate', 'rotate', 'scale']) {
    $(`m-${mode}`).onclick = () => vp.setGizmoMode(mode);
  }
  $('m-space').onclick = () => {
    vp.setGizmoSpace(vp.gizmoSpace === 'world' ? 'local' : 'world');
    $('m-space').textContent = vp.gizmoSpace === 'world' ? 'World' : 'Local';
  };

  const syncSnap = () => {
    vp.setSnap('translate', $('snap-t').checked ? parseFloat($('snap-t-v').value) : 0);
    vp.setSnap('rotate', $('snap-r').checked ? parseFloat($('snap-r-v').value) : 0);
  };
  ['snap-t', 'snap-t-v', 'snap-r', 'snap-r-v'].forEach((id) => ($(id).onchange = syncSnap));
  $('uniform').onchange = (e) => { vp.uniformScale = e.target.checked; };
  $('floorlock').onchange = (e) => { vp.floorLock = e.target.checked; };

  $('b-undo').onclick = undo;
  $('b-redo').onclick = redo;
  $('q').oninput = buildLibrary;

  document.querySelectorAll('#viewbtns .btn').forEach((b) => {
    b.onclick = () => vp.setView(b.dataset.view);
  });
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

function wireInspector() {
  for (const id of ['bx', 'by', 'bz']) {
    $(id).onchange = () => {
      map.mapBoundsSize = {
        x: clampInt($('bx').value, 1, 60),
        y: clampInt($('by').value, 1, 20),
        z: clampInt($('bz').value, 1, 60),
      };
      applyMapMeta();
      vp.setBounds(map.mapBoundsSize);
      commit();
    };
  }
  $('m-name').onchange = () => { map.name = $('m-name').value || 'Untitled'; refreshMeta(); touchEdited(); };
  $('m-author').onchange = () => { map.author = $('m-author').value; touchEdited(); };
  $('b-newguid').onclick = () => { map.guid = newGuid(); refreshMeta(); toast('New map ID generated.'); };

  $('nav-shape').onchange = async () => {
    const shape = $('nav-shape').value;
    $('nav-r-row').style.display = shape === 'circle' ? '' : 'none';
    $('nav-w-row').style.display = shape === 'rect' ? '' : 'none';
    $('nav-d-row').style.display = shape === 'rect' ? '' : 'none';
    if (shape !== 'keep') await regenerateNav();
  };
  for (const id of ['nav-r', 'nav-w', 'nav-d']) {
    $(id).onchange = () => { if ($('nav-shape').value !== 'keep') regenerateNav(); };
  }
}

async function regenerateNav() {
  const shape = $('nav-shape').value;
  if (shape === 'keep') return;
  const mask = buildNavMask({
    shape,
    radius: parseFloat($('nav-r').value) || 5,
    width: parseFloat($('nav-w').value) || 7,
    depth: parseFloat($('nav-d').value) || 7,
    divisions: map.navCloud.divisions.x,
  });
  map.navCloud.encodedPoints = await encodeNavCloud(mask);
  await vp.setNavCloud(map.navCloud);
  touchEdited();
  toast('Play space updated.');
}

function clampInt(v, lo, hi) {
  const n = Math.round(parseFloat(v) || lo);
  return Math.min(hi, Math.max(lo, n));
}

// -- selection panel --------------------------------------------------------

let selFields = null;

function buildSelectionPanel() {
  const host = $('sel-body');
  const list = [...vp.selection];
  selFields = null;
  if (!list.length) {
    host.innerHTML = '<p class="hint">Nothing selected. Click an object, or drag a box across the view.</p>';
    return;
  }
  const multi = list.length > 1;
  const def = list[0].userData.def;

  host.innerHTML = `
    <p class="hint" style="margin:0 0 9px">
      ${multi ? `${list.length} objects selected` : `<b style="color:var(--text)">${escapeHtml(def.label)}</b>
        <span style="font-family:var(--mono);font-size:10px">${escapeHtml(def.type)}</span>`}
      ${def.unknown ? '<br><span style="color:var(--accent)">Not in any loaded pack — shown as a marker, but exported unchanged.</span>' : ''}
    </p>
    ${multi ? '' : propRows(list[0])}
    ${vecRow('Position', 'p', multi ? 'Moves the whole selection' : '')}
    ${vecRow('Rotation', 'r', multi ? 'disabled' : '')}
    ${vecRow('Scale', 's', multi ? 'disabled' : '')}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:9px">
      <button class="btn ghost" id="s-dup">Duplicate</button>
      <button class="btn ghost" id="s-floor">To floor</button>
      <button class="btn ghost" id="s-group">Group</button>
      <button class="btn ghost" id="s-ungroup">Ungroup</button>
    </div>
    <button class="btn ghost" id="s-del" style="width:100%;margin-top:5px;color:var(--danger)">Delete</button>
  `;

  selFields = {
    p: ['x', 'y', 'z'].map((a) => host.querySelector(`#f-p${a}`)),
    r: ['x', 'y', 'z'].map((a) => host.querySelector(`#f-r${a}`)),
    s: ['x', 'y', 'z'].map((a) => host.querySelector(`#f-s${a}`)),
  };
  for (const key of ['p', 'r', 's']) {
    for (const input of selFields[key]) {
      if (!input) continue;
      input.onchange = () => applyNumericEdit();
    }
  }
  $('s-dup').onclick = duplicate;
  $('s-floor').onclick = () => vp.dropToFloor();
  $('s-group').onclick = groupSelection;
  $('s-ungroup').onclick = ungroupSelection;
  $('s-del').onclick = deleteSelection;
  if (!multi) wirePropRows(list[0]);
  refreshSelectionValues();
}

// -- subtype properties -----------------------------------------------------
// A weapon spawner's weapon, an enemy spawn's behaviour, a damage box's style.
// Values seen in the reference maps are offered as a list, but the field stays
// free text: this is one export's worth of evidence, not the game's full enum.

const PROP_LABELS = {
  specificWeapon: 'Weapon',
  enemyTypes: 'Enemy types',
  behaviour: 'Behaviour',
  style: 'Style',
};

/** Every value the catalog has ever seen for a property, for the datalist. */
function propSuggestions(key) {
  const out = new Set();
  for (const pack of getPacks()) {
    for (const def of pack.objects) {
      if (def.props && def.props[key] !== undefined) out.add(def.props[key]);
    }
  }
  return [...out];
}

/**
 * A spawner offers a set, not a value: tick several and the game picks one at
 * random each time it fills. Rendered as toggles rather than a text field
 * because the wire format is a joined string nobody should have to type, and
 * because the set is what the user is actually choosing.
 */
function weaponRow(value) {
  const chosen = new Set(parseWeapons(value));
  // Union, so a weapon from a future game update still shows and stays ticked.
  const all = [...new Set([...WEAPONS, ...chosen])];
  const chips = all.map((w) => {
    const icon = iconUrl({ icon: WEAPON_ICONS[w] });
    const art = icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy">` : '';
    return `<label class="wchip${chosen.has(w) ? ' on' : ''}">
      <input type="checkbox" data-weapon="${escapeHtml(w)}"${chosen.has(w) ? ' checked' : ''}>
      ${art}<span>${escapeHtml(w)}</span></label>`;
  }).join('');
  return `<div class="field wfield"><span>Weapons</span>
    <div class="wgrid" id="f-weapons">${chips}</div>
    <div class="whint" id="f-weapons-hint"></div></div>`;
}

function propRows(mesh) {
  const props = mesh.userData.props || {};
  const keys = Object.keys(props);
  if (!keys.length) return '';
  return keys
    .map((key, i) => {
      if (key === 'specificWeapon') return weaponRow(props[key]);
      const label = PROP_LABELS[key] || key;
      const list = propSuggestions(key);
      const opts = list.map((v) => `<option value="${escapeHtml(v)}">`).join('');
      return `<div class="field"><span>${escapeHtml(label)}</span>
        <input type="text" id="f-prop${i}" data-key="${escapeHtml(key)}"
          list="dl-prop${i}" value="${escapeHtml(props[key])}">
        <datalist id="dl-prop${i}">${opts}</datalist></div>`;
    })
    .join('');
}

function wireWeaponRow(mesh) {
  const host = $('f-weapons');
  if (!host) return;
  const hint = $('f-weapons-hint');
  const boxes = [...host.querySelectorAll('input[type=checkbox]')];

  const describe = (list, written) => {
    if (written === WEAPON_ANY) return `Any weapon — the game writes "${WEAPON_ANY}".`;
    if (list.length === 1) return `Always spawns a ${list[0]}.`;
    // The written value is one unbreakable token, so offer the line breaker a
    // zero-width space after each separator: it wraps at the semicolons rather
    // than through the middle of "RiotShield". Display only — the value stored
    // on the object is untouched.
    const wrappable = written.replaceAll(';', ';​');
    return `${list.length} weapons — the game picks one at random. Written "${wrappable}".`;
  };

  const refresh = () => {
    const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.weapon);
    for (const b of boxes) b.closest('.wchip').classList.toggle('on', b.checked);
    hint.textContent = describe(chosen, formatWeapons(chosen));
  };

  for (const box of boxes) {
    box.onchange = () => {
      const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.weapon);
      // One weapon is the minimum, so the last one simply will not come off
      // rather than silently turning the spawner back into "any".
      if (!chosen.length) {
        box.checked = true;
        hint.textContent = 'A spawner needs at least one weapon.';
        return;
      }
      refresh();
      vp.setProp(mesh, 'specificWeapon', formatWeapons(chosen));
      commit();
    };
  }
  refresh();
}

function wirePropRows(mesh) {
  wireWeaponRow(mesh);
  const keys = Object.keys(mesh.userData.props || {});
  keys.forEach((key, i) => {
    if (key === 'specificWeapon') return;
    const input = $(`f-prop${i}`);
    if (!input) return;
    input.onchange = () => {
      const value = input.value.trim();
      if (!value) {
        input.value = mesh.userData.props[key];
        return;
      }
      vp.setProp(mesh, key, value);
      buildSelectionPanel();
      commit();
      toast(`${PROP_LABELS[key] || key} set to ${value}.`);
    };
  });
}

function vecRow(label, key, note) {
  const dis = note === 'disabled' ? ' disabled' : '';
  const axes = ['x', 'y', 'z'].map(
    (a) => `<div class="axis" data-a="${a.toUpperCase()}"><input type="number" step="0.01" id="f-${key}${a}"${dis}></div>`
  ).join('');
  return `<div class="field"><span>${label}</span><div class="triple">${axes}</div></div>`;
}

function refreshSelectionValues() {
  if (!selFields) return;
  const list = [...vp.selection];
  if (!list.length) return;
  const set = (inputs, v) => {
    ['x', 'y', 'z'].forEach((a, i) => {
      const el = inputs[i];
      if (el && document.activeElement !== el) el.value = round3(v[a]);
    });
  };
  if (list.length === 1) {
    const mo = vp.toMapObject(list[0]);
    set(selFields.p, mo.position);
    set(selFields.r, mo.rotation);
    set(selFields.s, mo.scale);
  } else {
    const c = vp.selectionBounds().getCenter(new THREE.Vector3());
    set(selFields.p, { x: c.x, y: c.y, z: -c.z });
    set(selFields.r, { x: 0, y: 0, z: 0 });
    set(selFields.s, { x: 1, y: 1, z: 1 });
  }
}

function round3(v) {
  return Math.abs(v) < 1e-6 ? 0 : +v.toFixed(4);
}

function applyNumericEdit() {
  const list = [...vp.selection];
  if (!list.length) return;

  /**
   * A field displays a value rounded for legibility. Reading that back as if
   * the user had typed it would apply a delta of up to half a display unit to
   * axes nobody touched, so an unchanged field means exactly unchanged.
   */
  const read = (inputs, actual) => {
    const out = {};
    ['x', 'y', 'z'].forEach((axis, i) => {
      const typed = parseFloat(inputs[i].value);
      out[axis] = !Number.isFinite(typed) || typed === round3(actual[axis])
        ? actual[axis]
        : typed;
    });
    return out;
  };

  if (list.length === 1) {
    const mo = vp.toMapObject(list[0]);
    const p = read(selFields.p, mo.position);
    const r = read(selFields.r, mo.rotation);
    const s = read(selFields.s, mo.scale);
    // The pivot carries the object's world placement while it is selected.
    vp.pivot.position.set(p.x, p.y, -p.z);
    vp.pivot.quaternion.fromArray(unityEulerToQuat(r));
    list[0].scale.set(s.x || 0.001, s.y || 0.001, s.z || 0.001);
    vp.markDirty(list[0]);
  } else {
    const c = vp.selectionBounds().getCenter(new THREE.Vector3());
    const shown = { x: c.x, y: c.y, z: -c.z };
    const target = read(selFields.p, shown);
    vp.pivot.position.add(
      new THREE.Vector3(target.x - shown.x, target.y - shown.y, -(target.z - shown.z))
    );
    for (const m of list) vp.markDirty(m);
  }
  if (vp.floorLock) vp._applyFloorLock();
  vp.rebuildPivot();
  commit();
}


// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------
// One tab per game mode. A field left blank writes nothing, which is how the
// game says "use the default" — see rules.js. Touched settings get a dot next
// to the label so it is obvious at a glance what this map actually overrides.

function buildRules() {
  const tabs = $('mode-tabs');
  const body = $('rules-body');
  tabs.innerHTML = '';
  body.innerHTML = '';
  const sets = map?.ruleSets || [];
  if (!sets.length) {
    body.innerHTML = '<p class="hint">This map has no rule sets.</p>';
    $('rules-count').textContent = '';
    return;
  }
  if (activeMode >= sets.length) activeMode = 0;

  sets.forEach((rs, i) => {
    const n = overrideCount(rs);
    const b = document.createElement('button');
    b.className = 'pill' + (i === activeMode ? ' on' : '');
    b.textContent = rs.name || rs.type;
    b.title = n ? `${n} setting${n === 1 ? '' : 's'} changed from the game default` : 'All defaults';
    if (n) b.textContent += ` ${n}`;
    b.onclick = () => { activeMode = i; buildRules(); };
    tabs.appendChild(b);
  });

  const rs = sets[activeMode];
  const fields = fieldsFor(rs.type);
  $('rules-count').textContent = `${sets.reduce((a, r) => a + overrideCount(r), 0)} set`;

  if (!fields.length) {
    body.innerHTML =
      `<p class="hint">No known settings for mode <b>${escapeHtml(rs.type)}</b>. ` +
      'Its values are kept as they came and exported unchanged.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  const heads = { [INT]: 'Numbers', [BOOL]: 'Toggles', [ENUM]: 'Options', [FLAGS]: 'Sources' };
  let lastKind = null;
  for (const f of fields) {
    if (f.kind !== lastKind) {
      const h = document.createElement('div');
      h.className = 'rule-cat';
      h.textContent = heads[f.kind];
      frag.appendChild(h);
      lastKind = f.kind;
    }
    frag.appendChild(ruleRow(rs, f));
  }

  const extra = unknownKeys(rs);
  if (extra.length) {
    const h = document.createElement('div');
    h.className = 'rule-cat';
    h.textContent = 'Not recognised';
    frag.appendChild(h);
    const p = document.createElement('p');
    p.className = 'hint';
    p.innerHTML =
      `${extra.map((u) => `<code>${escapeHtml(u.key)}</code> = ${escapeHtml(String(u.value))}`).join('<br>')}
       <br><br>Kept from the file and exported unchanged.`;
    frag.appendChild(p);
  }

  const note = document.createElement('p');
  note.className = 'hint';
  note.style.marginTop = '12px';
  note.textContent =
    'Blank means the game decides. Only the settings you change are written to ' +
    'the file, exactly as the game does it.';
  frag.appendChild(note);

  body.appendChild(frag);
}

function ruleRow(rs, f) {
  const row = document.createElement('div');
  row.className = 'rule';
  const has = rs[f.dict][f.key] !== undefined;
  if (has) row.classList.add('set');

  const label = document.createElement('label');
  label.textContent = f.label;
  label.title = f.key;
  row.appendChild(label);

  const cell = document.createElement('div');
  cell.className = 'val';
  const change = (value) => {
    setValue(rs, f.key, f.kind, value);
    touchEdited();
    buildRules();
  };

  if (f.kind === BOOL) {
    // Three states — on, off and untouched — so a checkbox alone will not do.
    const sel = document.createElement('select');
    sel.innerHTML =
      '<option value="">Default</option><option value="true">On</option><option value="false">Off</option>';
    sel.value = has ? String(rs[f.dict][f.key]) : '';
    sel.onchange = () => change(sel.value === '' ? undefined : sel.value === 'true');
    cell.appendChild(sel);
  } else if (f.kind === FLAGS) {
    const chosen = new Set(parseFlags(rs[f.dict][f.key]));
    const wrap = document.createElement('div');
    wrap.className = 'flagset';
    for (const opt of f.options || []) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.has(opt);
      cb.onchange = () => {
        cb.checked ? chosen.add(opt) : chosen.delete(opt);
        change(chosen.size ? joinFlags([...chosen]) : undefined);
      };
      l.append(cb, document.createTextNode(opt));
      wrap.appendChild(l);
    }
    row.style.gridTemplateColumns = '1fr';
    row.appendChild(wrap);
    return row;
  } else if (f.kind === ENUM) {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Default';
    input.value = has ? rs[f.dict][f.key] : '';
    input.setAttribute('list', `dl-${f.key}`);
    const dl = document.createElement('datalist');
    dl.id = `dl-${f.key}`;
    for (const opt of f.options || []) {
      const o = document.createElement('option');
      o.value = opt;
      dl.appendChild(o);
    }
    input.onchange = () => change(input.value.trim() || undefined);
    cell.append(input, dl);
  } else {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.placeholder = 'Default';
    input.value = has ? rs[f.dict][f.key] : '';
    input.onchange = () => {
      const raw = input.value.trim();
      change(raw === '' ? undefined : Math.round(parseFloat(raw) || 0));
    };
    cell.appendChild(input);
    if (f.unit) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = f.unit;
      cell.appendChild(u);
    }
  }

  row.appendChild(cell);
  return row;
}

// ---------------------------------------------------------------------------
// Outliner
// ---------------------------------------------------------------------------

function buildOutliner() {
  const host = $('outliner');
  host.innerHTML = '';
  vp.objects.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'row' + (vp.selection.has(m) ? ' on' : '');
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = m.userData.def.color;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = m.userData.def.label;
    row.append(dot, t);
    if (m.userData.group) {
      const g = document.createElement('span');
      g.className = 'g';
      g.textContent = m.userData.group.toUpperCase();
      row.appendChild(g);
    }
    row.onclick = (e) => {
      const picked = vp.expandGroup(m, e.ctrlKey || e.metaKey);
      if (e.shiftKey) {
        const next = new Set(vp.selection);
        for (const o of picked) next.add(o);
        vp.setSelection([...next]);
      } else vp.setSelection(picked);
    };
    host.appendChild(row);
  });
  $('obj-count').textContent = String(vp.objects.length);
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function wireKeyboard() {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;

    // While something is riding the cursor, the only thing to say is "not there".
    if (vp.placing) {
      if (e.key === 'Escape') { e.preventDefault(); vp.cancelPlacement(); }
      return;
    }

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); vp.selectAll(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportMap(); return; }

    switch (e.key) {
      case 'w': case 'W': vp.setGizmoMode('translate'); break;
      case 'e': case 'E': vp.setGizmoMode('rotate'); break;
      case 'r': case 'R': vp.setGizmoMode('scale'); break;
      case 'f': case 'F': vp.frameSelection(); break;
      case 'g': case 'G': e.shiftKey ? ungroupSelection() : groupSelection(); break;
      case 'End': vp.dropToFloor(); break;
      case 'Delete': case 'Backspace': deleteSelection(); break;
      case 'Escape': vp.setSelection([]); break;
    }
  });
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function wireDragDrop() {
  const stage = $('stage');
  let depth = 0;

  stage.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; stage.classList.add('dropping'); });
  stage.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  stage.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; stage.classList.remove('dropping'); } });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    stage.classList.remove('dropping');
    const key = e.dataTransfer.getData('text/spatial-ops-key');
    const def = key && getByKey(key);
    if (def) {
      placeNew(def, vp.groundPoint(e.clientX, e.clientY));
      return;
    }
    const file = e.dataTransfer.files?.[0];
    if (file) openFile(file);
  });

  // Dropping a map file anywhere else opens it too.
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) openFile(file);
  });
}

// ---------------------------------------------------------------------------
// Viewport events
// ---------------------------------------------------------------------------

function wireViewport() {
  const box = $('marquee');
  vp.addEventListener('marquee-move', (e) => {
    const r = e.detail;
    box.style.display = 'block';
    box.style.left = `${r.x1}px`;
    box.style.top = `${r.y1}px`;
    box.style.width = `${r.x2 - r.x1}px`;
    box.style.height = `${r.y2 - r.y1}px`;
  });
  vp.addEventListener('marquee-end', () => { box.style.display = 'none'; });
  vp.addEventListener('selection', () => { buildSelectionPanel(); buildOutliner(); refreshStatus(); });
  vp.addEventListener('transform', () => { refreshSelectionValues(); refreshStatus(); });
  vp.addEventListener('commit-end', () => commit());
  vp.addEventListener('placement-end', (e) => {
    const { committed, meshes } = e.detail;
    const fresh = placingLabel;   // a library pick-up rather than a paste
    placingLabel = null;
    if (committed) {
      commit();
      toast(fresh
        ? `Placed ${fresh}.`
        : `Pasted ${meshes.length} object${meshes.length === 1 ? '' : 's'}.`);
      return;
    }
    vp.removeObjects(meshes);
    vp.setSelection(placeReturn.filter((m) => vp.objects.includes(m)));
    refreshAll();
    toast(fresh ? 'Placement cancelled.' : 'Paste cancelled.');
  });
  vp.addEventListener('mode', refreshStatus);
  vp.addEventListener('change', () => { buildOutliner(); refreshStatus(); });
}

// ---------------------------------------------------------------------------
// File in / out
// ---------------------------------------------------------------------------

async function openFile(file) {
  try {
    const text = await file.text();
    const parsed = parseMap(text);
    map = parsed;
    vp.clearObjects();
    for (const mo of parsed.mapObjects) vp.addObject(mo);
    applyMapMeta();
    activeMode = 0;
    buildRules();
    await vp.setNavCloud(map.navCloud);
    $('nav-shape').value = 'keep';
    vp.setSelection([]);
    vp.setView('persp');
    undoStack = []; redoStack = []; current = snapshot();
    refreshAll();

    const unknown = new Set(
      vp.objects.filter((m) => m.userData.def.unknown).map((m) => m.userData.def.type)
    );
    let msg = `Loaded "${map.name}" — ${parsed.mapObjects.length} objects.`;
    if (parsed.version !== MAP_VERSION) msg += ` Map format v${parsed.version}, editor targets v${MAP_VERSION}.`;
    if (unknown.size) msg += ` ${unknown.size} type(s) not in any loaded pack: ${[...unknown].join(', ')}.`;
    toast(msg, unknown.size > 0);
    $('st-file').textContent = file.name;
  } catch (err) {
    console.error(err);
    toast(`Could not read that file: ${err.message}`, true);
  }
}

function exportMap() {
  try {
    map.editedTime = nowStamp();
    map.version = map.version || MAP_VERSION;
    map.mapObjects = vp.objects.map((m) => vp.toMapObject(m));
    const text = serializeMap(map);
    const name = mapFileName(map.name, map.guid);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $('st-file').textContent = name;
    toast(`Exported ${name} — ${map.mapObjects.length} objects. Copy it into the game's maps folder with no file extension.`);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

function applyMapMeta() {
  $('bx').value = map.mapBoundsSize.x;
  $('by').value = map.mapBoundsSize.y;
  $('bz').value = map.mapBoundsSize.z;
  vp.setBounds(map.mapBoundsSize);
  refreshMeta();
}

function refreshMeta() {
  $('m-name').value = map.name;
  $('m-author').value = map.author || '';
  $('m-guid').value = map.guid;
  $('fname').textContent = mapFileName(map.name, map.guid);
}

function refreshAll() {
  buildOutliner();
  buildSelectionPanel();
  refreshMeta();
  refreshStatus();
  $('b-undo').disabled = !undoStack.length;
  $('b-redo').disabled = !redoStack.length;
}

function refreshStatus() {
  const n = vp.selection.size;
  $('sel-count').textContent = n ? `${n} selected` : 'none';
  $('st-mode').textContent =
    `${vp.gizmoMode.toUpperCase()} · ${vp.gizmoSpace.toUpperCase()} · ` +
    `grid ${vp.snap.translate ? vp.snap.translate + 'm' : 'off'} · ` +
    `angle ${vp.snap.rotate ? vp.snap.rotate + '°' : 'off'}`;
  $('st-sel').textContent = `${vp.objects.length} objects · ${n} selected`;
  $('b-undo').disabled = !undoStack.length;
  $('b-redo').disabled = !redoStack.length;
  for (const mode of ['translate', 'rotate', 'scale']) {
    $(`m-${mode}`).classList.toggle('on', vp.gizmoMode === mode);
  }

  const b = map ? map.mapBoundsSize : { x: 0, y: 0, z: 0 };
  let extra = '';
  if (n) {
    const s = vp.selectionBounds().getSize(new THREE.Vector3());
    extra = `<br>SEL <b>${s.x.toFixed(2)} × ${s.y.toFixed(2)} × ${s.z.toFixed(2)}</b> m`;
  }
  $('readout').innerHTML =
    `ARENA <b>${b.x} × ${b.y} × ${b.z}</b> m<br>OBJECTS <b>${vp.objects.length}</b>${extra}`;
}

// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (bad ? ' bad' : '');
  $('st-msg').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 5200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
