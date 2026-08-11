// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ComboGizmo } from './gizmo.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { geometryFor } from './placeholders.js';
import { defFor, modelUrl, iconUrl } from './catalog.js';
import {
  WEAPON_ICONS, WEAPON_ANY, parseWeapons,
  ENEMY_ICONS, ENEMY_MODELS, ENEMY_TYPES, ENEMY_ANY, parseEnemyTypes,
} from './packs.js';
import { convertPosition, unityEulerToQuat, quatToUnityEuler, MODEL_YAW } from './unity.js';
import { decodeNavCloud, navIndexToWorld, NAV_SPACING } from './format.js';

const ACCENT = 0xe8c547;
const CYAN = 0x4ec9e0;

/**
 * The half turn every mesh carries relative to the map's own frame — see
 * MODEL_YAW in unity.js, which explains where it comes from.
 *
 * It matters here because the pivot the gizmo drives has to be in the *map's*
 * frame, not the mesh's. Left in the mesh's, an unrotated object's own +X
 * points along world −X, so the scale cube for X sat on the opposite side of
 * the gizmo from the X arrow, and the array tool stepped backwards along its
 * own axes. Turning the pivot by the same half turn and letting `attach` push
 * it down onto the mesh cancels both: the object's world transform is untouched
 * (a half turn about Y commutes with any diagonal scale), and every axis the
 * editor draws now means what the map file means by it.
 */
const MAP_FRAME = new THREE.Quaternion().fromArray(MODEL_YAW);

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

/**
 * Team colours recoverable from a material's *name*, for art that arrived
 * without any.
 *
 * The same trick the damage boxes need, and for the same reason: Unity put the
 * colour in a shader glTF has no slot for, and the only thing that survived the
 * export is what the artist called the material.
 */
const NAME_TINTS = [
  [/orange[ _]?team/i, 0xe08a3c],
  [/blue[ _]?team/i, 0x4a90d9],
  [/crystal/i, 0xd98a4a],
];

const nameTint = (name) => NAME_TINTS.find(([re]) => re.test(name || ''))?.[1] ?? null;

const normalMapVerdicts = new Map();

/**
 * Is this texture a normal map wearing a base colour's clothes?
 *
 * The five Corrupted enemy prefabs each carry one, and it is why they render as
 * a wash of violet and blue: the glTF export wrote the humanoid's *normal* map
 * into `baseColorTexture` and left the diffuse behind entirely. A tangent-space
 * normal map is unmistakable — it is a field of (0.5, 0.5, 1.0), so the average
 * pixel is mid red, mid green, near-full blue, and blue is the largest channel
 * almost everywhere. Measured across all thirteen enemy prefabs, the five
 * corrupted bodies score 97-98% blue-dominant with an average of (0.50, 0.50,
 * 0.96) and nothing else comes close, so the test separates them cleanly.
 *
 * The average alone does not, though, which is what `flat` is here to fix. Blue
 * and mid-grey is also what a *blue-grey* piece of art averages to, and Hatchet
 * Corp's barriers are painted exactly that: HatCoBarriersTextureUpdated_Diffuse
 * averages (0.37, 0.60, 0.74) over 94% blue-dominant pixels and passed every
 * test above, so the whole theme lost its artwork and came out flat grey. So
 * the pixels are asked as well as their mean: a normal map is not merely blue
 * *on average*, it is (0.5, 0.5, ~1) nearly everywhere, because nearly every
 * texel of it describes a surface that is flat. Over the 141 textures the
 * prefabs actually put in a base-colour slot, every real normal map scores 99%
 * or better and the Hatchet Corp diffuse scores 56% — a gap wide enough that
 * the threshold could sit almost anywhere between.
 *
 * Sampled at 32x32, which is plenty for an average, and remembered per texture.
 * A cross-origin image would taint the canvas and throw; that answers "no",
 * because guessing wrong here would strip the art off a perfectly good model.
 */
