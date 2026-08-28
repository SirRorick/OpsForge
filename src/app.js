// ---------------------------------------------------------------------------
// Spatial Ops map editor — application wiring
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Viewport, PLAYABLE_SIZE, brandImage } from './scene.js';
import {
  parseMap, serializeMap, newMap, newGuid, nowStamp, mapFileName,
  buildNavMask, encodeNavCloud, decodeNavCloud, MAP_VERSION,
} from './format.js';
import {
  getPacks, categoriesOf, packsInGroup, getByKey, iconUrl,
  equivalentIn, teamVariants, teamVariant,
} from './catalog.js';
import {
  PACK_GROUPS, WEAPONS, WEAPON_ICONS, WEAPON_ANY, parseWeapons, formatWeapons,
  ENEMY_TYPES, ENEMY_ICONS, ENEMY_LABELS, ENEMY_BEHAVIOURS, ENEMY_ANY,
  parseEnemyTypes, formatEnemyTypes, BOUNDARY_PACK,
} from './packs.js';
import {
  MODES, layoutFor, unknownKeys, setValue, parseFlags, joinFlags, overrideCount,
  describeFallback, effectiveValue, optionLabel, splitDuration, joinDuration,
  formatDuration, clampInt, outOfRange, newRuleSet, duplicateRuleSet,
  resetRuleSet, changeBaseMode, missingRequirements, modeByType, modeTagsFor, MODE_TAGS,
  objectWeapon,
  INT, BOOL, ENUM, FLAGS,
} from './rules.js';
import {
  newProject, newLayer, projectVariants, venueMapName, duplicateName,
  writeProjectArchive, readProjectArchive, projectFileName, identifyObjects, nextObjectId,
  objectsOutsidePlaySpace, paintedCells, isBoundaryObject, PROJECT_EXT,
} from './project.js';
import { geometryFor } from './placeholders.js';
import {
  checkpointsAvailable, checkpointList, checkpointText, checkpointEditorState,
  saveCheckpoint, removeCheckpoint, clearCheckpoints, checkpointBytes, timeAgo,
} from './checkpoints.js';
import { zipWrite } from './zip.js';
import {
  modioSearch, modioFetchMapText, modioValidateToken, modioMyMods,
  modioAddMod, modioEditMod, modioAddModfile, modioAddTags, modioDeleteTags,
  modioToken, modioSaveToken,
  modioForgetToken, modioMineMap, modioRecordMine, modioCachedUsername,
  modioRequestEmailCode, modioExchangeEmailCode,
} from './modio.js';

const $ = (id) => document.getElementById(id);
const vp = new Viewport($('view'));

let map = null;             // everything except mapObjects, which live in the viewport
let project = null;         // `map` and its venue layers. No layers unless LBE mode put them there
let activeLayer = null;     // index into project.layers, or null for the design itself
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
  project = newProject(map);
  applyMapMeta();
  buildLibrary();
  buildRules();
  wireToolbar();
  wireBotGrid();
  wireInspectorTabs();
  wireMirrorTool();
  wireArrayTool();
  wireBrand();
  wirePrefabTool();
  wirePreviews();
  wirePreviewButton();
  wireInspector();
  wireKeyboard();
  wireDragDrop();
  wireViewport();
  wireAutosave();
  wireLayerPicker();
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
  placePreviewButton();
}

// ---------------------------------------------------------------------------
// Preview walkaround
// ---------------------------------------------------------------------------

/**
 * Put the Preview button in the middle of the top bar, or beside Mouse/Trackpad
 * when the middle is taken.
 *
 * The middle of the *bar*, which is the middle of the window — not the middle
 * of whatever the controls happen to leave over, which drifts every time a
 * label changes. So it is positioned absolutely and measured against its
 * neighbours: the controls to its left end somewhere, Undo and Redo begin
 * somewhere, and a centred button either clears both or it does not. When it
 * does not it goes back into the flow, where it lands next to Mouse/Trackpad.
 *
 * Measured with the button in the flow, always, because that is the only state
 * in which its own width is known — an absolutely positioned element has been
 * taken out of the row it would otherwise stretch.
 */
function placePreviewButton() {
  const btn = $('b-preview');
  const bar = $('topbar');
  if (!btn || !bar) return;
  btn.classList.remove('centred');
  const barBox = bar.getBoundingClientRect();
  const own = btn.getBoundingClientRect().width;
  const left = btn.previousElementSibling?.getBoundingClientRect().right ?? barBox.left;
  const right = btn.nextElementSibling?.getBoundingClientRect().left ?? barBox.right;
  // Its neighbours do not move when it leaves the flow: what is left of it
  // stays put, and Undo/Redo is pinned to the right-hand end by `margin-left:
  // auto` whatever else is in the row.
  const middle = (barBox.left + barBox.right) / 2;
  const GAP = 14;
  if (middle - own / 2 > left + GAP && middle + own / 2 < right - GAP) btn.classList.add('centred');
}

