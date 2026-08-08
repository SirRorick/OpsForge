// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { geometryFor } from './placeholders.js';
import { defOrUnknown } from './catalog.js';
import { convertPosition, unityEulerToQuat, quatToUnityEuler } from './unity.js';
import { decodeNavCloud, navIndexToWorld } from './format.js';

const ACCENT = 0xe8c547;
const CYAN = 0x4ec9e0;

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
    this._nextId = 1;
    this._edgeCache = new Map();
    this._materials = new Map();
    this._modelCache = new Map();
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
    // Left is reserved for selection. Right orbits, middle pans, Alt+Left orbits.
    this.orbit.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
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
    const def = defOrUnknown(mo.type);
    const mesh = new THREE.Mesh(geometryFor(def), this.materialFor(def));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      id: this._nextId++,
      def,
      raw: mo.raw || null,
      dirty: !!mo.dirty,
      group: null,
    };
    mesh.position.fromArray(convertPosition(mo.position));
    mesh.quaternion.fromArray(unityEulerToQuat(mo.rotation));
    mesh.scale.set(mo.scale.x, mo.scale.y, mo.scale.z);
    this.scene.add(mesh);
    this.objects.push(mesh);
    if (def.model) this._swapInModel(mesh, def);
    return mesh;
  }

  /** Replace the placeholder with a real asset once one is configured. */
  async _swapInModel(mesh, def) {
    try {
      let geo = this._modelCache.get(def.model);
      if (!geo) {
        const gltf = await this._gltf.loadAsync(def.model);
        const found = [];
        gltf.scene.updateWorldMatrix(true, true);
        gltf.scene.traverse((n) => {
          if (n.isMesh) {
            const g = n.geometry.clone();
            g.applyMatrix4(n.matrixWorld);
            found.push(g);
          }
        });
        if (!found.length) return;
        geo = found[0];
        this._modelCache.set(def.model, geo);
      }
      mesh.geometry = geo;
      this._refreshOutline(mesh);
      this.emit('change');
    } catch (err) {
      console.warn(`Could not load model for ${def.type}, keeping placeholder.`, err);
    }
  }

  removeObjects(meshes) {
    for (const m of meshes) {
      this._setOutline(m, false);
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
    this.setSelection([]);
    for (const m of this.objects) m.removeFromParent();
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
    return {
      $type: 'MapObject',
      type: mesh.userData.def.type,
      position: { x: p.x, y: p.y, z: -p.z },
      rotation: quatToUnityEuler(q.toArray()),
      scale: { x: s.x, y: s.y, z: s.z },
      raw: mesh.userData.raw,
      dirty: mesh.userData.dirty,
    };
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
      down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      this.emit('marquee-start', down);
    });

    addEventListener('pointermove', (e) => {
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

  _frame() {
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }
}
