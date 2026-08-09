// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { geometryFor } from './placeholders.js';
import { defFor, modelUrl, iconUrl } from './catalog.js';
import { WEAPON_ICONS, WEAPON_ANY, parseWeapons } from './packs.js';
import { convertPosition, unityEulerToQuat, quatToUnityEuler } from './unity.js';
import { decodeNavCloud, navIndexToWorld } from './format.js';

const ACCENT = 0xe8c547;
const CYAN = 0x4ec9e0;

// -- prefab meshes -----------------------------------------------------------
// A missing asset is normal, not an error, so each one is mentioned once.
const warnedModels = new Set();

// `vfx` covers the runtime effects the spawners carry: the weapon spawner's
// SpawnBoxVFX holds a single-sided LightQuad two metres by four, which reads as
// a pane hanging in the air that vanishes when you orbit past it.
const FURNITURE = /manipulator|collider|hologram|ghost|outline|lockspawner|vfx/i;

/** True when the node, or any ancestor, is editor furniture rather than art. */
function isFurniture(node) {
  for (let n = node; n; n = n.parent) if (FURNITURE.test(n.name || '')) return true;
  return false;
}

const lowerLod = (node) => /_LOD[1-9]\d*$/i.test(node.name || '');

/**
 * Sit a loaded prefab on the cell floor, exactly, the way geometryFor does for
 * the placeholders.
 *
 * The prefabs are not authored to the floor — the crate's mesh starts a
 * millimetre below it, the barriers six millimetres above. Floor lock drops a
 * selection until its bounding box rests on y = 0, so a model that misses by
 * any amount shifts the object on every edit and writes that shift into the
 * exported map. That is the invariant that makes an untouched map survive
 * select-all plus a no-op edit byte for byte, and swapping in raw prefab
 * geometry breaks all thirteen reference maps without this.
 *
 * Only the Y origin moves. Nothing is rescaled, so the mesh keeps its real
 * dimensions: a `center` pivot only needs its box to start half a nominal unit
 * below the origin, which is what the game's own placements imply, and the
 * couple of millimetres a mesh falls short of that unit stay at the top where
 * they cost nothing.
 */
function seatOnFloor(geometry, def) {
  geometry.computeBoundingBox();
  geometry.translate(0, -geometry.boundingBox.min.y, 0);
  if (def.pivot === 'center') geometry.translate(0, -def.size[1] / 2, 0);
  geometry.computeBoundingBox();
}

/**
 * A prefab material as this viewport can light it.
 *
 * Two corrections, both because glTF cannot carry what Unity meant.
 *
 * The solid primitives ship as full metals, and a metal with no environment to
 * reflect has nothing to be lit by, so it renders pitch black under the two
 * lights here. Clamping metalness is the cheap half of what an environment map
 * would do and keeps the editor's flat, readable look.
 *
 * And some prefabs carry no colour at all. The damage boxes are the clearest
 * case: their material is `{"name":"MATDamageBoxRed","pbrMetallicRoughness":{}}`
 * — no texture and no baseColorFactor either, so the glTF default of pure white
 * applies and all three teams render as identical white cubes. The colour
 * survived only in the material's *name*, because Unity's own shader had
 * nothing to map onto glTF's PBR. Where a material brings neither a map nor a
 * colour, the catalog's tint is the only thing that knows red from blue, so it
 * stands in. Anything that does carry colour is left alone.
 */
const displayMaterials = new Map();

function displayMaterial(material, tint) {
  if (Array.isArray(material)) return material.map((m) => displayMaterial(m, tint));
  if (!material) return material;
  const key = `${material.uuid}|${tint ?? ''}`;
  if (displayMaterials.has(key)) return displayMaterials.get(key);
  const out = material.clone();
  if (out.metalness !== undefined && !out.envMap) {
    out.metalness = Math.min(out.metalness, 0.25);
    out.roughness = Math.max(out.roughness ?? 0.5, 0.45);
  }
  if (tint && !out.map && out.color?.getHex() === 0xffffff) out.color.set(tint);
  displayMaterials.set(key, out);
  return out;
}