function wirePreviewButton() {
  $('b-preview').onclick = () => vp.togglePreview();
  vp.addEventListener('preview', (e) => {
    const on = e.detail.on;
    $('b-preview').classList.toggle('on', on);
    $('b-preview').textContent = on ? 'Previewing' : 'Preview';
    $('preview-hud').hidden = !on;
    $('stage').classList.toggle('previewing', on);
    // The button changes width with its label, so where it belongs may have
    // changed with it.
    placePreviewButton();
    refreshStatus();
    if (on) {
      tip('preview',
        'You are standing in the map at six feet. The arrow keys walk, the mouse looks, C crouches to '
        + 'three feet, and Escape puts you back where you were in the editor.');
    }
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    objects: vp.objects.map((m) => {
      // In the design's own frame rather than the world's. A snapshot taken
      // with a venue layer open has to record the map, not the placement of
      // the map in hall 3 -- otherwise an undo in one hall would rewrite the
      // design into that hall's coordinates for every other hall too.
      const { p, q, s } = vp.designPose(m);
      return {
        // Identity, not order: a project names the objects a venue layer has
        // stopped inheriting, and an undo must not renumber them underneath it.
        id: m.userData.id,
        // Which venue it is one of, or null for the map. Both are on screen
        // together, and an undo has to put each back where it came from.
        layer: m.userData.layer,
        type: m.userData.def.type,
        $type: m.userData.objectType,
        props: { ...m.userData.props },
        p: p.toArray(), q: q.toArray(), s: s.toArray(),
        dirty: m.userData.dirty, raw: m.userData.raw, group: m.userData.group,
        locked: !!m.userData.locked, hidden: !!m.userData.hidden,
      };
    }),
    selection: vp.objects.map((m) => vp.selection.has(m)),
    bounds: { ...map.mapBoundsSize },
    // What the venue on screen has stopped inheriting. Not derivable from the
    // objects -- a fork and the design object it came from are two objects with
    // two ids -- so undoing a detachment needs it written down.
    detached: currentLayer() ? [...currentLayer().detached] : [],
    // Where the design is standing. An alignment is an edit like any other and
    // undo should reach it -- and without this an undo would put the objects
    // back and leave the frame under them wherever the last drag left it.
    placement: vp.designTransform(),
  };
}

function restore(snap) {
  vp.clearObjects();
  // Before the objects go back, so each is asked whether to draw itself against
  // the right answer. Written back to the layer as well as to the viewport:
  // the layer is what an export reads.
  const layer = currentLayer();
  if (layer) layer.detached = [...(snap.detached || [])];
  vp.setDetachedHere(snap.detached || []);
  const picked = [];
  snap.objects.forEach((rec, i) => {
    const mesh = vp.addObject({
      type: rec.type, $type: rec.$type, props: rec.props,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      raw: rec.raw, dirty: rec.dirty, hidden: rec.hidden,
      id: rec.id, layer: rec.layer ?? null,
    });
    mesh.position.fromArray(rec.p);
    mesh.quaternion.fromArray(rec.q);
    mesh.scale.fromArray(rec.s);
    mesh.userData.group = rec.group;
    mesh.userData.locked = !!rec.locked;
    if (snap.selection[i]) picked.push(mesh);
  });
  map.mapBoundsSize = { ...snap.bounds };
  if (snap.placement) vp.setDesignTransform(snap.placement.offset, snap.placement.yaw);
  vp.setBounds(map.mapBoundsSize);
  vp.setSelection(picked);
  // Quietly, before `refreshAll` would do it loudly: putting a state back is
  // not putting a foot over a line.
  vp.refreshOutside(vp.objects, true);
  refreshAll();
}

function commit() {
  // A run of nudges is waiting to be recorded as one edit; whatever is being
  // committed now closes it, and this *is* that record.
  clearTimeout(nudgeCommit);
  nudgeCommit = null;
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
  // The game's own library icon, when the game assets are present. It is
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
  // Asking for a boundary while boundaries are hidden is asking to see one.
  if (def.pack === BOUNDARY_PACK) showBoundaries();
  // The scale a piece is placed at comes from the catalog, not from 1,1,1: a
  // solid cylinder is 0.5 x 2 x 0.5 in every map the game wrote, and a tunnel
  // is 1 x 2 x 1.
  const local = vp.toDesignPoint(worldPoint);
  const [sx, sy, sz] = def.defaultScale;
  const y = def.pivot === 'center' ? (def.size[1] * sy) / 2 : 0;
  // Square to the grid, unless the mesh itself is not: Graffiti's Big Crate is
  // modelled down Z where the rest of its family runs along X, so it is placed
  // the quarter turn over that makes it lie like the others. See `shapeYaw` in
  // packs.js.
  return vp.addObject({
    $type: def.objectType,
    type: def.type,
    props: def.props ? { ...def.props } : undefined,
    position: { x: round(local.x), y, z: round(-local.z) },
    rotation: { x: 0, y: def.shapeYaw, z: 0 },
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
  const made = [];
  const groups = new Map();
  for (const { cell, step } of vp.arraySteps({ nx, ny, nz, dx, dy, dz })) {
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
  // The array has been made, so the ghosts of it have nothing left to say.
  arrayJustApplied = true;
  vp.setSelection([...source, ...made]);
  // ...and the settings that made it are spent. Selecting the result refreshes
  // the spacings to the block's own size; the counts are put back here. Without
  // it the boxes still read 5 x 1 x 1 over a selection that is now the whole
  // wall, so a second press — to array the wall itself, which is the obvious
  // next move — silently makes five walls instead of the one that was meant.
  resetArrayCounts();
  commit();
  toast(`Arrayed ${made.length} cop${made.length === 1 ? 'y' : 'ies'} — ${nx} x ${ny} x ${nz}.`);
  tip('array',
    'Each copy is its own group, so you can pull one out of the wall afterwards without dragging '
    + 'the rest with it.');
}

/**
 * Where the mirror across `axis` puts one object, and how it had to be turned
 * inside out to get there.
 *
 * Shared by the tool and by its ghosts, and the same call Flip makes with the
 * plane somewhere other than the middle of the arena. Chirality is asked of the
 * *source* piece: the copy's model may still be loading, and a themed swap is
 * the same shape anyway.
 */
function mirroredPlacement(mesh, axis) {
  return vp.reflectedPlacement(mesh, axis, 0);
}

/**
 * Copy the selection to the other side of the map, as a true reflection.
 *
 * `axis` is 'x' or 'z' — the two horizontal ones; mirroring in Y would put the
 * map underground. The plane is the middle of the arena, which is the origin,
 * so a piece two metres to the left comes back two metres to the right.
 *
 * A reflection is three things, not one. The position flips, obviously. The
 * rotation is reflected. And the piece itself has to be turned inside out,
 * which is the difference between a corner barrier that faces the right way and
 * one that actually closes the far corner — see `reflectedPlacement` in
 * scene.js for how much of that a half turn can do and how little is left for a
 * negative scale.
 *
 * `into` renders the copy as something else, which is how you get a blue half
 * and an orange half: `{ label, pick }`, where `pick` is handed each piece's
 * catalog entry and returns what to build instead, or null to keep it. The two
 * that exist are a theme, which swaps a Camo barrier for a Default one, and a
 * team, which swaps a blue spawn zone for the orange one. A piece the picker
 * has nothing for keeps its own.
 */
function mirrorSelection(axis, into = null) {
  if (!vp.selection.size) return toast('Select something to mirror.');
  const made = [];
  const remap = new Map();
  let already = 0, kept = 0, flipped = 0;

  for (const m of [...vp.selection]) {
    const placement = mirroredPlacement(m, axis);

    const target = into ? into.pick(m.userData.def) : null;
    const def = target || m.userData.def;
    // Two of the three outcomes are worth a word in the toast: a piece that was
    // already what was asked for, and a piece with nothing of that kind to
    // become — a genuinely partial library rather than a mistake. The third,
    // the ones that swapped, is everything else and needs no counting.
    if (into) { if (!target) kept++; else if (target === m.userData.def) already++; }

    const copy = vp.addObject({
      type: def.type,
      $type: target ? (def.objectType || 'MapObject') : m.userData.objectType,
      // Props belong to the subtype, so they only carry over within it.
      props: target && target.type !== m.userData.def.type
        ? { ...(def.props || {}) } : { ...m.userData.props },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    copy.position.copy(placement.position);
    copy.quaternion.copy(placement.quaternion);
    if (target) alignShapeYaw(copy.quaternion, m.userData.def, target);
    copy.scale.copy(placement.scale);
    if (placement.flip !== 'none') flipped++;
    if (m.userData.group) {
      if (!remap.has(m.userData.group)) remap.set(m.userData.group, `g${groupSeq++}`);
      copy.userData.group = remap.get(m.userData.group);
    }
    made.push(copy);
  }

  // The pointer is still on the Mirror panel — it is on the button that was
  // just pressed — but the copies are real now, so the ghosts step aside until
  // the pointer leaves and comes back.
  mirrorHover = false;
  vp.setSelection(made);
  commit();
  const where = into ? ` as ${into.label}` : '';
  const same = already ? `, ${already} already ${into.label}` : '';
  const missing = kept ? `, ${kept} with no equivalent kept as they were` : '';
  const turned = flipped ? `, ${flipped} turned inside out to face the other way` : '';
  toast(`Mirrored ${made.length} object${made.length === 1 ? '' : 's'} across ${axis.toUpperCase()}${where}${same}${missing}${turned}.`);
  tip('mirror',
    'The copies are a reflection, not just a move: a piece with a left and a right comes out the '
    + 'other way round. Build one half of the arena, then mirror it.');
}

/**
 * Turn a selection round where it stands, rather than copying it across the
 * arena. Mirror's reflection with the plane moved to the selection's own middle
 * and the copies left out — see `flipSelection` in scene.js.
 *
 * The objects stay selected afterwards. They are the same objects: a flip is an
 * edit, and the next thing anyone does to a piece they have just turned round is
 * nudge it.
 */
function flipSelection(meshes, axis) {
  const targets = meshes.filter((m) => !m.userData.locked);
  if (!targets.length) return toast('Nothing to flip.');
  vp.setSelection(targets);
  // No `commit()` here: `flipSelection` ends by emitting 'commit-end', which is
  // already wired to it. Calling it a second time pushed the *result* onto the
  // undo stack as well as the state before it, so the first Ctrl+Z restored the
  // flip over itself and looked as though undo had stopped working.
  const n = vp.flipSelection(axis);
  if (!n) return toast('Nothing to flip.');
  toast(`Flipped ${n} object${n === 1 ? '' : 's'} across ${axis.toUpperCase()}.`);
  tip('flip',
    'Flip turns the selection round where it stands, the way Mirror turns a copy round on the far '
    + 'side of the arena. Several pieces flip as one, so a run comes out as the run you would have '
    + 'built from the other end.');
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

/**
 * The floor from the other side: the selection goes down until its top face
 * rests on the ground rather than its bottom one.
 *
 * A map is built on a floor you cannot see the underside of, and the pieces
 * that belong below it — the block filling a pit, the slab a walkway is bedded
 * into — are otherwise placed by reading a height off the inspector and
 * subtracting the object's own thickness by hand.
 */
function dropUnderGround() {
  if (!vp.selection.size) return toast('Select something to put under the ground.');
  const moved = vp.dropSelection('under');
  toast(moved
    ? `Put ${moved} object${moved === 1 ? '' : 's'} under the ground.`
    : 'Already sitting under the ground — nothing to move.');
  tip('under',
    'Under ground is To floor upside down: the top of the object lands on the ground instead of '
    + 'its bottom, so the whole of it is buried. A stack goes down as one, keeping its stacking.');
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
// Prefabs
// ---------------------------------------------------------------------------
// A piece of a map kept on its own, in a file: a bunker, a doorway, a stack of
// crates. Copy and paste already move a selection about inside one session;
// this is the same idea outliving the tab, so a thing built once can be built
// into a second map, or a tenth.
//
// The file is the clipboard record with a header on it, and for the same reason
// the clipboard is values rather than mesh references: what makes a prefab
// portable is that it says what its pieces *are* — a type, its props, a
// transform — and nothing about the map it came out of. An object type the
// reading editor has never heard of still loads, as the same pink marker an
// unknown type in a map file gets, and exports unchanged.
//
// X and Z are written relative to the middle of the selection, so a prefab's
// own coordinates start where the prefab does. Y is left as it stands, because
// height in this format means height above the arena floor and that is a fact
// about the thing: a stack of crates built on the ground comes back on the
// ground, and a jumbotron hung at three metres comes back at three.

const PREFAB_FORMAT = 'opsforge.prefab';
const PREFAB_VERSION = 1;
const PREFAB_EXT = 'opsprefab';

/** The selection as a prefab document, ready to serialise. */
function prefabFromSelection(name) {
  const list = [...vp.selection];
  // The viewport's own measurement of the selection, which leaves out what the
  // editor draws about an object: a spawner near the edge of a prefab used to
  // push the whole thing off centre by the length of the gun hanging over it.
  const centre = vp.selectionBounds().getCenter(new THREE.Vector3());
  return {
    format: PREFAB_FORMAT,
    version: PREFAB_VERSION,
    name,
    created: nowStamp(),
    objects: list.map((m) => {
      m.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.matrixWorld.decompose(p, q, s);
      return {
        type: m.userData.def.type,
        $type: m.userData.objectType,
        props: { ...m.userData.props },
        p: [p.x - centre.x, p.y, p.z - centre.z],
        q: q.toArray(),
        s: s.toArray(),
      };
    }),
  };
}

/** A name to offer, so the common case is a name you accept rather than type. */
function suggestPrefabName() {
  const list = [...vp.selection];
  if (!list.length) return 'Prefab';
  const first = list[0].userData.def.label;
  if (list.every((m) => m.userData.def.label === first)) {
    return list.length === 1 ? first : `${first} x${list.length}`;
  }
  return `${list.length} objects`;
}

function prefabFileName(name) {
  const safe = String(name || 'Prefab').replace(/[\\/:*?"<>|]/g, '').trim() || 'Prefab';
  return `${safe}.${PREFAB_EXT}`;
}

function exportPrefab(meshes = null) {
  if (meshes) vp.setSelection(meshes);
  if (!vp.selection.size) return toast('Select what you want to keep as a prefab first.');
  const n = vp.selection.size;
  openDialog({
    title: 'Export prefab',
    body: `${n} object${n === 1 ? '' : 's'} will be written to a file you can bring back into this `
      + 'map or any other. The name is the file name, and what the editor calls it on the way back in.',
    fields: [{ id: 'dlg-prefab', label: 'Name', value: suggestPrefabName(), placeholder: 'Prefab name' }],
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      { label: 'Export', run: (v) => writePrefabFile(v['dlg-prefab']) },
    ],
  });
}

function writePrefabFile(name) {
  try {
    const prefab = prefabFromSelection(String(name || '').trim() || 'Prefab');
    const file = prefabFileName(prefab.name);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(prefab, null, 1)], { type: 'application/json' })
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`Exported ${file} — ${prefab.objects.length} object${prefab.objects.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    toast(`Could not write that prefab: ${err.message}`, true);
  }
}

/** True for a file that is a prefab rather than a map, before reading it. */
const looksLikePrefab = (file) => (file.name || '').toLowerCase().endsWith(`.${PREFAB_EXT}`);

async function importPrefabFile(file) {
  try {
    placePrefab(JSON.parse(await file.text()));
  } catch (err) {
    console.error(err);
    toast(`Could not read that prefab: ${err.message}`, true);
  }
}

/**
 * Rebuild a prefab's objects and hand them to the cursor.
 *
 * Everything arrives in one group. A prefab is a thing you assembled and named,
 * and it should land as that thing rather than as forty loose pieces to be
 * rounded up before they can be moved; ungroup breaks it apart the moment you
 * want the pieces. Groups the objects were in when it was written are not
 * restored, and cannot be — a group here is one flat id per object, with no
 * nesting for a group of groups to live in.
 */
function placePrefab(data) {
  if (!data || data.format !== PREFAB_FORMAT || !Array.isArray(data.objects)) {
    throw new Error('that is not an OpsForge prefab file');
  }
  if (!data.objects.length) return toast('That prefab has nothing in it.');
  const newer = data.version > PREFAB_VERSION;

  const group = `g${groupSeq++}`;
  const made = data.objects.map((rec) => {
    const mesh = vp.addObject({
      type: rec.type, $type: rec.$type, props: rec.props,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      dirty: true,
    });
    mesh.position.fromArray(rec.p);
    mesh.quaternion.fromArray(rec.q);
    mesh.scale.fromArray(rec.s);
    // A single object is a single object, whatever the file it arrived in.
    if (data.objects.length > 1) mesh.userData.group = group;
    return mesh;
  });

  const unknown = new Set(made.filter((m) => m.userData.def.unknown).map((m) => m.userData.def.type));
  placeReturn = [...vp.selection];
  placingLabel = data.name || 'prefab';
  vp.beginPlacement(made);

  let msg = `${data.name || 'Prefab'} — ${made.length} object${made.length === 1 ? '' : 's'}. `
    + 'Click to place, Esc cancels.';
  if (newer) msg += ` Written by a newer editor (prefab v${data.version}); anything it added is ignored.`;
  if (unknown.size) msg += ` ${unknown.size} type(s) not in any loaded pack: ${[...unknown].join(', ')}.`;
  toast(msg, newer || unknown.size > 0);
}

function wirePrefabTool() {
  $('b-prefab-export').onclick = () => exportPrefab();
  $('b-prefab-import').onclick = () => $('prefabpick').click();
  $('prefabpick').onchange = (e) => {
    const f = e.target.files[0];
    if (f) importPrefabFile(f);
    e.target.value = '';
  };
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function wireToolbar() {
  const startNewMap = async () => {
    map = await newMap({ name: 'New Map', author: map?.author || '' });
    project = newProject(map);
    resetLayerView();
    vp.clearObjects();
    applyMapMeta();
    await loadNavCloud();
    activeRuleSet = 0;
    buildRules();
    undoStack = []; redoStack = []; current = snapshot();
    adoptMapGuides();
    // Back to where the editor opens. A new map is an empty arena, and leaving
    // the camera wherever the last map's far corner left it means starting the
    // new one looking at nothing — with no object on screen to say which way is
    // which, or how far away you are.
    vp.setView('persp');
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
        + 'so you can get back to it from the Map tab.'
        + (project?.layers.length
          ? ` The ${project.layers.length} venue layers go too: an alignment is a placement of `
            + 'one particular design, and this is about to be a different one.'
          : ''),
      confirmLabel: 'New map',
      run: () => { takeCheckpoint('manual', true); startNewMap(); },
    });
  };
  $('b-open').onclick = () => openSourceChooser();
  $('filepick').onchange = (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; };
  $('projectpick').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    // Straight to the project reader rather than through `openFile`: this
    // picker was opened by asking for a project, so a file without the
    // extension should be tried as one and refused with a reason.
    if (f) importProjectFile(f);
  };
  $('b-save').onclick = exportMap;

  const syncSnap = () => {
    vp.setSnap('translate', $('snap-t').checked ? parseFloat($('snap-t-v').value) : 0);
    vp.setSnap('rotate', $('snap-r').checked ? parseFloat($('snap-r-v').value) : 0);
  };
  ['snap-t', 'snap-t-v', 'snap-r', 'snap-r-v'].forEach((id) => ($(id).onchange = syncSnap));
  $('uniform').onchange = (e) => vp.setUniformScale(e.target.checked);

  $('orbit-cursor').onchange = (e) => {
    vp.setOrbitAtCursor(e.target.checked);
    toast(e.target.checked
      ? 'Orbiting about whatever is under the pointer. Middle-drag on a piece and it stays put.'
      : 'Orbiting about the middle of the view.');
  };

  wirePointerScheme();

  // Nothing about the map changes here, so no commit and no edited stamp — it
  // is a way of looking at the scene, not a way of changing it.
  $('placeholders').onchange = (e) => {
    vp.setUsePlaceholders(e.target.checked);
    toast(e.target.checked
      ? 'Showing the built-in stand-in shapes.'
      : 'Showing the game\'s own models where they are on disk.');
  };

  // Also a way of looking rather than a way of changing: the boundaries stay in
  // the map and go out with it either way.
  $('hide-boundaries').onchange = (e) => {
    vp.setHideBoundaries(e.target.checked);
    buildOutliner();
    toast(e.target.checked
      ? 'Boundaries hidden. They are still on the map and still exported.'
      : 'Boundaries shown.');
  };

  // The way back from Hide. Also a way of looking rather than a way of
  // changing: what it does is bring the put-away objects into view faded, so
  // one of them can be picked out and brought back for good.
  $('show-hidden').onchange = (e) => {
    vp.setShowHidden(e.target.checked);
    buildOutliner();
    refreshHiddenCount();
    const n = vp.hiddenCount();
    toast(e.target.checked
      ? `Showing ${n} hidden object${n === 1 ? '' : 's'}, faded. Right-click one and pick Show `
        + 'to bring it back for good.'
      : 'Hidden objects put away again.');
  };

  $('b-undo').onclick = undo;
  $('b-redo').onclick = redo;
  $('q').oninput = buildLibrary;

  document.querySelectorAll('#viewbtns .btn').forEach((b) => {
    b.onclick = () => vp.setView(b.dataset.view);
  });
}

// ---------------------------------------------------------------------------
// Mouse or trackpad
// ---------------------------------------------------------------------------
// The editor's own scheme wants three mouse buttons and a wheel, and a laptop
// without a mouse has none of them: no middle button to orbit with, no
// comfortable right drag to pan with. So the top bar carries a switch between
// the mouse scheme and a trackpad one — two fingers to orbit, Shift to pan,
// Ctrl to zoom, which is what Blender does and therefore what a good many
// people's fingers already know. `Viewport._initWheel` is where the gestures
// live and why they cannot be detected rather than declared.
//
// Remembered in this browser, because it is a fact about the machine rather than
// about the map: whoever works on a laptop works on a laptop tomorrow as well.

const POINTER_KEY = 'spatialops.pointer';
// Mouse, then trackpad, then trackpad with orbit and pan reversed — cycling
// forward on every click and wrapping back to mouse. The dot has one stop
// per mode, left to right in this order.
const POINTER_MODES = ['mouse', 'trackpad', 'trackpad-inverted'];

function wirePointerScheme() {
  let mode = 'mouse';
  try {
    const saved = localStorage.getItem(POINTER_KEY);
    if (POINTER_MODES.includes(saved)) mode = saved;
  } catch { /* no storage */ }
  setPointerScheme(mode, false);
  const sw = $('b-pointer');
  const advance = () => setPointerScheme(POINTER_MODES[(POINTER_MODES.indexOf(sw.dataset.mode) + 1) % POINTER_MODES.length], true);
  sw.onclick = advance;
  // A switch, not a button — Space and Enter both toggle it, the way a
  // checkbox responds to either.
  sw.onkeydown = (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
  };
}

/** The dot's position says which scheme is in force, rather than which one is next. */
function setPointerScheme(mode, announce) {
  const pad = mode !== 'mouse';
  vp.setTrackpad(pad, mode === 'trackpad-inverted');
  const sw = $('b-pointer');
  sw.dataset.mode = mode;
  sw.setAttribute('aria-checked', String(pad));
  const trackpadLbl = sw.querySelector('.pswitch-trackpad');
  if (trackpadLbl) trackpadLbl.textContent = mode === 'trackpad-inverted' ? 'Trackpad Inverted' : 'Trackpad';
  refreshStatus();
  // Nothing to write on the way in: that is where the value came from.
  if (!announce) return;
  try { localStorage.setItem(POINTER_KEY, mode); } catch { /* fine */ }
  toast(
    mode === 'trackpad-inverted'
      ? 'Trackpad, inverted. Same two-finger gestures — orbit and pan run backwards, the zoom is unchanged.'
      : pad
        ? 'Trackpad. Two fingers on the pad orbit, Shift and two fingers pan, Ctrl and two fingers zoom.'
        : 'Mouse. Middle drag orbits, right drag pans, the wheel zooms towards the pointer.',
  );
  if (pad) {
    tip('trackpad',
      'A two-finger tap is a right click, so the object menu is still there. The mouse scheme '
      + 'stays live underneath: Alt+left drag orbits without a middle button.');
  }
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
  showInspectorTab = (name, call = false) => {
    show(name);
    if (!call) return;
    // A panel that changes with nothing else moving on screen is a panel nobody
    // notices has changed, and someone sent here from the export reminder was
    // looking at a dialog a moment ago rather than at the inspector. So the tab
    // itself says where they have been put — twice, and then never again.
    const tab = tabs.find((t) => t.dataset.pane === name);
    if (!tab) return;
    tab.classList.remove('calling');
    void tab.offsetWidth;                    // restart the animation
    tab.classList.add('calling');
    tab.addEventListener('animationend', () => tab.classList.remove('calling'), { once: true });
  };
  show('build');
}

/**
 * Switch the inspector to a tab from elsewhere, optionally drawing attention to
 * it on the way. Set by `wireInspectorTabs`.
 */
let showInspectorTab = () => {};

/**
 * The mirror tool. It lives in the Build tab beside Array because the two are
 * the same kind of thing — one selection in, a lot of objects out — and both
 * want the object list they act on within reach.
 */
/** What the second box currently offers, in the order it lists them. */
let mirrorTargetList = [];

/**
 * What the Mirror panel's second box currently offers, and what picking each
 * one would build.
 *
 * Two different lists, because a selection is one kind of thing or the other. A
 * wall belongs to a *theme* and the eleven virtual packs are its choices. A
 * player spawn zone belongs to a *team*, and blue and orange are its only two —
 * no themed pack holds a spawn zone at all, which is why offering the themes
 * over one used to mirror the zone and leave it the colour it started.
 *
 * The team list appears only when the whole selection is one family, since that
 * is when the answer is unambiguous. Mirror a half-arena with a spawn zone in
 * it and the themes are back, which is right: the eleven pieces of wall are
 * what the choice is about, and the zone goes across as itself.
 */
function mirrorTargets() {
  const sel = [...vp.selection];
  const family = sel.length && sel[0].userData.def.teamFamily;
  if (family && sel.every((m) => m.userData.def.teamFamily === family)) {
    return teamVariants(sel[0].userData.def).map((d) => ({
      value: `team:${d.team}`,
      // The damage boxes have a third member that belongs to nobody, and
      // "Neutral Team" is not a thing anybody says.
      label: d.team === 'Neutral' ? 'No team' : `${d.team} Team`,
      pick: (def) => teamVariant(def, d.team),
    }));
  }
  return packsInGroup('virtual').map((p) => ({
    value: `pack:${p.id}`,
    label: p.name,
    pick: (def) => equivalentIn(def, p.id),
  }));
}

/**
 * Fill the second box from the selection. Called on every selection change, and
 * it keeps whatever was picked if that option still exists — swapping between
 * two walls should not silently reset a chosen theme.
 */
function refreshMirrorTargets() {
  const select = $('mirror-pack');
  const was = select.value;
  mirrorTargetList = mirrorTargets();
  select.textContent = '';
  const same = document.createElement('option');
  same.value = '';
  same.textContent = mirrorTargetList[0]?.value.startsWith('team:') ? 'Same team' : 'Same pack';
  select.appendChild(same);
  for (const t of mirrorTargetList) {
    const o = document.createElement('option');
    o.value = t.value;
    o.textContent = t.label;
    select.appendChild(o);
  }
  select.value = [...select.options].some((o) => o.value === was) ? was : '';
}

function wireMirrorTool() {
  refreshMirrorTargets();
  $('b-mirror').onclick = () => {
    const chosen = mirrorTargetList.find((t) => t.value === $('mirror-pack').value) || null;
    mirrorSelection($('mirror-axis').value, chosen);
  };
}

/** Whatever the array boxes currently say, as the tool takes them. */
function arraySettings() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    nx: Math.max(1, Math.round(num('arr-nx', 1))),
    ny: Math.max(1, Math.round(num('arr-ny', 1))),
    nz: Math.max(1, Math.round(num('arr-nz', 1))),
    dx: num('arr-dx', 1), dy: num('arr-dy', 1), dz: num('arr-dz', 1),
  };
}

/**
 * The array tool. Counts and spacings are read at the moment you press Array,
 * so changing the selection first and the numbers after works either way round
 * — and the ghosts in the view are read from the same six boxes as you type,
 * so there is nothing left to picture.
 */
function wireArrayTool() {
  $('b-array').onclick = () => arraySelection(arraySettings());
  for (const id of ['arr-nx', 'arr-ny', 'arr-nz', 'arr-dx', 'arr-dy', 'arr-dz']) {
    // `input` rather than `change`: the point of the preview is to answer the
    // question while the number is still being typed.
    $(id).oninput = () => { arrayPreviewOn = true; refreshPreview(); };
  }
}

/**
 * Put the counts back to 1 after an array has been made.
 *
 * Counts only. The spacings are the selection's own size and `refreshArrayDefaults`
 * has already reset them against the new selection by the time this runs; setting
 * `.value` from script fires no `input` event, so neither the ghosts nor
 * `arrayPreviewOn` are disturbed.
 */
function resetArrayCounts() {
  for (const id of ['arr-nx', 'arr-ny', 'arr-nz']) $(id).value = 1;
}

/** The grid the array's automatic spacing lands on. */
const ARRAY_SPACING_STEP = 0.25;

/**
 * Reset the spacings to the selection's own size whenever the selection
 * changes, so the common case — copies sitting flush — needs no arithmetic.
 * Counts are left alone here: repeating the same 5 x 1 wall with a different
 * piece is a normal thing to want, and merely picking a different object is no
 * reason to retype the numbers. Applying the array is — see `resetArrayCounts`.
 *
 * The measured size is rounded to the nearest 25 cm on the way in. An object's
 * mesh is whatever the artist built — a barrier is 1.04 m wide, a crate 0.98 —
 * and arraying by that leaves a row sitting at 1.04, 2.08, 3.12, which lines up
 * with nothing else on the map and cannot be typed back in later. A quarter
 * metre is the grid the editor snaps to and the one the game's own placements
 * fall on, so a row spaced by it stays on the grid however long it gets. The
 * centimetre or two of overlap or gap that rounding introduces is the whole
 * reason the number is still an editable box.
 */
function refreshArrayDefaults() {
  const n = vp.selection.size;
  $('arr-count').textContent = n ? `${n} selected` : '';
  $('b-array').disabled = !n;
  if (!n) return;
  const e = selectionExtent();
  const tidy = (v) => Math.max(ARRAY_SPACING_STEP,
    Math.round(v / ARRAY_SPACING_STEP) * ARRAY_SPACING_STEP);
  $('arr-dx').value = tidy(e.x);
  $('arr-dy').value = tidy(e.y);
  $('arr-dz').value = tidy(e.z);
}

// ---------------------------------------------------------------------------
// Tool previews
// ---------------------------------------------------------------------------
// Array and Mirror both take a selection and a handful of settings and produce
// a lot of objects, and until you press the button the only place the result
// exists is in your head. So it is drawn: translucent copies, exactly where the
// current settings would put real ones, updating as the settings change.
//
// Two rules keep them from becoming clutter. Array shows its ghosts whenever a
// count is above 1, because that reading is unambiguous — a count of 1 means
// nothing to preview. Mirror has no such tell, so it shows its ghosts while the
// pointer is on its panel, and stops when the pointer leaves.
//
// The three landing buttons follow Mirror's rule, one hover at a time. They are
// the case that needs it most: Drop, To floor and Under ground all read as
// "put it down" and differ in where, which is a distinction the words carry
// badly and a picture carries exactly. Hovering one shows where that button
// would leave the selection; a button that would move nothing shows nothing,
// which is the same answer its toast gives after the fact.

const GHOST_LIMIT = 500;      // the array tool's own ceiling on copies

let arrayPreviewOn = false;   // armed by the array boxes and by a new selection
let arrayJustApplied = false; // the copies are real now; do not ghost them again
let mirrorHover = false;      // the pointer, or the focus, is on the Mirror panel
let dropHover = null;         // 'surface' | 'floor' | 'under' while one is under the pointer
let flipHover = null;         // { meshes, axis } while a Flip row is under the pointer

function wirePreviews() {
  const panel = $('sec-mirror');
  const enter = () => { mirrorHover = true; refreshPreview(); };
  const leave = () => { mirrorHover = false; refreshPreview(); };
  panel.addEventListener('pointerenter', enter);
  panel.addEventListener('pointerleave', leave);
  // Focus counts as well, so tabbing to the axis picker shows the same thing
  // pointing at it does.
  panel.addEventListener('focusin', enter);
  panel.addEventListener('focusout', (e) => { if (!panel.contains(e.relatedTarget)) leave(); });
  $('mirror-axis').addEventListener('change', refreshPreview);

  // Nothing worth previewing mid-drag: the settings are about to be measured
  // against a selection that is still moving.
  vp.addEventListener('commit-begin', () => vp.clearGhosts());
}

/**
 * Draw whichever tool has something to say, or nothing.
 *
 * A flip wins over a landing, a landing over the mirror, and the mirror over
 * the array, because that is the order the pointer put them in: you cannot be
 * hovering a landing button without having reached past the other two, and the
 * right-click menu is over the top of all of it.
 */
function refreshPreview() {
  if (vp.placing) return vp.clearGhosts();
  // Flip first, and before the selection is consulted at all: the right-click
  // menu reads what was clicked rather than what is selected, so a flip can be
  // asked about an object that is not in the selection — or when there is no
  // selection whatsoever.
  if (flipHover) return vp.setGhosts(vp.flipGhosts(flipHover.meshes, flipHover.axis));
  if (!vp.selection.size) return vp.clearGhosts();
  if (dropHover) return vp.setGhosts(vp.dropGhosts(dropHover));
  vp.setGhosts(mirrorHover ? mirrorGhosts() : arrayGhosts());
}

/**
 * Wire one landing button to preview itself. Focus counts as well as the
 * pointer, so tabbing along the row shows the same thing pointing at it does.
 *
 * The ghosts go on click too: the objects are where the ghosts were, and
 * leaving the ghosts there would draw a second copy of a selection that has
 * already landed.
 */
function wireDropPreview(id, onto) {
  const button = $(id);
  if (!button) return;
  const on = () => { dropHover = onto; refreshPreview(); };
  const off = () => { if (dropHover === onto) { dropHover = null; refreshPreview(); } };
  button.addEventListener('pointerenter', on);
  button.addEventListener('pointerleave', off);
  button.addEventListener('focus', on);
  button.addEventListener('blur', off);
  button.addEventListener('click', off);
}

function arrayGhosts() {
  if (!arrayPreviewOn) return [];
  const spec = arraySettings();
  if (spec.nx * spec.ny * spec.nz <= 1) return [];
  const source = [...vp.selection];
  const out = [];
  for (const { step } of vp.arraySteps(spec)) {
    for (const m of source) {
      if (out.length >= GHOST_LIMIT) return out;
      m.updateWorldMatrix(true, false);
      const matrix = m.matrixWorld.clone();
      const e = m.matrixWorld.elements;
      matrix.setPosition(e[12] + step.x, e[13] + step.y, e[14] + step.z);
      out.push({ source: m, matrix });
    }
  }
  return out;
}

/**
 * The mirrored copies, drawn in the source's own shape. A themed mirror swaps
 * each piece for its equivalent in another pack, and the ghost does not follow
 * it there: what the preview is for is where the copies land and which way
 * round they face, and a themed equivalent is the same shape in another colour.
 */
function mirrorGhosts() {
  const axis = $('mirror-axis').value;
  return [...vp.selection].map((m) => {
    const { position, quaternion, scale } = mirroredPlacement(m, axis);
    return { source: m, matrix: new THREE.Matrix4().compose(position, quaternion, scale) };
  });
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
  if (activeLayer !== null) {
    // The grid on screen is the hall's, read out of its template. Painting it
    // would write a venue's play space into the design's own file.
    return void toast('That is the venue’s play space, not the map’s. '
      + 'Go back to the map to paint its own.', true);
  }
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
  // The landing buttons are about to be replaced, so no `pointerleave` is
  // coming for the one the pointer was on. Left set, it would keep drawing a
  // landing for whatever got selected next.
  dropHover = null;
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
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-top:9px">
      <button class="btn ghost" id="s-drop"
        title="Let it fall until it rests on whatever is underneath — the top of another object, or the ground. Loose objects each find their own landing; a group falls as one and keeps its stacking (Shift+End)">Drop</button>
      <button class="btn ghost" id="s-floor"
        title="Put it on the ground, whatever is in the way. Anything stacked or grouped goes down as one, so a stack lands stacked; pieces standing apart each land on their own (End)">To floor</button>
      <button class="btn ghost" id="s-under"
        title="Put it under the ground — the same landing as To floor, on the other side of it, so the top face sits on y=0 and none of it shows (Ctrl+End)">Under ground</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:5px">
      <button class="btn ghost" id="s-group" title="Move these together from now on (G)">Group</button>
      <button class="btn ghost" id="s-ungroup" title="Break the group up (Shift+G)">Ungroup</button>
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
  $('s-drop').onclick = dropOntoSurface;
  $('s-floor').onclick = () => vp.dropSelection('floor');
  $('s-under').onclick = dropUnderGround;
  // The panel is rebuilt from scratch whenever the selection changes, so these
  // are rewired here rather than once at startup.
  wireDropPreview('s-drop', 'surface');
  wireDropPreview('s-floor', 'floor');
  wireDropPreview('s-under', 'under');
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
  content: 'Message',
  showInGame: 'Show in game',
};

/** Props with a row of their own; `propRows` leaves these to the builders below. */
const SPECIAL_PROPS = ['specificWeapon', 'enemyTypes', 'behaviour', 'content', 'showInGame'];

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

/**
 * The words on a custom message.
 *
 * A textarea rather than the one-line box every other free-text prop gets,
 * because this one is a sentence and the panel is 250 pixels wide. The value
 * written to the file is still a single string — a newline typed in here goes
 * out as one, escaped, which is what the format allows and what the game will
 * make of it is its own business.
 */
function messageRow(value) {
  return `<div class="field mfield"><span>Message</span>
    <textarea id="f-content" rows="3"
      placeholder="What the sign says">${escapeHtml(value ?? '')}</textarea></div>`;
}

/**
 * The tick that decides whether players ever see it. Off is a note the author
 * left for themselves, and the viewport draws it greyed to match.
 */
function showInGameRow(value) {
  const on = value !== false;
  return `<label class="mtick" title="Unticked, the message is drawn in the editor and left out of the game">
    <input type="checkbox" id="f-showingame"${on ? ' checked' : ''}>
    <span>Show in game</span></label>`;
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
      if (key === 'content') return messageRow(props[key]);
      if (key === 'showInGame') return showInGameRow(props[key]);
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

/**
 * The message rows. `input` rather than `change` on the text, so the sign in
 * the viewport is redrawn as you type and you can see it fit — the whole reason
 * the words are drawn there at all. The undo step is still one per edit, taken
 * when the box is left.
 */
function wireMessageRows(mesh) {
  const text = $('f-content');
  if (text) {
    text.oninput = () => vp.setProp(mesh, 'content', text.value);
    text.onchange = () => commit();
  }
  const tick = $('f-showingame');
  if (tick) {
    tick.onchange = () => {
      vp.setProp(mesh, 'showInGame', tick.checked);
      commit();
      toast(tick.checked
        ? 'Players will see this message.'
        : 'Message kept in the map but hidden from players.');
    };
  }
}

function wirePropRows(mesh) {
  wireSpawnerRows(mesh);
  wireMessageRows(mesh);
  const keys = Object.keys(mesh.userData.props || {});
  keys.forEach((key, i) => {
    if (SPECIAL_PROPS.includes(key)) return;
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
  // The three boxes can put a piece off the floor or outside the square as
  // surely as a drag can, so they end the same way a drag does.
  vp.settle();
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
  // The icons are keyed the way a map object names a weapon and these options
  // are named the way a rule names one, which for four of the nine is not the
  // same word. `objectWeapon` is the bridge; see the note at the top of
  // rules.js for why there are two spellings at all.
  const weaponIcon = (o) => WEAPON_ICONS[objectWeapon(o)];
  const weapons = (f.options || []).every((o) => weaponIcon(o));

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
      img.src = iconUrl({ icon: weaponIcon(opt) });
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

// The row order as last drawn, one entry per row with the objects a click on
// it stands for — a group row's members, or a lone object's one mesh. Shift
// click walks this to find everything between two rows; it is rebuilt every
// buildOutliner, so the anchor index is only ever read back against the list
// that produced it.
let outlinerOrder = [];
let outlinerAnchor = -1;

function buildOutliner() {
  const host = $('outliner');
  host.innerHTML = '';
  outlinerOrder = [];

  // Walk the objects in order and emit either a lone object or, at the first
  // member of a group, the whole group. Order follows the scene, so a group
  // sits where its first member is.
  // Everything except the design objects the venue on screen has replaced.
  // Those are still the map's and still in its file, but this hall is showing
  // its own copy of each instead, and two rows for one crate is a list nobody
  // can read. Hand-hidden objects stay listed: the list is how they are reached.
  const listed = vp.objects.filter((m) => !vp.replacedHere(m));

  const groups = new Map();
  for (const m of listed) {
    const g = m.userData.group;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  const emitted = new Set();

  for (const m of listed) {
    const g = m.userData.group;
    if (!g) { host.appendChild(objectRow(m, false)); continue; }
    if (emitted.has(g)) continue;
    emitted.add(g);
    const members = groups.get(g);
    host.appendChild(groupRow(g, members));
    if (openGroupRows.has(g)) for (const child of members) host.appendChild(objectRow(child, true));
  }
  $('obj-count').textContent = String(listed.length);
}

/**
 * A row was clicked in the outliner. Plain click replaces the selection with
 * this row's objects. Ctrl adds or removes them, for building up a selection
 * one row at a time. Shift selects every row between the last row clicked and
 * this one, inclusive — the anchor is whichever row a plain or ctrl click last
 * touched, so a shift click always reasons from where the user's attention
 * actually was.
 */
function outlinerRowClick(e, index, targets) {
  // The list reaches objects the pointer deliberately cannot, which is the
  // whole point of it -- a locked object, a hidden one. In a venue that would
  // also mean the design, and selecting a piece of the design here is the one
  // gesture that could fork it without anybody meaning to. Right-click still
  // works on those rows, which is where meaning it lives.
  if (activeLayer !== null && targets.some((m) => !m.userData.layer)) {
    return void toast('That one belongs to the map. Right-click it to give this venue a copy of '
      + 'its own, or go back to the map to change it everywhere.', true);
  }
  if (e.shiftKey && outlinerAnchor >= 0) {
    const [lo, hi] = outlinerAnchor <= index ? [outlinerAnchor, index] : [index, outlinerAnchor];
    const next = new Set();
    for (let i = lo; i <= hi; i++) for (const m of outlinerOrder[i]) next.add(m);
    vp.setSelection([...next]);
    return;
  }
  outlinerAnchor = index;
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(vp.selection);
    const allIn = targets.every((m) => next.has(m));
    for (const m of targets) allIn ? next.delete(m) : next.add(m);
    vp.setSelection([...next]);
  } else {
    vp.setSelection(targets);
  }
}

/** Double click: this object and every other object of the same type. */
function outlinerRowDblClick(m) {
  vp.setSelection(vp.objects.filter((o) => o.userData.def.type === m.userData.def.type));
}

/**
 * Put the invisible walls back, wherever the user has just asked for something
 * they cannot see — clicked a greyed row, or taken a boundary out of the
 * library while the switch was on. Placing a piece that never appears is the
 * kind of thing you spend a minute doubting the editor over.
 */
function showBoundaries() {
  if (!vp.hideBoundaries) return;
  $('hide-boundaries').checked = false;
  vp.setHideBoundaries(false);
  buildOutliner();
  toast('Boundaries shown again.');
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
  const index = outlinerOrder.length;
  outlinerOrder.push(members);
  row.onclick = (e) => outlinerRowClick(e, index, members);
  row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, members); };
  return row;
}

function objectRow(m, child) {
  const row = document.createElement('div');
  // Anything out of sight stays in the list, because it is still in the map and
  // a list that quietly loses rows is worse than one that greys them. Clicking
  // it brings it back into view rather than putting a gizmo on thin air — and
  // which switch does that depends on why it went: the Boundaries one for an
  // invisible wall, Show hidden for something put away by hand. An object can
  // be both, so the boundaries come back first.
  const away = !!m.userData.hidden;
  const unseen = !m.visible;
  const reveal = () => {
    if (!m.visible) showBoundaries();
    if (!m.visible && away) revealHidden();
  };
  row.className = 'row' + (vp.selection.has(m) ? ' on' : '') +
    (child ? ' child' : '') + (m.userData.locked ? ' locked' : '') + (unseen ? ' unseen' : '') +
    (away ? ' away' : '');
  const dot = document.createElement('i');
  dot.className = 'dot';
  dot.style.background = m.userData.def.color;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = m.userData.def.label;
  if (away) {
    row.title = unseen
      ? 'Hidden. Click to bring the hidden objects into view, then right-click for Show.'
      : 'Hidden, and shown faded because Show hidden is on. Right-click for Show.';
  } else if (unseen) {
    row.title = 'Hidden by the Hide boundaries switch. Click to show them again.';
  }
  row.append(dot, t, lockToggle([m], !!m.userData.locked));
  const index = outlinerOrder.length;
  outlinerOrder.push([m]);
  row.onclick = (e) => {
    reveal();
    outlinerRowClick(e, index, [m]);
  };
  row.ondblclick = () => {
    reveal();
    outlinerRowDblClick(m);
  };
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
  const away = meshes.every((m) => m.userData.hidden);
  const someAway = !away && meshes.some((m) => m.userData.hidden);
  const many = meshes.length > 1;

  const el = document.createElement('div');
  el.className = 'ctxmenu';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  // `preview` is what the row would do, drawn in the viewport while the pointer
  // is on it. The menu covers a corner of the view and the ghosts are in the
  // middle of it, so a row can show its own answer without being in the way of
  // it — see `flipHover`, which is the one row where the answer is not obvious
  // from the words.
  const item = (label, hint, fn, disabled = false, preview = null) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = disabled;
    b.innerHTML = `<span>${escapeHtml(label)}</span>` + (hint ? `<kbd>${escapeHtml(hint)}</kbd>` : '');
    b.onclick = () => { hideContextMenu(); fn(); };
    if (preview && !disabled) {
      b.addEventListener('pointerenter', () => { flipHover = preview; refreshPreview(); });
      b.addEventListener('pointerleave', () => {
        if (flipHover === preview) { flipHover = null; refreshPreview(); }
      });
    }
    el.appendChild(b);
    return b;
  };

  const head = document.createElement('div');
  head.className = 'ctxhead';
  head.textContent = many
    ? `${meshes.length} objects${meshes[0].userData.group ? ' · group' : ''}`
    : meshes[0].userData.def.label;
  el.appendChild(head);

  if (activeLayer !== null && meshes.every((m) => !m.userData.layer)) {
    // Everything else on this menu edits the map, and the map is not what is
    // being looked at: a lock, a delete or a swap here would reach all twenty
    // venues from inside one of them. Taking it out of the design first is
    // what makes any of those mean this venue and no other.
    item(many ? 'Break these out of the map' : 'Break out of the map', '',
      () => detachIntoLayer(meshes));
    return void mountContextMenu(el);
  }

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

  // Its own band, between locking and everything that edits. Both are about
  // whether a piece is in your way rather than about what the piece is, and
  // neither changes the map. Hide is offered for a locked object too: locking
  // it is a reason to want it out of the way, not a reason to keep looking
  // at it.
  if (away || someAway) item(someAway ? 'Show all' : 'Show', '', () => showObjects(meshes));
  if (!away) item(many ? `Hide ${meshes.length}` : 'Hide', '', () => hideObjects(meshes));

  const sep0 = document.createElement('div');
  sep0.className = 'ctxsep';
  el.appendChild(sep0);

  item('Select', '', () => vp.setSelection(meshes), locked);
  item('Flip across X', '', () => flipSelection(meshes, 'x'), locked,
    { meshes, axis: 'x' });
  item('Flip across Z', '', () => flipSelection(meshes, 'z'), locked,
    { meshes, axis: 'z' });
  item('Swap theme…', '', () => showThemeMenu(x, y, meshes), locked);
  item('Replace…', '', () => openReplace(meshes), locked);
  item('Export prefab…', '', () => exportPrefab(meshes), locked);
  item('Duplicate', 'Ctrl D', () => { vp.setSelection(meshes); duplicate(); }, locked);
  item('Copy', 'Ctrl C', () => { vp.setSelection(meshes); copySelection(); }, locked);
  item('Delete', 'Del', () => { vp.setSelection(meshes); deleteSelection(); }, locked);

  mountContextMenu(el);
}

/** Put a built menu on the page, and keep it there when the click was near an edge. */
function mountContextMenu(el) {
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth) el.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) el.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  contextMenuEl = el;
}

function hideContextMenu() {
  contextMenuEl?.remove();
  contextMenuEl = null;
  // The menu is gone, so the row the pointer was on is gone with it. Nothing
  // else clears this: `pointerleave` does not fire on a button that has been
  // removed from under the pointer.
  if (flipHover) { flipHover = null; refreshPreview(); }
}

/**
 * The theme picker, as a second menu in the place of the first.
 *
 * A second level rather than a panel, because the list is short and the answer
 * is one click: the pointer is already here and the menu is already open. Each
 * row says how many of the selection that theme could take, so a pack with
 * nothing to offer is greyed rather than silently doing nothing, and the one
 * the pieces are already in reads "already there".
 */
function showThemeMenu(x, y, meshes) {
  hideContextMenu();
  const targets = meshes.filter((m) => !m.userData.locked);
  if (!targets.length) return;

  const el = document.createElement('div');
  el.className = 'ctxmenu';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  const options = themeOptions(targets);
  // A spawn zone is offered the other side rather than eleven themes, so the
  // heading has to say which question is being asked.
  const noun = options[0]?.option.team ? 'team' : 'theme';

  const head = document.createElement('div');
  head.className = 'ctxhead';
  head.textContent = targets.length > 1
    ? `Swap ${targets.length} objects to…`
    : `Swap ${noun} to…`;
  el.appendChild(head);

  for (const { option, hits, already } of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !hits;
    b.innerHTML = `<span>${escapeHtml(option.name)}</span>`
      + `<kbd>${hits ? `${hits}/${targets.length}` : already ? '✓' : '—'}</kbd>`;
    b.title = hits
      ? `${hits} of ${targets.length} would become ${option.name}${option.team ? '' : ' pieces'}`
      : already
        ? `Already ${option.name}`
        : `Nothing in the selection has a ${option.name} equivalent`;
    b.onclick = () => { hideContextMenu(); swapTheme(option, targets); };
    el.appendChild(b);
  }

  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  if (r.right > innerWidth) el.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) el.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  contextMenuEl = el;
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
  const swapped = swapInPlace(live.map((m) => [m, def]));
  toast(`Replaced ${swapped} object${swapped === 1 ? '' : 's'} with ${def.label}.`);
}

/**
 * Turn `q` from the way `from`'s mesh lies to the way `to`'s does, and return
 * it. A no-op for the 172 entries that agree, which is nearly all of them.
 *
 * Two pieces in one shape family can be modelled a quarter turn apart —
 * Graffiti's Big Crate runs down Z where Camo's Crate Big runs along X — and
 * `shapeYaw` is where the catalog says so. Without this a swap between the two
 * keeps the rotation it finds, which keeps the *number* and turns the crate;
 * with it the number moves and the crate stays lying where it lay, which is
 * what a theme swap promises.
 *
 * Applied on the right, about the object's own up axis, for the same reason
 * `MODEL_YAW` is: it is a fact about the mesh, not about where the piece
 * stands. So a piece tilted off the floor turns about its own vertical rather
 * than the world's, and comes back to itself if it is swapped back.
 */
function alignShapeYaw(q, from, to) {
  const deg = to.shapeYaw - from.shapeYaw;
  if (!deg) return q;
  return q.multiply(new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180));
}

/**
 * Stand a new object where an old one was, for each `[mesh, def]` pair, and
 * take the old ones away. Returns how many were swapped.
 *
 * Shared by Replace, which points every one at the same entry, and by Swap
 * theme, which gives each its own — the same operation, differing only in how
 * the target is chosen.
 */
function swapInPlace(pairs) {
  const live = pairs.filter(([m, def]) => def && vp.objects.includes(m));
  if (!live.length) return 0;

  const made = [];
  for (const [m, def] of live) {
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
    alignShapeYaw(next.quaternion.copy(q), m.userData.def, def);
    next.scale.copy(s);
    next.userData.group = m.userData.group;
    made.push(next);
  }
  vp.removeObjects(live.map(([m]) => m));
  vp.setSelection(made);
  commit();
  return made.length;
}

// -- swap theme --------------------------------------------------------------
// Rebuilding an arena in another theme, without rebuilding it. Every themed
// pack holds the same pieces in a different material — a Camo barrier corner
// stands for a Default one — and `equivalentIn` is what pairs them up; the
// mirror tool has used it since it could mirror into a second theme. This is
// that mapping applied where the pieces already are.
//
// Anything the target pack has no equivalent for is left exactly as it was
// rather than dropped or turned into a stand-in, and the toast says how many.
// That is the honest answer for a genuinely partial library: Wild West has no
// U barrier and Hatchet Corp has no low one, so half a wall really can have
// nowhere to go.

/**
 * The team families Swap theme offers as a choice of side rather than a theme.
 *
 * A player spawn zone is blue or it is orange, and that is the whole of what it
 * is — no themed pack holds one, so the theme list was twelve greyed rows over a
 * piece whose only real alternative was the other colour. The Mirror panel has
 * offered the sides for exactly this reason since it could mirror into a second
 * theme; this is the same idea in the menu the pointer is already on.
 *
 * A set rather than "anything with a `teamFamily`", because the other two
 * families — the capture flags and the damage boxes — are the same shape of
 * thing and have not been confirmed as wanting it. Adding either is one word
 * here.
 */
const TEAM_SWAP_FAMILIES = new Set(['playerSpawnZone']);

/**
 * What a selection could be swapped into: eleven themes, or — for a piece whose
 * identity is a side rather than a material — the sides.
 *
 * Each option is a name and a `pick`, which is handed one catalog entry and
 * returns what to build in its place, or null for a piece that has no
 * equivalent. That is the same shape `mirrorTargets` uses, and for the same
 * reason: the two menus are asking one question with two answers behind it.
 *
 * The team list appears only when the whole selection is one family, since that
 * is when the answer is unambiguous — a mixed bag of walls and spawn zones is a
 * question about themes again, and the zones go across as themselves.
 */
function swapTargets(targets) {
  const family = targets.length && targets[0].userData.def.teamFamily;
  if (family && TEAM_SWAP_FAMILIES.has(family)
      && targets.every((m) => m.userData.def.teamFamily === family)) {
    return teamVariants(targets[0].userData.def).map((d) => ({
      // The damage boxes have a third member belonging to nobody, and "Neutral
      // Team" is not a thing anybody says.
      name: d.team === 'Neutral' ? 'No team' : `${d.team} Team`,
      team: true,
      pick: (def) => teamVariant(def, d.team),
    }));
  }
  return packsInGroup('virtual').map((p) => ({
    name: p.name, team: false, pick: (def) => equivalentIn(def, p.id),
  }));
}

/** ...and how much of the selection each of them would take. */
function themeOptions(targets) {
  return swapTargets(targets).map((option) => {
    let hits = 0, already = 0;
    for (const m of targets) {
      const to = option.pick(m.userData.def);
      if (!to) continue;
      if (to === m.userData.def) already++;
      else hits++;
    }
    return { option, hits, already };
  });
}

function swapTheme(option, targets) {
  const live = targets.filter((m) => !m.userData.locked && vp.objects.includes(m));
  const pairs = [];
  let missing = 0;
  for (const m of live) {
    const to = option.pick(m.userData.def);
    if (!to) { missing++; continue; }
    if (to !== m.userData.def) pairs.push([m, to]);
  }
  const name = option.name;
  if (!pairs.length) {
    return toast(missing
      ? `Nothing in the selection has a ${name} equivalent.`
      : `Already ${name}.`, !!missing);
  }
  const swapped = swapInPlace(pairs);
  const left = missing ? `, ${missing} left alone with no ${name} equivalent` : '';
  toast(`Swapped ${swapped} object${swapped === 1 ? '' : 's'} to ${name}${left}.`);
  if (!option.team) {
    tip('swaptheme',
      'A theme swap keeps every position, rotation and scale, so it is the same arena in different '
      + 'materials. Pieces the target theme does not have are left where they are.');
  }
}

// -- putting things out of the way -------------------------------------------
// A roof over the room you are building, an outer wall between the camera and
// everything behind it, the mezzanine you finished an hour ago. All of them are
// finished work that is now in the way, and the answer is neither to delete
// them nor to keep fighting them.
//
// Hiding is a way of looking, not a way of building: the objects stay on the
// map, export exactly as they would have done, and come back with an undo. What
// they stop doing is being *there* — no click, no marquee, no drop landing on
// them, and nothing for the wheel or Orbit at cursor to catch on.
//
// The way back is the switch in the toolbar, which brings them into view faded
// so you can find the one you want and put it back for good.

function hideObjects(meshes) {
  if (!meshes.length) return;
  vp.setHidden(meshes, true);
  // Not `commit`: nothing about the map changed, and an undo stack full of
  // "hid a roof" is an undo stack that cannot reach the edit before it. It does
  // go into the *next* snapshot, so an undo taken later does not resurrect it.
  current = snapshot();
  refreshAll();
  const n = meshes.length;
  toast(`Hid ${n} object${n === 1 ? '' : 's'}. Still on the map, still exported — `
    + 'tick Show hidden in the toolbar to find them again.');
  tip('hide',
    'Hidden objects are out of the way of everything, not just out of sight: the camera will not '
    + 'catch on one, a marquee will not pick one up, and a drop will not land on one.');
}

function showObjects(meshes) {
  const away = meshes.filter((m) => m.userData.hidden);
  if (!away.length) return;
  vp.setHidden(away, false);
  current = snapshot();
  refreshAll();
  toast(`Brought back ${away.length} object${away.length === 1 ? '' : 's'}.`);
}

/**
 * Tick Show hidden, from somewhere that is not the switch — the outliner, where
 * clicking a row you cannot see has to do something about not being able to
 * see it. The mirror of `showBoundaries`.
 */
function revealHidden() {
  if (vp.showHidden) return;
  $('show-hidden').checked = true;
  vp.setShowHidden(true);
  buildOutliner();
  toast('Hidden objects shown, faded. Right-click one and pick Show to bring it back for good.');
}

/** The count beside the toolbar switch, so you know there is something to find. */
function refreshHiddenCount() {
  const n = vp.hiddenCount();
  const el = $('hidden-count');
  if (el) el.textContent = n ? `${n}` : '';
  const sw = $('show-hidden');
  if (sw) {
    sw.disabled = !n && !vp.showHidden;
    sw.closest('.sw')?.classList.toggle('idle', !n && !vp.showHidden);
  }
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

/**
 * What each arrow key means, as the *view* reads it: how far right across the
 * screen, and how far away from the camera. Which world axis that turns out to
 * be is the viewport's to work out — see `viewGroundAxes`.
 */
const NUDGE = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
};

let nudgeCommit = null;

/**
 * Step the selection one grid square. A run of them is one undo step: an arrow
 * key held down repeats about thirty times a second, and an edit apiece would
 * push everything else out of the history before the piece had crossed the
 * arena. The run ends when the keys stop, and only then is it recorded.
 */
function nudge(key, vertical) {
  if (!vp.selection.size) return void toast('Select something to nudge.');
  const [right, away] = NUDGE[key];
  // Up and down is the one direction the ground plane has nothing to say
  // about, so Shift lends it the two keys that already mean near and far.
  const moved = vertical && away
    ? vp.nudgeSelection(0, 0, away)
    : vp.nudgeSelection(right, away);
  if (!moved) return;
  refreshPreview();
  clearTimeout(nudgeCommit);
  nudgeCommit = setTimeout(() => { nudgeCommit = null; commit(); }, 350);
  tip('nudge',
    'The arrow keys move the selection the way the view is facing, snapped to the nearest map axis '
    + 'so it stays on the grid. Shift with up and down lifts it instead.');
}

function wireKeyboard() {
  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (typing) return;
    // In the walkaround the keyboard belongs to the player. The arrows would
    // otherwise nudge the selection about while you walked over it, and Escape
    // would clear it on the way out.
    if (vp.previewing) return;
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

    if (!mod && NUDGE[e.key]) { e.preventDefault(); nudge(e.key, e.shiftKey); return; }

    switch (e.key) {
      case 'f': case 'F': vp.frameSelection(); break;
      case 'g': case 'G': e.shiftKey ? ungroupSelection() : groupSelection(); break;
      case 'End':
        if (mod) dropUnderGround();
        else if (e.shiftKey) dropOntoSurface();
        else vp.dropSelection('floor');
        break;
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
    // `pickGroup`, not `expandGroup`: this menu was opened by pointing at
    // something in the view, so it acts on what is in the view. The outliner's
    // own menu uses the unfiltered one, which is what keeps a hidden object
    // reachable at all.
    const meshes = vp.selection.has(hit) && vp.selection.size > 1
      ? [...vp.selection]
      : vp.pickGroup(hit, e.shiftKey);
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
  vp.addEventListener('selection', () => {
    buildSelectionPanel();
    buildOutliner();
    refreshArrayDefaults();
    refreshMirrorTargets();
    // A new selection is a new question for the array tool to answer — except
    // the one the tool makes for itself, which is the answer.
    arrayPreviewOn = !arrayJustApplied;
    arrayJustApplied = false;
    refreshPreview();
    refreshStatus();
  });
  vp.addEventListener('transform', () => {
    // Moving the *design* in a hall is what "placed" means, so the first drag
    // of the alignment handle takes the ghost off it. Nudging one of the
    // venue's own crates is not the same claim and does not count.
    if (activeLayer !== null && vp.isAligning()) markLayerPlaced();
    refreshSelectionValues();
    refreshStatus();
  });
  vp.addEventListener('outside', (e) => warnOutside(e.detail.fresh));
  vp.addEventListener('ground-held', () => warnGroundOnly());
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
  // Both drop targets come through here, so a prefab dropped on the page is
  // placed rather than tried as a map and rejected for not being one -- and a
  // project the same, which is also how one can simply be dropped on the page.
  if (looksLikePrefab(file)) return importPrefabFile(file);
  if (looksLikeProject(file)) return importProjectFile(file);
  confirmDroppingVenues(async () => {
    try {
      await loadMapText(await file.text(), file.name);
    } catch (err) {
      console.error(err);
      toast(`Could not read that file: ${err.message}`, true);
    }
  });
}

/** True for a project file rather than a map, before reading it. */
const looksLikeProject = (file) => (file.name || '').toLowerCase().endsWith(`.${PROJECT_EXT}`);

/**
 * Ask before a map replaces a set of venues, because that is the one thing in
 * here nothing else can put back.
 *
 * A map is a file on disk and a checkpoint is in the browser, but twenty
 * alignments live only in this tab until somebody writes the project out. So
 * the way to keep them is named in the question rather than left to be known.
 */
function confirmDroppingVenues(then) {
  const n = project?.layers.length || 0;
  if (!n) return void then();
  confirmDialog({
    title: 'Open this over the venues?',
    body: `${n} venue${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} loaded, and a different map `
      + 'is a different design for them to be alignments of, so they go with this one. If you want '
      + 'them back, cancel and use Export project first — that is the only thing that keeps them.',
    confirmLabel: 'Open anyway',
    run: then,
  });
}

/** `#b-open` — a file on this computer, or a map from the Spatial Ops library. */
function openSourceChooser() {
  openDialog({
    title: 'Open a map',
    body: 'From a file the game or this editor wrote, or from the maps other players have published.',
    actions: [
      { label: 'From this computer', ghost: true, run: () => openFromDisk() },
      { label: 'Mod.io Library', run: () => openLibraryBrowser() },
    ],
  });
}

/**
 * What "from this computer" means, which depends on whether venues are in play.
 *
 * With LBE mode off there is one kind of file to open and this is a file
 * picker. With it on there are three, and they are different enough acts to be
 * worth choosing between by name rather than by which file you happen to pick:
 * one map, a project to carry on with, or a map together with the halls it is
 * going to be played in.
 *
 * A second screen rather than three more buttons on the first, because the
 * first screen's question is where the map is coming from, and none of these
 * three is an answer to that -- they are all "this computer".
 */
function openFromDisk() {
  if (!lbeOn()) return void $('filepick').click();
  openDialog({
    title: 'Open from this computer',
    body: 'A map on its own, a project to pick up where it was left, or a map together with '
      + 'the venues it will be played in.',
    actions: [
      { label: 'A map', ghost: true, run: () => $('filepick').click() },
      { label: 'A project', ghost: true, run: () => $('projectpick').click() },
      { label: 'Map and venues', run: () => openVenueImport() },
    ],
  });
}

/**
 * Open a project: the map, every venue, and every alignment, as they were left.
 *
 * The map goes through the same ingest every other map does, and the ids stored
 * beside it are put back over the ones the viewport minted on the way in. That
 * is the whole reason the file exists: a venue names the objects it has stopped
 * inheriting, and those names have to still mean the same objects tomorrow.
 */
async function importProjectFile(file) {
  return importProjectBuffer(await file.arrayBuffer(), file.name);
}

async function importProjectBuffer(buffer, sourceName) {
  try {
    const { mapText, ids, editor, layers } = await readProjectArchive(buffer);
    await loadMapText(mapText, sourceName);
    applyProjectIds(ids);
    applyEditorState(editor);
    project.layers = layers;
    // A baseline taken after all of that, so the first Ctrl+Z does not quietly
    // undo the identities and the grouping that were just put back.
    undoStack = []; redoStack = []; current = snapshot();
    refreshAll();

    const n = layers.length;
    const unplaced = layers.filter((l) => !l.placed).length;
    toast(`${map.name} — ${vp.objects.length} objects, ${n} venue${n === 1 ? '' : 's'}`
      + (unplaced ? `, ${unplaced} still to be aligned` : ', all aligned')
      + '. Changes to the map reach every one of them.', unplaced > 0);
  } catch (err) {
    console.error(err);
    toast(`Could not read that project: ${err.message}`, true);
  }
}

/**
 * Put the stored ids back over the ones this session handed out.
 *
 * Both halves, because both are asked: the meshes are what an editing session
 * talks to, and `map.mapObjects` is what an export reads. Then the counters on
 * both sides are wound past whatever came in, since a project is the only thing
 * that reintroduces ids the editor did not issue -- and without that the next
 * object placed would be handed a number a venue is already using.
 */
function applyProjectIds(ids) {
  if (!ids?.length) return;
  const meshes = vp.designObjects();
  ids.forEach((id, i) => {
    if (!Number.isInteger(id)) return;
    if (meshes[i]) meshes[i].userData.id = id;
    if (map.mapObjects[i]) map.mapObjects[i].id = id;
  });
  identifyObjects(map.mapObjects);
  vp.seedObjectIds(nextObjectId());
}

/** Write the whole project out: the map, every template, every alignment. */
async function writeProjectFile() {
  try {
    readLayerFromScene(currentLayer());
    // For its side effects, as in `writeVenueZip`: this is what refreshes
    // `mapObjects` off the viewport and stamps `editedTime`.
    currentMapText();

    const blob = await writeProjectArchive(project, { editor: editorState() });
    const name = projectFileName(map.name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    $('st-file').textContent = name;
    takeCheckpoint('export');
    const n = project.layers.length;
    toast(`Saved ${name} — the map and ${n} venue${n === 1 ? '' : 's'}. Open it again to carry `
      + 'on, and the venues keep the identities they already have on the headsets.');
  } catch (err) {
    console.error(err);
    toast(`Could not write that project: ${err.message}`, true);
  }
}

/**
 * LBE import: the map, and a template per hall it will be played in.
 *
 * Two boxes, because the two files are not the same kind of thing. The map is
 * the design — every object in it, its rules, its author — and there is one of
 * it. A template is a room: walls traced around the spatial anchors on its own
 * wall, built and exported in a headset standing in it. Nothing in a template
 * is exported. What is wanted from it is the half of a map file that says
 * where it is rather than what is in it — the nav cloud and the anchors.
 *
 * Every template is named here, because the name is both the map name the game
 * lists and the first half of the file name, and twenty files all called
 * ARENA-01 are twenty files nobody can tell apart on a headset. The default
 * pairs the map with the template's own name — call a template VEN1_HALL1 in
 * the headset and the name writes itself — and stops being offered for a row
 * the moment somebody types in it.
 *
 * The guid is minted here, once, and kept for the life of the project. That is
 * what makes the second export overwrite the first rather than leaving a second
 * set of twenty maps on every headset in the building.
 */
function openVenueImport() {
  const body = document.createElement('div');

  const intro = document.createElement('p');
  intro.textContent = 'The map is the one being built. A venue template is a hall, exported '
    + 'from a headset standing in it: its boundary walls and its spatial data travel into that '
    + 'venue’s file, and everything else in it stays here to align against. One playable file '
    + 'comes out per venue, plus the map itself.';
  body.appendChild(intro);

  const mapRow = document.createElement('div');
  mapRow.className = 'vrow';
  const mapLabel = document.createElement('div');
  mapLabel.className = 'vfile';
  mapLabel.textContent = 'No map chosen yet';
  const mapPick = document.createElement('button');
  mapPick.className = 'btn ghost';
  mapPick.textContent = 'Choose map';
  mapPick.onclick = () => $('primarypick').click();
  mapRow.append(mapLabel, mapPick);
  body.appendChild(mapRow);

  const venueRow = document.createElement('div');
  venueRow.className = 'vrow';
  const count = document.createElement('div');
  count.className = 'vfile';
  const addPick = document.createElement('button');
  addPick.className = 'btn ghost';
  addPick.textContent = 'Add venues';
  addPick.onclick = () => $('venuepick').click();
  venueRow.append(count, addPick);
  body.appendChild(venueRow);

  const status = document.createElement('p');
  status.className = 'hint';
  status.style.margin = '8px 0 0';
  body.appendChild(status);

  // Twenty halls is an ordinary number of them, so the list scrolls rather than
  // growing the dialog off the bottom of the screen.
  const list = document.createElement('div');
  list.className = 'scroll';
  list.style.cssText = 'max-height:40vh;margin-top:4px';
  body.appendChild(list);

  let primary = null;
  let primaryText = '';
  let primaryFile = '';
  const templates = [];   // { file, map, name, touched }

  const defaultName = (t) => (primary ? venueMapName(primary.name, t.map.name) : t.map.name);

  function renderTemplates() {
    list.innerHTML = '';
    for (const t of templates) {
      const row = document.createElement('div');
      row.className = 'vrow';

      const file = document.createElement('div');
      file.className = 'vfile';
      file.textContent = t.file;
      file.title = `${t.file}\n${t.map.mapObjects.length} objects in this template; its `
        + 'boundary walls travel into the venue, and the rest stays here';

      const kill = document.createElement('button');
      kill.className = 'kill';
      kill.textContent = '×';
      kill.title = 'Take this venue out';
      kill.onclick = () => {
        templates.splice(templates.indexOf(t), 1);
        renderTemplates();
      };

      const name = document.createElement('input');
      name.className = 'vname';
      name.type = 'text';
      name.value = t.name;
      name.placeholder = 'Name the map this venue exports as';
      name.oninput = () => { t.name = name.value; t.touched = true; };

      row.append(file, kill, name);

      // The one thing about a template that cannot be fixed here. A map naming
      // no anchor names nothing the headset can re-localise against, so it
      // lands asking to be aligned by hand — which is the work this exists to
      // abolish, and much cheaper to hear about now than on site.
      if (!(t.map.anchors || []).length) {
        const note = document.createElement('p');
        note.className = 'vnote';
        note.textContent = 'No spatial anchors in this template. Its map will ask to be aligned '
          + 'by hand in the headset instead of landing on its own.';
        row.appendChild(note);
      }

      list.appendChild(row);
    }
    count.textContent = templates.length
      ? `${templates.length} venue${templates.length === 1 ? '' : 's'}`
      : 'No venue templates yet';
  }

  $('primarypick').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      primary = parseMap(text);
      primaryText = text;
      primaryFile = f.name;
      mapLabel.textContent = `${primary.name} — ${primary.mapObjects.length} objects`;
      mapLabel.title = f.name;
      status.textContent = '';
      // A name suggested with no map to pair it with was only ever half a name.
      for (const t of templates) if (!t.touched) t.name = defaultName(t);
      renderTemplates();
    } catch (err) {
      status.textContent = `Could not read ${f.name}: ${err.message}`;
    }
  };

  $('venuepick').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const bad = [];
    for (const f of files) {
      try {
        const t = { file: f.name, map: parseMap(await f.text()), name: '', touched: false };
        t.name = defaultName(t);
        templates.push(t);
      } catch (err) {
        bad.push(`${f.name} (${err.message})`);
      }
    }
    status.textContent = bad.length ? `Not a map file, so left out: ${bad.join(', ')}` : '';
    renderTemplates();
  };

  renderTemplates();

  openDialog({
    title: 'Open a map and its venues',
    body,
    wide: true,
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      {
        label: 'Import',
        keepOpen: true,
        run: async (_v, ui) => {
          if (!primary) {
            return ui.status('Choose the map first — the one with the objects in it.', true);
          }
          const named = templates.map((t) => t.name.trim());
          if (named.some((n) => !n)) {
            return ui.status('Every venue needs a name: it is the map name in the game and the '
              + 'file name on the headset.', true);
          }
          const twice = duplicateName(named);
          if (twice) {
            return ui.status(`Two venues are both called "${twice}". The name is the only `
              + 'thing that tells one from another in the game’s map list.', true);
          }

          ui.close();
          // The map goes through the same ingest every other map does, so a
          // venue import cannot load one differently from a plain open. That
          // resets `project`, which is why the layers are attached afterwards.
          await loadMapText(primaryText, primaryFile);
          for (let i = 0; i < templates.length; i++) {
            project.layers.push(newLayer({
              name: named[i], guid: newGuid(), template: templates[i].map,
            }));
          }
          refreshAll();
          const n = project.layers.length;
          toast(`${map.name} — ${vp.objects.length} objects, ${n} venue${n === 1 ? '' : 's'}. `
            + `An export writes ${n + 1} files.`);
        },
      },
    ],
  });
}

/**
 * A wide dialog: a debounced search over `modioSearch` and a scrolling list of
 * results. Clicking one downloads and unzips it, then hands the text to
 * `loadMapText` — the same ingest point the file picker, the drop handler and
 * checkpoint restore all already share.
 */
function openLibraryBrowser() {
  const body = document.createElement('div');

  const searchRow = document.createElement('div');
  searchRow.className = 'field';
  const label = document.createElement('span');
  label.textContent = 'Search';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Map name, or leave blank for the most popular';
  searchRow.append(label, input);
  body.appendChild(searchRow);

  const status = document.createElement('p');
  status.className = 'hint';
  status.style.margin = '8px 0 0';
  body.appendChild(status);

  const list = document.createElement('div');
  list.className = 'scroll';
  list.style.cssText = 'max-height:46vh;margin-top:6px';
  body.appendChild(list);

  let query = '';
  let offset = 0;
  let loading = false;
  let exhausted = false;
  let debounce = null;
  // Bumped on every reset search, so a slow response for a query the user has
  // since changed (e.g. retyping "rtx" as "RTx" before the first request
  // lands) is dropped instead of overwriting the newer, correct results.
  let searchToken = 0;

  function libModRow(mod) {
    const row = document.createElement('div');
    row.className = 'libmod';
    const img = document.createElement('img');
    img.src = mod.logo?.thumb_320x180 || '';
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'libmeta';
    const name = document.createElement('div');
    name.className = 'libname';
    name.textContent = mod.name;
    const sub = document.createElement('div');
    sub.className = 'libsub';
    const updated = mod.date_updated ? new Date(mod.date_updated * 1000).toLocaleDateString() : '';
    sub.textContent = `${mod.submitted_by?.username || 'unknown'} · `
      + `${mod.stats?.downloads_total ?? 0} downloads · ${updated}`;
    meta.append(name, sub);
    row.append(img, meta);
    row.onclick = async () => {
      if (row.classList.contains('busy')) return;
      row.classList.add('busy');
      try {
        const { text, name: fileName } = await modioFetchMapText(mod);
        closeDialog();
        await loadMapText(text, fileName);
        // A downloaded map carries its author's guid — record which mod it
        // came from, but Export (Part 5) still confirms ownership live before
        // ever offering to treat it as yours to update.
        modioRecordMine(map.guid, mod.id);
        tip('modio-open', 'Downloaded maps keep their author’s ID. Take a New ID, '
          + 'in the Map tab, if you mean to publish this as your own.');
      } catch (err) {
        row.classList.remove('busy');
        toast(`Could not open "${mod.name}": ${err.message}`, true);
      }
    };
    return row;
  }

  async function runSearch(reset) {
    if (reset) { offset = 0; exhausted = false; list.innerHTML = ''; }
    else if (loading || exhausted) return;
    const token = reset ? ++searchToken : searchToken;
    loading = true;
    status.textContent = 'Searching mod.io…';
    try {
      const res = await modioSearch(query, offset);
      if (token !== searchToken) return; // superseded by a newer search
      status.textContent = res.result_total
        ? `${res.result_total} map${res.result_total === 1 ? '' : 's'}`
        : 'No maps found.';
      for (const mod of res.data) list.appendChild(libModRow(mod));
      offset += res.data.length;
      exhausted = res.data.length === 0 || offset >= res.result_total;
    } catch (err) {
      if (token !== searchToken) return;
      status.textContent = `Could not reach mod.io: ${err.message}`;
      exhausted = true;
    } finally {
      if (token === searchToken) loading = false;
    }
  }

  input.addEventListener('input', () => {
    query = input.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(true), 300);
  });
  list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight > list.scrollHeight - 48) runSearch(false);
  });

  openDialog({
    title: 'The map library',
    body,
    wide: true,
    actions: [{ label: 'Cancel', ghost: true, run: () => {} }],
  });
  input.focus();
  runSearch(true);
}

/**
 * Grow the arena box to enclose every object in the map that was just loaded.
 *
 * `mapBoundsSize` is authored data, not something the editor measures — most
 * maps are built with the arena in mind and the two agree. But a map built
 * and re-aligned inside a headset takes its room's play-space as centre, and
 * what comes out the far side can have furniture standing outside the arena
 * its own file still claims. `setBounds` always centres the box on the world
 * origin, so growing it symmetrically is the only fit that keeps the box it
 * draws valid — there is no offset to give it instead.
 *
 * Only grows, never shrinks: a map that already fits its arena is left
 * exactly as authored, and this never second-guesses a deliberately generous
 * one.
 */
function fitBoundsToObjects() {
  const box = vp.allBounds();
  if (box.isEmpty()) return false;
  const margin = 0.25; // a little clearance, so objects don't sit flush on the line
  const needX = 2 * Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) + margin * 2;
  const needZ = 2 * Math.max(Math.abs(box.min.z), Math.abs(box.max.z)) + margin * 2;
  const needY = box.max.y + margin;
  const size = map.mapBoundsSize;
  const fit = {
    x: Math.min(60, Math.max(size.x, Math.ceil(needX))),
    y: Math.min(20, Math.max(size.y, Math.ceil(needY))),
    z: Math.min(60, Math.max(size.z, Math.ceil(needZ))),
  };
  if (fit.x === size.x && fit.y === size.y && fit.z === size.z) return false;
  map.mapBoundsSize = fit;
  return true;
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
  resetLayerView();
  vp.clearObjects();
  // The viewport mints the id an object keeps, and the map object it was built
  // from carries the same one from here on: `toMapObject` hands it back, so
  // every later rebuild of `mapObjects` says the same thing the meshes do. One
  // namespace, because a venue layer names the objects it has stopped
  // inheriting and has to mean the same objects whichever of the two it asks.
  for (const mo of parsed.mapObjects) mo.id = vp.addObject(mo).userData.id;
  // A map arriving is a project starting. Venue layers are an alignment of one
  // particular design, so they do not survive a different map coming in --
  // including a checkpoint being restored, which is one map and never a set.
  project = newProject(map);
  const resized = fitBoundsToObjects();
  applyMapMeta();
  activeRuleSet = 0;
  buildRules();
  await loadNavCloud();
  vp.setSelection([]);
  vp.setView('persp');
  undoStack = []; redoStack = []; current = snapshot();
  vp.refreshOutside(vp.objects, true);
  // Before `refreshAll`, which paints the object bar and would otherwise open
  // the budget dialog on the way past a line this map arrived on the far side
  // of. A map already over the budget was built that way on purpose, and the
  // objects already outside the playable square are somebody else's decision
  // too: both are adopted rather than argued with. Both go back to asking as
  // soon as this session puts a foot over the line.
  adoptMapGuides();
  refreshAll();

  const unknown = new Set(
    vp.objects.filter((m) => m.userData.def.unknown).map((m) => m.userData.def.type)
  );
  const outside = vp.outsideCount();
  let msg = `Loaded "${map.name}" — ${parsed.mapObjects.length} objects.`;
  if (parsed.version !== MAP_VERSION) msg += ` Map format v${parsed.version}, editor targets v${MAP_VERSION}.`;
  if (unknown.size) msg += ` ${unknown.size} type(s) not in any loaded pack: ${[...unknown].join(', ')}.`;
  if (resized) msg += ' Arena boundary grown to fit objects that landed outside it.';
  if (outside) {
    msg += ` ${outside} object${outside === 1 ? '' : 's'} outside the ${PLAYABLE_SIZE} m `
      + 'playable square, marked in red — the headset will not draw those.';
  }
  toast(msg, unknown.size > 0);
  $('st-file').textContent = sourceName;
}

/**
 * Bring `map.mapObjects` up to date with what is on screen, claiming nothing.
 *
 * The design, not everything on screen: a venue's own objects belong to that
 * venue's file and have no business in the map's. Split out from
 * `currentMapText` because the fit check needs the objects fresh and has no
 * business stamping `editedTime` to get them.
 */
function syncMapObjects() {
  map.mapObjects = vp.designObjects().map((m) => vp.toMapObject(m));
}

/** The map as the game would read it. Used by both Export and autosave. */
function currentMapText() {
  map.editedTime = nowStamp();
  map.version = map.version || MAP_VERSION;
  syncMapObjects();
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
/**
 * What the map is missing that the game will notice and the editor cannot fix
 * on its own.
 *
 * A name and an author because both are on screen in the game's map list beside
 * the map, and neither can be added afterwards without re-exporting. Rules
 * because a map with none is a map the game has nothing to play on it: the
 * modes are picked from rule sets, and a file where every one of the five is
 * untouched offers the player no way in.
 *
 * "Untouched" is the same test the Rules panel counts with. A new map carries
 * all five modes with four empty dictionaries each, which is exactly what the
 * game writes when nobody has been near the rules screen — so the presence of a
 * rule set says nothing and the presence of a *setting* says everything.
 */
function exportGaps() {
  return {
    name: UNNAMED(map.name),
    author: !map.author.trim(),
    rules: !(map.ruleSets || []).some((rs) => overrideCount(rs) > 0),
  };
}

function exportMap() {
  const gaps = exportGaps();
  if (tipsOn() && (gaps.name || gaps.author || gaps.rules)) {
    promptForMapDetails(gaps);
    return;
  }
  chooseExportDestination();
}

/**
 * Hand the browser one map file, named the way the game wants it.
 *
 * Not application/json: `download` names the file without an extension, and
 * browsers append one inferred from the MIME type when it is missing. A JSON
 * type gets ".json" bolted on and the game will not read the file.
 */
function downloadMapFile(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function writeMapFile() {
  try {
    const text = currentMapText();
    const name = mapFileName(map.name, map.guid);
    downloadMapFile(text, name);
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

/**
 * The last look at what an export is about to write, one row per file.
 *
 * The name is the only thing on this screen that cannot be fixed afterwards
 * without exporting again: the game lists maps by it, the file is called after
 * it, and twenty arenas in one building are told apart by nothing else. So it
 * is here, editable, with the file name it produces underneath — and the two
 * things that make a venue's file not work are said out loud rather than left
 * to be discovered on site.
 */
async function openVenueExport() {
  // Whatever is on screen for the venue being looked at belongs to that venue
  // before any of it is counted. Read rather than banked: an export has no
  // business clearing the venue off the screen on its way past.
  readLayerFromScene(currentLayer());
  syncMapObjects();

  // Every hall's play space, decoded once, so each row can say whether the
  // design actually lands inside the boundary somebody walked in that room.
  // The last chance to hear it: after this the files are on a headset and the
  // next person to find out is standing in the building.
  //
  // Measured over the variants themselves -- the very maps the export is about
  // to write -- rather than over a second calculation that would have to be
  // trusted to agree with them. Primary first, then one per layer, which is
  // the order the rows below are built in.
  // Walls the design carries, which a venue supplies for itself and therefore
  // leaves behind. Not expected to be any, and worth saying out loud when there
  // are: an object in the map that is not in any venue's file is exactly the
  // kind of thing somebody goes looking for later.
  const strays = (map.mapObjects || []).filter(isBoundaryObject).length;

  const spaces = [];
  for (const variant of projectVariants(project)) {
    try {
      const mask = await decodeNavCloud(variant.navCloud?.encodedPoints || '');
      spaces.push({
        painted: paintedCells(mask),
        outside: objectsOutsidePlaySpace(variant, mask).length,
      });
    } catch {
      // A play space that will not decode is one this cannot speak about.
      spaces.push({ painted: 0, outside: 0 });
    }
  }

  const rows = [
    {
      label: 'The map itself',
      name: map.name,
      guid: map.guid,
      anchors: (map.anchors || []).length,
      placed: true,
      venue: false,
      space: spaces[0] || {},
      apply: (n) => { map.name = n; },
    },
    ...project.layers.map((l, i) => ({
      label: `From ${l.template.name}`,
      name: l.name,
      guid: l.guid,
      anchors: (l.template.anchors || []).length,
      placed: l.placed,
      venue: true,
      space: spaces[i + 1] || {},
      apply: (n) => { l.name = n; },
    })),
  ];

  const body = document.createElement('div');
  const intro = document.createElement('p');
  intro.textContent = rows.length === 1
    ? 'One map, in a zip. No venues have been added yet — Open, from this computer, map and '
      + 'venues is where the halls come in.'
    : `${rows.length} files, in one zip. Unpack it and copy the lot into the game’s maps `
      + 'folder — each one is a whole playable map, carrying the objects from here and the '
      + 'spatial data of the venue it is for.';
  body.appendChild(intro);

  const list = document.createElement('div');
  list.className = 'scroll';
  list.style.cssText = 'max-height:46vh;margin-top:4px';
  body.appendChild(list);

  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'vrow';

    const label = document.createElement('div');
    label.className = 'vfile';
    label.textContent = row.label;

    const name = document.createElement('input');
    name.className = 'vname';
    name.type = 'text';
    name.value = row.name;
    name.placeholder = 'Name this map';

    const out = document.createElement('p');
    out.className = 'vout';
    const redraw = () => {
      row.name = name.value;
      out.textContent = mapFileName(name.value.trim() || 'Map', row.guid);
    };
    name.oninput = redraw;
    redraw();

    el.append(label, document.createElement('span'), name, out);

    if (!row.anchors) {
      const note = document.createElement('p');
      note.className = 'vnote';
      note.textContent = 'No spatial anchors: this one will ask to be aligned by hand in the '
        + 'headset instead of landing on its own.';
      el.appendChild(note);
    }
    if (!row.placed) {
      const note = document.createElement('p');
      note.className = 'vnote';
      note.textContent = 'Never aligned. The map will sit wherever its own origin falls in this '
        + 'venue, which is almost certainly not where you want it.';
      el.appendChild(note);
    }
    if (row.venue && strays) {
      const note = document.createElement('p');
      note.className = 'vnote';
      note.textContent = `${strays} boundary object${strays === 1 ? '' : 's'} in the map `
        + `${strays === 1 ? 'is' : 'are'} left out of this file. A venue is played inside the `
        + 'walls of its own room, and those are the ones it carries.';
      el.appendChild(note);
    }
    if (!row.space.painted) {
      const note = document.createElement('p');
      note.className = 'vnote';
      note.textContent = 'No play space recorded. Nobody walked a boundary in this room, so the '
        + 'file carries an empty one — the game has nothing to hold a player inside, and there '
        + 'is nothing here to check the map against.';
      el.appendChild(note);
    } else if (row.space.outside) {
      const n = row.space.outside;
      const note = document.createElement('p');
      note.className = 'vnote';
      note.textContent = `${n} object${n === 1 ? '' : 's'} outside the play space walked in this `
        + `room. ${n === 1 ? 'It is' : 'They are'} in the file, and nobody can reach `
        + (n === 1 ? 'it.' : 'them.');
      el.appendChild(note);
    }

    list.appendChild(el);
  }

  /**
   * Take the names off the screen, or say what is wrong with them.
   *
   * Shared by both buttons, because the names belong to the project as much as
   * to the files: saving the project with one set and writing the maps with
   * another is the one way this screen could lie.
   */
  const settleNames = (ui) => {
    const named = rows.map((r) => r.name.trim());
    if (named.some((n) => !n)) {
      ui.status('Every map needs a name: it is what the game lists it under.', true);
      return false;
    }
    const twice = duplicateName(named);
    if (twice) {
      ui.status(`Two of these are both called "${twice}". The name is the only thing that `
        + 'tells one from another in the game’s map list.', true);
      return false;
    }
    rows.forEach((r, i) => r.apply(named[i]));
    return true;
  };

  openDialog({
    title: rows.length === 1 ? 'Export' : 'Export every venue',
    body,
    wide: true,
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      {
        // Named for what is on screen, because that is what it writes -- one
        // file, for the venue being looked at. Re-exporting a single hall
        // after a change meant for that hall alone is a normal thing to want,
        // and unpacking a zip of twenty to find one of them is not.
        label: activeLayer === null ? 'Export the map only' : 'Export this venue only',
        ghost: true,
        keepOpen: true,
        run: (_v, ui) => { if (settleNames(ui)) { ui.close(); writeCurrentVariant(); } },
      },
      {
        label: 'Export project',
        ghost: true,
        keepOpen: true,
        run: (_v, ui) => { if (settleNames(ui)) { ui.close(); writeProjectFile(); } },
      },
      {
        label: 'Export maps zip',
        keepOpen: true,
        run: (_v, ui) => { if (settleNames(ui)) { ui.close(); writeVenueZip(); } },
      },
    ],
  });
}

/**
 * One file: whichever map is being looked at.
 *
 * The venue on screen, or the map itself when none is. Same bytes that map
 * would have in the zip -- built from the same fan-out and written by the same
 * writer, so a hall re-exported on its own is the hall the whole set carries.
 */
function writeCurrentVariant() {
  try {
    readLayerFromScene(currentLayer());
    currentMapText();

    // `projectVariants` is the map first, then one per layer, in order.
    const variant = projectVariants(project)[activeLayer === null ? 0 : activeLayer + 1];
    const name = mapFileName(variant.name, variant.guid);
    downloadMapFile(serializeMap(variant), name);

    $('st-file').textContent = name;
    takeCheckpoint('export');
    toast(`Exported ${name} — ${variant.mapObjects.length} objects. Copy it into the game's `
      + 'maps folder with no file extension.');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, true);
  }
}

/**
 * Every venue's map, in one zip.
 *
 * One file per venue plus the map itself, because that is what goes onto a
 * headset — and as separate downloads a browser would block all but the first
 * few of twenty. The archive unpacks to exactly the files the game reads, with
 * no extension on any of them.
 */
async function writeVenueZip() {
  try {
    // For its side effects: this is what refreshes `mapObjects` off the
    // viewport and stamps `editedTime`, so the map in the zip is the same
    // bytes a plain export of it would write.
    currentMapText();

    const files = projectVariants(project).map((m) => ({
      name: mapFileName(m.name, m.guid),
      data: serializeMap(m),
    }));
    // `zipWrite` hands back a Blob already; it is rewrapped below only to put
    // a type on it, since a Blob's type is fixed at construction.
    const zip = await zipWrite(files);
    const stem = String(map.name || 'Map').replace(/[\\/:*?"<>|]/g, '').trim() || 'Map';
    const zipName = `${stem} venues.zip`;

    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);

    $('st-file').textContent = zipName;
    takeCheckpoint('export');
    refreshAll();
    toast(`Exported ${zipName} — ${files.length} maps. Unpack it and copy them into the game's `
      + 'maps folder, with no file extension on any of them.');
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, true);
  }
}

function promptForMapDetails(gaps = exportGaps()) {
  const body = document.createElement('div');

  // The two that can be fixed here, in the dialog itself.
  const needsDetails = gaps.name || gaps.author;
  if (needsDetails) {
    const missing = gaps.name && gaps.author ? 'a name and an author'
      : gaps.name ? 'a name' : 'an author';
    const p = document.createElement('p');
    p.textContent = `This map still needs ${missing}. Both are shown in the game's map list, and `
      + 'the name becomes the file name — a folder of maps all called "New Map" is hard to sort '
      + 'out later. Fill them in here, or export as it is.';
    body.appendChild(p);
  }

  // ...and the one that cannot: a rule set is half a screenful of settings and
  // belongs in the panel built for it, not in a box in front of an export. So
  // this says what is wrong and offers the way there.
  if (gaps.rules) {
    const p = document.createElement('p');
    p.style.marginBottom = '0';
    p.innerHTML = needsDetails
      ? '<b>No game rules have been set either.</b> '
      : '<b>No game rules have been set.</b> ';
    p.append('The game picks its modes from the rule sets a map carries, and every one of this '
      + "map's five is still exactly as it came — so the map will load with nothing to play on "
      + 'it. Open the Rules tab and set up at least the mode you built this map for.');
    body.appendChild(p);
  }

  openDialog({
    title: 'Before you export',
    body,
    fields: needsDetails ? [
      { id: 'dlg-name', label: 'Name', value: gaps.name ? '' : map.name, placeholder: 'Map name' },
      { id: 'dlg-author', label: 'Author', value: map.author, placeholder: 'Your name' },
    ] : [],
    // Going to the Rules tab ends the export rather than continuing it, which
    // is the point: there is work to do there before this map is worth writing
    // out. It is offered alongside Save and export rather than instead of it
    // when both are wrong, so neither piece of advice is the price of the
    // other — and it comes last when it is the only thing wrong, since Enter
    // and the eye both land on the last button.
    actions: [
      { label: 'Export anyway', ghost: true, run: () => chooseExportDestination() },
      ...(gaps.rules ? [{
        label: 'Go to Rules',
        ghost: needsDetails,
        run: () => {
          showInspectorTab('rules', true);
          toast('Pick a mode and set its rules, then export again.');
        },
      }] : []),
      ...(needsDetails ? [{
        label: 'Save and export',
        run: (values) => {
          if (values['dlg-name'].trim()) map.name = values['dlg-name'].trim();
          map.author = values['dlg-author'].trim();
          touchEdited();
          refreshMeta();
          chooseExportDestination();
        },
      }] : []),
    ],
  });
}

/**
 * The zip a map leaves the editor in, whichever way it leaves. Kept behind one
 * function so the layout is a two-line change if the archive needs one.
 */
function modfileArchive(text, name) {
  return zipWrite([{ name, data: text }]);
}

/**
 * The header the game submits beside a map, rebuilt field for field: its own
 * key casing, its own order, the bounds split into three. mod.io keeps it as
 * an opaque string, and the library shows what a map published without one
 * costs — no size, no guid, nothing to match a download against.
 */
function mapMetadataBlob() {
  return JSON.stringify({
    Guid: map.guid,
    EditedTime: map.editedTime,
    MapWidth: map.mapBoundsSize.x,
    MapHeight: map.mapBoundsSize.y,
    MapDepth: map.mapBoundsSize.z,
  });
}

/**
 * `Ctrl+S`, `#b-save`, and both buttons in `promptForMapDetails` all land here:
 * write the file, or publish it. Export to computer is the focused default —
 * with no token saved this is also the only enabled destination — so the old
 * `Ctrl+S`, `Enter` muscle memory still writes the file.
 */
function chooseExportDestination() {
  // In LBE mode there is no destination to choose. Mod.io publishes one map and
  // this is a set of them -- near-identical arenas, each tied by its anchors to
  // a room in one particular building, is not what the library is for. So the
  // chooser is skipped rather than offering a route that would then have to be
  // explained away.
  //
  // On the switch alone, not on whether any venues have been added yet: the
  // mode is the answer to "is this going to a venue", and a project with no
  // venues in it yet is still on its way to one.
  if (lbeOn()) return void openVenueExport();

  const token = modioToken();
  const username = modioCachedUsername();
  const signedIn = !!(token && username);

  const body = document.createElement('div');
  const intro = document.createElement('p');
  intro.textContent = 'Write the map out as a file, or publish it for other players.';
  body.appendChild(intro);

  if (signedIn) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 4px';
    const who = document.createElement('span');
    who.className = 'hint';
    who.style.margin = '0';
    who.textContent = `Signed in to mod.io as ${username}`;
    const signOut = document.createElement('button');
    signOut.className = 'btn ghost';
    signOut.textContent = 'Sign out';
    signOut.onclick = () => { modioForgetToken(); closeDialog(); chooseExportDestination(); };
    row.append(who, signOut);
    body.appendChild(row);
  }

  openDialog({
    title: 'Export',
    body,
    actions: signedIn
      ? [
        { label: 'Export to Mod.io Library', run: () => openUploadDialog() },
        { label: 'Export to computer', run: () => writeMapFile() },
      ]
      : [
        { label: 'Sign in to mod.io', ghost: true, run: () => openSignInDialog() },
        { label: 'Export to computer', run: () => writeMapFile() },
      ],
  });
}

/**
 * mod.io's personal access tokens (mod.io/me/access) are bound to the account
 * they were issued for, not to a game — `POST /games/11054/mods` answers
 * "does not grant access to this resource" no matter which scopes are ticked,
 * and a game-scoped token isn't offered unless the account is on the Spatial
 * Ops team. A user OAuth token is the right instrument instead: mod.io emails
 * a code, and exchanging it hands back a token that represents the person and
 * can publish to any game that accepts community submissions.
 */
function openSignInDialog() {
  openDialog({
    title: 'Sign in to mod.io',
    body: 'mod.io will email you a 5-digit code to confirm it is you.',
    fields: [{ id: 'email', label: 'Email', placeholder: 'you@example.com' }],
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      {
        label: 'Send code',
        keepOpen: true,
        run: async (values, ui) => {
          const email = values.email.trim();
          if (!email.includes('@')) { ui.status('That does not look like an email address.', true); return; }
          ui.busy(true);
          ui.enable('Send code', false);
          try {
            ui.status('Emailing a code…');
            await modioRequestEmailCode(email);
            ui.close();
            openCodeDialog();
          } catch (err) {
            ui.status(err.message, true);
            ui.enable('Send code', true);
            ui.busy(false);
          }
        },
      },
    ],
  });
}

