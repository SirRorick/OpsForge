// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ComboGizmo } from './gizmo.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { geometryFor } from './placeholders.js';
import { defFor, modelUrl, iconUrl } from './catalog.js';
import {
  WEAPON_ICONS, WEAPON_ANY, parseWeapons,
  ENEMY_ICONS, ENEMY_MODELS, ENEMY_TYPES, ENEMY_ANY, parseEnemyTypes,
} from './packs.js';
import { convertPosition, unityEulerToQuat, quatToUnityEuler } from './unity.js';
import { decodeNavCloud, navIndexToWorld, NAV_SPACING } from './format.js';

const ACCENT = 0xe8c547;
const CYAN = 0x4ec9e0;

// -- prefab meshes -----------------------------------------------------------
// A missing asset is normal, not an error, so each one is mentioned once.
const warnedModels = new Set();

// `vfx` covers the runtime effects the spawners carry: the weapon spawner's
// SpawnBoxVFX holds a single-sided LightQuad two metres by four, which reads as
// a pane hanging in the air that vanishes when you orbit past it.
// `*Hologram` is included on the evidence of the meshes themselves: every one
// in the dump is a shell of the object it sits on, a centimetre proud of the
// surface and wearing MATTerminalSpawn, which carries neither a texture nor a
// colour. HandgunBotSpawnerHologram inside EnemySpawnPoint looked from its name
// like the exception — a preview of the bot that spawns there — and was kept
// for a while on that reading. It is not: it measures 1.08 x 0.30 x 1.08
// against the pad's 1.06 x 0.29 x 1.06, so it is the pad's own shell, and being
// colourless it took the catalog's red and hid the textured pad underneath it.
// The prefab's BotPreview node holds no mesh at all; the figure is a separate
// prefab, loaded by `_refreshFigure` below.
const FURNITURE = /manipulator|collider|hologram|ghost|outline|lockspawner|vfx/i;

/** True when the node, or any ancestor, is editor furniture rather than art. */
function isFurniture(node) {
  for (let n = node; n; n = n.parent) {
    if (FURNITURE.test(n.name || '')) return true;
  }
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
 * Settings for an object the catalog marks translucent. A damage box marks a
 * region rather than filling it, so you have to see what is inside. Depth
 * writing is off so whatever sits behind still draws, and both faces render so
 * the far walls of the volume are visible from outside.
 */
function translucency(opacity) {
  if (opacity >= 1) return {};
  return { transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide };
}

/**
 * A flat marker whose texture is mostly transparent — the domination zones are
 * one quad wearing "Circle Outline 1024px - Stroke 10px.png". glTF only marks a
 * material as cut out when the exporter said so, and this one did not, so the
 * alpha channel was ignored and the ring drew as a solid white square.
 */
function cutout() {
  return {
    transparent: true, alphaTest: 0.05, depthWrite: false, side: THREE.DoubleSide,
  };
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

function displayMaterial(material, tint, opacity = 1, force = false, cut = false) {
  if (Array.isArray(material)) return material.map((m) => displayMaterial(m, tint, opacity, force, cut));
  if (!material) return material;
  const key = `${material.uuid}|${tint ?? ''}|${opacity}|${force}|${cut}`;
  if (displayMaterials.has(key)) return displayMaterials.get(key);
  const out = material.clone();
  if (out.metalness !== undefined && !out.envMap) {
    out.metalness = Math.min(out.metalness, 0.25);
    out.roughness = Math.max(out.roughness ?? 0.5, 0.45);
  }
  // `force` is for prefabs whose art is deliberately colourless and gets its
  // team colour from a shader the export could not carry — the player spawn
  // zones are a white gradient that Unity tints blue or orange. Multiplying a
  // greyscale map by the catalog colour is what that shader did.
  if (tint && (force || (!out.map && out.color?.getHex() === 0xffffff))) out.color.set(tint);
  Object.assign(out, translucency(opacity));
  if (cut) Object.assign(out, cutout());
  displayMaterials.set(key, out);
  return out;
}

/** Largest value a normalised attribute of this type can hold: its "1.0". */
const FULL_SCALE = new Map([
  [Int8Array, 127], [Uint8Array, 255], [Int16Array, 32767], [Uint16Array, 65535],
]);

const matchesTemplate = (attr, template) =>
  attr && attr.itemSize === template.itemSize
  && attr.array.constructor === template.array.constructor
  && attr.normalized === template.normalized;

/**
 * A vertex colour of "no change", in whatever form the prefab already uses.
 *
 * mergeGeometries needs every part to agree on the array *type* of an
 * attribute, not just its item count, and the prefabs do not agree: a player
 * spawn zone mixes parts carrying a normalised Uint8 colour with parts carrying
 * none. Substituting a Float32 white for the missing ones failed the merge, and
 * the fallback below then drew the whole spawn machine as whichever single mesh
 * had the most vertices — its pillar, without the dish on top.
 */
function neutralColour(template, count) {
  const Kind = template.array.constructor;
  const white = template.normalized ? (FULL_SCALE.get(Kind) ?? 1) : 1;
  const attr = new THREE.BufferAttribute(
    new Kind(count * template.itemSize).fill(white), template.itemSize);
  attr.normalized = template.normalized;
  return attr;
}

/**
 * One geometry for the whole prefab. Merging needs every part to carry the same
 * attributes, which is not guaranteed across a prefab's meshes, so trim each to
 * position and normal first; if a merge still fails, the largest single part is
 * a better stand-in than nothing.
 *
 * `opacity` is the object's, and a part may override it with its own — one draw
 * group per part means a prefab can hold a translucent volume and a solid
 * machine at once, which is exactly what a player spawn zone is.
 */
function mergeForDisplay(parts, tint, opacity, force, cut) {
  const opacityOf = (p) => p.opacity ?? opacity;
  // Some prefabs carry vertex colours on the visible mesh and not on the rest —
  // the solid primitives do, the props do not. GLTFLoader turns that into
  // material.vertexColors, so a part that loses the attribute renders black.
  // Anything missing one gets opaque white, which multiplies to no change.
  const template = parts.map(({ geometry }) => geometry.getAttribute('color')).find(Boolean);

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
    if (template) {
      const colour = g.getAttribute('color');
      out.setAttribute('color', matchesTemplate(colour, template)
        ? colour
        : neutralColour(template, position.count));
    }
    if (!normal) out.computeVertexNormals();
    return out;
  });
  try {
    // useGroups keeps one draw group per part, so the prefab's own materials
    // survive as a material array and the object arrives textured.
    const merged = mergeGeometries(trimmed, true);
    if (merged) {
      return {
        geometry: merged,
        materials: parts.map((p) => displayMaterial(p.material, tint, opacityOf(p), force, cut)),
      };
    }
  } catch { /* fall through to the largest part */ }
  let best = 0;
  trimmed.forEach((g, i) => {
    if (g.getAttribute('position').count > trimmed[best].getAttribute('position').count) best = i;
  });
  return {
    geometry: trimmed[best],
    materials: displayMaterial(parts[best].material, tint, opacityOf(parts[best]), force, cut),
  };
}