function isNormalMapTexture(texture) {
  if (!texture?.image) return false;
  if (normalMapVerdicts.has(texture.uuid)) return normalMapVerdicts.get(texture.uuid);
  let verdict = false;
  try {
    const N = 32;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(texture.image, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);
    let n = 0, blueWins = 0, flat = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      sr += r; sg += g; sb += b;
      if (b >= r && b >= g) blueWins++;
      // "Points more or less straight out of the surface", the normal that a
      // flat texel carries and a painted one has no reason to.
      if (Math.abs(r - 0.5) < 0.25 && Math.abs(g - 0.5) < 0.25 && b > 0.7) flat++;
      n++;
    }
    if (n) {
      const r = sr / n, g = sg / n, b = sb / n;
      verdict = blueWins / n > 0.9 && flat / n > 0.75
        && b > 0.6 && b > r + 0.12 && b > g + 0.12
        && Math.abs(r - 0.5) < 0.2 && Math.abs(g - 0.5) < 0.25;
    }
  } catch {
    verdict = false;
  }
  normalMapVerdicts.set(texture.uuid, verdict);
  return verdict;
}

function displayMaterial(material, tint, opacity = 1, force = false, cut = false, litByVertex = true) {
  if (Array.isArray(material)) {
    return material.map((m) => displayMaterial(m, tint, opacity, force, cut, litByVertex));
  }
  if (!material) return material;
  const key = `${material.uuid}|${tint ?? ''}|${opacity}|${force}|${cut}|${litByVertex}`;
  if (displayMaterials.has(key)) return displayMaterials.get(key);
  const out = material.clone();
  if (out.metalness !== undefined && !out.envMap) {
    out.metalness = Math.min(out.metalness, 0.25);
    out.roughness = Math.max(out.roughness ?? 0.5, 0.45);
  }
  // Vertex colours the merged geometry cannot supply, or that were only ever
  // black, must not be read. See `usableColour`.
  if (!litByVertex) out.vertexColors = false;
  // A normal map in the base colour slot is put where it belongs — the surface
  // detail it carries is real and worth having — and the colour it was standing
  // in for comes from the material's name. Not the diffuse the artist painted:
  // that texture is not in the file at all. It reads as a crystallised orange
  // bot rather than a violet one, which is what the crystals on its own back
  // say it should be.
  if (out.map && isNormalMapTexture(out.map)) {
    if (!out.normalMap) {
      const bumps = out.map.clone();
      bumps.colorSpace = THREE.NoColorSpace;   // it is geometry, not colour
      bumps.needsUpdate = true;
      out.normalMap = bumps;
    }
    out.map = null;
    out.color.set(nameTint(material.name) ?? 0xb9c3cc);
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
 * A part's vertex colours, if they are colours at all.
 *
 * The player spawn zone's machine ships a COLOR_0 that is **entirely zero**, and
 * glTF says a base colour is multiplied by it — so the machine, which has a
 * perfectly good 1024px texture atlas, rendered pure black, and both teams'
 * spawn zones looked like scorched metal. Nothing dressed as a base colour can
 * have meant "multiply the artwork by nothing"; Unity's own shader read that
 * channel as a mask for an effect glTF has nowhere to put, and the exporter
 * wrote it out anyway.
 *
 * So an all-black colour attribute is treated as no colour attribute. A single
 * non-zero component anywhere is enough to take it at its word — this is only
 * ever meant to catch the degenerate case, not to second-guess dark shading.
 */
function usableColour(geometry) {
  const attr = geometry.getAttribute('color');
  if (!attr) return null;
  for (let i = 0; i < attr.count; i++) {
    if (attr.getX(i) || attr.getY(i) || attr.getZ(i)) return attr;
  }
  return null;
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
  const colours = parts.map(({ geometry }) => usableColour(geometry));
  const template = colours.find(Boolean);

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
      // `toNonIndexed` above rebuilt the attribute, so the usable one is looked
      // up again on the trimmed copy rather than reused from `colours`.
      const colour = g === geometry ? colours[i] : usableColour(g);
      out.setAttribute('color', matchesTemplate(colour, template)
        ? colour
        : neutralColour(template, position.count));
    }
    if (!normal) out.computeVertexNormals();
    return out;
  });
  // A material may only read vertex colours if the merged geometry has some to
  // read: bound to nothing, the shader's `color` attribute is black and takes
  // the whole mesh with it.
  const lit = !!template;
  try {
    // useGroups keeps one draw group per part, so the prefab's own materials
    // survive as a material array and the object arrives textured.
    const merged = mergeGeometries(trimmed, true);
    if (merged) {
      return {
        geometry: merged,
        materials: parts.map((p) => displayMaterial(p.material, tint, opacityOf(p), force, cut, lit)),
      };
    }
  } catch { /* fall through to the largest part */ }
  let best = 0;
  trimmed.forEach((g, i) => {
    if (g.getAttribute('position').count > trimmed[best].getAttribute('position').count) best = i;
  });
  return {
    geometry: trimmed[best],
    materials: displayMaterial(parts[best].material, tint, opacityOf(parts[best]), force, cut, lit),
  };
}