function openCodeDialog() {
  openDialog({
    title: 'Enter the code',
    body: 'Check your email for a 5-digit code from mod.io.',
    fields: [{ id: 'code', label: 'Code', placeholder: '12345' }],
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      {
        label: 'Verify',
        keepOpen: true,
        run: async (values, ui) => {
          const code = values.code.trim();
          ui.busy(true);
          ui.enable('Verify', false);
          try {
            ui.status('Checking…');
            const token = await modioExchangeEmailCode(code);
            const me = await modioValidateToken(token);
            modioSaveToken(token, me.username);
            ui.close();
            chooseExportDestination();
          } catch (err) {
            ui.status(err.message, true);
            ui.enable('Verify', true);
            ui.busy(false);
          }
        },
      },
    ],
  });
}

/**
 * Publish the map to mod.io — new, or an update to a mod already owned. The
 * logo is a top-down shot taken automatically when the dialog opens; there is
 * no way to override it with a custom image for now. Ownership is never
 * trusted from `spatialops.modio.mine` alone — a downloaded map records the
 * mod it came from too — so it is confirmed live against `GET /me/mods`
 * before the update option is offered.
 */
// -- the thumbnail somebody brings themselves ---------------------------------
// A map's picture on mod.io is the whole of its first impression, and a render
// of the arena is not always the best one anybody has — a poster, a photograph
// of the room the map was built for, a shot taken in the headset.
//
// It is not on the panel because it is not for everyone. A library of maps whose
// thumbnails are pictures of something other than the map is a library nobody
// can browse, and the honest default — this is what the map looks like — is the
// one worth keeping in front of the person who has not thought about it. So the
// door exists and is not signposted: five clicks on the wordmark, which is a
// thing nobody does by accident and anybody can be told.
//
// The wordmark itself gets no hover, no cursor and no pressed state. A control
// that looks like a control has been signposted.

