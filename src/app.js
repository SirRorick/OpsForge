// ---------------------------------------------------------------------------
// Spatial Ops map editor — application wiring
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Viewport } from './scene.js';
import {
  parseMap, serializeMap, newMap, newGuid, nowStamp, mapFileName,
  buildNavMask, encodeNavCloud, MAP_VERSION,
} from './format.js';
import {
  getPacks, getPack, registerPack, categoriesOf, packsInGroup, getByKey, iconUrl,
  equivalentIn,
} from './catalog.js';
import {
  PACK_GROUPS, WEAPONS, WEAPON_ICONS, WEAPON_ANY, parseWeapons, formatWeapons,
  ENEMY_TYPES, ENEMY_ICONS, ENEMY_LABELS, ENEMY_BEHAVIOURS, ENEMY_ANY,
  parseEnemyTypes, formatEnemyTypes,
} from './packs.js';
import {
  MODES, layoutFor, unknownKeys, setValue, parseFlags, joinFlags, overrideCount,
  describeFallback, effectiveValue, optionLabel, splitDuration, joinDuration,
  formatDuration, clampInt, outOfRange, newRuleSet, duplicateRuleSet,
  resetRuleSet, changeBaseMode, missingRequirements, modeByType,
  INT, BOOL, ENUM, FLAGS,
} from './rules.js';
import { geometryFor } from './placeholders.js';
import {
  checkpointsAvailable, checkpointList, checkpointText, saveCheckpoint,
  removeCheckpoint, clearCheckpoints, checkpointBytes, timeAgo,
} from './checkpoints.js';

const $ = (id) => document.getElementById(id);
const vp = new Viewport($('view'));

let map = null;             // everything except mapObjects, which live in the viewport
let activePack = 'default';                 // theme shown inside Virtual Objects
let openGroups = new Set(['virtual']);      // expanded top-level library sections
let activeRuleSet = 0;                         // rule set tab
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
  wireBotGrid();
  wireInspectorTabs();
  wireMirrorTool();
  wireArrayTool();
  wireInspector();
  wireKeyboard();
  wireDragDrop();
  wireViewport();
  wireAutosave();
  await loadNavCloud();
  resize();
  addEventListener('resize', resize);
  current = snapshot();
  refreshAll();
  toast('Ready. Open a map file, or drag objects in from the library.');
  greetWithCheckpoints();
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
        locked: !!m.userData.locked,
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
    mesh.userData.locked = !!rec.locked;
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
  // Everything that changes the map goes through here, which makes it the one
  // place autosave has to watch to know a checkpoint would be worth taking.
  mapTouched = true;
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
  // ...and puts down a bot-grid brush, which would otherwise still own the left
  // button while an object sat waiting to be placed with it.
  if (vp.navPaint) vp.setNavPaint(null);
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

/**
 * The size of the selection along each of the pivot's own axes.
 *
 * This is what the array tool offers as its default spacing, so a row of crates
 * comes out flush and you only touch the number to open a gap. Measured in the
 * pivot's frame rather than the world's: a barrier turned 30 degrees should
 * array along its own face, and its world bounding box is wider than the piece.
 */
function selectionExtent() {
  const list = [...vp.selection];
  if (!list.length) return { x: 1, y: 1, z: 1 };
  const inv = new THREE.Matrix4().copy(vp.pivot.matrixWorld).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const m of list) {
    m.updateWorldMatrix(true, false);
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const b = m.geometry.boundingBox;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      v.applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      box.expandByPoint(v);
    }
  }
  const size = box.getSize(new THREE.Vector3());
  const tidy = (n) => Math.max(0.05, Math.round(n * 1000) / 1000);
  return { x: tidy(size.x), y: tidy(size.y), z: tidy(size.z) };
}

/**
 * Duplicate the selection into a grid of copies — five across and six high
 * builds a wall in one go, and widening the spacing turns the same wall into a
 * row of barricades.
 *
 * The steps are taken along the pivot's axes, not the world's, so a rotated
 * piece arrays along its own length instead of skewing off it. The original
 * counts as the first copy in each direction, so 1 x 1 x 1 does nothing.
 */
function arraySelection({ nx, ny, nz, dx, dy, dz }) {
  if (!vp.selection.size) return toast('Select something to array.');
  const total = nx * ny * nz;
  if (total <= 1) return toast('Set at least one count above 1.');
  if (total > 500) return toast(`That is ${total} copies. Keep it under 500.`);

  const source = [...vp.selection];
  vp.pivot.updateMatrixWorld(true);
  const basis = {
    x: new THREE.Vector3(1, 0, 0).applyQuaternion(vp.pivot.quaternion),
    y: new THREE.Vector3(0, 1, 0),      // up is up, whatever the piece is doing
    z: new THREE.Vector3(0, 0, 1).applyQuaternion(vp.pivot.quaternion),
  };

  const made = [];
  const groups = new Map();
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        if (!ix && !iy && !iz) continue;      // that one is the original
        const step = new THREE.Vector3()
          .addScaledVector(basis.x, ix * dx)
          .addScaledVector(basis.y, iy * dy)
          .addScaledVector(basis.z, iz * dz);
        // Each cell of the array gets its own group id, so the copies can be
        // moved apart later without dragging the whole wall.
        const cell = `${ix},${iy},${iz}`;
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
          copy.position.copy(p).add(step);
          copy.quaternion.copy(q);
          copy.scale.copy(s);
          if (m.userData.group) {
            const key = `${cell}|${m.userData.group}`;
            if (!groups.has(key)) groups.set(key, `g${groupSeq++}`);
            copy.userData.group = groups.get(key);
          }
          made.push(copy);
        }
      }
    }
  }
  vp.setSelection([...source, ...made]);
  commit();
  toast(`Arrayed ${made.length} cop${made.length === 1 ? 'y' : 'ies'} — ${nx} x ${ny} x ${nz}.`);
  tip('array',
    'Each copy is its own group, so you can pull one out of the wall afterwards without dragging '
    + 'the rest with it.');
}

/**
 * Copy the selection to the other side of the map, as a true reflection.
 *
 * `axis` is 'x' or 'z' — the two horizontal ones; mirroring in Y would put the
 * map underground. The plane is the middle of the arena, which is the origin,
 * so a piece two metres to the left comes back two metres to the right.
 *
 * A reflection is three things, not one. The position flips, obviously. The
 * rotation is reflected — under a mirror, a rotation about an axis becomes one
 * about the mirrored axis, which for the quaternion is negating the two
 * components perpendicular to the plane. And the piece itself has to be turned
 * inside out, which no rotation can do: that is a negative scale, always on the
 * object's own axis matching the mirror plane, and it is the difference between
 * a corner barrier that faces the right way and one that actually closes the
 * far corner.
 *
 * The flip is spent only where it buys something. `needsMirrorFlip` asks the
 * geometry whether the piece is already its own reflection; a crate, a cylinder
 * and a plain wall all are, and they export exactly as they always did.
 *
 * `packId` renders the copy in another theme, which is how you get a blue half
 * and an orange half. An entry with no equivalent there keeps its own.
 */