/**
 * One geometry for the whole prefab. Merging needs every part to carry the same
 * attributes, which is not guaranteed across a prefab's meshes, so trim each to
 * position and normal first; if a merge still fails, the largest single part is
 * a better stand-in than nothing.
 */
function mergeForDisplay(parts, tint) {
  // Some prefabs carry vertex colours on the visible mesh and not on the rest —
  // the solid primitives do, the props do not. GLTFLoader turns that into
  // material.vertexColors, so a part that loses the attribute renders black.
  // Anything missing one gets opaque white, which multiplies to no change.
  const colours = parts.map(({ geometry }) => geometry.getAttribute('color'));
  const colourSize = colours.find(Boolean)?.itemSize ?? 0;

  const trimmed = parts.map(({ geometry }, i) => {
    // Non-indexed throughout, or a mix of indexed and not refuses to merge.
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const out = new THREE.BufferGeometry();
    const position = g.getAttribute('position');
    out.setAttribute('position', position);
    const normal = g.getAttribute('normal');
    if (normal) out.setAttribute('normal', normal);
    // Every part needs the same attributes to merge, and the parts without UVs
    // are the ones whose material has no map to sample anyway.
    const uv = g.getAttribute('uv');
    out.setAttribute('uv', uv ?? new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
    if (colourSize) {
      const colour = g.getAttribute('color');
      out.setAttribute('color', colour && colour.itemSize === colourSize
        ? colour
        : new THREE.BufferAttribute(
          new Float32Array(position.count * colourSize).fill(1), colourSize));
    }
    if (!normal) out.computeVertexNormals();
    return out;
  });
  try {
    // useGroups keeps one draw group per part, so the prefab's own materials
    // survive as a material array and the object arrives textured.
    const merged = mergeGeometries(trimmed, true);
    if (merged) return { geometry: merged, materials: parts.map((p) => displayMaterial(p.material, tint)) };
  } catch { /* fall through to the largest part */ }
  let best = 0;
  trimmed.forEach((g, i) => {
    if (g.getAttribute('position').count > trimmed[best].getAttribute('position').count) best = i;
  });
  return { geometry: trimmed[best], materials: displayMaterial(parts[best].material, tint) };
}

export class Viewport extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.objects = [];
    this.selection = new Set();
    this.uniformScale = true;
    this.floorLock = true;
    this.snap = { translate: 0.25, rotate: 15, scale: 0 };
    this.gizmoMode = 'translate';
    this.gizmoSpace = 'world';
    this.placing = null;
    this._pointer = null;
    this._nextId = 1;
    this._edgeCache = new Map();
    this._materials = new Map();
    this._modelCache = new Map();
    this._badges = new Map();
    this._gltf = new GLTFLoader();

    this._initRenderer();
    this._initScene();
    this._initControls();
    this._initPicking();

    this.renderer.setAnimationLoop(() => this._frame());
  }

  // -- setup ----------------------------------------------------------------

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  _initScene() {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.camera.position.set(7, 6, 9);

    this.scene.add(new THREE.HemisphereLight(0x9fc4e0, 0x1a2028, 2.0));
    const key = new THREE.DirectionalLight(0xfff2df, 2.4);
    key.position.set(6, 12, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = 14;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0012;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x7fa8c9, 0.7);
    fill.position.set(-7, 5, -6);
    this.scene.add(fill);

    // Ground catches shadows but is otherwise invisible.
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.32 })
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(40, 160, 0x2f4553, 0x1c2831);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.75;
    this.scene.add(this.grid);

    this.boundsGroup = new THREE.Group();
    this.scene.add(this.boundsGroup);

    this.navGroup = new THREE.Group();
    this.scene.add(this.navGroup);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
  }

  _initControls() {
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.499;
    this.orbit.target.set(0, 0.75, 0);
    // Left is reserved for selection. Middle orbits, right pans, Alt+Left orbits.
    this.orbit.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmo.setSize(0.9);
    // three r169+ exposes the visual half of TransformControls separately.
    this._gizmoHelper =
      typeof this.gizmo.getHelper === 'function' ? this.gizmo.getHelper() : this.gizmo;
    this.scene.add(this._gizmoHelper);

    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._beginDrag();
      else this._endDrag();
    });
    this.gizmo.addEventListener('objectChange', () => {
      this._constrainDuringDrag();
      this.emit('transform');
    });

    addEventListener('keydown', (e) => {
      if (e.key === 'Alt') this.orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    });
    addEventListener('keyup', (e) => {
      if (e.key === 'Alt') this.orbit.mouseButtons.LEFT = null;
    });
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // -- object lifecycle -----------------------------------------------------

  materialFor(def) {
    const key = def.color + (def.unknown ? '!' : '');
    if (!this._materials.has(key)) {
      this._materials.set(
        key,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(def.color),
          roughness: 0.82,
          metalness: 0.04,
          flatShading: false,
        })
      );
    }
    return this._materials.get(key);
  }

  /**
   * Add a map object. `mo` uses Unity values, exactly as they appear in the
   * file, so nothing is lost on the way in or out.
   */
  addObject(mo) {
    const def = defFor(mo);
    const mesh = new THREE.Mesh(geometryFor(def), this.materialFor(def));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      id: this._nextId++,
      def,
      // The subtype and its extra fields belong to the object, not the catalog
      // entry: a spawner whose weapon the user changed still has to export the
      // value it actually carries.
      objectType: mo.$type || def.objectType || 'MapObject',
      props: { ...(def.props || {}), ...(mo.props || {}) },
      raw: mo.raw || null,
      dirty: !!mo.dirty,
      group: null,
    };
    mesh.position.fromArray(convertPosition(mo.position));
    mesh.quaternion.fromArray(unityEulerToQuat(mo.rotation));
    mesh.scale.set(mo.scale.x, mo.scale.y, mo.scale.z);
    this.scene.add(mesh);
    this.objects.push(mesh);
    this._refreshWeaponBadge(mesh);
    if (def.model) this._swapInModel(mesh, def);
    return mesh;
  }

  /**
   * Replace the placeholder with the real prefab mesh, if the asset dump is
   * present. It is gitignored and optional, so a miss keeps the placeholder and
   * says so once rather than failing.
   */
  async _swapInModel(mesh, def) {
    const url = modelUrl(def);
    if (!url) return;
    try {
      // Two entries can share a prefab and not a pivot, and the normalisation
      // below depends on both.
      const cacheKey = `${def.model}|${def.pivot}|${def.size[1]}|${def.color}`;
      let model = this._modelCache.get(cacheKey);
      if (!model) {
        const gltf = await this._gltf.loadAsync(url);
        const found = [];
        gltf.scene.updateWorldMatrix(true, true);
        gltf.scene.traverse((n) => {
          // Most of a prefab is not the object: drag handles, a hologram shell
          // a couple of centimetres proud of the surface, collider proxies, an
          // outline, and lower LODs. Including them makes every primitive
          // 1.25 m. See tools/measure-prefabs.mjs, which filters identically.
          if (!n.isMesh || isFurniture(n) || lowerLod(n)) return;
          const geometry = n.geometry.clone();
          geometry.applyMatrix4(n.matrixWorld);
          found.push({ geometry, material: n.material });
        });
        if (!found.length) return;
        model = mergeForDisplay(found, def.color);
        seatOnFloor(model.geometry, def);
        this._modelCache.set(cacheKey, model);
      }
      mesh.geometry = model.geometry;
      mesh.material = model.materials;
      this._refreshOutline(mesh);
      this.emit('change');
    } catch (err) {
      if (!warnedModels.has(def.model)) {
        warnedModels.add(def.model);
        console.warn(`No model for ${def.type} at ${url}, keeping placeholder.`, err.message ?? err);
      }
    }
  }

  removeObjects(meshes) {
    for (const m of meshes) {
      this._setOutline(m, false);
      this._dropWeaponBadge(m);
      m.removeFromParent();
      const i = this.objects.indexOf(m);
      if (i >= 0) this.objects.splice(i, 1);
      this.selection.delete(m);
    }
    this.rebuildPivot();
    this.emit('selection');
    this.emit('change');
  }

  clearObjects() {
    if (this.placing) this._endPlacement(false);
    this.setSelection([]);
    for (const m of this.objects) {
      this._dropWeaponBadge(m);
      m.removeFromParent();
    }
    this.objects.length = 0;
    this.emit('change');
  }

  markDirty(mesh) {
    mesh.userData.dirty = true;
  }

  /** Unity-space record for a mesh, ready to hand to the serialiser. */
  toMapObject(mesh) {
    mesh.updateWorldMatrix(true, false);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    mesh.matrixWorld.decompose(p, q, s);
    const { def, objectType, props } = mesh.userData;
    return {
      $type: objectType || 'MapObject',
      type: def.type,
      props: props && Object.keys(props).length ? { ...props } : undefined,
      position: { x: p.x, y: p.y, z: -p.z },
      rotation: quatToUnityEuler(q.toArray()),
      scale: { x: s.x, y: s.y, z: s.z },
      raw: mesh.userData.raw,
      dirty: mesh.userData.dirty,
    };
  }

  /**
   * Change one of a subtype's extra fields — which weapon a spawner holds,
   * how an enemy spawn behaves. Swapping the value can mean a different
   * catalog entry and so a different placeholder, so the mesh is re-skinned.
   */
  setProp(mesh, key, value) {
    mesh.userData.props = { ...mesh.userData.props, [key]: value };
    const def = defFor({ type: mesh.userData.def.type, props: mesh.userData.props });
    if (def !== mesh.userData.def) {
      mesh.userData.def = def;
      mesh.geometry = geometryFor(def);
      mesh.material = this.materialFor(def);
      this._refreshOutline(mesh);
    }
    this._refreshWeaponBadge(mesh);
    this.markDirty(mesh);
    this.emit('change');
  }

  // -- selection ------------------------------------------------------------

  setSelection(list) {
    const next = new Set(list);
    for (const m of this.selection) if (!next.has(m)) this._setOutline(m, false);
    for (const m of next) if (!this.selection.has(m)) this._setOutline(m, true);
    this.selection = next;
    this.rebuildPivot();
    this.emit('selection');
  }

  selectAll() {
    this.setSelection(this.objects);
  }

  /** Expand a click to its whole group, unless the user is overriding. */
  expandGroup(mesh, override = false) {
    const g = mesh.userData.group;
    if (!g || override) return [mesh];
    return this.objects.filter((o) => o.userData.group === g);
  }

  _setOutline(mesh, on) {
    if (on) {
      if (mesh.userData.outline) return;
      const line = new THREE.LineSegments(
        this._edgesFor(mesh.geometry),
        new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true })
      );
      line.renderOrder = 999;
      mesh.add(line);
      mesh.userData.outline = line;
    } else if (mesh.userData.outline) {
      mesh.userData.outline.removeFromParent();
      mesh.userData.outline.material.dispose();
      mesh.userData.outline = null;
    }
  }

  _refreshOutline(mesh) {
    if (mesh.userData.outline) {
      this._setOutline(mesh, false);
      this._setOutline(mesh, true);
    }
  }

  _edgesFor(geometry) {
    if (!this._edgeCache.has(geometry)) {
      this._edgeCache.set(geometry, new THREE.EdgesGeometry(geometry, 25));
    }
    return this._edgeCache.get(geometry);
  }

  selectionBounds() {
    const box = new THREE.Box3();
    for (const m of this.selection) box.expandByObject(m);
    return box;
  }

  // -- gizmo ----------------------------------------------------------------

  rebuildPivot() {
    // Hand every child back to the scene before moving the pivot.
    for (const child of [...this.pivot.children]) this.scene.attach(child);

    if (!this.selection.size) {
      this.gizmo.detach();
      return;
    }
    const list = [...this.selection];
    if (list.length === 1) {
      const m = list[0];
      m.updateWorldMatrix(true, false);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m.matrixWorld.decompose(p, q, s);
      this.pivot.position.copy(p);
      this.pivot.quaternion.copy(q);
    } else {
      this.pivot.position.copy(this.selectionBounds().getCenter(new THREE.Vector3()));
      this.pivot.quaternion.identity();
    }
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    for (const m of list) this.pivot.attach(m);

    this.gizmo.attach(this.pivot);
    this._applyGizmoConstraints();
  }

  setGizmoMode(mode) {
    this.gizmoMode = mode;
    this.gizmo.setMode(mode);
    this._applyGizmoConstraints();
    this.emit('mode');
  }

  setGizmoSpace(space) {
    this.gizmoSpace = space;
    this.gizmo.setSpace(space);
    this.emit('mode');
  }

  _applyGizmoConstraints() {
    const list = [...this.selection];
    const yawOnly = list.length > 0 && list.every((m) => m.userData.def.rotationAxes === 'y');
    this.gizmo.showX = true;
    this.gizmo.showY = true;
    this.gizmo.showZ = true;
    if (this.gizmoMode === 'rotate' && yawOnly) {
      this.gizmo.showX = false;
      this.gizmo.showZ = false;
    }
    this.gizmo.translationSnap = this.snap.translate || null;
    this.gizmo.rotationSnap = this.snap.rotate ? THREE.MathUtils.degToRad(this.snap.rotate) : null;
    this.gizmo.scaleSnap = this.snap.scale || null;
    this.gizmo.setSpace(this.gizmoSpace);
  }

  setSnap(part, value) {
    this.snap[part] = value;
    this._applyGizmoConstraints();
    this.emit('mode');
  }

  _beginDrag() {
    this._dragStartScale = this.pivot.scale.clone();
    this.emit('commit-begin');
  }

  _constrainDuringDrag() {
    if (this.gizmoMode === 'scale') {
      // A rotated child under a non-uniformly scaled parent shears, which no
      // position/rotation/scale triple can represent. Forcing uniform scale on
      // multi-selects keeps the export honest.
      const force = this.uniformScale || this.selection.size > 1;
      if (force && this._dragStartScale) {
        const s0 = this._dragStartScale;
        const s = this.pivot.scale;
        const r = [s.x / s0.x, s.y / s0.y, s.z / s0.z];
        let best = r[0];
        for (const v of r) if (Math.abs(v - 1) > Math.abs(best - 1)) best = v;
        s.set(s0.x * best, s0.y * best, s0.z * best);
      }
    }
    if (this.floorLock) this._applyFloorLock();
  }

  _applyFloorLock() {
    for (const m of this.selection) {
      if (!m.userData.def.floor) continue;
      m.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(m);
      const drop = box.min.y;
      if (Math.abs(drop) > 1e-5) {
        const world = new THREE.Vector3();
        m.getWorldPosition(world);
        world.y -= drop;
        const local = this.pivot.worldToLocal(world.clone());
        if (m.parent === this.pivot) m.position.copy(local);
        else m.position.copy(world);
      }
    }
  }

  dropToFloor() {
    const targets = this.selection.size ? [...this.selection] : [];
    for (const m of targets) {
      const box = new THREE.Box3().setFromObject(m);
      const world = new THREE.Vector3();
      m.getWorldPosition(world);
      world.y -= box.min.y;
      const local = m.parent === this.pivot ? this.pivot.worldToLocal(world.clone()) : world;
      m.position.copy(local);
      this.markDirty(m);
    }
    this.emit('transform');
    this.emit('commit-end');
  }

  _endDrag() {
    for (const m of this.selection) this.markDirty(m);
    this.rebuildPivot();
    this.emit('transform');
    this.emit('commit-end');
  }

  // -- picking --------------------------------------------------------------

  _initPicking() {
    this.ray = new THREE.Raycaster();
    this.marquee = null;
    const pt = new THREE.Vector2();

    const ndc = (e) => {
      const r = this.canvas.getBoundingClientRect();
      pt.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      return pt;
    };

    let down = null;

    this.canvas.addEventListener('pointerdown', (e) => {
      // this.gizmo.axis is set while a handle is hovered; TransformControls
      // registers its listeners first, so this reliably wins.
      if (e.button !== 0 || e.altKey || this.gizmo.dragging || this.gizmo.axis) return;
      if (this.placing) return;   // that click drops what is being placed
      down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      this.emit('marquee-start', down);
    });

    addEventListener('pointermove', (e) => {
      this._pointer = { clientX: e.clientX, clientY: e.clientY };
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.active && Math.hypot(dx, dy) > 4) down.active = true;
      if (down.active) {
        this.marquee = {
          x1: Math.min(down.x, e.clientX), y1: Math.min(down.y, e.clientY),
          x2: Math.max(down.x, e.clientX), y2: Math.max(down.y, e.clientY),
        };
        this.emit('marquee-move', this.marquee);
      }
    });

    addEventListener('pointerup', (e) => {
      if (!down) return;
      const wasDrag = down.active;
      const mods = { shift: down.shift, ctrl: down.ctrl };
      const box = this.marquee;
      down = null;
      this.marquee = null;
      this.emit('marquee-end');
      if (wasDrag && box) this._marqueeSelect(box, mods);
      else this._clickSelect(ndc(e), mods);
    });
  }

  _clickSelect(ndcPoint, mods) {
    this.ray.setFromCamera(ndcPoint, this.camera);
    const hits = this.ray.intersectObjects(this.objects, false);
    const hit = hits.length ? hits[0].object : null;
    if (!hit) {
      if (!mods.shift && !mods.ctrl) this.setSelection([]);
      return;
    }
    const picked = this.expandGroup(hit, mods.ctrl);
    if (mods.shift) {
      const next = new Set(this.selection);
      const allIn = picked.every((m) => next.has(m));
      for (const m of picked) allIn ? next.delete(m) : next.add(m);
      this.setSelection([...next]);
    } else {
      this.setSelection(picked);
    }
  }

  _marqueeSelect(box, mods) {
    const r = this.canvas.getBoundingClientRect();
    const toScreen = (v) => {
      const p = v.clone().project(this.camera);
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, z: p.z };
    };
    const corner = new THREE.Vector3();
    const inside = [];
    for (const m of this.objects) {
      m.updateWorldMatrix(true, false);
      const bb = new THREE.Box3().setFromObject(m);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, visible = false;
      for (let i = 0; i < 8; i++) {
        corner.set(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        );
        const s = toScreen(corner);
        if (s.z < 1) visible = true;
        minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
      }
      if (!visible) continue;
      const overlaps = maxX >= box.x1 && minX <= box.x2 && maxY >= box.y1 && minY <= box.y2;
      if (overlaps) inside.push(m);
    }

    const expanded = new Set();
    for (const m of inside) for (const g of this.expandGroup(m, mods.ctrl)) expanded.add(g);

    if (mods.shift) {
      const next = new Set(this.selection);
      for (const m of expanded) next.add(m);
      this.setSelection([...next]);
    } else {
      this.setSelection([...expanded]);
    }
  }

  // -- follow-the-cursor placement ------------------------------------------

  /**
   * Carry `meshes` under the pointer until a left click drops them. They ride
   * on the pivot like any other selection, so this only has to move the pivot
   * and floor lock keeps working unchanged. Ends by emitting 'placement-end'
   * with { committed, meshes }; a cancelled placement leaves the meshes in the
   * scene for the caller to dispose of.
   */
  beginPlacement(meshes) {
    if (this.placing) this._endPlacement(false);
    if (!meshes.length) return;

    this.setSelection(meshes);
    // The gizmo would swallow the click that drops them, and there is nothing
    // worth transforming until they have landed.
    this.gizmo.detach();

    const centre = this.selectionBounds().getCenter(new THREE.Vector3());
    // Constant offset from the point under the cursor to the pivot, so the
    // group keeps its own layout and its heights while it follows.
    const lead = this.pivot.position.clone().sub(new THREE.Vector3(centre.x, 0, centre.z));

    const move = (e) => {
      const g = this.groundPoint(e.clientX, e.clientY);
      const s = this.snap.translate;
      if (s) {
        g.x = Math.round(g.x / s) * s;
        g.z = Math.round(g.z / s) * s;
      }
      this.pivot.position.copy(g).add(lead);
      if (this.floorLock) this._applyFloorLock();
      this.emit('transform');
    };
    const drop = (e) => { if (e.button === 0) this._endPlacement(true); };

    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', drop);
    this.canvas.style.cursor = 'copy';
    this.placing = {
      meshes,
      dispose: () => {
        this.canvas.removeEventListener('pointermove', move);
        this.canvas.removeEventListener('pointerup', drop);
      },
    };
    // Until the mouse moves they stay where they were created.
    if (this._pointer) move(this._pointer);
  }

  cancelPlacement() {
    this._endPlacement(false);
  }

  _endPlacement(committed) {
    if (!this.placing) return;
    const { meshes, dispose } = this.placing;
    this.placing = null;
    dispose();
    this.canvas.style.cursor = '';
    if (committed) {
      for (const m of meshes) this.markDirty(m);
      this.rebuildPivot();
    }
    this.emit('placement-end', { committed, meshes });
  }

  /** Where a screen point meets the ground plane, for drag-and-drop placement. */
  groundPoint(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndcPoint = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
    this.ray.setFromCamera(ndcPoint, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(plane, out) ? out : new THREE.Vector3(0, 0, 0);
  }

  // -- arena and play space -------------------------------------------------

  setBounds(size) {
    this.boundsGroup.clear();
    const { x, y, z } = size;
    const geo = new THREE.BoxGeometry(x, y, z);
    geo.translate(0, y / 2, 0);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.5 })
    );
    this.boundsGroup.add(edges);

    // Solid corner brackets read as an arena; a plain wire box reads as noise.
    const len = Math.min(0.6, Math.min(x, z) * 0.18);
    const mat = new THREE.LineBasicMaterial({ color: CYAN });
    const pts = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = (sx * x) / 2;
        const cz = (sz * z) / 2;
        pts.push(cx, 0, cz, cx - sx * len, 0, cz);
        pts.push(cx, 0, cz, cx, 0, cz - sz * len);
        pts.push(cx, 0, cz, cx, len, cz);
        pts.push(cx, y, cz, cx - sx * len, y, cz);
        pts.push(cx, y, cz, cx, y, cz - sz * len);
        pts.push(cx, y, cz, cx, y - len, cz);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.boundsGroup.add(new THREE.LineSegments(bg, mat));
    geo.dispose();
  }

  /** Draw the play space mask so it is obvious where the player can walk. */
  async setNavCloud(navCloud) {
    this.navGroup.clear();
    if (!navCloud || !navCloud.encodedPoints) return;
    let bytes;
    try {
      bytes = await decodeNavCloud(navCloud.encodedPoints);
    } catch {
      return;
    }
    const N = navCloud.divisions.x;
    const M = navCloud.divisions.y;
    const positions = [];
    // Outline only: draw an edge wherever an inside cell touches an outside one.
    const at = (r, c) => (r < 0 || c < 0 || r >= M || c >= N ? 0 : bytes[r * N + c]);
    const h = 0.012;
    for (let r = 0; r < M; r++) {
      for (let c = 0; c < N; c++) {
        if (!at(r, c)) continue;
        const x0 = navIndexToWorld(c, N) - 0.125;
        const x1 = x0 + 0.25;
        const z0 = -(navIndexToWorld(r, M) - 0.125);
        const z1 = z0 - 0.25;
        if (!at(r - 1, c)) positions.push(x0, h, z0, x1, h, z0);
        if (!at(r + 1, c)) positions.push(x0, h, z1, x1, h, z1);
        if (!at(r, c - 1)) positions.push(x0, h, z0, x0, h, z1);
        if (!at(r, c + 1)) positions.push(x1, h, z0, x1, h, z1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.navGroup.add(
      new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x5ad6a0, transparent: true, opacity: 0.85 }))
    );
  }

  // -- camera ---------------------------------------------------------------

  frameSelection() {
    const box = this.selection.size ? this.selectionBounds() : this._allBounds();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.8);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).add(dir.multiplyScalar(radius * 3));
  }

  _allBounds() {
    const box = new THREE.Box3();
    for (const m of this.objects) box.expandByObject(m);
    return box;
  }

  setView(name) {
    const box = this._allBounds();
    const center = box.isEmpty() ? new THREE.Vector3(0, 0.75, 0) : box.getCenter(new THREE.Vector3());
    const d = box.isEmpty() ? 10 : Math.max(box.getSize(new THREE.Vector3()).length(), 6);
    const offsets = {
      top: [0.001, d, 0.001],
      front: [0, d * 0.25, d],
      side: [d, d * 0.25, 0],
      persp: [d * 0.7, d * 0.6, d * 0.9],
    };
    const o = offsets[name] || offsets.persp;
    this.orbit.target.copy(center);
    this.camera.position.set(center.x + o[0], center.y + o[1], center.z + o[2]);
  }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(r.width, r.height, false);
  }

  // -- weapon spawner badge -------------------------------------------------
  // A spawner's whole configuration is one prop, and a crate looks the same
  // whatever it holds, so the set is drawn above it. Kept as a scene-level
  // sprite rather than a child of the mesh: a child inherits the object's
  // scale, and a spawner stretched to 3 m would stretch its label with it.

  /** Build or refresh the badge for one spawner, and drop it if it has none. */
  _refreshWeaponBadge(mesh) {
    const value = mesh.userData.props?.specificWeapon;
    if (value === undefined) return;

    let badge = this._badges.get(mesh);
    if (!badge) {
      const texture = new THREE.CanvasTexture(document.createElement('canvas'));
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthTest: false, sizeAttenuation: true,
      }));
      sprite.renderOrder = 10;
      this.scene.add(sprite);
      badge = { sprite, texture, value: null };
      this._badges.set(mesh, badge);
    }
    if (badge.value === value) return;
    badge.value = value;
    this._drawBadge(badge, parseWeapons(value), value === WEAPON_ANY);
  }

  /** Paint the icon strip. Icons decode late, so it repaints as they arrive. */
  _drawBadge(badge, weapons, isAny) {
    const CELL = 64, PAD = 6;
    const shown = weapons.slice(0, 6);
    const cols = Math.max(1, shown.length);
    const canvas = badge.texture.image;
    const width = cols * CELL + PAD * 2;
    const height = CELL + PAD * 2 + (isAny || weapons.length > shown.length ? 20 : 0);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      // Resizing a canvas behind a live texture leaves the old bitmap on the
      // GPU, so the sprite would wear the previous weapon set stretched to the
      // new shape. Hand the material a fresh texture instead.
      badge.texture.dispose();
      badge.texture = new THREE.CanvasTexture(canvas);
      badge.texture.colorSpace = THREE.SRGBColorSpace;
      badge.sprite.material.map = badge.texture;
      badge.sprite.material.needsUpdate = true;
    }

    const paint = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(10,15,20,0.78)';
      ctx.strokeStyle = 'rgba(232,197,71,0.55)';
      ctx.lineWidth = 2;
      const r = 8;
      ctx.beginPath();
      ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, r);
      ctx.fill();
      ctx.stroke();
      shown.forEach((w, i) => {
        const img = badge.images?.[w];
        if (img?.complete && img.naturalWidth) {
          ctx.drawImage(img, PAD + i * CELL, PAD, CELL, CELL);
        }
      });
      if (isAny || weapons.length > shown.length) {
        ctx.fillStyle = '#E8C547';
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(isAny ? 'ANY' : `+${weapons.length - shown.length}`,
          canvas.width / 2, canvas.height - 7);
      }
      badge.texture.needsUpdate = true;
      // Height fixed, width follows the icon count, so one weapon reads as a
      // small tag rather than a banner.
      const H = 0.22;
      badge.sprite.scale.set(H * (canvas.width / canvas.height), H, 1);
    };

    badge.images = {};
    for (const w of shown) {
      const url = iconUrl({ icon: WEAPON_ICONS[w] });
      if (!url) continue;
      const img = new Image();
      img.onload = paint;
      img.src = url;
      badge.images[w] = img;
    }
    paint();
  }

  _dropWeaponBadge(mesh) {
    const badge = this._badges.get(mesh);
    if (!badge) return;
    this.scene.remove(badge.sprite);
    badge.sprite.material.map?.dispose();
    badge.sprite.material.dispose();
    this._badges.delete(mesh);
  }

  /** Float each badge just above its object, in world space. */
  _placeBadges() {
    if (!this._badges.size) return;
    const box = new THREE.Box3();
    for (const [mesh, badge] of this._badges) {
      box.setFromObject(mesh);
      if (box.isEmpty()) continue;
      badge.sprite.position.set(
        (box.min.x + box.max.x) / 2,
        box.max.y + 0.28,
        (box.min.z + box.max.z) / 2,
      );
    }
  }

  _frame() {
    this.orbit.update();
    this._placeBadges();
    this.renderer.render(this.scene, this.camera);
  }
}