// -- mirror symmetry ---------------------------------------------------------
// Copying the selection to the far side of the arena is a reflection, and a
// reflection is not a rotation: a corner barrier reflected is a piece no amount
// of turning produces. Working the transform through,
//
//   reflect · T(p)·R(q)·S(s)  =  T(reflect p) · R(q') · S(s with one sign flipped)
//
// where q' is the mirrored quaternion the mirror already writes — and the sign
// that flips is always the object's *local* x for a mirror across world X, and
// its local z for one across world Z, whatever the piece is rotated to.
//
// A negative scale in an exported map is not something the game has ever been
// seen to write, so it is worth spending only where it buys something. Most
// pieces are their own reflection: a crate, a cylinder, a plain wall. Those are
// mirrored by rotation alone and export exactly as they always did.

const symmetryCache = new WeakMap();

// One centimetre. Loose on purpose: this is asking whether a piece has a left
// and a right, and the answer is measured in the tens of centimetres a barrier
// arm or a ramp's slope spans. Exact matching answers "chiral" for everything,
// because the traced numbers carry the real prefabs' own asymmetries — the U
// barrier's notch runs -0.186 to 0.185, one millimetre off centre, which is a
// measurement and not a shape.
const SYMMETRY_EPSILON = 0.01;

/**
 * Is `geometry` unchanged by flipping the sign of `axis` about the origin?
 *
 * Answered off the vertices rather than a hand-kept list of which pieces are
 * chiral: bin every vertex into a coarse grid, then ask of each whether its
 * mirror image has a vertex near it. Triangulation is ignored, so a symmetric
 * shape cut into asymmetric triangles still answers yes; the neighbouring bins
 * are checked as well as the exact one, so a vertex that lands a hair the wrong
 * side of a bin edge does not answer no on its own.
 */