function mirrorSelection(axis, packId = null) {
  if (!vp.selection.size) return toast('Select something to mirror.');
  const turn = axis === 'x' ? [1, -1, -1] : [-1, -1, 1];   // quaternion x,y,z signs
  const made = [];
  const remap = new Map();
  let swapped = 0, kept = 0, flipped = 0;

  for (const m of [...vp.selection]) {
    m.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.matrixWorld.decompose(p, q, s);

    const target = packId ? equivalentIn(m.userData.def, packId) : null;
    const def = target || m.userData.def;
    if (packId) (target ? swapped++ : kept++, undefined);

    const copy = vp.addObject({
      type: def.type,
      $type: target ? (def.objectType || 'MapObject') : m.userData.objectType,
      // Props belong to the subtype, so they only carry over within it.
      props: target && target.type !== m.userData.def.type
        ? { ...(def.props || {}) } : { ...m.userData.props },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    copy.position.set(axis === 'x' ? -p.x : p.x, p.y, axis === 'z' ? -p.z : p.z);
    copy.quaternion.set(q.x * turn[0], q.y * turn[1], q.z * turn[2], q.w);
    copy.scale.copy(s);
    // Chirality is the source piece's, so it is asked of the source: the copy's
    // model may still be loading, and a themed swap is the same shape anyway.
    if (vp.needsMirrorFlip(m, axis)) {
      copy.scale[axis] = -copy.scale[axis];
      flipped++;
    }
    if (m.userData.group) {
      if (!remap.has(m.userData.group)) remap.set(m.userData.group, `g${groupSeq++}`);
      copy.userData.group = remap.get(m.userData.group);
    }
    made.push(copy);
  }

  vp.setSelection(made);
  commit();
  const where = packId ? ` as ${getPack(packId)?.name ?? packId}` : '';
  const missing = kept ? `, ${kept} with no equivalent kept as they were` : '';
  const turned = flipped ? `, ${flipped} turned inside out to face the other way` : '';
  toast(`Mirrored ${made.length} object${made.length === 1 ? '' : 's'} across ${axis.toUpperCase()}${where}${missing}${turned}.`);
  tip('mirror',
    'The copies are a reflection, not just a move: a piece with a left and a right comes out the '
    + 'other way round. Build one half of the arena, then mirror it.');
}

/**
 * Drop the selection onto whatever is under it. The viewport does the work;
 * this is here to say what happened, because a drop that finds nothing to land
 * on looks identical to a drop that did not run.
 */
function dropOntoSurface() {
  if (!vp.selection.size) return toast('Select something to drop.');
  const moved = vp.dropSelection('surface');
  toast(moved
    ? `Dropped ${moved} object${moved === 1 ? '' : 's'} onto what was underneath.`
    : 'Already resting on something — nothing to drop.');
  tip('drop',
    'Drop lands a piece on the top of whatever is beneath it, so a crate goes on a crate. '
    + 'To floor ignores all that and puts it on the ground.');
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
  const startNewMap = async () => {
    map = await newMap({ name: 'New Map', author: map?.author || '' });
    vp.clearObjects();
    applyMapMeta();
    await loadNavCloud();
    activeRuleSet = 0;
    buildRules();
    undoStack = []; redoStack = []; current = snapshot();
    refreshAll();
    toast('New map started. It has no bot grid and no rule sets yet — both are yours to add.');
  };
  $('b-new').onclick = () => {
    if (!vp.objects.length) return void startNewMap();
    // A checkpoint first, so "start again" is recoverable even though undo
    // deliberately does not reach across a new map.
    confirmDialog({
      title: 'Start a new map',
      body: `This clears the ${vp.objects.length} object${vp.objects.length === 1 ? '' : 's'} on `
        + 'screen and everything set against them. A checkpoint of the current map is taken first, '
        + 'so you can get back to it from the Map tab.',
      confirmLabel: 'New map',
      run: () => { takeCheckpoint('manual', true); startNewMap(); },
    });
  };
  $('b-open').onclick = () => $('filepick').click();
  $('filepick').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('b-save').onclick = exportMap;

  const syncSnap = () => {
    vp.setSnap('translate', $('snap-t').checked ? parseFloat($('snap-t-v').value) : 0);
    vp.setSnap('rotate', $('snap-r').checked ? parseFloat($('snap-r-v').value) : 0);
  };
  ['snap-t', 'snap-t-v', 'snap-r', 'snap-r-v'].forEach((id) => ($(id).onchange = syncSnap));
  $('uniform').onchange = (e) => vp.setUniformScale(e.target.checked);

  // Nothing about the map changes here, so no commit and no edited stamp — it
  // is a way of looking at the scene, not a way of changing it.
  $('placeholders').onchange = (e) => {
    vp.setUsePlaceholders(e.target.checked);
    toast(e.target.checked
      ? 'Showing the built-in stand-in shapes.'
      : 'Showing the game\'s own models where they are on disk.');
  };

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
        x: clampBound($('bx').value, 1, 60),
        y: clampBound($('by').value, 1, 20),
        z: clampBound($('bz').value, 1, 60),
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
  refreshNavCount();
  toast('Bot grid filled.');
}

/**
 * The inspector's tabs. Build is first and default because it holds the things
 * touched constantly — the selection's numbers and the object list — with the
 * mirror and array tools between them, next to what they act on.
 *
 * Leaving World puts any bot-grid brush down. The brush is modal in the worst
 * way — it takes the left button away from selection everywhere in the viewport
 * — and its only controls are on that tab, so walking away from them while it
 * is still up leaves no visible sign of why clicking an object stopped working.
 */
function wireInspectorTabs() {
  const tabs = [...document.querySelectorAll('.itab')];
  const show = (name) => {
    if (name !== 'world' && vp.navPaint) {
      vp.setNavPaint(null);
      toast('Brush put down.');
    }
    for (const t of tabs) t.classList.toggle('on', t.dataset.pane === name);
    for (const t of tabs) $(`pane-${t.dataset.pane}`).hidden = t.dataset.pane !== name;
    if (name === 'rules') {
      tip('rules',
        'A mode can be added once the map holds what it needs to play it — the picker lists the '
        + 'rest greyed out, saying what is missing.');
    }
    if (name === 'world') {
      tip('world',
        'The bot grid is the ground the bots may walk on. A new map starts with none: paint what '
        + 'you want them to reach.');
    }
  };
  for (const t of tabs) t.onclick = () => show(t.dataset.pane);
  show('build');
}

/**
 * The mirror tool. It lives in the Build tab beside Array because the two are
 * the same kind of thing — one selection in, a lot of objects out — and both
 * want the object list they act on within reach.
 */
function wireMirrorTool() {
  const packSelect = $('mirror-pack');
  for (const p of packsInGroup('virtual')) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    packSelect.appendChild(o);
  }
  $('b-mirror').onclick = () => mirrorSelection($('mirror-axis').value, packSelect.value || null);
}

/**
 * The array tool. Counts and spacings are read at the moment you press Array,
 * so changing the selection first and the numbers after works either way round.
 */
function wireArrayTool() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  $('b-array').onclick = () => arraySelection({
    nx: Math.max(1, Math.round(num('arr-nx', 1))),
    ny: Math.max(1, Math.round(num('arr-ny', 1))),
    nz: Math.max(1, Math.round(num('arr-nz', 1))),
    dx: num('arr-dx', 1), dy: num('arr-dy', 1), dz: num('arr-dz', 1),
  });
}

/**
 * Reset the spacings to the selection's own size whenever the selection
 * changes, so the common case — copies sitting flush — needs no arithmetic.
 * Counts are left alone: repeating the same 5 x 1 wall with a different piece
 * is a normal thing to want.
 */
function refreshArrayDefaults() {
  const n = vp.selection.size;
  $('arr-count').textContent = n ? `${n} selected` : '';
  $('b-array').disabled = !n;
  if (!n) return;
  const e = selectionExtent();
  $('arr-dx').value = e.x;
  $('arr-dy').value = e.y;
  $('arr-dz').value = e.z;
}

/**
 * The brushes. Picking one up takes the left button away from selection until
 * it is put down again, which is why they toggle rather than fire.
 *
 * The buttons are painted from `vp.navPaint` rather than from whichever click
 * last happened, because the viewport puts the brush down by itself — leaving
 * the World tab, or picking an object out of the library, both drop it. A brush
 * still lit while the left button had gone back to selecting was the worst of
 * both: clicks that neither painted nor selected.
 */
function wireBotGrid() {
  const buttons = { add: $('nav-add'), remove: $('nav-remove') };
  const showBrush = () => {
    for (const [id, b] of Object.entries(buttons)) b.classList.toggle('on', vp.navPaint === id);
  };
  const paint = (mode) => {
    const next = vp.navPaint === mode ? null : mode;
    vp.setNavPaint(next, parseFloat($('nav-brush').value) || 0.5);
    toast(next
      ? `${next === 'add' ? 'Adding to' : 'Removing from'} the bot grid. Click the button again to stop.`
      : 'Brush put down.');
    if (next) {
      tip('brush',
        'While a brush is up the left button paints the floor instead of selecting. It puts itself '
        + 'down when you leave this tab or reach for the library.');
    }
  };
  buttons.add.onclick = () => paint('add');
  buttons.remove.onclick = () => paint('remove');
  $('nav-brush').onchange = () => vp.setNavPaint(vp.navPaint, parseFloat($('nav-brush').value) || 0.5);
  vp.addEventListener('mode', showBrush);

  $('nav-clear').onclick = async () => {
    vp.clearNavMask();
    await commitNavMask();
    toast('Bot grid cleared.');
  };

  // One undo step per stroke rather than per cell, so a long drag is one edit.
  vp.addEventListener('nav-painted', () => { commitNavMask(); });
}

/**
 * Hand the map's bot grid to the viewport, so there is something to paint on.
 *
 * Called for every map that arrives, new ones included. It used not to be: a
 * new map's grid only reached the viewport if you changed the Fill setting,
 * which is why the brushes did nothing on a fresh map until you set Fill to
 * Circle and back to Keep. There was no mask to paint into.
 */
async function loadNavCloud() {
  await vp.setNavCloud(map.navCloud);
  $('nav-shape').value = 'keep';
  $('nav-r-row').style.display = '';
  $('nav-w-row').style.display = 'none';
  $('nav-d-row').style.display = 'none';
  refreshNavCount();
}