/**
 * Flatten the parts of a prefab that draw a volume rather than a solid.
 *
 * A player spawn zone ships as a one metre cube centred on the object's origin.
 * It marks the area a team spawns in; it is not a wall, and drawn as one it
 * hides everything inside it and drags the rest of the prefab half a metre off
 * the floor when the whole thing is seated. The named parts are remapped
 * together onto [0, height] so the slab rests on the floor exactly, and are
 * handed the area's own opacity so the solid parts stay solid.
 *
 * The parts are remapped as one group rather than each on its own: the zone's
 * four floor quads are flat, and normalising a zero-height part individually
 * would divide by nothing and lose where it sat relative to the cube.
 */
function flattenArea(area, parts) {
  if (!area?.parts) return parts;
  const re = new RegExp(area.parts, 'i');
  const marked = new Set(parts.filter((p) => re.test(p.path)));
  if (!marked.size || marked.size === parts.length) return parts;

  const box = new THREE.Box3();
  for (const p of marked) {
    box.union(new THREE.Box3().setFromBufferAttribute(p.geometry.getAttribute('position')));
  }
  const span = box.max.y - box.min.y;
  const scale = span > 1e-6 ? (area.height ?? 0.1) / span : 1;

  return parts.map((p) => {
    if (!marked.has(p)) return p;
    const geometry = p.geometry.clone();
    geometry.translate(0, -box.min.y, 0);
    geometry.scale(1, scale, 1);
    return { ...p, geometry, opacity: area.opacity ?? 1 };
  });
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
    // The combined gizmo is the one you get on a fresh selection; Move, Rotate
    // and Scale switch to the single-purpose ones.
    this.gizmoMode = 'combined';
    this.gizmoSpace = 'world';
    // Draw the procedural stand-ins even when the real prefabs are on disk, so
    // the two can be compared. Off by default: the real art is better when it
    // is there.
    this.usePlaceholders = false;
    this.placing = null;
    this._pointer = null;
    this._nextId = 1;
    this._edgeCache = new Map();
    this._materials = new Map();
    this._modelCache = new Map();
    this._badges = new Map();
    this._fixedParts = new Map();
    this._figures = new Map();
    this._figureCache = new Map();
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
    // Two millimetres under the floor rather than on it. A domination zone is a
    // flat quad at exactly y = 0 and was fighting this plane for the same
    // pixels; dropping the shadow catcher below the floor leaves y = 0 to the
    // objects that actually sit there.
    this.ground.position.y = -0.002;
    this.scene.add(this.ground);

    // Everything that lives at floor level is coplanar with everything else at
    // floor level, and the depth buffer cannot separate them — which is what
    // made the grid strobe against the shadow plane and the domination rings
    // strobe against both. So the ground layers are stacked in a few
    // millimetres, smallest first, and none of them writes depth.
    this.grid = new THREE.GridHelper(40, 160, 0x2f4553, 0x1c2831);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.75;
    this.grid.material.depthWrite = false;
    this.grid.position.y = -0.006;
    this.grid.renderOrder = -2;
    this.scene.add(this.grid);

    // A bolder cross through the middle of the arena, so the halfway line is
    // findable when building something symmetrical. Sized in setBounds.
    //
    // Thin quads rather than lines: WebGL ignores `linewidth` on every desktop
    // driver, so a LineBasicMaterial cannot be made any heavier than the grid
    // it has to stand out from. A three centimetre strip can.
    this.centreLines = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x5f8ba4, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    this.centreLines.position.y = -0.004;
    this.centreLines.renderOrder = -1;
    this.scene.add(this.centreLines);

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

    // The combined gizmo does move, rotate and scale at once. It speaks the
    // same two events, so both go through one pair of handlers and everything
    // downstream — snapping, floor lock, the scale anchor — is shared.
    this.combo = new ComboGizmo(this.camera, this.canvas);
    this.scene.add(this.combo);

    const onDragChange = (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._beginDrag();
      else this._endDrag();
    };
    const onObjectChange = () => {
      this._constrainDuringDrag();
      this.emit('transform');
    };
    for (const g of [this.gizmo, this.combo]) {
      g.addEventListener('dragging-changed', onDragChange);
      g.addEventListener('objectChange', onObjectChange);
    }

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
    const opacity = def.opacity ?? 1;
    const key = `${def.color}|${opacity}${def.unknown ? '!' : ''}`;
    if (!this._materials.has(key)) {
      this._materials.set(
        key,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(def.color),
          roughness: 0.82,
          metalness: 0.04,
          flatShading: false,
          ...translucency(opacity),
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
    this._refreshBadge(mesh);
    this._refreshFigure(mesh);
    if (def.model && !this.usePlaceholders) this._swapInModel(mesh, def);
    return mesh;
  }

  /**
   * Swap the whole scene between the real prefabs and the procedural
   * placeholders. The placeholders are what the open-source build ships, and
   * the only way to tell whether one of them resembles the piece it stands in
   * for is to look at both in the same viewport.
   *
   * Geometry and material only — nothing about the map changes, so this cannot
   * dirty an object or move it.
   */
  setUsePlaceholders(on) {
    const next = !!on;
    if (next === this.usePlaceholders) return;
    this.usePlaceholders = next;
    for (const mesh of this.objects) {
      const def = mesh.userData.def;
      if (!def.model) continue;
      if (next) {
        this._dropFixedPart(mesh);
        mesh.geometry = geometryFor(def);
        mesh.material = this.materialFor(def);
        const figure = this._figures.get(mesh)?.child;
        if (figure) figure.position.y = mesh.geometry.boundingBox.max.y;
        this._refreshOutline(mesh);
      } else {
        this._swapInModel(mesh, def);
      }
    }
    this.rebuildPivot();
    this.emit('change');
  }

  /**
   * Part of a prefab that must not stretch when the object is resized.
   *
   * A player spawn zone is a floor area you drag out to whatever size the team
   * needs, with a machine standing at one corner of it. The map object's scale
   * is the size of the *area*; the machine keeps its own size and rides the
   * corner. Merging the two and scaling the lot would stretch the machine along
   * with the floor.
   *
   * The fixed part is a child of the object, so it follows position, rotation
   * and the corner as the area grows, and its scale is inverted each frame to
   * cancel the parent's.
   */
  _splitFixedPart(mesh, def, parts) {
    const pattern = def.fixedParts;
    if (!pattern) return { scaled: parts, fixed: [] };
    const re = new RegExp(pattern, 'i');
    const scaled = [], fixed = [];
    for (const p of parts) (re.test(p.path) ? fixed : scaled).push(p);
    // All of it fixed, or none of it, means the split has nothing to say.
    return scaled.length && fixed.length ? { scaled, fixed } : { scaled: parts, fixed: [] };
  }

  _attachFixedPart(mesh, def, fixed, dropY) {
    this._dropFixedPart(mesh);
    if (!fixed.length) return;
    const model = mergeForDisplay(fixed, def.color, def.opacity ?? 1, def.tintModel === true,
      def.cutout === true);
    model.geometry.translate(0, dropY, 0);
    const child = new THREE.Mesh(model.geometry, model.materials);
    child.userData.fixedScale = true;
    mesh.add(child);
    this._fixedParts.set(mesh, child);
  }

  _dropFixedPart(mesh) {
    const child = this._fixedParts.get(mesh);
    if (!child) return;
    child.removeFromParent();
    this._fixedParts.delete(mesh);
  }

  /** Cancel the parent's scale on every fixed part, once per frame. */
  _holdFixedParts() {
    for (const [mesh, child] of this._fixedParts) {
      child.scale.set(
        1 / (mesh.scale.x || 1e-6),
        1 / (mesh.scale.y || 1e-6),
        1 / (mesh.scale.z || 1e-6),
      );
    }
  }

  // -- spawned figure --------------------------------------------------------
  // An enemy spawner is a bare metal pad. What tells one apart from another is
  // what walks off it, and the dump ships a textured figure of every enemy —
  // `<Enemy>BotSpawner.glb`, a 1.7 m humanoid for the gun bots, a hovering
  // drone or a chopper for the other two. Standing one on the pad is the whole
  // difference between "a spawner" and "a sniper spawner".
  //
  // A child of the object rather than a mesh merged into it: the figure changes
  // whenever the user reticks the enemy list, and it must not join the pad's
  // outline or its picking geometry. It does inherit the object's scale, which
  // is right — a pad stretched to twice the size is drawn with a bot to match.

  /** Build or replace the figure standing on one spawner. */
  _refreshFigure(mesh) {
    const def = mesh.userData.def;
    if (def?.figure !== 'enemy') {
      this._dropFigure(mesh);
      return;
    }
    // Several ticked types means the game picks one at random each spawn, so
    // any of them is an honest illustration; take the first in library order,
    // which makes "All" show a handgun bot — the enemy the prefab itself names.
    const chosen = parseEnemyTypes(mesh.userData.props?.enemyTypes);
    const type = ENEMY_TYPES.find((t) => chosen.includes(t)) ?? chosen[0];
    const model = ENEMY_MODELS[type];
    const current = this._figures.get(mesh);
    if (current?.model === model) return;
    this._dropFigure(mesh);
    if (!model) return;

    // The load is async and the user can retick faster than it resolves, so the
    // token says whether this answer is still the one being waited for.
    const token = {};
    this._figures.set(mesh, { model, token, child: null });
    this._loadFigure(model).then((built) => {
      const entry = this._figures.get(mesh);
      if (!built || entry?.token !== token || !mesh.parent) return;
      const child = new THREE.Mesh(built.geometry, built.materials);
      child.castShadow = true;
      child.receiveShadow = true;
      // On top of the pad, in the object's own unscaled space.
      mesh.geometry.computeBoundingBox();
      child.position.y = mesh.geometry.boundingBox.max.y;
      mesh.add(child);
      entry.child = child;
      this.emit('change');
    });
  }

  /** One merged, floor-seated geometry per enemy prefab. */
  async _loadFigure(model) {
    if (!this._figureCache.has(model)) {
      this._figureCache.set(model, (async () => {
        const url = modelUrl({ model });
        try {
          const parts = await this._prefabParts(url);
          if (!parts.length) return null;
          // No tint: these prefabs are fully textured, and a tint would only
          // ever reach a part that shipped without art.
          const built = mergeForDisplay(parts, null, 1, false, false);
          built.geometry.computeBoundingBox();
          // Drone and chopper hover in their own prefabs; only the ground is
          // moved, so whatever height the artists gave them is kept.
          built.geometry.translate(0, -built.geometry.boundingBox.min.y, 0);
          built.geometry.computeBoundingBox();
          return built;
        } catch (err) {
          if (!warnedModels.has(model)) {
            warnedModels.add(model);
            console.warn(`No figure at ${url}, drawing the pad bare.`, err.message ?? err);
          }
          return null;
        }
      })());
    }
    return this._figureCache.get(model);
  }

  _dropFigure(mesh) {
    const entry = this._figures.get(mesh);
    if (!entry) return;
    entry.child?.removeFromParent();
    this._figures.delete(mesh);
  }

  /**
   * Every part of a prefab worth drawing, baked into the prefab's own space.
   *
   * Most of a prefab is not the object: drag handles, a hologram shell a couple
   * of centimetres proud of the surface, collider proxies, an outline, and
   * lower LODs. Including them makes every primitive 1.25 m. See
   * tools/measure-prefabs.mjs, which filters identically.
   */
  async _prefabParts(url) {
    const gltf = await this._gltf.loadAsync(url);
    const found = [];
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((n) => {
      if (!n.isMesh || isFurniture(n) || lowerLod(n)) return;
      const geometry = n.geometry.clone();
      geometry.applyMatrix4(n.matrixWorld);
      const path = [];
      for (let p = n; p; p = p.parent) path.unshift(p.name || '');
      found.push({ geometry, material: n.material, path: path.join('/') });
    });
    return found;
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
      const cacheKey = `${def.model}|${def.pivot}|${def.size[1]}|${def.color}|${def.opacity ?? 1}` +
        `|${def.tintModel}|${def.fixedParts ?? ''}|${def.cutout}|${JSON.stringify(def.area ?? null)}`;
      let model = this._modelCache.get(cacheKey);
      if (!model) {
        const found = await this._prefabParts(url);
        if (!found.length) return;

        const { scaled, fixed } = this._splitFixedPart(mesh, def, found);
        const whole = mergeForDisplay(flattenArea(def.area, scaled), def.color, def.opacity ?? 1,
          def.tintModel === true, def.cutout === true);
        // Seat on the floor using the whole object's extent, then move the
        // fixed part by the same amount so it does not drift off the area.
        const before = new THREE.Box3().setFromBufferAttribute(
          whole.geometry.getAttribute('position')).min.y;
        seatOnFloor(whole.geometry, def);
        const after = new THREE.Box3().setFromBufferAttribute(
          whole.geometry.getAttribute('position')).min.y;
        model = { ...whole, fixed, dropY: after - before };
        this._modelCache.set(cacheKey, model);
      }
      mesh.geometry = model.geometry;
      mesh.material = model.materials;
      this._attachFixedPart(mesh, def, model.fixed, model.dropY);
      // The pad the figure stands on just changed height under it.
      const figure = this._figures.get(mesh)?.child;
      if (figure) figure.position.y = model.geometry.boundingBox.max.y;
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
      this._dropBadge(m);
      this._dropFixedPart(m);
      this._dropFigure(m);
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
      this._dropBadge(m);
      this._dropFixedPart(m);
      this._dropFigure(m);
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
      if (def.model) this._swapInModel(mesh, def);
    }
    this._refreshBadge(mesh);
    this._refreshFigure(mesh);
    this.markDirty(mesh);
    this.emit('change');
  }

  // -- selection ------------------------------------------------------------

  /**
   * A locked object cannot be selected, which is the whole of how locking is
   * enforced. Every way to move, rotate, scale, drop, nudge or delete something
   * goes through the selection, so keeping locked objects out of it means there
   * is exactly one guard rather than one per operation — and no path that
   * quietly forgot about it.
   *
   * Getting it unlocked again therefore cannot go through the selection either.
   * Right-clicking the object reaches it (`pickAt` ignores the lock) and so
   * does the padlock beside its row in the outliner.
   */
  setSelection(list) {
    const next = new Set([...list].filter((m) => !m.userData.locked));
    for (const m of this.selection) if (!next.has(m)) this._setOutline(m, false);
    for (const m of next) if (!this.selection.has(m)) this._setOutline(m, true);
    this.selection = next;
    this.rebuildPivot();
    this.emit('selection');
  }

  selectAll() {
    this.setSelection(this.objects);
  }

  setLocked(meshes, locked) {
    for (const m of meshes) m.userData.locked = !!locked;
    if (locked) this.setSelection([...this.selection].filter((m) => !m.userData.locked));
    this.emit('selection');
    this.emit('change');
  }

  /**
   * The object under a screen point, lock and grouping ignored. The context
   * menu needs this: a locked object has to be reachable by the one gesture
   * that can unlock it.
   */
  pickAt(ndcPoint) {
    this.ray.setFromCamera(ndcPoint, this.camera);
    const hits = this.ray.intersectObjects(this.objects, true);
    return this._ownerOf(hits.find((h) => h.object.isMesh)?.object) || null;
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
      // The combined one too. It used to be left attached here, so it hung in
      // the air over nothing after a deselect.
      this.combo.detach();
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

    if (this.gizmoMode === 'combined') {
      this.gizmo.detach();
      this.combo.attach(this.pivot);
    } else {
      this.combo.detach();
      this.gizmo.attach(this.pivot);
    }
    this._applyGizmoConstraints();
  }

  setGizmoMode(mode) {
    this.gizmoMode = mode;
    if (mode !== 'combined') this.gizmo.setMode(mode);
    this.rebuildPivot();
    this.emit('mode');
  }

  setGizmoSpace(space) {
    this.gizmoSpace = space;
    this.gizmo.setSpace(space);
    this.combo.space = space;
    this.emit('mode');
  }

  /**
   * Which of the three a drag is actually doing. TransformControls is in one
   * mode at a time and says so; the combined gizmo only knows once a handle has
   * been grabbed. `_beginDrag` needs the answer to decide whether to capture a
   * scale anchor.
   */
  _activeMode() {
    return this.gizmoMode === 'combined' ? this.combo.activeMode : this.gizmoMode;
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

    // The combined gizmo keeps its move and scale arms on whatever the piece
    // allows and drops only the rotation arcs it may not turn about, so a
    // yaw-only object still shows two of its three arcs' worth of handles.
    this.combo.translationSnap = this.snap.translate || null;
    this.combo.rotationSnap = this.snap.rotate ? THREE.MathUtils.degToRad(this.snap.rotate) : null;
    this.combo.scaleSnap = this.snap.scale || null;
    this.combo.space = this.gizmoSpace;
    this.combo.uniform = this.uniformScale;
    this.combo.showRotate = { x: !yawOnly, y: true, z: !yawOnly };
  }

  setSnap(part, value) {
    this.snap[part] = value;
    this._applyGizmoConstraints();
    this.emit('mode');
  }

  _beginDrag() {
    this._dragStartScale = this.pivot.scale.clone();
    this._scaleAnchor = this._activeMode() === 'scale' ? this._captureScaleAnchor() : null;
    this.emit('commit-begin');
  }

  _constrainDuringDrag() {
    if (this._activeMode() === 'scale') {
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
      this._applyScaleAnchor();
    }
    if (this.floorLock) this._applyFloorLock();
  }

  // -- scale anchoring -------------------------------------------------------
  // TransformControls scales about the object's origin, so a crate shrinks away
  // from every face at once: pull the right-hand handle in and the left-hand
  // face comes with it, and shrink a centre-pivot box standing on the floor and
  // it ends up hanging in the air. The side you are not dragging should stay
  // exactly where it is, which is what the game's own stretcher does — its
  // spawn zones carry PosX, NegX, PosZ and NegZ handles, one per edge.

  /**
   * Bounding box of the selection's own geometry in pivot-local space.
   *
   * Its own geometry, not `setFromObject`: the machine on a spawn zone and the
   * bot on an enemy spawner are children, and anchoring to the top of a two
   * metre machine rather than the floor pad it stands on would be wrong. Exact
   * under rotation, because the corners are transformed rather than a world
   * AABB being squeezed back into local space.
   */
  _selectionLocalBox() {
    const box = new THREE.Box3();
    const toLocal = new THREE.Matrix4();
    const corner = new THREE.Vector3();
    this.pivot.updateMatrixWorld(true);
    const inv = this.pivot.matrixWorld.clone().invert();
    for (const m of this.selection) {
      m.updateWorldMatrix(true, false);
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      toLocal.multiplyMatrices(inv, m.matrixWorld);
      for (let i = 0; i < 8; i++) {
        corner.set(
          i & 1 ? bb.max.x : bb.min.x,
          i & 2 ? bb.max.y : bb.min.y,
          i & 4 ? bb.max.z : bb.min.z
        );
        box.expandByPoint(corner.applyMatrix4(toLocal));
      }
    }
    return box;
  }

  /**
   * Which end of an axis the user grabbed: +1, -1, or 0 when it cannot be told.
   *
   * TransformControls names both ends of a scale axis "X", so the handle does
   * not say which side the drag started from. The pointer does: project the
   * axis onto the screen and see which way along it the cursor sits.
   */
  _handleSign(a) {
    if (!this._pointer) return 0;
    const r = this.canvas.getBoundingClientRect();
    const project = (v) => {
      const p = v.clone().project(this.camera);
      return new THREE.Vector2(((p.x + 1) / 2) * r.width, ((1 - p.y) / 2) * r.height);
    };
    // The scale gizmo is drawn in the object's own frame whatever `gizmoSpace`
    // says, so the axis to project is the pivot's. Length only has to put the
    // probe somewhere near the handle; which of the two ends is nearer the
    // cursor does not depend on how far out it sits.
    const dir = new THREE.Vector3(+(a === 'x'), +(a === 'y'), +(a === 'z'))
      .applyQuaternion(this.pivot.quaternion)
      .multiplyScalar(this.camera.position.distanceTo(this.pivot.position) * 0.1);
    const origin = project(this.pivot.position);
    const along = project(this.pivot.position.clone().add(dir)).sub(origin);
    if (along.lengthSq() < 1) return 0;      // edge on: no side to read
    const cursor = new THREE.Vector2(this._pointer.clientX - r.left, this._pointer.clientY - r.top);
    return Math.sign(cursor.sub(origin).dot(along));
  }

  /** The point that must not move during this drag, in pivot-local space. */
  _captureScaleAnchor() {
    const box = this._selectionLocalBox();
    if (box.isEmpty()) return null;
    const centre = box.getCenter(new THREE.Vector3());
    // Y holds at the bottom whatever axis is being dragged, so something that
    // was standing on the floor is still standing on it afterwards. That is the
    // case uniform scaling gets wrong even when no vertical handle is touched.
    const point = new THREE.Vector3(centre.x, box.min.y, centre.z);
    const axis = this.gizmo.axis || '';
    // The uniform handle sits in the middle and has no near end to read.
    if (axis !== 'XYZ') {
      for (const a of ['x', 'y', 'z']) {
        if (!axis.includes(a.toUpperCase())) continue;
        const sign = this._handleSign(a);
        if (sign) point[a] = sign > 0 ? box.min[a] : box.max[a];
      }
    }
    return { point, positions: new Map([...this.selection].map((m) => [m, m.position.clone()])) };
  }

  /**
   * Hold the anchor still as the scale changes.
   *
   * A point at pivot-local `p` lands at `S * p`, so restoring it to where `S0`
   * had it means offsetting every child by `(S0/S - 1) * anchor`. Recomputed
   * from the drag-start positions each frame rather than accumulated, so
   * nothing drifts and floor lock is free to overrule the Y it produces.
   *
   * The children move rather than the pivot, deliberately: TransformControls
   * measures the drag against a plane through the gizmo's own position, so
   * moving the gizmo mid-drag feeds straight back into the scale it computes.
   */
  _applyScaleAnchor() {
    const anchor = this._scaleAnchor;
    if (!anchor) return;
    const s = this.pivot.scale;
    const s0 = this._dragStartScale;
    const shift = new THREE.Vector3(
      (s0.x / (s.x || 1e-6) - 1) * anchor.point.x,
      (s0.y / (s.y || 1e-6) - 1) * anchor.point.y,
      (s0.z / (s.z || 1e-6) - 1) * anchor.point.z,
    );
    for (const [m, start] of anchor.positions) {
      if (m.parent === this.pivot) m.position.copy(start).add(shift);
    }
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
    this._scaleAnchor = null;
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
      // Recorded before the early return below: a scale drag reads it to work
      // out which end of the handle was grabbed, and a press with no move
      // before it would otherwise leave it stale.
      this._pointer = { clientX: e.clientX, clientY: e.clientY };
      // While a brush is up, the left button paints the bot grid and does not
      // select. Checked before the gizmo, because the gizmo is hidden anyway
      // and a stray hover must not swallow the stroke.
      if (this.navPaint && e.button === 0 && !e.altKey) {
        e.preventDefault();
        this._painting = true;
        this.orbit.enabled = false;
        this.emit('commit-begin');
        this._paintNavAt(e);
        return;
      }
      // this.gizmo.axis is set while a handle is hovered; TransformControls
      // registers its listeners first, so this reliably wins.
      if (e.button !== 0 || e.altKey || this.gizmo.dragging || this.gizmo.axis) return;
      if (this.combo.dragging || this.combo.hovered) return;
      if (this.placing) return;   // that click drops what is being placed
      down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      this.emit('marquee-start', down);
    });

    addEventListener('pointermove', (e) => {
      this._pointer = { clientX: e.clientX, clientY: e.clientY };
      if (this._painting) { this._paintNavAt(e); return; }
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
      if (this._painting) {
        this._painting = false;
        this.orbit.enabled = true;
        // One undo step per stroke, not per cell.
        this.emit('nav-painted');
        return;
      }
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

  /** The object a raycast hit belongs to, or null if it hit scenery. */
  _ownerOf(node) {
    for (let n = node; n; n = n.parent) if (this.objects.includes(n)) return n;
    return null;
  }

  _clickSelect(ndcPoint, mods) {
    this.ray.setFromCamera(ndcPoint, this.camera);
    // Recursive: half of what you see of some objects is a child rather than
    // the object's own geometry — the spawn zone's machine, the bot standing on
    // an enemy spawner — and clicking the visible thing has to select it.
    // Meshes only, because the selection outline is a child too, and line
    // picking uses a one metre threshold that would grab it from across the map.
    const hits = this.ray.intersectObjects(this.objects, true);
    const hit = this._ownerOf(hits.find((h) => h.object.isMesh)?.object);
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
      this.pivot.position.copy(g).add(lead);
      // Snap after the lead offset, not before it. `lead` is the gap between
      // the cursor and the pivot, and for anything whose origin is not in the
      // middle of its own footprint — a corner barrier is 44 cm out — it is not
      // a whole number of grid steps. Snapping the ground point and then adding
      // it put the object down off-grid, which is the position that gets
      // exported.
      const s = this.snap.translate;
      if (s) {
        this.pivot.position.x = Math.round(this.pivot.position.x / s) * s;
        this.pivot.position.z = Math.round(this.pivot.position.z / s) * s;
      }
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

    // The halfway cross, a little longer than the arena so it reads as a datum
    // rather than as part of the box. Two strips lying flat, as triangles.
    const over = 0.6;
    const w = 0.015;                       // half width, so 3 cm across
    const halfX = x / 2 + over;
    const halfZ = z / 2 + over;
    const quad = (x0, z0, x1, z1) => [
      x0, 0, z0, x1, 0, z0, x1, 0, z1,
      x0, 0, z0, x1, 0, z1, x0, 0, z1,
    ];
    const cross = new THREE.BufferGeometry();
    cross.setAttribute('position', new THREE.Float32BufferAttribute([
      ...quad(-halfX, -w, halfX, w),
      ...quad(-w, -halfZ, w, halfZ),
    ], 3));
    this.centreLines.geometry.dispose();
    this.centreLines.geometry = cross;
  }

  /** Draw the play space mask so it is obvious where the player can walk. */
  /**
   * The walkable grid, kept decoded so a brush stroke does not have to gzip
   * anything between one cell and the next. `navMask` is the live copy;
   * `app.js` re-encodes it once a stroke ends.
   */
  async setNavCloud(navCloud) {
    this.navGroup.clear();
    this.navMask = null;
    this.navGrid = null;
    if (!navCloud) return;
    const N = navCloud.divisions.x;
    const M = navCloud.divisions.y;
    let bytes;
    if (navCloud.encodedPoints) {
      try { bytes = await decodeNavCloud(navCloud.encodedPoints); } catch { return; }
    } else {
      bytes = new Uint8Array(N * M);
    }
    if (bytes.length < N * M) {
      const grown = new Uint8Array(N * M);
      grown.set(bytes.subarray(0, Math.min(bytes.length, grown.length)));
      bytes = grown;
    }
    this.navMask = bytes;
    this.navGrid = { N, M };
    this._renderNavMask();
  }

  /** Redraw the outline from whatever `navMask` currently says. */
  _renderNavMask() {
    this.navGroup.clear();
    const bytes = this.navMask;
    if (!bytes || !this.navGrid) return;
    const { N, M } = this.navGrid;
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

  /**
   * Pick up or put down a brush. 'add' and 'remove' both paint with the left
   * button; null hands it back to selection.
   */
  setNavPaint(mode, radius = 0.5) {
    this.navPaint = mode || null;
    this.navBrush = radius;
    this.canvas.style.cursor = mode ? 'crosshair' : '';
    this.emit('mode');
  }

  /** Wipe the grid without touching its size or spacing. */
  clearNavMask() {
    if (!this.navMask) return;
    this.navMask.fill(0);
    this._renderNavMask();
  }

  /**
   * Paint one dab where the pointer meets the floor.
   *
   * The row index runs the opposite way to world Z — `_renderNavMask` draws row
   * r at `-navIndexToWorld(r)` — so the inverse has to negate as well, or the
   * grid comes out mirrored front to back against the map it belongs to.
   */
  _paintNavAt(e) {
    if (!this.navMask || !this.navGrid || !this.navPaint) return;
    const hit = this.groundPoint(e.clientX, e.clientY);
    if (!hit) return;
    const { N, M } = this.navGrid;
    const value = this.navPaint === 'add' ? 1 : 0;
    const toIndex = (metres, divisions) => (metres / NAV_SPACING) + (divisions - 1) / 2;
    const cx = toIndex(hit.x, N);
    const cr = toIndex(-hit.z, M);
    const reach = this.navBrush / NAV_SPACING;
    const r0 = Math.max(0, Math.floor(cr - reach)), r1 = Math.min(M - 1, Math.ceil(cr + reach));
    const c0 = Math.max(0, Math.floor(cx - reach)), c1 = Math.min(N - 1, Math.ceil(cx + reach));
    let touched = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if ((r - cr) ** 2 + (c - cx) ** 2 > reach * reach) continue;
        const i = r * N + c;
        if (this.navMask[i] === value) continue;
        this.navMask[i] = value;
        touched = true;
      }
    }
    if (touched) this._renderNavMask();
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

  // -- spawner badge ---------------------------------------------------------
  // A spawner's whole configuration is one or two props, and a pad looks the
  // same whatever it holds, so the set is drawn above it. Kept as a scene-level
  // sprite rather than a child of the mesh: a child inherits the object's
  // scale, and a spawner stretched to 3 m would stretch its label with it.

  /**
   * What one object's badge should say, or null when it wants none.
   *
   * `value` is the whole content collapsed to a string, so the repaint check is
   * one comparison however many props feed it.
   */
  _badgeContent(mesh) {
    const def = mesh.userData.def;
    const props = mesh.userData.props || {};
    // A domination zone is a ring painted on the floor, which says nothing
    // about which of the three it is; the letter is the whole identity.
    if (def?.badge) return { value: def.badge, letter: def.badge, colour: def.color };
    if (props.specificWeapon !== undefined) {
      return {
        value: `w:${props.specificWeapon}`,
        items: parseWeapons(props.specificWeapon),
        icons: WEAPON_ICONS,
        any: props.specificWeapon === WEAPON_ANY,
      };
    }
    if (props.enemyTypes !== undefined) {
      // Behaviour is the other half of what a spawner is set to, and unlike the
      // enemy list it has no icon anywhere in the dump, so it goes in as text.
      return {
        value: `e:${props.enemyTypes}|${props.behaviour ?? ''}`,
        items: parseEnemyTypes(props.enemyTypes),
        icons: ENEMY_ICONS,
        any: props.enemyTypes === ENEMY_ANY,
        note: props.behaviour,
      };
    }
    return null;
  }

  /** Build or refresh the badge for one object, and drop it if it has none. */
  _refreshBadge(mesh) {
    const content = this._badgeContent(mesh);
    if (!content) {
      this._dropBadge(mesh);
      return;
    }

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
    if (badge.value === content.value) return;
    badge.value = content.value;
    if (content.letter) this._drawLetterBadge(badge, content.letter, content.colour);
    else this._drawBadge(badge, content);
  }

  /** Paint a single big letter, for the domination zones. */
  _drawLetterBadge(badge, letter, colour) {
    const canvas = badge.texture.image;
    if (canvas.width !== 128 || canvas.height !== 128) {
      canvas.width = canvas.height = 128;
      badge.texture.dispose();
      badge.texture = new THREE.CanvasTexture(canvas);
      badge.texture.colorSpace = THREE.SRGBColorSpace;
      badge.sprite.material.map = badge.texture;
      badge.sprite.material.needsUpdate = true;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = 'rgba(10,15,20,0.78)';
    ctx.strokeStyle = colour ?? '#E8C547';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(2, 2, 124, 124, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colour ?? '#E8C547';
    ctx.font = '700 82px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, 64, 70);
    badge.texture.needsUpdate = true;
    badge.sprite.scale.set(0.3, 0.3, 1);
  }

  /** Paint the icon strip. Icons decode late, so it repaints as they arrive. */
  _drawBadge(badge, { items, icons, any, note }) {
    const CELL = 64, PAD = 6;
    const shown = items.slice(0, 6);
    const cols = Math.max(1, shown.length);
    const canvas = badge.texture.image;
    // Thirteen enemy types do not fit in one row, so what the strip leaves out
    // is said in the footer alongside the behaviour: "+2 · Aggresive". A
    // spawner set to everything says so instead of counting — "ANY" already
    // means the six icons are a sample.
    const spare = !any && items.length > shown.length ? `+${items.length - shown.length}` : null;
    const footer = [any ? 'ANY' : spare, note].filter(Boolean).join(' · ');
    const width = cols * CELL + PAD * 2;
    const height = CELL + PAD * 2 + (footer ? 20 : 0);

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
      if (footer) {
        ctx.fillStyle = '#E8C547';
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(footer, canvas.width / 2, canvas.height - 7);
      }
      badge.texture.needsUpdate = true;
      // Height fixed, width follows the icon count, so one weapon reads as a
      // small tag rather than a banner.
      const H = 0.22;
      badge.sprite.scale.set(H * (canvas.width / canvas.height), H, 1);
    };

    badge.images = {};
    for (const w of shown) {
      const url = iconUrl({ icon: icons?.[w] });
      if (!url) continue;
      const img = new Image();
      img.onload = paint;
      img.src = url;
      badge.images[w] = img;
    }
    paint();
  }

  _dropBadge(mesh) {
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
    this.combo.update();
    this._holdFixedParts();
    this._placeBadges();
    this.renderer.render(this.scene, this.camera);
  }
}