function isMirrorSymmetric(geometry, axis) {
  if (!geometry) return true;
  let entry = symmetryCache.get(geometry);
  if (!entry) symmetryCache.set(geometry, (entry = {}));
  if (entry[axis] !== undefined) return entry[axis];

  const pos = geometry.getAttribute('position');
  const bin = (v) => Math.floor(v / SYMMETRY_EPSILON);
  const filled = new Set();
  for (let i = 0; i < pos.count; i++) {
    filled.add(`${bin(pos.getX(i))},${bin(pos.getY(i))},${bin(pos.getZ(i))}`);
  }
  const near = (x, y, z) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) if (filled.has(`${x + dx},${y + dy},${z + dz}`)) return true;
      }
    }
    return false;
  };

  let symmetric = true;
  for (let i = 0; i < pos.count && symmetric; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    symmetric = axis === 'x'
      ? near(bin(-x), bin(y), bin(z))
      : near(bin(x), bin(y), bin(-z));
  }
  entry[axis] = symmetric;
  return symmetric;
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
    this.snap = { translate: 0.25, rotate: 15, scale: 0 };
    // Draw the procedural stand-ins even when the real prefabs are on disk, so
    // the two can be compared. Off by default: the real art is better when it
    // is there.
    this.usePlaceholders = false;
    this.placing = null;
    this._pointer = null;
    this._nextId = 1;
    this._materials = new Map();
    this._modelCache = new Map();
    this._badges = new Map();
    this._fixedParts = new Map();
    this._figures = new Map();
    this._figureCache = new Map();
    this._gltf = new GLTFLoader();

    this._initRenderer();
    this._initScene();
    this._initOutline();
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

  /**
   * The yellow stroke round a selected object.
   *
   * Drawn in screen space, off a mask of what the selection actually covers,
   * rather than out of the object's own edges. Two goes at doing it from the
   * geometry both came out wrong in the same way. `EdgesGeometry` drew every
   * crease over 25 degrees and read as a wireframe cage; a real silhouette,
   * computed per frame from which faces turn away from the eye, was right about
   * the outer boundary but drew every *interior* fold it could see as well —
   * the rim of a recessed panel, the corner posts set into a wall — because
   * those are silhouette edges too. They are honest lines and not what was
   * asked for. What was asked for is the stroke round a sprite: one contour, at
   * the outside, a couple of pixels thick.
   *
   * A mask gives that directly. The selection is rendered to an offscreen
   * buffer, the edge of the shape it covers is found and thickened, and the
   * result is laid over the frame — so the contour is the one the *camera*
   * sees, interpenetrating parts and all, and its width is in pixels rather
   * than in metres, which is what makes it read the same on a crate and on a
   * thirty-metre wall.
   *
   * The cost is that the viewport now renders through a composer instead of
   * straight to the canvas; the two settings below are what that costs to keep
   * honest.
   */
  _initOutline() {
    this.composer = new EffectComposer(this.renderer);
    // EffectComposer makes its own buffers and makes them single-sampled, which
    // throws away the `antialias: true` the canvas was created with — every
    // model edge and every line of the grid goes to stairs. Both buffers are
    // asked for the 4x the canvas had. Safe here because nothing has rendered
    // yet, so neither framebuffer has been built.
    this.composer.renderTarget1.samples = 4;
    this.composer.renderTarget2.samples = 4;
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.outline = new OutlinePass(
      this.renderer.getSize(new THREE.Vector2()), this.scene, this.camera);
    this.outline.visibleEdgeColor.setHex(ACCENT);
    // Black is the off switch. The overlay blends additively, so an edge drawn
    // in black adds nothing — which is how "only what the camera can see" is
    // said here. The far side of a selected object, and a selected object
    // standing behind a wall, contribute no stroke at all.
    this.outline.hiddenEdgeColor.setHex(0x000000);
    this.outline.edgeGlow = 0;        // a stroke, not a halo
    this.outline.edgeStrength = 6;
    this.outline.edgeThickness = 2;
    this.composer.addPass(this.outline);

    // Render targets hold linear colour. This is what turns it back into sRGB
    // for the screen — the job each material's own shader was doing while the
    // renderer drew straight to the canvas.
    this.composer.addPass(new OutputPass());
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

    // One gizmo, doing move, rotate and scale at once. There used to be a mode
    // switch and three single-purpose gizmos behind it; the combined one covers
    // all of it, so the switch went and TransformControls with it.
    this.gizmo = new ComboGizmo(this.camera, this.canvas);
    this.scene.add(this.gizmo);

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
      this._dropBadge(m);
      this._dropFixedPart(m);
      this._dropFigure(m);
      m.removeFromParent();
      const i = this.objects.indexOf(m);
      if (i >= 0) this.objects.splice(i, 1);
      this.selection.delete(m);
    }
    // Before anything else: a deleted mesh left in the outline's list would be
    // drawn into its mask from outside the scene it no longer belongs to.
    this._syncOutline();
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
   * Put the selection where the inspector's three boxes say, in map values.
   *
   * Goes through the pivot because the pivot is what carries a selection's
   * placement while it is selected, and through here rather than from `app.js`
   * because the pivot is in the map's frame and the quaternion a map rotation
   * converts to is in the mesh's — the half turn between them is this module's
   * business, not the panel's.
   */
  placeSelection(unityPosition, unityRotation) {
    this.pivot.position.set(unityPosition.x, unityPosition.y, -unityPosition.z);
    this.pivot.quaternion.fromArray(unityEulerToQuat(unityRotation)).multiply(MAP_FRAME);
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
    this.selection = new Set([...list].filter((m) => !m.userData.locked));
    this._syncOutline();
    this.rebuildPivot();
    this.emit('selection');
  }

  /** Hand the outline pass the current selection to draw its mask from. */
  _syncOutline() {
    this.outline.selectedObjects = [...this.selection];
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

  selectionBounds() {
    const box = new THREE.Box3();
    for (const m of this.selection) box.expandByObject(m);
    return box;
  }

  /**
   * Does mirroring this object across `axis` need a scale sign flipped, or will
   * the mirrored rotation alone do it?
   *
   * Asked of the placeholder rather than of whatever mesh is on screen. The
   * placeholders are the traced silhouette built out of boxes and cylinders, so
   * a symmetric piece is symmetric to the last decimal and the answer is clean.
   * The real prefabs are not: an artist's crate is symmetric to look at and off
   * by a millimetre here and there in fact, which makes every object in the map
   * read as chiral and puts a negative scale on all of them. Same shape, better
   * evidence.
   */
  needsMirrorFlip(mesh, axis) {
    return !isMirrorSymmetric(geometryFor(mesh.userData.def), axis);
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
      this.pivot.quaternion.copy(q).multiply(MAP_FRAME);
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

  /**
   * Which of the three a drag is actually doing. The gizmo offers all three at
   * once, so it only knows once a handle has been grabbed. `_beginDrag` needs
   * the answer to decide whether to capture a scale anchor.
   */
  _activeMode() {
    return this.gizmo.activeMode;
  }

  _applyGizmoConstraints() {
    this.gizmo.translationSnap = this.snap.translate || null;
    this.gizmo.rotationSnap = this.snap.rotate ? THREE.MathUtils.degToRad(this.snap.rotate) : null;
    // Deliberately off. The gizmo can round the scale *factor*, and rounding
    // the resulting *size* to the grid is the thing worth having — see
    // `_snapScaleToGrid`, which does it in `_constrainDuringDrag` where the
    // object's own extent is known.
    this.gizmo.scaleSnap = null;
    this.gizmo.uniform = this.uniformScale;
    // All three circles, on everything. The catalog's `rotationAxes` used to
    // hide X and Z on a yaw-only piece, which is what the in-game editor allows
    // rather than what the format allows: the map file stores a full euler for
    // every object, and the reference exports themselves contain damage boxes
    // turned 90 degrees about X and a solid box turned freely. Hiding two
    // thirds of the gizmo enforced a rule the file does not have.
    this.gizmo.showRotate = { x: true, y: true, z: true };
  }

  setSnap(part, value) {
    this.snap[part] = value;
    this._applyGizmoConstraints();
    this.emit('mode');
  }

  /**
   * Scale every axis together, or one at a time. Pushed through to the gizmo
   * here rather than left for the next `rebuildPivot`, which is what used to
   * happen — so ticking the box mid-selection did nothing until you clicked
   * something else.
   */
  setUniformScale(on) {
    this.uniformScale = !!on;
    this._applyGizmoConstraints();
    this.emit('mode');
  }

  _beginDrag() {
    this._dragStartScale = this.pivot.scale.clone();
    // The scale the object already carried, which is what the inspector shows
    // and the file stores. The pivot's own scale starts every drag at 1 and
    // multiplies this, so it is the two together that make the number being
    // snapped. A multi-select has no single answer — each piece has its own —
    // so the group's multiplier is what steps there instead.
    //
    // The pivot is turned a half turn about Y from the mesh under it, and a
    // half turn maps each axis onto itself, so a component read here lines up
    // with the pivot component of the same name.
    this._dragStartWorldScale = this.selection.size === 1
      ? [...this.selection][0].getWorldScale(new THREE.Vector3())
      : new THREE.Vector3(1, 1, 1);
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
      this._snapScaleToGrid(force);
      this._applyScaleAnchor();
    }
  }

  /**
   * Step a scale drag by the grid, when the grid is on.
   *
   * What steps is the scale itself — the number in the inspector and the number
   * the map file stores. At 25 cm a barrier goes 1, 1.25, 1.5, however far the
   * pointer travelled in between.
   *
   * This did once round the object's *size* to the grid instead, on the
   * reasoning that a grid is a distance. It is, but it made the scale unusable:
   * an asset's mesh is whatever the artist built, so a barrier 1.04 m wide
   * reaching a tidy 1.25 m does it at a scale of 1.2019, and a column of those
   * in the inspector is no way to build anything. Round scales are the ones
   * worth having — they are what the file carries, and a piece at 1.5 is a
   * piece you can match by typing.
   *
   * Snapped against the scale the object *had* when the drag began, not against
   * the pivot's own multiplier, which always starts at 1: those differ for
   * anything already resized, and rounding the multiplier would step a piece
   * sitting at 1.3 to 1.55 rather than to 1.5. The gizmo's own `scaleSnap`
   * rounds that multiplier and is left off for exactly this reason.
   *
   * With uniform scale the same correction goes on all three axes, so the axis
   * being dragged lands on the grid and the other two keep their proportions —
   * which for the usual piece, placed at 1, 1, 1, means all three land on it.
   */
  _snapScaleToGrid(uniform) {
    const step = this.snap.translate;
    const axis = this.gizmo.axis;
    if (!step || !axis || axis === 'view') return;

    const started = Math.abs(this._dragStartWorldScale?.[axis] ?? 1);
    const scale = this.pivot.scale;
    const now = started * Math.abs(scale[axis]);
    if (started < 1e-9 || now < 1e-9) return;
    // Never round away to nothing: a scale of zero is one no further drag can
    // recover, because every scale from there is zero too.
    const wanted = Math.max(step, Math.round(now / step) * step);
    const correction = wanted / now;
    if (!Number.isFinite(correction) || correction <= 0) return;

    if (uniform) scale.multiplyScalar(correction);
    else scale[axis] *= correction;
  }

  // -- scale anchoring -------------------------------------------------------
  // Scaling an object multiplies its own origin outwards, so a crate grows away
  // from every face at once: pull the right-hand handle out and the left-hand
  // face moves too, and shrink a centre-pivot box standing on the floor and it
  // ends up hanging in the air. The side you are *not* dragging should stay
  // exactly where it is, which is what the game's own stretcher does — its
  // spawn zones carry PosX, NegX, PosZ and NegZ handles, one per edge.
  //
  // So the far face is pinned: the point opposite the handle is held still and
  // the children are shifted each frame to keep it there. This applies to
  // uniform scaling as well as per-axis, since "the opposite side stays put" is
  // no less true when the other two axes come along for the ride.

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
   * The point that must not move during this drag, in pivot-local space.
   *
   * The handle grabbed says which end: it is drawn in the pivot's own frame at
   * one end of its axis, and the face to hold still is the other one. Since the
   * X and Z cubes moved to whichever end faces the camera, that end is the
   * gizmo's to report rather than this method's to assume — `scaleSign` says
   * which one it put there. There is still nothing to guess: this used to
   * project the axis to the screen and read which end the cursor was nearer,
   * because the old gizmo labelled both ends of an axis the same.
   *
   * The other two axes hold at the bottom in Y and at the middle in the
   * remaining horizontal, so a piece standing on the floor is still standing on
   * it afterwards and a uniform scale grows evenly sideways.
   */
  _captureScaleAnchor() {
    const box = this._selectionLocalBox();
    if (box.isEmpty()) return null;
    const centre = box.getCenter(new THREE.Vector3());
    const point = new THREE.Vector3(centre.x, box.min.y, centre.z);
    const axis = this.gizmo.axis;
    if (axis && axis !== 'view') {
      point[axis] = this.gizmo.scaleSign[axis] < 0 ? box.max[axis] : box.min[axis];
    }
    return { point, positions: new Map([...this.selection].map((m) => [m, m.position.clone()])) };
  }

  /**
   * Hold the anchor still as the scale changes.
   *
   * A point at pivot-local `p` lands at `S * p`, so restoring it to where `S0`
   * had it means offsetting every child by `(S0/S - 1) * anchor`. Recomputed
   * from the drag-start positions each frame rather than accumulated, so
   * nothing drifts however long the drag goes on.
   *
   * The children move rather than the pivot, deliberately: the gizmo measures
   * the drag against a plane through its own position, so moving the gizmo
   * mid-drag would feed straight back into the scale it computes.
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

  /**
   * Let the selection fall until it rests on something.
   *
   * `onto` is 'floor' for the ground, always, or 'surface' for whatever is
   * actually underneath — the top of another object if there is one, the ground
   * if there is not. The second is how a crate goes on a crate: put it roughly
   * over the target and drop it, rather than reading a height off the inspector
   * and typing it.
   *
   * Height is otherwise unconstrained. This used to run on every edit, off a
   * Floor tick that was on by default, which made anything the catalog marks
   * `floor` impossible to lift — and maps want that: a walkway over a gap, a
   * barrier used as a ceiling.
   *
   * Each object falls on its own rather than the selection moving as one, which
   * is what makes dropping a scattered handful of props onto uneven ground do
   * the useful thing.
   */
  dropSelection(onto = 'floor') {
    const targets = [...this.selection];
    if (!targets.length) return 0;
    // Only things outside the selection can be landed on. Otherwise a stack
    // dropped as a group would rest on itself and never move.
    const others = onto === 'surface' ? this.objects.filter((m) => !this.selection.has(m)) : [];

    let moved = 0;
    for (const m of targets) {
      m.updateWorldMatrix(true, false);
      const box = new THREE.Box3().setFromObject(m);
      if (box.isEmpty()) continue;
      const rest = others.length ? this._surfaceUnder(box, others) : 0;
      const drop = box.min.y - rest;
      if (Math.abs(drop) < 1e-5) continue;
      const world = new THREE.Vector3();
      m.getWorldPosition(world);
      world.y -= drop;
      m.position.copy(m.parent === this.pivot ? this.pivot.worldToLocal(world.clone()) : world);
      this.markDirty(m);
      moved++;
    }
    // The gizmo hangs off the pivot, and the pivot does not follow a child that
    // moves underneath it — so without this the gizmo stayed in the air above
    // whatever had just been dropped until the object was selected again.
    this.rebuildPivot();
    this.emit('transform');
    this.emit('commit-end');
    return moved;
  }

  /** Kept for the old name; the floor is the common case. */
  dropToFloor() {
    return this.dropSelection('floor');
  }

  /**
   * The height of the highest thing under `box`, or 0 for the ground.
   *
   * Nine rays straight down through the object's footprint — corners, edge
   * middles and centre — rather than one down the middle, so a crate sitting
   * half over the edge of a table lands on the table rather than dropping
   * through it. The highest surface any of them finds wins.
   *
   * Hits above the object's own top are ignored: those are things it is under,
   * not things it is on. Hits between its bottom and its top are kept, so a
   * piece pushed into another one rises to sit on it instead of staying sunk —
   * which is what "drop it on that" means when you have eyeballed the position.
   */
  _surfaceUnder(box, others) {
    const ray = new THREE.Raycaster();
    ray.ray.direction.set(0, -1, 0);
    const size = box.getSize(new THREE.Vector3());
    // Inset from the edges so a ray grazing the side of the object's own
    // footprint is not decided by floating point.
    const ix = Math.min(0.02, size.x / 3);
    const iz = Math.min(0.02, size.z / 3);
    const xs = [box.min.x + ix, (box.min.x + box.max.x) / 2, box.max.x - ix];
    const zs = [box.min.z + iz, (box.min.z + box.max.z) / 2, box.max.z - iz];
    const ceiling = box.max.y - 1e-4;

    let best = 0;
    for (const x of xs) {
      for (const z of zs) {
        ray.ray.origin.set(x, box.max.y + 0.05, z);
        for (const hit of ray.intersectObjects(others, true)) {
          if (hit.point.y > ceiling) continue;   // an overhang, not a shelf
          if (hit.point.y > best) best = hit.point.y;
          break;                                  // hits are sorted, so this is the top
        }
      }
    }
    return best;
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
      // Recorded before the early returns below: `beginPlacement` puts what it
      // is carrying under the cursor straight away, and a press with no move
      // before it would otherwise leave this stale.
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
      // `hovered` is set while a handle is under the pointer, so a press meant
      // for the gizmo never starts a marquee behind it.
      if (e.button !== 0 || e.altKey || this.gizmo.dragging || this.gizmo.hovered) return;
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
   * and each piece keeps whatever height it was created at. Ends by emitting
   * 'placement-end' with { committed, meshes }; a cancelled placement leaves the
   * meshes in the scene for the caller to dispose of.
   */
  beginPlacement(meshes) {
    if (this.placing) this._endPlacement(false);
    if (!meshes.length) return;

    // Reaching for an object puts any bot-grid brush down. The left button
    // cannot both paint the floor and drop what is riding on the cursor, and of
    // the two the thing in your hand is obviously the one you meant.
    this.setNavPaint(null);
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
      // A millimetre toward the front and none at all to the side. The nudge is
      // there because straight down is degenerate — the camera's up vector and
      // its view direction would be the same line — and OrbitControls reads the
      // heading off that offset as `atan2(x, z)`. Equal nudges on both, which is
      // what this was, is a heading of 45 degrees: the map came up turned, and
      // no amount of "top" is a corner view. Zero in x pins it to due north.
      top: [0, d, 0.001],
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
    // In CSS pixels: the composer multiplies by the renderer's pixel ratio
    // itself, and hands every pass the size in device pixels.
    this.composer.setSize(r.width, r.height);
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
    this.gizmo.update();
    this._holdFixedParts();
    this._placeBadges();
    this.composer.render();
  }
}