const CUSTOM_LOGO_CLICKS = 5;
let customLogoUnlocked = false;
let brandClicks = 0;
let brandClickTimer = null;

function wireBrand() {
  const brand = $('brand');
  if (!brand) return;
  brand.addEventListener('click', () => {
    if (customLogoUnlocked) return;
    brandClicks++;
    // The run has to be a run. Left to accumulate for ever, a click a day for
    // five days would open it, which is not a gesture anybody made.
    clearTimeout(brandClickTimer);
    brandClickTimer = setTimeout(() => { brandClicks = 0; }, 2500);
    if (brandClicks < CUSTOM_LOGO_CLICKS) return;
    customLogoUnlocked = true;
    toast('Custom export image enabled for this session.');
  });
}

/**
 * Ask for a picture, crop and badge it, and hand it back. The input is reused
 * and its value cleared, so choosing the same file twice in a row still fires.
 */
function pickCustomLogo(done) {
  const input = $('logopick');
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      done(await brandImage(file));
    } catch (err) {
      console.error(err);
      toast(`That image could not be read: ${err.message}`, true);
    }
  };
  input.click();
}

async function openUploadDialog() {
  const body = document.createElement('div');

  const shot = document.createElement('img');
  shot.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:4px;'
    + 'background:var(--panel2);display:block';
  body.appendChild(shot);

  let logoBlob = null;
  const setLogo = (blob) => { logoBlob = blob; shot.src = URL.createObjectURL(blob); };
  shot.style.margin = '0 0 8px';

  // What the picture is, said once. The shot is taken from wherever the editor
  // was looking when Export was pressed, and the only way to change it is to
  // close this, frame the map, and press Export again — so the sentence is
  // worth the two lines it costs.
  const shotNote = document.createElement('p');
  shotNote.className = 'hint';
  shotNote.style.cssText = 'margin:0 0 14px';
  shotNote.textContent = customLogoUnlocked
    ? 'Taken from the view as you left it. Close this and reframe the map to take another, '
      + 'or use a picture of your own.'
    : 'Taken from the view as you left it. Close this and reframe the map to take another.';
  body.appendChild(shotNote);

  if (customLogoUnlocked) {
    const choose = document.createElement('button');
    choose.className = 'btn ghost';
    choose.style.cssText = 'margin:0 0 14px';
    choose.textContent = 'Upload an image…';
    choose.title = 'Use a picture of your own. It is cropped to fill 16:9 and badged the '
      + 'same way a screenshot is.';
    choose.onclick = () => pickCustomLogo(setLogo);
    body.appendChild(choose);
  }

  // The library sorts by game mode, so this is the difference between a map
  // other players can find and one only its author ever sees. Shown before the
  // upload rather than after, while adding the missing spawn zone is still a
  // matter of closing the dialog.
  const modeTags = modeTagsFor(map.ruleSets, placedTypes());
  const modes = document.createElement('p');
  modes.className = 'hint';
  modes.textContent = `Listed under: ${modeTags.join(', ')}. `
    + 'A mode needs its rule set and its objectives before the library lists the map under it.';
  body.appendChild(modes);

  const mineId = modioMineMap()[map.guid];
  let owned = null;
  if (mineId) {
    try {
      const mine = await modioMyMods();
      owned = mine.find((m) => m.id === mineId) || null;
    } catch { /* couldn't confirm — treat as not owned, publishing as new is always safe */ }
  }

  let updateMode = !!owned;
  if (owned) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.innerHTML = `You have published this map before, as <b>${owned.name}</b> — `
      + `${owned.stats?.subscribers_total ?? 0} subscribers.`;
    body.appendChild(note);

    const choice = document.createElement('div');
    choice.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:12px';
    const updateOpt = document.createElement('label');
    updateOpt.className = 'flagopt';
    updateOpt.innerHTML = '<input type="radio" name="modio-mode" checked> Update it';
    const newOpt = document.createElement('label');
    newOpt.className = 'flagopt';
    newOpt.innerHTML = '<input type="radio" name="modio-mode"> Publish as a separate map';
    choice.append(updateOpt, newOpt);
    body.appendChild(choice);
    updateOpt.querySelector('input').onchange = () => { updateMode = true; };
    newOpt.querySelector('input').onchange = () => { updateMode = false; };
  }

  openDialog({
    title: 'Upload to the map library',
    body,
    wide: true,
    fields: [
      { id: 'title', label: 'Title', value: owned ? owned.name : map.name },
      { id: 'summary', label: 'Summary', type: 'textarea', value: owned ? owned.summary : '' },
      // Shown whenever an update is even possible; ignored at submit time if
      // "Publish as a separate map" ends up chosen instead.
      ...(owned ? [
        { id: 'version', label: 'Version', placeholder: '1.0.0' },
        { id: 'changelog', label: 'Changelog', type: 'textarea', placeholder: 'What changed' },
      ] : []),
    ],
    actions: [
      { label: 'Cancel', ghost: true, run: () => {} },
      {
        label: 'Upload',
        keepOpen: true,
        run: async (values, ui) => {
          ui.busy(true);
          ui.enable('Cancel', false);
          ui.enable('Upload', false);
          try {
            if (!logoBlob) { ui.status('Rendering a shot of the map…'); logoBlob = await vp.captureMapImage(); shot.src = URL.createObjectURL(logoBlob); }
            ui.status('Zipping the map…');
            const zip = await modfileArchive(currentMapText(), mapFileName(map.name, map.guid));
            const tags = modeTags;

            let modId = updateMode && owned ? owned.id : null;
            let modResult = owned;
            if (!modId) {
              ui.status('Creating the mod.io entry…');
              modResult = await modioAddMod({
                name: values.title, summary: values.summary, logo: logoBlob, visible: true,
                tags, metadataBlob: mapMetadataBlob(),
              });
              modId = modResult.id;
            } else {
              // Always re-sent, even when the title and summary are unchanged —
              // otherwise a retaken screenshot never reaches mod.io on an update.
              ui.status('Updating the mod.io entry…');
              modResult = await modioEditMod(modId, {
                name: values.title, summary: values.summary, logo: logoBlob,
                metadataBlob: mapMetadataBlob(),
              });
              // Tags are their own endpoints, and a map that gained a flag or
              // lost a spawn zone since the last upload has to lose the tag
              // with it — only the mode tags are ours to touch, so anything
              // else the map carries is left where it is.
              const had = (owned.tags || []).map((t) => t.name);
              const ours = Object.values(MODE_TAGS);
              await modioDeleteTags(modId, had.filter((t) => ours.includes(t) && !tags.includes(t)));
              await modioAddTags(modId, tags.filter((t) => !had.includes(t)));
            }

            ui.status('Uploading the map file…');
            const fileMeta = updateMode ? { version: values.version, changelog: values.changelog } : {};
            await modioAddModfile(modId, { zip, ...fileMeta });

            modioRecordMine(map.guid, modId);
            takeCheckpoint('export');

            const modUrl = modResult?.profile_url || `https://mod.io/g/spatial-ops/m/${modId}`;
            ui.close();
            toast(`${updateMode ? 'Updated' : 'Published'} "${values.title}" on mod.io.`);
            openDialog({
              title: updateMode ? 'Map updated' : 'Map published',
              body: `"${values.title}" is ${updateMode ? 'updated' : 'now live'} on mod.io.`,
              actions: [
                { label: 'Close', ghost: true, run: () => {} },
                { label: 'View on mod.io', run: () => window.open(modUrl, '_blank', 'noopener') },
              ],
            });
          } catch (err) {
            ui.status(err?.errors ? `${err.message} (${Object.values(err.errors).join(', ')})` : err.message, true);
            ui.enable('Cancel', true);
            ui.enable('Upload', true);
            ui.busy(false);
          }
        },
      },
    ],
  });

  setLogo(await vp.captureMapImage());
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
// A handful of moments deserve more than a toast that fades in five seconds:
// the export reminder, and confirming something destructive. `confirm()` would
// do the job in three characters, but it freezes the page — including the
// render loop — and cannot say more than one line, so this builds its own.

