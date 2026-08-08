// ---------------------------------------------------------------------------
// Spatial Ops map editor — application wiring
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Viewport } from './scene.js';
import {
  parseMap, serializeMap, newMap, newGuid, nowStamp, mapFileName,
  buildNavMask, encodeNavCloud, MAP_VERSION,
} from './format.js';
import { getPacks, registerPack, categoriesOf, defOrUnknown } from './catalog.js';
import { unityEulerToQuat } from './unity.js';
import { geometryFor } from './placeholders.js';

const $ = (id) => document.getElementById(id);
const vp = new Viewport($('view'));

let map = null;             // everything except mapObjects, which live in the viewport
let activePack = 'default';
let undoStack = [], redoStack = [], current = null;
let groupSeq = 1;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  map = await newMap({ name: 'New Map' });
  applyMapMeta();
  await tryLoadDiskPacks();
  buildPackBar();
  buildLibrary();
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

/** Packs sitting next to index.html, when the editor is served over http. */
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
  } catch { /* file:// or no packs folder — the built-in pack is enough */ }
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
      type: rec.type,
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

function buildPackBar() {
  const bar = $('packbar');
  bar.innerHTML = '';
  for (const p of getPacks()) {
    const b = document.createElement('button');
    b.className = 'pill' + (p.id === activePack ? ' on' : '');
    b.textContent = p.name;
    b.onclick = () => { activePack = p.id; buildPackBar(); buildLibrary(); };
    bar.appendChild(b);
  }
}

function buildLibrary() {
  const pack = getPacks().find((p) => p.id === activePack) || getPacks()[0];
  const q = $('q').value.trim().toLowerCase();
  const host = $('lib-list');
  host.innerHTML = '';
  let shown = 0;

  for (const [cat, defs] of categoriesOf(pack)) {
    const matching = defs.filter(
      (d) => !q || d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q)
    );
    if (!matching.length) continue;
    const h = document.createElement('div');
    h.className = 'cat';
    h.textContent = cat;
    host.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'items';
    for (const def of matching) {
      shown++;
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
      el.onclick = () => placeNew(def, vp.orbit.target.clone().setY(0));
      el.ondragstart = (ev) => {
        ev.dataTransfer.setData('text/spatial-ops-type', def.type);
        ev.dataTransfer.effectAllowed = 'copy';
      };
      grid.appendChild(el);
    }
    host.appendChild(grid);
  }
  $('lib-count').textContent = `${shown}`;
  if (!shown) host.innerHTML = '<p class="hint" style="padding:16px 12px">No objects match that filter.</p>';
}

// -- thumbnails -------------------------------------------------------------
// Rendered from the same geometry the viewport uses, so when real models drop
// in the library updates itself.

let thumbRenderer = null, thumbScene = null, thumbCam = null;
const thumbCache = new Map();

function thumbnail(def) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  if (thumbCache.has(def.type)) {
    c.getContext('2d').drawImage(thumbCache.get(def.type), 0, 0);
    return c;
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
    thumbCache.set(def.type, store);
  } catch (e) {
    console.warn('Thumbnail render failed', e);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Placing, duplicating, grouping
// ---------------------------------------------------------------------------

function placeNew(def, worldPoint) {
  const y = def.pivot === 'center' ? def.size[1] / 2 : 0;
  const mesh = vp.addObject({
    type: def.type,
    position: { x: round(worldPoint.x), y, z: round(-worldPoint.z) },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    dirty: true,
  });
  vp.setSelection([mesh]);
  commit();
  toast(`Placed ${def.label}.`);
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
  $('b-import-pack').onclick = () => $('packpick').click();
  $('packpick').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      registerPack(p);
      activePack = p.id;
      thumbCache.clear();
      buildPackBar(); buildLibrary();
      toast(`Loaded pack "${p.name}" with ${p.objects.length} objects.`);
    } catch (err) {
      toast(`That pack did not load: ${err.message}`, true);
    }
  };

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
  refreshSelectionValues();
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
  const read = (inputs) => ({
    x: parseFloat(inputs[0].value) || 0,
    y: parseFloat(inputs[1].value) || 0,
    z: parseFloat(inputs[2].value) || 0,
  });

  if (list.length === 1) {
    const p = read(selFields.p), r = read(selFields.r), s = read(selFields.s);
    // The pivot carries the object's world placement while it is selected.
    vp.pivot.position.set(p.x, p.y, -p.z);
    vp.pivot.quaternion.fromArray(unityEulerToQuat(r));
    list[0].scale.set(s.x || 0.001, s.y || 0.001, s.z || 0.001);
    vp.markDirty(list[0]);
  } else {
    const target = read(selFields.p);
    const c = vp.selectionBounds().getCenter(new THREE.Vector3());
    vp.pivot.position.add(new THREE.Vector3(target.x - c.x, target.y - c.y, -target.z - c.z));
    for (const m of list) vp.markDirty(m);
  }
  if (vp.floorLock) vp._applyFloorLock();
  vp.rebuildPivot();
  commit();
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

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return; }
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
    const type = e.dataTransfer.getData('text/spatial-ops-type');
    if (type) {
      placeNew(defOrUnknown(type), vp.groundPoint(e.clientX, e.clientY));
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