/** Re-encode the painted mask back into the map. */
async function commitNavMask() {
  if (!vp.navMask || !map?.navCloud) return;
  map.navCloud.encodedPoints = await encodeNavCloud(vp.navMask);
  touchEdited();
  refreshNavCount();
}

function refreshNavCount() {
  const mask = vp.navMask;
  if (!mask) return void ($('nav-count').textContent = '');
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  const area = n * 0.25 * 0.25;
  $('nav-count').textContent = n ? `${area.toFixed(1)} m²` : 'empty';
}

function clampBound(v, lo, hi) {
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
      <button class="btn ghost" id="s-dup" title="Copy in place (Ctrl+D)">Duplicate</button>
      <button class="btn ghost" id="s-drop"
        title="Let it fall until it rests on whatever is underneath — the top of another object, or the ground (Shift+End)">Drop</button>
      <button class="btn ghost" id="s-floor"
        title="Put it on the ground, whatever is in the way (End)">To floor</button>
      <button class="btn ghost" id="s-group" title="Move these together from now on (G)">Group</button>
      <button class="btn ghost" id="s-ungroup" title="Break the group up (Shift+G)">Ungroup</button>
      <span></span>
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
  $('s-drop').onclick = dropOntoSurface;
  $('s-floor').onclick = () => vp.dropSelection('floor');
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
/**
 * A set of toggles for a prop that holds several values at once. Shared by the
 * weapon spawners and the enemy spawners, which have the same shape: one
 * object, a set of things it may produce, and the game choosing among them.
 */
function chipSetRow(label, id, all, chosen, icons, labels) {
  // Union, so a value from a future game update still shows and stays ticked.
  const every = [...new Set([...all, ...chosen])];
  const chips = every.map((v) => {
    const on = chosen.includes(v);
    const icon = icons?.[v] ? iconUrl({ icon: icons[v] }) : null;
    const art = icon ? `<img src="${escapeHtml(icon)}" alt="" loading="lazy">` : '';
    // The file's spelling on the tooltip, a readable one on the chip.
    return `<label class="wchip${on ? ' on' : ''}" title="${escapeHtml(v)}">
      <input type="checkbox" data-value="${escapeHtml(v)}"${on ? ' checked' : ''}>
      ${art}<span>${escapeHtml(labels?.[v] ?? v)}</span></label>`;
  }).join('');
  return `<div class="field wfield"><span>${escapeHtml(label)}</span>
    <div class="wgrid" id="${id}">${chips}</div>
    <div class="whint" id="${id}-hint"></div></div>`;
}

function weaponRow(value) {
  return chipSetRow('Weapons', 'f-weapons', WEAPONS, parseWeapons(value), WEAPON_ICONS, null);
}

function enemyTypesRow(value) {
  return chipSetRow('Enemies', 'f-enemies', ENEMY_TYPES, parseEnemyTypes(value),
    ENEMY_ICONS, ENEMY_LABELS);
}

/** Behaviour is one of a known few, so a select rather than a free text box. */
function behaviourRow(value) {
  const all = [...new Set([...ENEMY_BEHAVIOURS, value].filter(Boolean))];
  const opts = all.map((b) =>
    `<option value="${escapeHtml(b)}"${b === value ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('');
  return `<div class="field"><span>Behaviour</span>
    <select id="f-behaviour">${opts}</select></div>`;
}

function propRows(mesh) {
  const props = mesh.userData.props || {};
  const keys = Object.keys(props);
  if (!keys.length) return '';
  return keys
    .map((key, i) => {
      if (key === 'specificWeapon') return weaponRow(props[key]);
      if (key === 'enemyTypes') return enemyTypesRow(props[key]);
      if (key === 'behaviour') return behaviourRow(props[key]);
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

/**
 * Wire one set-of-toggles row. `noun` names the thing for the hints, `any` is
 * the game's shorthand for "no restriction", and `format` turns the ticked set
 * back into the value written to the file.
 */
function wireChipSet(mesh, { id, prop, noun, plural, any, format, labels }) {
  const host = $(id);
  if (!host) return;
  const hint = $(`${id}-hint`);
  const boxes = [...host.querySelectorAll('input[type=checkbox]')];

  const describe = (list, written) => {
    if (written === any) return `Any ${noun} — the game writes "${any}".`;
    if (list.length === 1) return `Always spawns a ${labels?.[list[0]] ?? list[0]}.`;
    // The written value is one unbreakable token, so offer the line breaker a
    // zero-width space after each separator: it wraps at the commas rather than
    // through the middle of a name. Display only — the value stored on the
    // object is untouched.
    const wrappable = written.replaceAll(',', ',​');
    return `${list.length} ${plural} — the game picks one at random. Written "${wrappable}".`;
  };

  const refresh = () => {
    const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.value);
    for (const b of boxes) b.closest('.wchip').classList.toggle('on', b.checked);
    hint.textContent = describe(chosen, format(chosen));
  };

  for (const box of boxes) {
    box.onchange = () => {
      const chosen = boxes.filter((b) => b.checked).map((b) => b.dataset.value);
      // One is the minimum, so the last one simply will not come off rather
      // than silently turning the spawner back into "any".
      if (!chosen.length) {
        box.checked = true;
        hint.textContent = `A spawner needs at least one ${noun}.`;
        return;
      }
      refresh();
      vp.setProp(mesh, prop, format(chosen));
      commit();
    };
  }
  refresh();
}

function wireSpawnerRows(mesh) {
  wireChipSet(mesh, {
    id: 'f-weapons', prop: 'specificWeapon', noun: 'weapon', plural: 'weapons',
    any: WEAPON_ANY, format: formatWeapons,
  });
  wireChipSet(mesh, {
    id: 'f-enemies', prop: 'enemyTypes', noun: 'enemy', plural: 'enemies',
    any: ENEMY_ANY, format: formatEnemyTypes, labels: ENEMY_LABELS,
  });
  const behaviour = $('f-behaviour');
  if (behaviour) {
    behaviour.onchange = () => {
      vp.setProp(mesh, 'behaviour', behaviour.value);
      commit();
      toast(`Behaviour set to ${behaviour.value}.`);
    };
  }
}

function wirePropRows(mesh) {
  wireSpawnerRows(mesh);
  const keys = Object.keys(mesh.userData.props || {});
  keys.forEach((key, i) => {
    if (['specificWeapon', 'enemyTypes', 'behaviour'].includes(key)) return;
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
    vp.placeSelection(p, r);
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
  vp.rebuildPivot();
  commit();
}


// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------
// A map holds a list of rule sets, each with a free-text name and a base mode.
// The mode decides which settings render; the name is just a name. Two sets may
// share a mode and differ only by what they are called — "Domination Fast" and
// "Domination Long" is the game's own example — so the list is addressed by
// position, never by type, and its order is part of the file.
//
// A field left blank writes nothing, which is how the game says "use the
// default" — see rules.js. Every control therefore shows the value that will
// actually apply, greyed when it is the game choosing it rather than this map,
// and touched settings get a dot next to the label so it is obvious at a glance
// what the map overrides.

let armedDelete = -1;    // rule set index whose delete button is waiting to be confirmed

function ruleSets() {
  return map?.ruleSets || [];
}

/** Object types actually placed, for the mode-availability check. */
function placedTypes() {
  return new Set(vp.objects.map((m) => m.userData.def.type));
}

function rulesEdited() {
  touchEdited();
  buildRules();
}

/**
 * Redraw the rules panel when — and only when — the set of object types on the
 * map changes, because that is what decides which modes can be added and what
 * the warning at the top of an existing set says. Guarded by a signature rather
 * than rebuilt on every object move: the panel holds live inputs, and throwing
 * them away underneath somebody mid-edit loses focus and the caret with it.
 */
let placedSignature = null;

function refreshModeAvailability() {
  const now = [...placedTypes()].sort().join('|');
  if (now === placedSignature) return;
  placedSignature = now;
  buildRules();
}

function buildRules() {
  const tabs = $('mode-tabs');
  const body = $('rules-body');
  tabs.innerHTML = '';
  body.innerHTML = '';
  const sets = ruleSets();
  $('rules-count').textContent = sets.length
    ? `${sets.reduce((a, r) => a + overrideCount(r), 0)} set`
    : '';

  sets.forEach((rs, i) => {
    const n = overrideCount(rs);
    const b = document.createElement('button');
    b.className = 'pill' + (i === activeRuleSet ? ' on' : '');
    b.textContent = rs.name || rs.type;
    // The count goes in its own element rather than on the end of the name.
    // Names may end in a number — duplicating Domination gives "Domination 2" —
    // and "Domination 2" meaning two overrides would read as the same thing.
    if (n) {
      const c = document.createElement('span');
      c.className = 'n';
      c.textContent = String(n);
      b.appendChild(c);
    }
    b.title = `${rs.name || '(unnamed)'} [${rs.type}] — ` +
      (n ? `${n} setting${n === 1 ? '' : 's'} changed from the game default` : 'all defaults');
    b.onclick = () => { activeRuleSet = i; armedDelete = -1; buildRules(); };
    tabs.appendChild(b);
  });
  tabs.appendChild(addRuleSetPicker());

  if (!sets.length) {
    body.innerHTML =
      '<p class="hint">No rule sets yet, which is where a new map starts: a mode ' +
      'is worth adding once the map can play it, and not before. Add above — the ' +
      'list offers whatever the objectives on the map allow, and says what the ' +
      'rest are waiting for.</p>';
    return;
  }
  if (activeRuleSet >= sets.length) activeRuleSet = sets.length - 1;

  const rs = sets[activeRuleSet];
  const frag = document.createDocumentFragment();
  frag.appendChild(ruleSetHeader(rs));

  const missing = missingRequirements(rs.type, placedTypes());
  if (missing.length) {
    const w = document.createElement('p');
    w.className = 'rs-warn';
    w.textContent =
      `The game only offers ${modeByType(rs.type)?.name || rs.type} once the map has ` +
      `its objectives. Still to place: ${missing.join(', ')}. The rule set is kept ` +
      'and exported either way.';
    frag.appendChild(w);
  }

  const layout = layoutFor(rs);
  if (!layout.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.innerHTML =
      `No known settings for mode <b>${escapeHtml(rs.type)}</b>. ` +
      'Its values are kept as they came and exported unchanged.';
    frag.appendChild(p);
  }

  let derived = 0;
  for (const section of layout) {
    const h = document.createElement('div');
    h.className = 'rule-cat' + (section.active ? '' : ' off');
    h.textContent = section.name;
    if (!section.active) {
      const tag = document.createElement('em');
      tag.textContent = section.id === 'spawners'
        ? 'weapon source excludes spawners'
        : 'weapon source excludes holsters';
      h.appendChild(tag);
    }
    frag.appendChild(h);
    for (const f of section.fields) {
      if (!f.active && !f.set) continue;   // hidden by a parent, and holding nothing
      if (!f.confirmed) derived++;
      frag.appendChild(ruleRow(rs, f));
    }
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
    "Greyed values are the game's own — this map leaves them alone and writes " +
    'nothing for them. Change one and it gets a dot; × puts it back. ' +
    (derived
      ? `${derived} of these settings have never appeared in an exported map: their ` +
        "names come from the game's own rule assets and are marked with a dotted " +
        'underline.'
      : '');
  frag.appendChild(note);

  body.appendChild(frag);
}

/**
 * Adding a set means picking its mode, and the mode it is given becomes its
 * name — so "Free For All" from this list produces a set called Free For All
 * running Free For All.
 *
 * A mode whose objectives are not on the map cannot be picked. The game will
 * not offer that mode either, so a rule set for it is a page of settings for a
 * match nobody can start — and offering it invited exactly that. The entry
 * stays in the list rather than disappearing, greyed, saying on hover what the
 * map is missing, because "Capture The Flag needs a team 1 flag" is a useful
 * thing to be told and an absent line is not.
 *
 * A set already in the file is never touched by any of this: maps get edited in
 * whatever order suits, and deleting somebody's rules because they moved a flag
 * would be much worse than leaving a warning at the top of the panel.
 */
function addRuleSetPicker() {
  const sel = document.createElement('select');
  sel.className = 'pill add';
  sel.title = 'Add a rule set';
  const head = document.createElement('option');
  head.textContent = '+ Add';
  head.value = '';
  sel.appendChild(head);
  const present = placedTypes();
  for (const m of MODES) {
    const o = document.createElement('option');
    o.value = m.type;
    const missing = missingRequirements(m.type, present);
    o.textContent = missing.length ? `${m.name} — needs ${missing.join(', ')}` : m.name;
    o.disabled = missing.length > 0;
    o.title = missing.length
      ? `Place ${missing.join(', ')} and this mode becomes available.`
      : `${m.name} can be played on this map.`;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    if (!sel.value) return;
    if (!map.ruleSets) map.ruleSets = [];
    map.ruleSets.push(newRuleSet(sel.value, map.ruleSets));
    activeRuleSet = map.ruleSets.length - 1;
    armedDelete = -1;
    rulesEdited();
  };
  return sel;
}

/**
 * Name, base mode, and the five list operations the in-game screen has.
 *
 * Changing the base mode reshapes the set: settings both modes share keep their
 * values, settings only the old mode had go. That is destructive and undo does
 * not cover the rules, which is also why delete arms on the first click and
 * fires on the second rather than going straight through.
 */
function ruleSetHeader(rs) {
  const box = document.createElement('div');
  box.className = 'rs-head';

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'rs-name';
  name.value = rs.name || '';
  name.placeholder = 'Rule set name';
  name.title = 'Shown in the game\'s rule set list. Names need not be unique.';
  name.onchange = () => { rs.name = name.value; rulesEdited(); };
  box.appendChild(name);

  const mode = document.createElement('select');
  mode.className = 'rs-mode';
  mode.title = 'Base mode — decides which settings this set has';
  const types = MODES.map((m) => [m.type, m.name]);
  if (!modeByType(rs.type)) types.push([rs.type, `${rs.type} (unknown)`]);
  for (const [value, label] of types) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    o.selected = value === rs.type;
    mode.appendChild(o);
  }
  // The name is left alone on purpose. The game treats the two as independent —
  // a set called "Co-op Survival" running Free For All is legal and shows the
  // Free For All rules — so renaming behind the user's back would be a guess.
  mode.onchange = () => {
    changeBaseMode(rs, mode.value);
    armedDelete = -1;
    rulesEdited();
  };
  box.appendChild(mode);

  const acts = document.createElement('div');
  acts.className = 'rs-acts';
  const sets = ruleSets();
  const i = activeRuleSet;

  const move = (to) => {
    const [item] = sets.splice(i, 1);
    sets.splice(to, 0, item);
    activeRuleSet = to;
    armedDelete = -1;
    rulesEdited();
  };
  acts.appendChild(actButton('↑', 'Move up', i === 0, () => move(i - 1)));
  acts.appendChild(actButton('↓', 'Move down', i === sets.length - 1, () => move(i + 1)));
  acts.appendChild(actButton('⧉', 'Duplicate', false, () => {
    sets.splice(i + 1, 0, duplicateRuleSet(rs, sets));
    activeRuleSet = i + 1;
    armedDelete = -1;
    rulesEdited();
  }));
  acts.appendChild(actButton('↺', 'Reset every setting to the game default',
    overrideCount(rs) === 0, () => { resetRuleSet(rs); armedDelete = -1; rulesEdited(); }));

  const armed = armedDelete === i;
  const del = actButton(armed ? 'Delete?' : '✕',
    armed ? 'Click again to delete this rule set' : 'Delete this rule set', false, () => {
      if (!armed) { armedDelete = i; buildRules(); return; }
      sets.splice(i, 1);
      activeRuleSet = Math.max(0, i - 1);
      armedDelete = -1;
      rulesEdited();
      toast('Rule set deleted. Undo does not cover the rules panel.');
    });
  del.classList.add('danger');
  if (armed) del.classList.add('armed');
  acts.appendChild(del);

  box.appendChild(acts);
  return box;
}

function actButton(text, title, disabled, onclick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rs-act';
  b.textContent = text;
  b.title = title;
  b.disabled = !!disabled;
  b.onclick = onclick;
  return b;
}

/**
 * One setting.
 *
 * Every control shows the value that will actually apply, whether or not this
 * map is the one choosing it: a setting nobody has touched draws its game
 * default greyed out rather than the word "Default", so the panel reads as what
 * the match will play like. Touched rows get the accent dot and a "clear"
 * button that takes the setting back out of the file entirely — which is not
 * the same as setting it to the default, and is why the button exists.
 *
 * Two states are marked rather than hidden. A row whose parent has turned it
 * off but which still holds a value is dimmed and labelled, because the value
 * is in the file and exported and there would otherwise be nothing that could
 * clear it. And a number outside the in-game stepper's range is flagged rather
 * than clamped — the reference export itself carries one, and rewriting a value
 * the game wrote would be worse than pointing at it.
 */
function ruleRow(rs, f) {
  const row = document.createElement('div');
  row.className = 'rule';
  const has = f.set;
  const value = has ? rs[f.dict][f.key] : undefined;
  row.classList.add(has ? 'set' : 'default');
  if (!f.active) row.classList.add('off');
  const bad = has && outOfRange(f, value);
  if (bad) row.classList.add('bad');

  const label = document.createElement('label');
  label.textContent = f.label;
  if (!f.confirmed) label.classList.add('derived');
  const bits = [f.key];
  const shown = describeFallback(f);
  if (shown) bits.push(`game default ${shown}`);
  if (f.kind === INT && !f.duration) bits.push(`range ${f.min}–${f.max}`);
  if (!f.confirmed) {
    bits.push("key name taken from the game's rule assets — no export has ever contained it");
  }
  if (!f.active) bits.push('not in effect with the current settings, but still written to the file');
  if (bad) bits.push(`outside the in-game range of ${f.min}–${f.max}`);
  label.title = bits.join('\n');
  row.appendChild(label);

  const change = (v) => { setValue(rs, f.key, f.kind, v); rulesEdited(); };

  // Takes the key back out of the file, which is not the same as zeroing it.
  // Always built, so the column does not jump as rows are set and cleared; it
  // is simply invisible on a row that has nothing to clear.
  const clear = document.createElement('button');
  clear.className = 'clear';
  clear.type = 'button';
  clear.textContent = '×';
  clear.title = shown
    ? `Back to the game default (${shown}), and out of the file`
    : 'Back to the game default, and out of the file';
  clear.disabled = !has;
  clear.onclick = () => change(undefined);

  const cell = document.createElement('div');
  cell.className = 'val';

  if (f.kind === BOOL) {
    // On, off, and untouched. A plain checkbox cannot say "untouched", but it
    // can show what untouched *means* — the default, greyed — which is more use
    // than a third dropdown entry reading "Default". Clicking it commits an
    // explicit value; the × beside it is how you get back to untouched.
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = effectiveValue(rs, f.key) === true;
    cb.onchange = () => change(cb.checked);
    cell.appendChild(cb);
  } else if (f.kind === ENUM) {
    // The default is an entry of its own rather than only a greyed value, so
    // that a setting whose default is "Off" can still be set to Off on purpose.
    // Those are different files, even though they are the same match.
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = shown ? `Default — ${optionLabel(f.fallback)}` : 'Default';
    sel.appendChild(none);
    const opts = [...new Set([...(f.options || []), ...(has ? [value] : [])])];
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = o;
      el.textContent = optionLabel(o);
      sel.appendChild(el);
    }
    sel.value = has ? value : '';
    sel.onchange = () => change(sel.value || undefined);
    cell.appendChild(sel);
  } else if (f.kind === FLAGS) {
    row.appendChild(flagsControl(rs, f, clear));
    row.classList.add('wide');
    return row;
  } else if (f.duration) {
    // Two steppers, one integer. The seconds field stops at 59 and does not
    // roll over, and the ten-second floor is on the total rather than on
    // either field, so both are read together on every edit.
    const base = splitDuration(effectiveValue(rs, f.key));
    const cur = splitDuration(value ?? 0);
    const part = (unit, max, placeholder, now) => {
      const i = document.createElement('input');
      i.type = 'number';
      i.step = '1';
      i.min = '0';
      i.max = String(max);
      i.placeholder = String(placeholder);
      i.value = has ? String(now) : '';
      i.title = unit;
      return i;
    };
    const m = part('minutes', 10000, base.minutes, cur.minutes);
    const s = part('seconds', 59, base.seconds, cur.seconds);
    const push = () => {
      const mv = m.value.trim() === '' ? base.minutes : Number(m.value);
      const sv = s.value.trim() === '' ? base.seconds : Number(s.value);
      change(joinDuration(mv, sv));
    };
    m.onchange = push;
    s.onchange = push;
    cell.classList.add('dur');
    cell.append(m, tag('m'), s, tag('s'));
  } else {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    if (f.min !== undefined) input.min = String(f.min);
    if (f.max !== undefined) input.max = String(f.max);
    // The default sits in the placeholder rather than the value, so the field
    // still reads as empty: typing the same number back would write it to the
    // file, and an untouched setting must stay out of the file.
    input.placeholder = f.fallback === undefined ? 'unknown' : String(f.fallback);
    input.value = has ? String(value) : '';
    input.onchange = () => {
      const raw = input.value.trim();
      if (raw === '') return change(undefined);
      const n = clampInt(f, raw);
      if (n === undefined) return change(undefined);
      change(n);
    };
    cell.appendChild(input);
    if (f.unit) cell.appendChild(tag(f.unit));
  }

  row.appendChild(cell);
  row.appendChild(clear);
  return row;
}

function tag(text) {
  const u = document.createElement('span');
  u.className = 'u';
  u.textContent = text;
  return u;
}

/**
 * A multi-select, drawn as the set it is rather than as a dropdown.
 *
 * The game's control collapses to the word ALL when everything is ticked, which
 * is a display convention only: the one flags value any export contains was
 * written out in full as `Spawners;Holsters`, so this writes members and shows
 * an ALL tag instead. Weapon-valued fields borrow the icon chips the weapon
 * spawner inspector uses, which is what keeps nine weapons inside the panel.
 *
 * Weapon Source is the one field that cannot be emptied — it decides whether
 * the last two sections exist at all — so its final tick refuses to come off.
 */
function flagsControl(rs, f, clear) {
  const wrap = document.createElement('div');
  wrap.className = 'flagset';
  const chosen = new Set(parseFlags(effectiveValue(rs, f.key), f.options));
  const weapons = (f.options || []).every((o) => WEAPON_ICONS[o]);

  const push = (next) => {
    setValue(rs, f.key, f.kind, joinFlags([...next], f));
    rulesEdited();
  };

  const bar = document.createElement('div');
  bar.className = 'flagbar';
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'flagpick' + (chosen.size === (f.options || []).length ? ' on' : '');
  all.textContent = 'All';
  all.onclick = () => push(new Set(f.options));
  bar.appendChild(all);
  if (!f.required) {
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'flagpick' + (chosen.size === 0 ? ' on' : '');
    none.textContent = 'None';
    none.title = 'Written as "None". Each holster is independent — this one only.';
    none.onclick = () => push(new Set());
    bar.appendChild(none);
  }
  bar.appendChild(clear);
  wrap.appendChild(bar);

  // Union, so a member from a future game update still shows and stays ticked.
  const every = [...new Set([...(f.options || []), ...chosen])];
  const grid = document.createElement('div');
  grid.className = weapons ? 'wgrid' : 'flagrow';
  for (const opt of every) {
    const l = document.createElement('label');
    l.className = weapons ? 'wchip' : 'flagopt';
    if (chosen.has(opt)) l.classList.add('on');
    l.title = opt;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = chosen.has(opt);
    cb.onchange = () => {
      const next = new Set(chosen);
      cb.checked ? next.add(opt) : next.delete(opt);
      if (f.required && !next.size) {
        cb.checked = true;
        return toast('At least one weapon source has to stay on.');
      }
      push(next);
    };
    l.appendChild(cb);
    if (weapons) {
      const img = document.createElement('img');
      img.src = iconUrl({ icon: WEAPON_ICONS[opt] });
      img.alt = '';
      img.loading = 'lazy';
      l.appendChild(img);
    }
    const t = document.createElement('span');
    t.textContent = optionLabel(opt);
    l.appendChild(t);
    grid.appendChild(l);
  }
  wrap.appendChild(grid);
  return wrap;
}

// ---------------------------------------------------------------------------
// Outliner
// ---------------------------------------------------------------------------

/**
 * The object list. A group is one row that stands for all of its members and
 * can be opened to show them, because a group of thirty crates was thirty rows
 * of "Crate" and told you nothing. Selecting the group row selects the group,
 * which is what copy, mirror and delete then act on.
 */
const openGroupRows = new Set();

function buildOutliner() {
  const host = $('outliner');
  host.innerHTML = '';

  // Walk the objects in order and emit either a lone object or, at the first
  // member of a group, the whole group. Order follows the scene, so a group
  // sits where its first member is.
  const groups = new Map();
  for (const m of vp.objects) {
    const g = m.userData.group;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  const emitted = new Set();

  for (const m of vp.objects) {
    const g = m.userData.group;
    if (!g) { host.appendChild(objectRow(m, false)); continue; }
    if (emitted.has(g)) continue;
    emitted.add(g);
    const members = groups.get(g);
    host.appendChild(groupRow(g, members));
    if (openGroupRows.has(g)) for (const child of members) host.appendChild(objectRow(child, true));
  }
  $('obj-count').textContent = String(vp.objects.length);
}

function selectFrom(list, e) {
  if (e.shiftKey) {
    const next = new Set(vp.selection);
    for (const o of list) next.add(o);
    vp.setSelection([...next]);
  } else vp.setSelection(list);
}

function groupRow(id, members) {
  const row = document.createElement('div');
  const allSelected = members.every((m) => vp.selection.has(m));
  const locked = members.every((m) => m.userData.locked);
  row.className = 'row grouprow' + (allSelected ? ' on' : '') + (locked ? ' locked' : '');

  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = openGroupRows.has(id) ? '▾' : '▸';
  tw.onclick = (e) => {
    e.stopPropagation();
    openGroupRows.has(id) ? openGroupRows.delete(id) : openGroupRows.add(id);
    buildOutliner();
  };

  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = members[0].userData.def.color;

  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `Group ${id.replace(/^g/, '')}`;

  const n = document.createElement('span');
  n.className = 'g';
  n.textContent = String(members.length);

  row.append(tw, dot, t, n, lockToggle(members, locked));
  row.onclick = (e) => selectFrom(members, e);
  row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, members); };
  return row;
}

function objectRow(m, child) {
  const row = document.createElement('div');
  row.className = 'row' + (vp.selection.has(m) ? ' on' : '') +
    (child ? ' child' : '') + (m.userData.locked ? ' locked' : '');
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = m.userData.def.color;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = m.userData.def.label;
  row.append(dot, t, lockToggle([m], !!m.userData.locked));
  row.onclick = (e) => selectFrom(vp.expandGroup(m, e.ctrlKey || e.metaKey), e);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, vp.expandGroup(m, e.ctrlKey || e.metaKey));
  };
  return row;
}

/**
 * Right-click menu for whatever was clicked, in the viewport or the list.
 *
 * It is where locking lives, and it has to be, because a locked object cannot
 * enter the selection — so every command that reads the selection is closed to
 * it. This menu reads what was clicked instead.
 */
let contextMenuEl = null;

function showContextMenu(x, y, meshes) {
  hideContextMenu();
  if (!meshes.length) return;
  const locked = meshes.every((m) => m.userData.locked);
  const mixed = !locked && meshes.some((m) => m.userData.locked);
  const many = meshes.length > 1;

  const el = document.createElement('div');
  el.className = 'ctxmenu';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const item = (label, hint, fn, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = disabled;
    b.innerHTML = `<span>${escapeHtml(label)}</span>` + (hint ? `<kbd>${escapeHtml(hint)}</kbd>` : '');
    b.onclick = () => { hideContextMenu(); fn(); };
    el.appendChild(b);
    return b;
  };

  const head = document.createElement('div');
  head.className = 'ctxhead';
  head.textContent = many
    ? `${meshes.length} objects${meshes[0].userData.group ? ' · group' : ''}`
    : meshes[0].userData.def.label;
  el.appendChild(head);

  if (locked || mixed) {
    item(mixed ? 'Unlock all' : 'Unlock', '', () => {
      vp.setLocked(meshes, false);
      vp.setSelection(meshes);
      touchEdited();
      refreshAll();
      toast(`Unlocked ${meshes.length} object${many ? 's' : ''}.`);
    });
  }
  if (!locked) {
    item('Lock', '', () => {
      vp.setLocked(meshes, true);
      touchEdited();
      refreshAll();
      toast(`Locked ${meshes.length} object${many ? 's' : ''}. Right-click it to unlock.`);
    });
  }

  const sep = document.createElement('div');
  sep.className = 'ctxsep';
  el.appendChild(sep);

  item('Select', '', () => vp.setSelection(meshes), locked);
  item('Replace…', '', () => openReplace(meshes), locked);
  item('Duplicate', 'Ctrl D', () => { vp.setSelection(meshes); duplicate(); }, locked);
  item('Copy', 'Ctrl C', () => { vp.setSelection(meshes); copySelection(); }, locked);
  item('Delete', 'Del', () => { vp.setSelection(meshes); deleteSelection(); }, locked);

  document.body.appendChild(el);
  // Keep it on screen when the click was near an edge.
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth) el.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) el.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  contextMenuEl = el;
}

function hideContextMenu() {
  contextMenuEl?.remove();
  contextMenuEl = null;
}

// -- replace ----------------------------------------------------------------
// Swapping one kind of object for another where it already stands. Rebuilding a
// wall out of a different theme's pieces is otherwise: read six numbers off the
// old one, delete it, place the new one, type the six numbers back — per piece.
//
// The panel floats rather than sitting behind the usual veil, because the
// gesture it is waiting for starts in the library, and a modal backdrop would
// swallow it. Nothing else is blocked while it is up; it goes on Escape, on
// Cancel, or on a successful drop.

let replaceEl = null;

function openReplace(meshes) {
  closeReplace();
  const targets = meshes.filter((m) => !m.userData.locked);
  if (!targets.length) return;
  const many = targets.length > 1;

  const el = document.createElement('div');
  el.id = 'replace';

  const h = document.createElement('h3');
  h.textContent = 'Replace';
  const p = document.createElement('p');
  p.textContent = many
    ? `Drag an object out of the library onto the panel below. It takes the place of all `
      + `${targets.length} selected objects, each keeping its own position, rotation and scale.`
    : `Drag an object out of the library onto the panel below. It takes the place of `
      + `${targets[0].userData.def.label}, keeping its position, rotation and scale.`;

  const zone = document.createElement('div');
  zone.className = 'dropzone';
  zone.textContent = 'Drag asset here';
  // Every one of these stops propagating: the panel sits over the viewport, and
  // the stage's own drop handler would otherwise *also* fire and place a second
  // object where the pointer happened to be.
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add('over');
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (e) => { e.stopPropagation(); zone.classList.remove('over'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove('over');
    const key = e.dataTransfer.getData('text/spatial-ops-key');
    const def = key && getByKey(key);
    if (!def) return toast('Drag an object from the library, not a file.', true);
    closeReplace();
    replaceWith(def, targets);
  });

  const acts = document.createElement('div');
  acts.className = 'acts';
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = 'Cancel';
  cancel.onclick = closeReplace;
  acts.appendChild(cancel);

  el.append(h, p, zone, acts);
  document.body.appendChild(el);
  replaceEl = el;
}

function closeReplace() {
  replaceEl?.remove();
  replaceEl = null;
}

/**
 * Put `def` where each of `targets` stands, and take the old ones away.
 *
 * Position, rotation and scale are copied across exactly as they are, which is
 * what was asked for and is worth being clear about: scale is a multiplier, not
 * a size, so a piece whose mesh is a different shape comes out a different size
 * at the same numbers. And a `center`-pivot object standing where a `base`-pivot
 * one did sits half in the floor until it is dropped. Both are visible the
 * moment it lands, and both are one undo away.
 *
 * Group membership carries over — replacing one piece of a group leaves it in
 * that group — and the new objects come out selected, so the swap can be nudged
 * straight away.
 */
function replaceWith(def, targets) {
  const live = targets.filter((m) => vp.objects.includes(m));
  if (!live.length) return toast('Those objects are no longer on the map.', true);

  const made = [];
  for (const m of live) {
    m.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.matrixWorld.decompose(p, q, s);
    const next = vp.addObject({
      $type: def.objectType,
      type: def.type,
      props: def.props ? { ...def.props } : undefined,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    next.position.copy(p);
    next.quaternion.copy(q);
    next.scale.copy(s);
    next.userData.group = m.userData.group;
    made.push(next);
  }
  vp.removeObjects(live);
  vp.setSelection(made);
  commit();
  toast(`Replaced ${live.length} object${live.length === 1 ? '' : 's'} with ${def.label}.`);
}

/** The padlock beside a row — and the only way back for a locked object. */
function lockToggle(meshes, locked) {
  const b = document.createElement('button');
  b.className = 'lockbtn' + (locked ? ' on' : '');
  b.type = 'button';
  b.textContent = locked ? '🔒' : '🔓';
  b.title = locked ? 'Locked — click to unlock' : 'Lock against editing';
  b.onclick = (e) => {
    e.stopPropagation();
    vp.setLocked(meshes, !locked);
    touchEdited();
    refreshAll();
  };
  return b;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function wireKeyboard() {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;

    // The replace panel is waiting for a drag, so Escape belongs to it before
    // it belongs to the selection — otherwise dismissing the panel would clear
    // the very objects it was about to swap.
    if (replaceEl && e.key === 'Escape') { e.preventDefault(); closeReplace(); return; }

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
      case 'f': case 'F': vp.frameSelection(); break;
      case 'g': case 'G': e.shiftKey ? ungroupSelection() : groupSelection(); break;
      case 'End': e.shiftKey ? dropOntoSurface() : vp.dropSelection('floor'); break;
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

  // The right button does two jobs: held and dragged it pans the camera, and
  // clicked it opens the menu below. Telling them apart is not something the
  // `contextmenu` event can do on its own — Windows fires it on the *release*,
  // so a pan that ends over a crate arrives looking exactly like a click on
  // that crate. So the press is remembered and the menu opens only if the
  // pointer stayed put, which also covers a pan that began on an object.
  //
  // Four pixels of slop, the same tolerance the marquee uses: a click with a
  // steady hand still moves a pixel or two between press and release.
  const PAN_SLOP = 4;
  let rightPress = null;
  $('view').addEventListener('pointerdown', (e) => {
    if (e.button === 2) rightPress = { x: e.clientX, y: e.clientY, panned: false };
  });
  // On the window: OrbitControls captures the pointer, and a pan drags well
  // outside the viewport in any case.
  addEventListener('pointermove', (e) => {
    if (rightPress && Math.hypot(e.clientX - rightPress.x, e.clientY - rightPress.y) > PAN_SLOP) {
      rightPress.panned = true;
    }
  });

  // Right-click reaches an object whether or not it is locked, which is what
  // makes locking reversible: nothing else can touch one.
  $('view').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Cleared here rather than on release: platforms differ over whether the
    // event comes with the press or the release, and either way the next press
    // starts a fresh one.
    const panned = rightPress?.panned;
    rightPress = null;
    if (panned) return hideContextMenu();
    const r = $('view').getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - r.left) / r.width) * 2 - 1,
      y: -((e.clientY - r.top) / r.height) * 2 + 1,
    };
    const hit = vp.pickAt(ndc);
    if (!hit) return hideContextMenu();
    // A click inside the current selection acts on all of it; outside, on the
    // thing clicked and its group.
    const meshes = vp.selection.has(hit) && vp.selection.size > 1
      ? [...vp.selection]
      : vp.expandGroup(hit, e.ctrlKey || e.metaKey);
    showContextMenu(e.clientX, e.clientY, meshes);
  });
  addEventListener('pointerdown', (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target)) hideContextMenu();
  }, true);
  addEventListener('blur', hideContextMenu);

  vp.addEventListener('marquee-move', (e) => {
    const r = e.detail;
    box.style.display = 'block';
    box.style.left = `${r.x1}px`;
    box.style.top = `${r.y1}px`;
    box.style.width = `${r.x2 - r.x1}px`;
    box.style.height = `${r.y2 - r.y1}px`;
  });
  vp.addEventListener('marquee-end', () => { box.style.display = 'none'; });
  vp.addEventListener('selection', () => { buildSelectionPanel(); buildOutliner(); refreshArrayDefaults(); refreshStatus(); });
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
      tip('gizmo',
        'One gizmo does everything: arrows move, the three coloured circles turn about X, Y and Z, '
        + 'the cubes scale from the far side, and the disc in the middle slides it across the view.');
      return;
    }
    vp.removeObjects(meshes);
    vp.setSelection(placeReturn.filter((m) => vp.objects.includes(m)));
    refreshAll();
    toast(fresh ? 'Placement cancelled.' : 'Paste cancelled.');
  });
  vp.addEventListener('mode', refreshStatus);
  vp.addEventListener('change', () => {
    buildOutliner();
    refreshModeAvailability();
    refreshStatus();
  });
}

// ---------------------------------------------------------------------------
// File in / out
// ---------------------------------------------------------------------------

async function openFile(file) {
  try {
    await loadMapText(await file.text(), file.name);
  } catch (err) {
    console.error(err);
    toast(`Could not read that file: ${err.message}`, true);
  }
}

/**
 * Replace everything on screen with a map read from `text`.
 *
 * Shared by the file picker, drag and drop, and restoring a checkpoint — all
 * three are the same act, and a checkpoint that took a different path through
 * this would be a checkpoint that restored subtly differently from the file it
 * was a copy of.
 */
async function loadMapText(text, sourceName) {
  const parsed = parseMap(text);
  map = parsed;
  vp.clearObjects();
  for (const mo of parsed.mapObjects) vp.addObject(mo);
  applyMapMeta();
  activeRuleSet = 0;
  buildRules();
  await loadNavCloud();
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
  $('st-file').textContent = sourceName;
}

/** The map as the game would read it. Used by both Export and autosave. */
function currentMapText() {
  map.editedTime = nowStamp();
  map.version = map.version || MAP_VERSION;
  map.mapObjects = vp.objects.map((m) => vp.toMapObject(m));
  return serializeMap(map);
}

/** A map still wearing the name it was born with has not been named. */
const UNNAMED = (name) => !name || !name.trim() || /^new map$/i.test(name.trim());

/**
 * Export, after a word about the two fields the game puts on screen beside the
 * map and nothing else in the editor forces you to fill in.
 *
 * The prompt is a reminder rather than a gate — "Export anyway" is right there,
 * because someone testing a throwaway map twenty times an hour should not have
 * to name it, and the Tips switch turns the reminder off for good. But the
 * default is to ask: a maps folder full of "New Map" is not recoverable after
 * the fact, since the name is most of how you tell one from another.
 */
function exportMap() {
  if (tipsOn() && (UNNAMED(map.name) || !map.author.trim())) {
    promptForMapDetails();
    return;
  }
  writeMapFile();
}

function writeMapFile() {
  try {
    const text = currentMapText();
    const name = mapFileName(map.name, map.guid);
    // Not application/json: `download` names the file without an extension,
    // and browsers append one inferred from the MIME type when it is missing.
    // A JSON type gets ".json" bolted on and the game will not read the file.
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    $('st-file').textContent = name;
    // An export is the best moment there is to take a checkpoint: it is the one
    // point where the author has said this state is worth keeping.
    takeCheckpoint('export');
    toast(`Exported ${name} — ${map.mapObjects.length} objects. Copy it into the game's maps folder with no file extension.`);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, true);
  }
}

function promptForMapDetails() {
  const missing = UNNAMED(map.name) && !map.author.trim() ? 'a name and an author'
    : UNNAMED(map.name) ? 'a name' : 'an author';
  openDialog({
    title: 'Before you export',
    body: `This map still needs ${missing}. Both are shown in the game's map list, and the name ` +
      'becomes the file name — a folder of maps all called "New Map" is hard to sort out later. ' +
      'Fill them in here, or export as it is.',
    fields: [
      { id: 'dlg-name', label: 'Name', value: UNNAMED(map.name) ? '' : map.name, placeholder: 'Map name' },
      { id: 'dlg-author', label: 'Author', value: map.author, placeholder: 'Your name' },
    ],
    actions: [
      { label: 'Export anyway', ghost: true, run: () => writeMapFile() },
      {
        label: 'Save and export',
        run: (values) => {
          if (values['dlg-name'].trim()) map.name = values['dlg-name'].trim();
          map.author = values['dlg-author'].trim();
          touchEdited();
          refreshMeta();
          writeMapFile();
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
// A handful of moments deserve more than a toast that fades in five seconds:
// the export reminder, and confirming something destructive. `confirm()` would
// do the job in three characters, but it freezes the page — including the
// render loop — and cannot say more than one line, so this builds its own.

let dialogClose = null;

function openDialog({ title, body, fields = [], actions }) {
  closeDialog();
  const veil = $('veil');
  const box = document.createElement('div');
  box.className = 'dlg';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const h = document.createElement('h3');
  h.textContent = title;
  box.appendChild(h);
  const p = document.createElement('p');
  p.textContent = body;
  box.appendChild(p);

  const inputs = {};
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'field';
    const label = document.createElement('span');
    label.textContent = f.label;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = f.id;
    input.value = f.value || '';
    input.placeholder = f.placeholder || '';
    inputs[f.id] = input;
    row.append(label, input);
    box.appendChild(row);
  }

  const acts = document.createElement('div');
  acts.className = 'acts';
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn' + (a.ghost ? ' ghost' : '');
    b.textContent = a.label;
    b.onclick = () => { const v = values(); closeDialog(); a.run(v); };
    acts.appendChild(b);
  }
  box.appendChild(acts);

  veil.innerHTML = '';
  veil.appendChild(box);
  veil.classList.add('show');

  // Escape cancels, which is always the last action listed — the harmless one.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    if (e.key === 'Enter' && fields.length) {
      e.preventDefault();
      const v = values();
      const primary = actions[actions.length - 1];
      closeDialog();
      primary.run(v);
    }
  };
  addEventListener('keydown', onKey, true);
  dialogClose = () => {
    removeEventListener('keydown', onKey, true);
    veil.classList.remove('show');
    veil.innerHTML = '';
    dialogClose = null;
  };
  (fields.length ? inputs[fields[0].id] : acts.lastChild)?.focus();
}

function closeDialog() {
  dialogClose?.();
}

/** Ask before something that cannot be undone. */
function confirmDialog({ title, body, confirmLabel, run }) {
  openDialog({
    title,
    body,
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      { label: confirmLabel, run },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------
// First-time hints. Every one of them is something the editor cannot make
// obvious by looking at it — where a mode came from, why the left button
// stopped selecting — and every one of them is worth saying exactly once.
// The switch in the toolbar turns the lot off, including the export reminder.

const TIPS_KEY = 'spatialops.tips';
const SEEN_KEY = 'spatialops.tips.seen';
let tipsSeen = new Set();

const tipsOn = () => $('tips')?.checked !== false;

function loadTipState() {
  try {
    const on = localStorage.getItem(TIPS_KEY);
    if (on !== null) $('tips').checked = on === '1';
    tipsSeen = new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch { /* no storage: tips stay on and repeat, which is harmless */ }
}

/** Say `message` the first time `id` comes up, and never again. */
function tip(id, message) {
  if (!tipsOn() || tipsSeen.has(id)) return;
  tipsSeen.add(id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...tipsSeen])); } catch { /* fine */ }
  toast(message);
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------
// The editor holds the only copy of an unexported map, and a browser tab is a
// fragile place to keep one. So the map is snapshotted into this browser's
// storage every couple of minutes of actual editing, on export, and on the way
// out of the page — and the Map tab lists what is there to be restored.
//
// See checkpoints.js for where they live and why it is not the build folder.

const AUTOSAVE_KEY = 'spatialops.autosave';
const AUTOSAVE_EVERY = 120_000;   // ms of wall clock between timed checkpoints
let mapTouched = false;

const autosaveOn = () => $('autosave')?.checked !== false;

function wireAutosave() {
  loadTipState();
  try {
    const on = localStorage.getItem(AUTOSAVE_KEY);
    if (on !== null) $('autosave').checked = on === '1';
  } catch { /* no storage */ }

  if (!checkpointsAvailable()) {
    // Private windows and file:// pages have nowhere to put these. Say so once
    // rather than offering a switch that silently does nothing.
    $('autosave').checked = false;
    $('autosave').disabled = true;
    $('autosave-sw').title =
      'This browser will not give the page any storage — private window, or opened from disk. ' +
      'Serve the editor over http:// to get autosave.';
  }

  $('autosave').onchange = () => {
    try { localStorage.setItem(AUTOSAVE_KEY, autosaveOn() ? '1' : '0'); } catch { /* fine */ }
    toast(autosaveOn()
      ? 'Autosave on. Checkpoints are kept in this browser and listed under Map.'
      : 'Autosave off. Nothing is kept but what you export.');
    refreshCheckpoints();
  };
  $('tips').onchange = () => {
    try { localStorage.setItem(TIPS_KEY, tipsOn() ? '1' : '0'); } catch { /* fine */ }
    toast(tipsOn() ? 'Hints on.' : 'Hints off, including the reminder before exporting.');
  };

  $('cp-save').onclick = () => {
    const entry = takeCheckpoint('manual', true);
    toast(entry ? 'Checkpoint taken.' : 'Nothing has changed since the last checkpoint.');
  };
  $('cp-clear').onclick = () => {
    if (!checkpointList().length) return toast('There are no checkpoints to clear.');
    confirmDialog({
      title: 'Clear every checkpoint',
      body: 'This deletes all of the autosaved snapshots held in this browser. Anything you have '
        + 'exported is a file on disk and is not affected.',
      confirmLabel: 'Clear them',
      run: () => { clearCheckpoints(); refreshCheckpoints(); toast('Checkpoints cleared.'); },
    });
  };

  setInterval(() => { if (mapTouched) takeCheckpoint('auto'); }, AUTOSAVE_EVERY);
  // `pagehide` fires where `beforeunload` is unreliable — a closed tab, a
  // navigation, the phone being locked — and localStorage is synchronous, so
  // the write finishes even as the page goes away.
  addEventListener('pagehide', () => { if (mapTouched) takeCheckpoint('exit'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && mapTouched) takeCheckpoint('exit');
  });
}

/**
 * Write a checkpoint if there is anything to write. `force` is for the button,
 * which should work whether or not the switch is on.
 */
function takeCheckpoint(reason, force = false) {
  if (!map || (!force && !autosaveOn())) return null;
  try {
    const entry = saveCheckpoint({
      text: currentMapText(),
      name: map.name,
      author: map.author,
      guid: map.guid,
      objects: vp.objects.length,
      reason,
    });
    mapTouched = false;
    if (entry) refreshCheckpoints();
    return entry;
  } catch (err) {
    console.warn('Checkpoint failed', err);
    return null;
  }
}

function refreshCheckpoints() {
  const host = $('cp-list');
  if (!host) return;
  const entries = checkpointList();
  $('cp-count').textContent = entries.length ? `${entries.length}` : '';
  host.innerHTML = '';

  if (!checkpointsAvailable()) {
    $('cp-note').textContent =
      'This browser gives the page no storage, so nothing can be kept here. Serve the editor '
      + 'over http:// rather than opening the file from disk.';
    return;
  }
  if (!entries.length) {
    $('cp-note').textContent = autosaveOn()
      ? 'Nothing kept yet. With Autosave on, a snapshot is taken every couple of minutes of '
        + 'editing, when you export, and when you leave the page.'
      : 'Autosave is off. Turn it on above the view, or take one by hand.';
    return;
  }

  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'cprow';

    const meta = document.createElement('div');
    meta.className = 'cpm';
    const n = document.createElement('div');
    n.className = 'cpn';
    n.textContent = e.name;
    const w = document.createElement('div');
    w.className = 'cpw';
    w.textContent = `${timeAgo(e.at)} · ${e.objects} object${e.objects === 1 ? '' : 's'}`
      + (e.reason === 'export' ? ' · exported' : e.reason === 'manual' ? ' · by hand' : '');
    meta.append(n, w);
    meta.title = `${e.name}${e.author ? ` by ${e.author}` : ''}\n${new Date(e.at).toLocaleString()}`
      + `\n${e.objects} objects, ${(e.bytes / 1024).toFixed(1)} kB`;

    const restore = document.createElement('button');
    restore.className = 'btn ghost';
    restore.textContent = 'Restore';
    restore.title = 'Load this snapshot, replacing what is on screen';
    restore.onclick = () => restoreCheckpoint(e);

    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.type = 'button';
    kill.textContent = '×';
    kill.title = 'Delete this checkpoint';
    kill.onclick = () => { removeCheckpoint(e.id); refreshCheckpoints(); };

    row.append(meta, restore, kill);
    host.appendChild(row);
  }

  const kb = checkpointBytes() / 1024;
  $('cp-note').textContent =
    `${entries.length} kept in this browser, ${kb.toFixed(0)} kB. The newest ${entries.length === 1
      ? 'one is' : 'few are'} kept and the oldest drop off. These live with the address the editor `
    + 'is served from, not in the map folder — Export is still what makes a file the game can read.';
}

function restoreCheckpoint(entry) {
  const text = checkpointText(entry.id);
  if (!text) { refreshCheckpoints(); return toast('That checkpoint is no longer stored.', true); }
  const go = async () => {
    try {
      await loadMapText(text, `${entry.name} (checkpoint)`);
      refreshCheckpoints();
    } catch (err) {
      console.error(err);
      toast(`That checkpoint would not load: ${err.message}`, true);
    }
  };
  if (!vp.objects.length) return void go();
  confirmDialog({
    title: 'Restore this checkpoint',
    body: `"${entry.name}" from ${timeAgo(entry.at)}, ${entry.objects} objects. What is on screen `
      + 'now will be replaced, and undo does not reach back past it. A checkpoint of where you are '
      + 'is taken first.',
    confirmLabel: 'Restore',
    run: () => { takeCheckpoint('manual', true); go(); },
  });
}

/** On the way in, mention what is waiting rather than leaving it to be found. */
function greetWithCheckpoints() {
  const entries = checkpointList();
  if (!entries.length) return;
  refreshCheckpoints();
  tip('checkpoints',
    `${entries.length} autosaved checkpoint${entries.length === 1 ? '' : 's'} from a previous `
    + `session — the newest is "${entries[0].name}", ${timeAgo(entries[0].at)}. Map tab, Checkpoints.`);
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
  refreshModeAvailability();
  refreshMeta();
  refreshStatus();
  $('b-undo').disabled = !undoStack.length;
  $('b-redo').disabled = !redoStack.length;
}

function refreshStatus() {
  const n = vp.selection.size;
  $('sel-count').textContent = n ? `${n} selected` : 'none';
  $('st-mode').textContent =
    `${vp.uniformScale ? 'uniform' : 'per-axis'} · ` +
    `grid ${vp.snap.translate ? vp.snap.translate + 'm' : 'off'} · ` +
    `angle ${vp.snap.rotate ? vp.snap.rotate + '°' : 'off'}` +
    (vp.navPaint ? ` · brush ${vp.navPaint}` : '');
  $('st-sel').textContent = `${vp.objects.length} objects · ${n} selected`;
  $('b-undo').disabled = !undoStack.length;
  $('b-redo').disabled = !redoStack.length;

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