let dialogClose = null;

/**
 * The export prompt, the prefab prompt, both destructive confirmations, and —
 * with the additions below — the mod.io token/upload dialogs, all built on one
 * function.
 *
 * `body` may be a string or a `Node` (a link, an image preview). A field may
 * set `type: 'textarea'|'password'` (default `'text'`), a `hint` shown under
 * it, and an `oninput(value, ui)` for live validation. An action may set
 * `keepOpen` (its `run` gets a `ui` handle and decides when to close) and
 * `disabled` (starts greyed out; toggle with `ui.enable`). `run` is always
 * called with `(values, ui)` — `ui.status(text, isError)`, `ui.busy(on)`
 * (blocks Escape while true, for a dialog mid-upload), `ui.enable(label, on)`,
 * `ui.close()`.
 */
function openDialog({ title, body, fields = [], actions, wide }) {
  closeDialog();
  const veil = $('veil');
  const box = document.createElement('div');
  box.className = 'dlg' + (wide ? ' wide' : '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');

  const h = document.createElement('h3');
  h.textContent = title;
  box.appendChild(h);

  const closeX = document.createElement('button');
  closeX.className = 'x-close';
  closeX.setAttribute('aria-label', 'Close');
  closeX.textContent = '×';
  closeX.onclick = () => { if (!busy) closeDialog(); };
  box.appendChild(closeX);

  if (body != null) {
    if (body instanceof Node) {
      box.appendChild(body);
    } else {
      const p = document.createElement('p');
      p.textContent = body;
      box.appendChild(p);
    }
  }

  const inputs = {};
  for (const f of fields) {
    const row = document.createElement('div');
    row.className = 'field';
    const label = document.createElement('span');
    label.textContent = f.label;
    const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
    if (f.type === 'password') input.type = 'password';
    else if (f.type !== 'textarea') input.type = 'text';
    input.id = f.id;
    input.value = f.value || '';
    input.placeholder = f.placeholder || '';
    inputs[f.id] = input;
    row.append(label, input);
    if (f.hint) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = f.hint;
      row.appendChild(hint);
    }
    box.appendChild(row);
    if (f.oninput) input.addEventListener('input', () => f.oninput(input.value, ui));
  }

  const status = document.createElement('p');
  status.className = 'status';
  status.hidden = true;
  box.appendChild(status);

  const acts = document.createElement('div');
  acts.className = 'acts';
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const buttons = {};
  const run = (a) => {
    if (a.disabled) return;
    const v = values();
    if (a.keepOpen) a.run(v, ui);
    else { closeDialog(); a.run(v); }
  };
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn' + (a.ghost ? ' ghost' : '');
    b.textContent = a.label;
    b.disabled = !!a.disabled;
    b.onclick = () => run(a);
    buttons[a.label] = b;
    acts.appendChild(b);
  }
  box.appendChild(acts);

  veil.innerHTML = '';
  veil.appendChild(box);
  veil.classList.add('show');

  let busy = false;
  const ui = {
    status(text, isError) {
      status.textContent = text || '';
      status.hidden = !text;
      status.classList.toggle('bad', !!isError);
    },
    busy(on) { busy = on; },
    enable(label, on) {
      const a = actions.find((x) => x.label === label);
      const b = buttons[label];
      if (a) a.disabled = !on;
      if (b) b.disabled = !on;
    },
    close() { closeDialog(); },
  };

  // Escape cancels, which is always the last action listed — the harmless
  // one — unless a dialog has marked itself busy (an upload in flight).
  const onKey = (e) => {
    if (busy) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    if (e.key === 'Enter' && fields.length && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      run(actions[actions.length - 1]);
    }
  };
  addEventListener('keydown', onKey, true);
  // A click that lands on the veil itself, not something inside the box,
  // means outside the dialog — the same "never mind" as Escape or the X.
  veil.onclick = (e) => { if (e.target === veil && !busy) closeDialog(); };
  dialogClose = () => {
    removeEventListener('keydown', onKey, true);
    veil.onclick = null;
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
// Warnings
// ---------------------------------------------------------------------------
// Three things the editor will happily let you do that the game will not thank
// you for, and none of them shows up until the map is in a headset:
//
//   the object budget   past about 700 objects the frame rate goes, and a map
//                       that stutters is not a better map for having more in it
//   the playable square the game draws a 60 m square and nothing outside it, so
//                       an object placed entirely beyond that is simply absent
//   enemy spawns        bots arrive on the ground under the pad wherever the pad
//                       is, so a spawner on a rooftop delivers them into
//                       whatever is standing below it
//
// All three are advice rather than rules, and all three are dismissible,
// because the person building the map knows things this editor does not.
// Dismissal lasts the session and no longer: it is not written to storage,
// since a limit silently switched off two weeks ago is worse than no limit.
//
// The third has no override — it is held rather than warned about, because a
// spawner off the ground is not a trade-off anyone would knowingly make. The
// dialog explains why the piece would not stay where it was put.

/** Where the frame rate starts to go, in objects. */
const OBJECT_BUDGET = 700;

let budgetOverride = false;    // "I know what I'm doing", for this session
let budgetWarned = false;      // the count is over and has been mentioned
let outsideDismissed = false;  // don't mention the playable square again
let groundWarned = false;      // the enemy-spawn explanation has been given

/**
 * Paint the bar at the foot of the window, and speak up on the way past the
 * line.
 *
 * The warning fires on the *crossing*, not on every object placed past it:
 * `budgetWarned` latches on the way up and is cleared again when the count
 * comes back under, so deleting thirty objects and adding them back asks once
 * more, and nudging the four hundredth object into place asks not at all.
 */
/**
 * The bar's colour at a given fraction of the budget: green, through amber, to
 * red at the line.
 *
 * A slide rather than three steps, because the question the bar answers is how
 * much room is left rather than whether the line has been crossed — and a bar
 * that stays green until it suddenly is not answers the second one only. Hue
 * alone moves; holding saturation and lightness keeps every point on the slide
 * as legible as every other, which stepping through named colours does not.
 *
 * The green end is held for the first quarter. A map of forty objects is not
 * "slightly full", and shading it towards amber would say it was.
 */
function budgetColour(ratio) {
  const t = Math.min(1, Math.max(0, (ratio - 0.25) / 0.75));
  // 142° is the green the rest of the editor uses; 0° is the danger red.
  return `hsl(${(142 * (1 - t)).toFixed(0)} 62% 52%)`;
}

function refreshBudget() {
  const n = vp.objects.length;
  const el = $('budget');
  if (!el) return;
  const over = n > OBJECT_BUDGET;
  const ratio = n / OBJECT_BUDGET;
  $('budget-count').innerHTML = `<b>${n}</b> / ${OBJECT_BUDGET}`;
  const fill = $('budget-fill');
  fill.style.width = `${Math.min(100, ratio * 100)}%`;
  // The class handles the two states off the slide; everything else is a colour.
  fill.style.backgroundColor = budgetOverride ? '' : budgetColour(ratio);
  el.classList.toggle('free', budgetOverride);
  el.classList.toggle('over', !budgetOverride && over);
  el.title = budgetOverride
    ? `${n} objects. The ${OBJECT_BUDGET} object guide is off for this session.`
    : over
      ? `${n} objects — past the ${OBJECT_BUDGET} a headset comfortably draws. Expect the frame `
        + 'rate to drop where the most is in view at once.'
      : `${n} of about ${OBJECT_BUDGET} objects — the number a headset comfortably draws. `
        + `Room for ${OBJECT_BUDGET - n} more.`;

  if (!over) { budgetWarned = false; return; }
  if (budgetWarned || budgetOverride) return;
  budgetWarned = true;
  openDialog({
    title: 'That is a lot of objects',
    body: `This map is up to ${n} objects. Past about ${OBJECT_BUDGET} the headset starts `
      + 'to struggle — the map is still playable and still exports normally, but expect the '
      + 'frame rate to drop, and expect it to drop hardest where the most is in view at once.',
    actions: [
      {
        label: 'I know what I am doing',
        ghost: true,
        run: () => { budgetOverride = true; refreshBudget(); toast('Object guide off for this session.'); },
      },
      { label: 'OK', run: () => {} },
    ],
  });
}

/**
 * Say, once, that something has been put where the headset will not draw it.
 *
 * Only for objects that have *just* gone outside, which is what the viewport's
 * `outside` event carries. A map that arrives already holding some is painted
 * and left alone — see `loadMapText`, which is where that is decided, and it is
 * deliberate: a warning about somebody else's map, before a single edit, is a
 * warning about nothing anyone in the room has done.
 */
function warnOutside(count) {
  if (outsideDismissed) return;
  openDialog({
    title: 'Outside the playable area',
    body: `${count === 1 ? 'That object is' : `${count} objects are`} entirely outside the `
      + `${PLAYABLE_SIZE} × ${PLAYABLE_SIZE} meter square the game draws, and will not appear in `
      + `the headset at all — the map will load and play but the object${count === 1 ? '' : 's'} `
      + `will not be visible. Anything that overlaps the square even partly is drawn in full, so `
      + 'a piece stretched out past the edge is fine. The ones out there are marked in red.',
    actions: [
      {
        label: "Don't mention it again",
        ghost: true,
        run: () => { outsideDismissed = true; },
      },
      { label: 'OK', run: () => {} },
    ],
  });
}

/**
 * Take a freshly opened map as given.
 *
 * A map over the budget is a map somebody built over the budget, and greeting
 * them with a dialog about it is arguing with a decision already made — so the
 * override starts on and the bar says so. A map with objects outside the
 * playable square gets them painted and counted in the load message, and no
 * dialog. Both revert to asking the moment this session pushes it further:
 * `budgetWarned` clears on the way back under the line, and `outsideDismissed`
 * is left alone so the first object *placed* outside still says something.
 */
function adoptMapGuides() {
  budgetOverride = vp.objects.length > OBJECT_BUDGET;
  budgetWarned = budgetOverride;
  outsideDismissed = false;
  groundWarned = false;
}

/** Say, once, why an enemy spawn will not come off the floor. */
function warnGroundOnly() {
  if (groundWarned) return;
  groundWarned = true;
  openDialog({
    title: 'Enemy spawns stay on the ground',
    body: 'An enemy spawn has been put back on the floor. The game spawns its bots on the '
      + 'ground beneath the pad rather than on the pad itself, so a spawner lifted onto a crate '
      + 'does not put enemies on the crate — it puts them inside whatever is standing under it, '
      + 'which breaks the round. Move it across the floor to wherever the enemies should arrive.',
    actions: [{ label: 'Understood', run: () => {} }],
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
// LBE mode
// ---------------------------------------------------------------------------
// Location-based entertainment: one map played in a row of venue halls, each
// with its own walls, its own guardian boundary and its own spatial anchors.
// Building for that today means saving the map once per hall and dragging each
// copy into place, after which changing one crate means changing it ten times.
//
// The switch turns on a different way of holding the same work: a project of
// one design plus a placement per venue, exported as a file per hall. See
// `src/project.js` for the model.
//
// **Off by default, and off is the editor exactly as it has always been.** That
// is not politeness. With no layers a project is a single map, so the venue
// path collapses into today's path rather than standing beside it as a second
// one to keep in step.

const LBE_KEY = 'spatialops.lbe';

// The other two switches default on, and so ask whether they are `!== false`.
// This one defaults off: a browser with no stored answer must leave it off.
const lbeOn = () => $('lbe')?.checked === true;

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

  try {
    const on = localStorage.getItem(LBE_KEY);
    if (on !== null) $('lbe').checked = on === '1';
  } catch { /* no storage: LBE stays off, which is the safe answer */ }

  $('lbe').onchange = () => {
    try { localStorage.setItem(LBE_KEY, lbeOn() ? '1' : '0'); } catch { /* fine */ }
    if (!lbeOn() && activeLayer !== null) showLayer(null);
    const held = project?.layers.length || 0;
    toast(lbeOn()
      ? 'LBE mode on. Open takes a map and a set of venue templates, and an export writes a '
        + 'file per venue.'
      // Turning it off hides the venue half rather than throwing it away. The
      // switch is a switch, and losing twenty alignments to one is not a thing
      // a switch should be able to do.
      : held
        ? `LBE mode off. The ${held} venue layers are kept, and not exported, until it is back on.`
        : 'LBE mode off. The editor works on one map at a time.');
    refreshVenues();
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
 * The three things about the map that the map file cannot say.
 *
 * Grouping, locking and Hide are the editor's own, and the game's format has no
 * field for any of them — so a checkpoint that is only `currentMapText()` comes
 * back with every group dissolved, which is a poor way to greet somebody who
 * has just lost a tab. They ride alongside instead; see the note at the top of
 * checkpoints.js.
 *
 * Addressed by position, because position is the one name these objects have:
 * `currentMapText` writes `mapObjects` straight off `vp.objects`, and
 * `loadMapText` builds them back in file order, so index *i* is the same object
 * either way. Sparse, because on most maps almost nothing carries any of the
 * three, and null when nothing does — there is no sense storing a second key
 * to say "no groups".
 */
function editorState() {
  const objects = {};
  // Indexed against the same list `currentMapText` writes, which is the design
  // alone -- a venue's own objects are not in the map these positions name.
  vp.designObjects().forEach((m, i) => {
    const rec = {};
    if (m.userData.group) rec.g = m.userData.group;
    if (m.userData.locked) rec.l = 1;
    if (m.userData.hidden) rec.h = 1;
    if (Object.keys(rec).length) objects[i] = rec;
  });
  return Object.keys(objects).length ? { v: 1, objects } : null;
}

/**
 * Put that state back over a map that has just been loaded. Returns how many
 * objects it touched, so the caller can tell whether anything happened.
 *
 * Locks and hidden flags go through the viewport rather than being written onto
 * `userData` here, because both have consequences — a hidden object leaves the
 * selection and stops being pickable, a locked one cannot be selected at all —
 * and those live behind `setHidden` and `setLocked`.
 *
 * The group counter is wound past whatever came back. Group ids are handed out
 * from a counter that starts at 1 with each page, and a restore is the only
 * thing in the editor that reintroduces ids it did not issue: without this, the
 * next Group would hand out `g3` to a map that already had one, and two
 * unrelated runs of objects would move as a single lump.
 */
function applyEditorState(state) {
  if (!state || state.v !== 1 || !state.objects) return 0;
  const hidden = [], locked = [];
  let touched = 0, highest = 0;
  for (const [key, rec] of Object.entries(state.objects)) {
    const m = vp.designObjects()[Number(key)];
    if (!m) continue;
    if (rec.g) {
      m.userData.group = rec.g;
      const seq = Number(String(rec.g).replace(/^g/, ''));
      if (Number.isFinite(seq)) highest = Math.max(highest, seq);
    }
    if (rec.l) locked.push(m);
    if (rec.h) hidden.push(m);
    touched++;
  }
  if (hidden.length) vp.setHidden(hidden, true);
  if (locked.length) vp.setLocked(locked, true);
  groupSeq = Math.max(groupSeq, highest + 1);
  return touched;
}

/**
 * Write a checkpoint if there is anything to write. `force` is for the button,
 * which should work whether or not the switch is on.
 */
// ---------------------------------------------------------------------------
// The venue half of a session
// ---------------------------------------------------------------------------
// A checkpoint is one map, and a set of venues is not one map. So the alignments
// and everything a venue keeps of its own would survive a crashed tab only as
// far as somebody had written the project out -- and the whole point of an
// autosave is the afternoon nobody thought to.
//
// One key, overwritten, rather than a ring of them: this is the tab coming back
// from the dead, not a history to browse. The archive is the same one Export
// project writes, base64'd because storage takes strings.

const PROJECT_AUTOSAVE_KEY = 'spatialops.project.autosave';

/** Keep a copy of the venue half beside the map's own checkpoint. */
async function saveProjectAutosave() {
  if (!checkpointsAvailable()) return;
  try {
    if (!project?.layers.length) return void localStorage.removeItem(PROJECT_AUTOSAVE_KEY);
    const bytes = new Uint8Array(
      await (await writeProjectArchive(project, { editor: editorState() })).arrayBuffer()
    );
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    localStorage.setItem(PROJECT_AUTOSAVE_KEY, JSON.stringify({
      at: Date.now(), name: map.name, venues: project.layers.length, data: btoa(binary),
    }));
  } catch {
    // No storage, or no room in it. Export project is still the thing that
    // keeps this, and it is what the warnings already point at.
  }
}

function projectAutosave() {
  try {
    return JSON.parse(localStorage.getItem(PROJECT_AUTOSAVE_KEY) || 'null');
  } catch {
    return null;
  }
}

/**
 * On the way in, offer back the venues a previous session was holding.
 *
 * Asked rather than restored, because it replaces what is on screen -- and the
 * editor opens on an empty map, so the honest version of "there is something
 * here" is a question about it.
 */
function offerProjectAutosave() {
  const rec = projectAutosave();
  if (!rec?.data) return;
  confirmDialog({
    title: 'Pick up where you left off?',
    body: `"${rec.name}" and ${rec.venues} venue${rec.venues === 1 ? '' : 's'}, from `
      + `${timeAgo(rec.at)}. This browser kept a copy when the last session ended. Opening it `
      + 'replaces what is on screen, which is a new map.',
    confirmLabel: 'Open it',
    run: async () => {
      const bin = Uint8Array.from(atob(rec.data), (c) => c.charCodeAt(0));
      await importProjectBuffer(bin.buffer, `${rec.name} (kept by the browser)`);
    },
  });
}

function takeCheckpoint(reason, force = false) {
  if (!map || (!force && !autosaveOn())) return null;
  try {
    const entry = saveCheckpoint({
      text: currentMapText(),
      // Written after the text, and from the same objects in the same order —
      // `currentMapText` builds `mapObjects` straight off `vp.objects`, so an
      // index here is the same object on the way back in.
      editor: editorState(),
      name: map.name,
      author: map.author,
      guid: map.guid,
      objects: vp.designObjects().length,
      reason,
    });
    mapTouched = false;
    // Fire and forget: it is a copy, the archive takes a moment to build, and
    // nothing that follows a checkpoint is waiting on it.
    saveProjectAutosave();
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
      : 'Autosave is off. Turn it on above, or take one by hand.';
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
      // After the map, because it is addressed by position in it. `loadMapText`
      // has already taken the baseline snapshot for undo, and that baseline was
      // of a map with no grouping in it — so it is taken again here rather than
      // leaving the first Ctrl+Z to quietly dissolve what was just restored.
      if (applyEditorState(checkpointEditorState(entry.id))) {
        current = snapshot();
        refreshAll();
      }
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
      + 'is taken first.'
      + (project?.layers.length
        ? ` The ${project.layers.length} venue layers go too: a checkpoint is one map, never a set `
          + 'of them. Export project first if you want them kept.'
        : ''),
    confirmLabel: 'Restore',
    run: () => { takeCheckpoint('manual', true); go(); },
  });
}

/** On the way in, mention what is waiting rather than leaving it to be found. */
function greetWithCheckpoints() {
  offerProjectAutosave();
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

/**
 * The Venues section of the Map tab: what an export would write, and what each
 * file would be called.
 *
 * A guid is minted once per venue and never again, so the file name beside each
 * one is the same file name every export — which is the whole reason copying a
 * fresh set onto a headset replaces the last set rather than doubling it. It is
 * worth being able to read them.
 *
 * Hidden with no layers, and hidden with LBE mode off even when there are: the
 * switch being off means the editor is working on one map, and a panel counting
 * twenty of them would be arguing with that.
 */
function refreshVenues() {
  const sec = $('venue-sec');
  if (!sec) return;
  const layers = project?.layers || [];
  sec.hidden = !(lbeOn() && layers.length);
  if (sec.hidden) return;

  $('venue-count').textContent = `${layers.length}`;
  const host = $('venue-list');
  host.innerHTML = '';
  for (const l of layers) {
    const row = document.createElement('div');
    row.className = 'cprow venuerow';
    const meta = document.createElement('div');
    meta.className = 'cpm';
    const n = document.createElement('div');
    n.className = 'cpn';
    n.textContent = l.name;
    const w = document.createElement('div');
    w.className = 'cpw';
    w.textContent = mapFileName(l.name, l.guid);
    meta.append(n, w);
    meta.title = `${l.name}\n${mapFileName(l.name, l.guid)}\n`
      + `Template: ${l.template.name}, ${l.template.mapObjects.length} objects`;
    row.appendChild(meta);
    host.appendChild(row);
  }
  $('venue-note').textContent = `An export writes ${layers.length + 1} files: the map itself, `
    + 'and one per venue.';
}

// ---------------------------------------------------------------------------
// Venue layers on screen
// ---------------------------------------------------------------------------
// Picking a hall out of the toolbar stands the map in it: the hall's walls come
// in around it, the hall's play space replaces the grid on the floor, and the
// gizmo changes hands from whatever was selected to the design as a whole.
//
// **Nothing in the map moves.** What moves is `mapRoot`, the frame every map
// object hangs from, and the placement it lands at is the layer's — one offset
// and one yaw, stored against that hall and no other. Which is the whole reason
// a crate added later turns up in all twenty of them: there is no copy of the
// design anywhere to be brought up to date.
//
// The design is drawn ghosted until it has been placed, because in a hall it
// has not been aligned into it is standing wherever the last hall left it, and
// it should not look like it belongs there.

/** The venue anything built right now belongs to, or null for the map. */
const currentLayer = () => (activeLayer === null ? null : project?.layers[activeLayer] || null);

/**
 * Take a piece of the design out of the design, in this venue only.
 *
 * Nothing moves. The object is already standing where it stands, already in the
 * frame the file records, and all that changes is who it belongs to: its id
 * goes on the layer's `detached` list so this venue stops inheriting it, and
 * the mesh itself is marked as the venue's own. From here it is an ordinary
 * object — move it, resize it, swap it, delete it — and none of that reaches
 * the map or any other venue.
 *
 * It is a fork rather than an override, so it does not come back. Deleting the
 * design's copy later leaves this one standing, because by then they are not
 * the same object and have not been since the moment this ran. Which is the
 * argument for it being a deliberate act off a menu rather than something a
 * drag could start.
 */
function detachIntoLayer(meshes) {
  const layer = currentLayer();
  if (!layer) return;
  const taken = meshes.filter((m) => !m.userData.layer);
  if (!taken.length) return;

  const made = taken.map((m) => {
    // A copy, standing exactly where the original stands. Not the original
    // itself with its allegiance switched: the map is written from the design
    // objects on screen, so moving one out of the design would take it out of
    // the map, and out of every other venue with it. The design keeps its
    // object; this venue gets one of its own, and stops drawing the one it has
    // stopped inheriting.
    const copy = vp.addObject({ ...vp.toMapObject(m), id: undefined, layer: layer.id });
    if (Number.isInteger(m.userData.id)) layer.detached.push(m.userData.id);
    return copy;
  });
  vp.setDetachedHere(layer.detached);
  vp.setSelection(made);
  commit();
  const n = made.length;
  toast(`${n} object${n === 1 ? '' : 's'} now ${n === 1 ? 'belongs' : 'belong'} to ${layer.name} `
    + 'alone. Changes to the map no longer reach '
    + `${n === 1 ? 'it' : 'them'}, and neither does deleting the original.`);
}

/**
 * Give the venue on screen back everything that is its own: where the design
 * ended up standing, and every object belonging to that venue alone.
 *
 * The objects go back to being values rather than meshes, because only one
 * venue is ever on screen and the other nineteen have to be somewhere. They
 * are read in the design's frame, the same frame the map is written in, so the
 * export applies one placement to the whole of what a venue plays.
 */
function readLayerFromScene(layer) {
  if (!layer) return;
  const { offset, yaw } = vp.designTransform();
  layer.offset = offset;
  layer.yaw = yaw;
  layer.objects = vp.layerOwnObjects().map((m) => vp.toMapObject(m));
}

function bankLayer() {
  const layer = currentLayer();
  if (!layer) return;
  readLayerFromScene(layer);
  // Off the screen as well as into the model: only one venue is ever drawn,
  // and the other nineteen have to be somewhere.
  vp.removeObjects(vp.layerOwnObjects());
  vp.newObjectLayer = null;
}

/** A design that has been moved in a hall is a design that has been put there. */
function markLayerPlaced() {
  const layer = project?.layers[activeLayer];
  if (!layer || layer.placed) return;
  layer.placed = true;
  vp.setDesignGhosted(false);
}

/** Back to the design's own frame, with no hall around it. */
function resetLayerView() {
  activeLayer = null;
  vp.newObjectLayer = null;
  vp.setDetachedHere([]);
  vp.setLayerAlign(false);
  vp.setVenueObjects([]);
  vp.setDesignGhosted(false);
  vp.setDesignTransform({ x: 0, y: 0, z: 0 }, 0);
}

/**
 * Show the map itself (`null`) or one of its venues.
 *
 * The placement on screen is banked back to the layer being left before
 * anything else happens, so switching between halls keeps each one's alignment
 * without anybody having to press anything.
 */
async function showLayer(index) {
  bankLayer();
  const layer = index === null ? null : project?.layers?.[index];
  if (index !== null && !layer) return;

  if (!layer) {
    resetLayerView();
    await vp.setNavCloud(map.navCloud);
    undoStack = []; redoStack = []; current = snapshot();
    refreshAll();
    return void toast(`Back to ${map.name}. Changes here reach every venue.`);
  }

  activeLayer = index;
  vp.setDesignTransform(layer.offset, layer.yaw);
  vp.setVenueObjects(layer.template.mapObjects);
  // This venue's own: the pieces taken out of the design here, and anything
  // added here. Stored as values while some other venue is on screen, since
  // only one of them can be, and built back into meshes on the way in.
  vp.newObjectLayer = layer.id;
  // Before the objects, so a design object this venue has replaced is already
  // known to be one by the time it is asked whether to draw itself.
  vp.setDetachedHere(layer.detached);
  for (const mo of layer.objects) vp.addObject({ ...mo, layer: layer.id });
  vp.setDesignGhosted(!layer.placed);
  await vp.setNavCloud(layer.template.navCloud);
  // Last, so the gizmo attaches to a frame already standing where it belongs.
  vp.setLayerAlign(true);
  // Undo does not reach across the switch, for the same reason it does not
  // reach across a new map: the stack is full of states of a scene that is no
  // longer the scene on screen, and stepping back into one of them would put
  // another venue's objects into this one.
  undoStack = []; redoStack = []; current = snapshot();
  refreshAll();

  toast(layer.placed
    ? `${layer.name}. Drag the map to adjust where it sits in this venue.`
    : `${layer.name}. The map is ghosted until it is placed — drag it onto the `
      + 'walls of this venue to line it up.');
}

/**
 * The venue list in the toolbar.
 *
 * Rebuilt only when the names change, so choosing one does not tear the element
 * out from under the pointer that is still inside it.
 */
function refreshLayerPicker() {
  const grp = $('layer-grp');
  if (!grp) return;
  const layers = project?.layers || [];
  grp.hidden = !(lbeOn() && layers.length);
  if (grp.hidden) return;

  const sel = $('layer-pick');
  const key = [map.name, ...layers.map((l) => l.name)].join('\u0000');
  if (sel.dataset.built !== key) {
    sel.innerHTML = '';
    const own = document.createElement('option');
    own.value = 'map';
    own.textContent = `${map.name} — the map`;
    sel.appendChild(own);
    layers.forEach((l, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = l.name;
      sel.appendChild(o);
    });
    sel.dataset.built = key;
  }
  sel.value = activeLayer === null ? 'map' : String(activeLayer);
}

function wireLayerPicker() {
  $('layer-pick').onchange = (e) => {
    const v = e.target.value;
    showLayer(v === 'map' ? null : Number(v));
  };
}

function refreshAll() {
  // Everything that edits the map ends here, which makes it the one place that
  // has to notice a piece having left the playable square. Objects built by
  // Duplicate, Paste, Array, Mirror and Replace are all made at the origin and
  // moved afterwards, so asking at the moment each was added would ask about
  // the wrong place every time.
  vp.refreshOutside();
  refreshHiddenCount();
  buildOutliner();
  buildSelectionPanel();
  refreshModeAvailability();
  refreshMeta();
  refreshVenues();
  refreshLayerPicker();
  refreshPreview();
  refreshStatus();
  $('b-undo').disabled = !undoStack.length;
  $('b-redo').disabled = !redoStack.length;
}

function refreshStatus() {
  const n = vp.selection.size;
  $('sel-count').textContent = n ? `${n} selected` : 'none';
  // Only the modes you are currently in, and only the ones you cannot see for
  // yourself: the snap settings and the scale mode are already legible in the
  // controls that set them, so repeating them here just crowds the bar.
  $('st-mode').textContent = [
    vp.previewing ? 'walkaround' : '',
    vp.trackpad ? `trackpad${vp.trackpadInverted ? ' inverted' : ''}` : '',
    vp.navPaint ? `brush ${vp.navPaint}` : '',
  ].filter(Boolean).join(' · ');
  // The map's own object count lives in the budget bar; this says only what is
  // selected, sitting beside the map name it belongs to.
  $('st-sel').textContent = n ? `${n} selected` : '';
  refreshBudget();
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
  // The toast is gone in five seconds and the status bar keeps the copy, so a
  // message longer than the bar has to be readable rather than merely present.
  // It scrolls; this puts a new one back at its own beginning, since the box may
  // still be scrolled to the end of the last one. The title is the whole of it
  // in one go, for anyone who would rather hover than drag.
  const scroll = $('st-msg-scroll');
  if (scroll) {
    scroll.scrollLeft = 0;
    scroll.title = msg;
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 5200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
