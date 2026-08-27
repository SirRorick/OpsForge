// ---------------------------------------------------------------------------
// Combined move / rotate / scale gizmo
// ---------------------------------------------------------------------------
// The only gizmo the editor has, and it does all three: an arrow per axis to
// move along it, a circle per axis to turn about it, a handle per axis to scale
// along it, and a centre disc that slides the whole thing across the floor.
// See reference/gizmo.jpeg.
//
// Rotation is always about X, Y or Z, and the three circles are coloured to say
// which is which. There was an outer ring that turned about whatever axis the
// camera happened to be looking down; it is gone, because an angle that depends
// on where you are standing is not one you can reason about, and a map built
// out of pieces at 15 degree steps needs the axis to be the same one every time.
//
// The drag maths is the ordinary stuff and worth stating once:
//   move    the closest point between the pointer ray and the axis line, minus
//           where that was when the drag started
//   rotate  intersect the pointer ray with the plane through the pivot whose
//           normal is the axis, and take the angle swept about the centre
//   scale   the same projection as move, as a ratio of its distance at the
//           start rather than a difference
//
// Move and rotate work on the world axes. Scale cannot: `object.scale` stretches
// the object's own x, y and z whatever direction the handle points, so a piece
// turned 30 degrees dragged by a world-aligned handle would grow sideways. The
// scale handles therefore sit in a sub-group carrying the object's own rotation
// and are dragged along the object's own axes — which is also what makes the
// far side hold still in `scene.js`.
//
// The X and Z handles — arrows and cubes alike — move to whichever end of their
// axis faces the camera, so the side you are looking at is the side you can
// reach; see `_faceHandles`.
//
// Everything downstream — snapping, uniform scaling, the scale anchor that
// holds the far face still — belongs to `scene.js` and is reached through the
// `objectChange` event raised here, so none of it is duplicated in this file.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** Axis colours, matching the inspector's X/Y/Z field tints. */
const AXIS_COLOUR = { x: 0xe06c6c, y: 0x7fd17f, z: 0x6c9be0 };
const VIEW_COLOUR = 0xd6e3eb;
const HOT_COLOUR = 0xe8c547;

const AXES = ['x', 'y', 'z'];
const UNIT = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

// Radii, in gizmo units. The whole thing is then scaled to a constant size on
// screen, so these are proportions rather than metres.
//
// **No two grabbable parts may share a radius.** The first cut had the
// translate handles grabbable along their whole shaft, which put them on top of
// the rotation circles at the circles' own radius — reaching for a turn got you
// a slide instead. Each ring of handles has the band to itself, and the arrows
// sit entirely outside the circles.
const R_CENTRE = 0.17;     // centre disc, slides on the ground plane
const R_SCALE = 0.42;      // scale cubes
const R_ARC = 0.78;        // the three rotation circles
const R_CONE = 1;          // where the arrow cone starts — outside everything
const R_ARROW = 1.2;       // arrow tip
const ARC_SEGMENTS = 64;

// How big the gizmo is allowed to get in the world, and how fast it stops
// getting bigger.
//
// A gizmo drawn at a constant size on screen is the right answer up close and
// the wrong one across an arena: at forty metres out it is twelve metres of
// arrows lying over half the map, hiding the very layout the zoom was for. So
// the screen-constant scale holds only up to `SOFT_CAP` — about a metre and a
// half of arrow, which is a piece of furniture rather than a landmark — and
// past it grows on a curve flat enough that the thing shrinks steadily on
// screen while still growing, slightly, in metres.
//
// The exponent is what makes it a knee rather than a wall. A hard clamp pins
// the world size and the gizmo then shrinks on screen exactly as fast as the
// camera pulls back, which at four times the distance is a quarter of the
// handles and nothing left to grab. At 0.35 the same pull-back leaves it about
// half, and `HARD_CAP` is only there to stop the drift going anywhere silly
// from orbit.
const SOFT_CAP = 1.35;
const CAP_EXPONENT = 0.35;
const HARD_CAP = SOFT_CAP * 2.6;

/** Screen-constant up close, compressed past the knee, capped beyond that. */
function capScale(s) {
  if (s <= SOFT_CAP) return s;
  return Math.min(HARD_CAP, SOFT_CAP * (s / SOFT_CAP) ** CAP_EXPONENT);
}

/**
 * How far `q` turns about `axis`, ignoring however far it leans off it.
 *
 * The twist half of a swing-twist split. Any rotation is exactly a turn about
 * a chosen axis followed by a lean away from it, and the two are independent —
 * so this is the one number a control that turns about a fixed world axis is
 * entitled to round. The twist quaternion is the part of `q` that points along
 * `axis`, which for a unit axis is the dot product, so the angle comes straight
 * off an atan2 with no decomposition to build and throw away.
 *
 * `q` and `-q` are the same rotation and would give angles a full turn apart,
 * so the sign is taken off `w` first and the result lands in (-180, 180].
 * Degenerate at a half turn about anything perpendicular to `axis`, where the
 * twist is genuinely undefined; atan2(0, 0) returns 0, which is the honest
 * answer and the harmless one.
 */
function twistAngle(q, axis) {
  const s = q.w < 0 ? -1 : 1;
  return 2 * Math.atan2((q.x * axis.x + q.y * axis.y + q.z * axis.z) * s, q.w * s);
}

function lineMaterial(colour, width = 2) {
  return new THREE.LineBasicMaterial({
    color: colour, transparent: true, depthTest: false, depthWrite: false, linewidth: width,
  });
}

function solidMaterial(colour) {
  return new THREE.MeshBasicMaterial({
    color: colour, transparent: true, depthTest: false, depthWrite: false,
  });
}

/** Invisible but pickable: what the pointer actually hits. */
function pickerMaterial() {
  return new THREE.MeshBasicMaterial({ visible: false, depthTest: false, depthWrite: false });
}

export class ComboGizmo extends THREE.Object3D {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.object = null;
    this.enabled = true;
    this.dragging = false;
    this.axis = null;          // 'x' | 'y' | 'z' | 'view'
    this.activeMode = null;    // 'translate' | 'rotate' | 'scale'
    this.hovered = null;
    this.size = 1;
    this.translationSnap = null;
    this.rotationSnap = null;
    this.scaleSnap = null;
    this.showAxis = { x: true, y: true, z: true };
    this.showRotate = { x: true, y: true, z: true };
    // Which end of each object axis the scale handle sits on. X and Z follow
    // the camera; see `_faceHandles`. Read by scene.js, which has to pin the
    // opposite face.
    this.scaleSign = { x: 1, y: 1, z: 1 };

    this.visible = false;
    this.renderOrder = 999;

    this._pickers = [];
    this._parts = [];
    // axis -> the pieces that move from one end of the axis to the other
    this._moveArms = {};
    this._scaleArms = {};
    this._ray = new THREE.Raycaster();
    this._ray.params.Line.threshold = 0.06;
    this._build();
    this._bind();
  }

  // -- construction ---------------------------------------------------------

  _build() {
    this._root = new THREE.Group();
    this.add(this._root);
    // Everything in here is world-aligned except the scale handles, which have
    // to follow the object or they would promise a stretch they cannot deliver.
    this._scaleRoot = new THREE.Group();
    this._root.add(this._scaleRoot);

    for (const axis of AXES) {
      const colour = AXIS_COLOUR[axis];
      const dir = UNIT[axis];

      // move: a thin guide line all the way out, and a cone you grab.
      // The line is decoration — it says where the axis points — and is not
      // pickable, so it can cross the arcs without stealing their clicks.
      const shaft = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          dir.clone().multiplyScalar(R_CENTRE), dir.clone().multiplyScalar(R_CONE),
        ]),
        lineMaterial(colour, 1)
      );
      shaft.material.opacity = 0.5;
      this._register(shaft, axis, 'translate');

      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.07, R_ARROW - R_CONE, 14), solidMaterial(colour));
      cone.position.copy(dir).multiplyScalar((R_ARROW + R_CONE) / 2);
      cone.quaternion.setFromUnitVectors(UNIT.y, dir);
      this._register(cone, axis, 'translate');

      // A fatter invisible cone over it: a 7 cm arrowhead is not something
      // anyone can be asked to hit exactly.
      const grab = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, R_ARROW - R_CONE + 0.06, 8), pickerMaterial());
      grab.position.copy(dir).multiplyScalar((R_ARROW + R_CONE) / 2);
      grab.quaternion.setFromUnitVectors(UNIT.y, dir);
      this._registerPicker(grab, axis, 'translate');

      this._moveArms[axis] = { shaft, cone, grab, sign: 1 };

      // rotate: a full circle in the plane whose normal is this axis, in the
      // axis's own colour — the whole of how you tell one turn from another.
      const arc = new THREE.Line(this._arcGeometry(), lineMaterial(colour, 3));
      arc.userData.arcAxis = axis;
      this._orientArc(arc, axis);
      this._register(arc, axis, 'rotate');
      arc.userData.isArc = true;

      const arcGrab = new THREE.Mesh(new THREE.TorusGeometry(R_ARC, 0.06, 4, 40), pickerMaterial());
      this._orientArc(arcGrab, axis);
      this._registerPicker(arcGrab, axis, 'rotate');

      // scale: a small cube on a short stalk
      const stalk = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          dir.clone().multiplyScalar(R_CENTRE), dir.clone().multiplyScalar(R_SCALE),
        ]),
        lineMaterial(colour, 1)
      );
      this._register(stalk, axis, 'scale');

      const cube = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), solidMaterial(colour));
      cube.position.copy(dir).multiplyScalar(R_SCALE);
      this._register(cube, axis, 'scale');

      const cubeGrab = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), pickerMaterial());
      cubeGrab.position.copy(dir).multiplyScalar(R_SCALE);
      this._registerPicker(cubeGrab, axis, 'scale');

      this._scaleArms[axis] = { stalk, cube, grab: cubeGrab, sign: 1 };
    }

    // Centre: slide across the floor. It faces the camera so it is always a
    // disc you can hit, but what it drags on is the ground plane — see
    // `_pointerDown`.
    this._centre = new THREE.Line(this._circleGeometry(R_CENTRE), lineMaterial(VIEW_COLOUR, 1));
    this._register(this._centre, 'view', 'translate');
    const centreGrab = new THREE.Mesh(new THREE.SphereGeometry(R_CENTRE, 10, 8), pickerMaterial());
    this._centreGrab = centreGrab;
    this._registerPicker(centreGrab, 'view', 'translate');

    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), solidMaterial(HOT_COLOUR));
    this._root.add(dot);
  }

  /** Which frame a handle is drawn in: the object's for scale, the world's otherwise. */
  _frameFor(mode) {
    return mode === 'scale' ? this._scaleRoot : this._root;
  }

  _register(obj, axis, mode) {
    obj.userData.axis = axis;
    obj.userData.mode = mode;
    obj.renderOrder = 1000;
    this._parts.push(obj);
    this._frameFor(mode).add(obj);
  }

  _registerPicker(obj, axis, mode) {
    obj.userData.axis = axis;
    obj.userData.mode = mode;
    this._pickers.push(obj);
    this._frameFor(mode).add(obj);
  }

  _circleGeometry(radius, segments = ARC_SEGMENTS) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    // Per-vertex alpha, so the half of the ring behind the object can be faded
    // rather than drawn over the top of it.
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array((segments + 1) * 3).fill(1), 3));
    return g;
  }

  _arcGeometry() {
    return this._circleGeometry(R_ARC);
  }

  /** Put a ring in the plane whose normal is `axis`. */
  _orientArc(obj, axis) {
    if (axis === 'x') obj.rotation.set(0, Math.PI / 2, 0);
    else if (axis === 'y') obj.rotation.set(Math.PI / 2, 0, 0);
    else obj.rotation.set(0, 0, 0);
  }

  // -- attachment -----------------------------------------------------------

  attach(object) {
    this.object = object;
    this.visible = true;
    return this;
  }

  detach() {
    this.object = null;
    this.visible = false;
    this.axis = null;
    this.hovered = null;
    return this;
  }

  /**
   * Keep the gizmo the same size on screen and pointing the right way, and fade
   * the far half of each circle.
   *
   * Called every frame from the render loop rather than on demand: it depends
   * on the camera, and the camera moves without anything else happening.
   */
  update() {
    if (!this.object || !this.visible) return;
    this.object.updateMatrixWorld();
    const pos = new THREE.Vector3().setFromMatrixPosition(this.object.matrixWorld);
    this.position.copy(pos);
    // Arrows and circles are world axes, always, so the red circle means the
    // same turn wherever the camera is and whatever the piece is doing.
    this.quaternion.identity();

    // Constant screen size. For a perspective camera that is distance times the
    // vertical field of view; an orthographic one has no distance term. Both go
    // through the same cap, since both grow without limit as the view pulls
    // back — one on distance, the other on zoom.
    const factor = this.camera.isOrthographicCamera
      ? (this.camera.top - this.camera.bottom) / this.camera.zoom
      : pos.distanceTo(this.camera.position) * Math.min(
        1.9 * Math.tan((Math.PI * this.camera.fov) / 360) / this.camera.zoom, 7);
    this.scale.setScalar(capScale((factor * this.size) / 7));

    // Scale handles ride the object; the centre disc faces the camera.
    this._scaleRoot.quaternion.copy(this.object.getWorldQuaternion(new THREE.Quaternion()));
    const camQuat = this.camera.getWorldQuaternion(new THREE.Quaternion());
    this._centre.quaternion.copy(camQuat);
    this._centreGrab.quaternion.copy(camQuat);

    this._faceHandles(pos);
    this._updateVisibility();
    this._fadeBackHalves(pos);
  }

  /**
   * Keep the X and Z handles — both the arrow and the scale cube — on the side
   * of the object you are looking at.
   *
   * A handle pinned to the positive end of its axis is only half a control:
   * walk round to the other side of a wall and the handle you want is behind
   * it, so working that face means orbiting back or dragging something you
   * cannot see. Neither drag minds which end it was started from. A scale is a
   * ratio, and the ratio comes out the same measured from either end; a move is
   * a difference along the axis line, and the pointer drags the object the way
   * the pointer went whichever end the arrow was drawn at. So both may as well
   * sit on the end you can reach, and `scene.js` then pins the face at the far
   * end of a scale rather than always the minimum.
   *
   * Y stays up in both. The other two ends of an object are equals; its bottom
   * is not, because a map is built on a floor and the scale anchor holds a
   * piece standing on it. A downward handle would grow a crate through the
   * ground, and a downward green arrow would be the only part of the gizmo that
   * disagreed with the inspector about which way is up.
   *
   * Arrows are measured against the world axes and cubes against the object's,
   * because that is the frame each is drawn in — a turned piece has its scale
   * cubes somewhere else entirely, which is the whole reason `_scaleRoot`
   * exists.
   *
   * Frozen while dragging, so a handle cannot jump ends under the pointer, and
   * given a dead band either side of edge-on so one seen end-first does not
   * flicker between the two.
   */
  _faceHandles(centre) {
    if (this.dragging) return;
    const toCam = this.camera.isOrthographicCamera
      ? this.camera.getWorldDirection(new THREE.Vector3()).negate()
      : this.camera.position.clone().sub(centre).normalize();
    for (const axis of ['x', 'z']) {
      const world = UNIT[axis];
      const own = world.clone().applyQuaternion(this._scaleRoot.quaternion);
      if (this._turnedAway(this._moveArms[axis], world.dot(toCam))) this._flipMoveArm(axis);
      if (this._turnedAway(this._scaleArms[axis], own.dot(toCam))) this._flipScaleArm(axis);
    }
  }

  /** Has the end this arm sits on gone round the back, clear of the dead band? */
  _turnedAway(arm, facing) {
    return facing * arm.sign < -0.05;
  }

  _flipMoveArm(axis) {
    const arm = this._moveArms[axis];
    arm.sign = -arm.sign;
    const dir = UNIT[axis].clone().multiplyScalar(arm.sign);
    const at = dir.clone().multiplyScalar((R_ARROW + R_CONE) / 2);
    // The arrowhead turns with the end it moved to: an arrow is a direction,
    // and one pointing back at the object it belongs to would read as a
    // different instruction entirely.
    for (const part of [arm.cone, arm.grab]) {
      part.position.copy(at);
      part.quaternion.setFromUnitVectors(UNIT.y, dir);
    }
    arm.shaft.scale[axis] = arm.sign;
  }

  _flipScaleArm(axis) {
    const arm = this._scaleArms[axis];
    arm.sign = -arm.sign;
    this.scaleSign[axis] = arm.sign;
    const at = UNIT[axis].clone().multiplyScalar(R_SCALE * arm.sign);
    arm.cube.position.copy(at);
    arm.grab.position.copy(at);
    // The stalk is drawn from the centre outwards along the axis, so mirroring
    // that one component is the whole of moving it to the other end. A line has
    // no facing to turn inside out, which a mirrored solid would.
    arm.stalk.scale[axis] = arm.sign;
  }

  _updateVisibility() {
    for (const part of [...this._parts, ...this._pickers]) {
      const { axis, mode } = part.userData;
      if (axis === 'view') continue;
      const on = mode === 'rotate' ? this.showRotate[axis] : this.showAxis[axis];
      part.visible = on;
    }
  }

  /**
   * Dim the half of each rotation circle that is behind the object.
   *
   * Three full bright circles overlap and read as a ball of wire. Blender's
   * answer is to draw only the near half; this fades the far half instead,
   * which keeps each circle readable as a whole while making clear which part
   * of it you can reach.
   */
  _fadeBackHalves(pos) {
    const toCam = this.camera.position.clone().sub(pos).normalize();
    for (const part of this._parts) {
      if (!part.userData.isArc) continue;
      const colours = part.geometry.getAttribute('color');
      const points = part.geometry.getAttribute('position');
      const q = part.getWorldQuaternion(new THREE.Quaternion());
      const v = new THREE.Vector3();
      for (let i = 0; i < points.count; i++) {
        v.fromBufferAttribute(points, i).applyQuaternion(q);
        const front = v.dot(toCam) >= 0 ? 1 : 0.22;
        colours.setXYZ(i, front, front, front);
      }
      colours.needsUpdate = true;
      part.material.vertexColors = true;
    }
  }

  // -- pointer --------------------------------------------------------------

  _bind() {
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this.domElement.addEventListener('pointerdown', this._onDown);
    this.domElement.addEventListener('pointermove', this._onMove);
    // On the window, so releasing outside the canvas still ends the drag.
    addEventListener('pointerup', this._onUp);
  }

  dispose() {
    this.domElement.removeEventListener('pointerdown', this._onDown);
    this.domElement.removeEventListener('pointermove', this._onMove);
    removeEventListener('pointerup', this._onUp);
  }

  _pointer(e) {
    const r = this.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  _hit(e) {
    if (!this.object || !this.visible || !this.enabled) return null;
    this._ray.setFromCamera(this._pointer(e), this.camera);
    const hits = this._ray.intersectObjects(this._pickers.filter((p) => p.visible), false);
    if (!hits.length) return null;
    // Nearest wins, except that the centre disc sits inside everything and
    // would otherwise be unreachable — it is checked first when it is hit at
    // all.
    const centre = hits.find((h) => h.object === this._centreGrab);
    const chosen = centre ?? hits[0];
    return { axis: chosen.object.userData.axis, mode: chosen.object.userData.mode };
  }

  _pointerMove(e) {
    if (this.dragging) { this._drag(e); return; }
    const hit = this._hit(e);
    const key = hit ? `${hit.mode}:${hit.axis}` : null;
    if (key === this.hovered) return;
    this.hovered = key;
    this._paintHover();
    this.domElement.style.cursor = hit ? 'grab' : '';
  }

  _paintHover() {
    for (const part of this._parts) {
      const { axis, mode } = part.userData;
      const on = this.hovered === `${mode}:${axis}`;
      const base = axis === 'view' ? VIEW_COLOUR : AXIS_COLOUR[axis];
      part.material.color.setHex(on ? HOT_COLOUR : base);
      part.material.opacity = on ? 1 : (mode === 'scale' ? 0.85 : 0.95);
    }
  }

  _pointerDown(e) {
    if (e.button !== 0) return;
    const hit = this._hit(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();

    this.axis = hit.axis;
    this.activeMode = hit.mode;
    this.dragging = true;

    const pos = new THREE.Vector3().setFromMatrixPosition(this.object.matrixWorld);
    this._start = {
      pointer: this._pointer(e),
      position: this.object.position.clone(),
      quaternion: this.object.quaternion.clone(),
      scale: this.object.scale.clone(),
      centre: pos,
      axisWorld: this._axisWorld(hit.axis, hit.mode),
    };
    this._ray.setFromCamera(this._start.pointer, this.camera);

    if (hit.mode === 'rotate') {
      this._start.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._start.axisWorld, pos);
      this._start.from = this._planePoint(this._start.plane, pos);
      this._start.angle = 0;
    } else if (hit.axis === 'view') {
      // The centre disc slides on the ground, not on the plane facing the
      // camera. A map is a floor plan: sliding a crate about is a thing you do
      // in X and Z, and a view-plane drag lifted it into the air by however
      // much the camera happened to be tilted — which then had to be undone.
      // Height is what the green arrow is for.
      this._start.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(UNIT.y, pos);
      this._start.from = this._planePoint(this._start.plane, pos);
    } else {
      this._start.offset = this._axisPoint(pos, this._start.axisWorld);
      this._start.reach = Math.max(1e-4, Math.abs(this._start.offset));
    }

    this.domElement.style.cursor = 'grabbing';
    this.dispatchEvent({ type: 'dragging-changed', value: true });
  }

  _pointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.axis = null;
    this.activeMode = null;
    this.domElement.style.cursor = '';
    this.dispatchEvent({ type: 'dragging-changed', value: false });
  }

  /**
   * The dragged axis in world space.
   *
   * Move and rotate use the world axis, matching the handle you grabbed. Scale
   * uses the object's own, because that is the only thing `object.scale` can
   * stretch — and it is the axis the cube was drawn along, since the scale
   * handles live in `_scaleRoot`.
   */
  _axisWorld(axis, mode) {
    if (axis === 'view') return this.camera.getWorldDirection(new THREE.Vector3()).negate();
    const v = UNIT[axis].clone();
    if (mode === 'scale' && this.object) {
      v.applyQuaternion(this.object.getWorldQuaternion(new THREE.Quaternion()));
    }
    return v.normalize();
  }

  /**
   * Round a turn to the angle snap — the angle *arrived at*, not the angle
   * applied.
   *
   * The difference is the whole of what the snap is for. Rounding the delta
   * keeps whatever the piece already had and adds tidy amounts to it, so a
   * barrier turned freely to 43 degrees with the snap off goes to 58, 73, 88
   * once it is back on: every one of them off-step, and nothing short of typing
   * a number ever gets it back. Rounding the result instead means the first
   * turn after the snap comes on lands on 45, and the piece is square with
   * everything else built at 15.
   *
   * The angle in question is the turn about the **world axis whose circle was
   * grabbed**, because that is the only thing the control claims to do. It is
   * measured with a swing-twist split: any orientation is a turn about that
   * axis followed by a lean off it, the two are independent, and the twist half
   * is the number this rounds. The correction is then applied as one more
   * rotation about the same world axis, which by construction cannot disturb
   * the lean.
   *
   * This used to decompose into a 'YXZ' euler and round the one component named
   * after the axis, on the reasoning that the euler is what the inspector shows
   * and the file stores. It is — but only Y survives the trip. 'YXZ' composes
   * as Ry·Rx·Rz, so Y is the outermost factor and a world-Y turn does land
   * exactly on `e.y`; `e.x` is an intermediate axis and `e.z` is the object's
   * *own* Z after the other two have been applied. Rounding either of those on
   * a piece that already carried some rotation moved it off the circle being
   * dragged — measured against the three-axis Box in `reference/Issues`, a
   * 20 degree pull on the Z circle turned it 20.11 degrees about Z *and* tilted
   * it 1.35 degrees about the other two, and landed on no multiple of anything.
   * A piece already at an angle could never be squared up by dragging at all.
   *
   * Rounding the arrived-at angle rather than the applied one is kept, and is
   * still the whole point: a barrier left at a free 43 degrees goes to 45 on
   * the first turn after the snap comes on, rather than to 58, 73, 88.
   *
   * What is given up is tidy *euler* numbers on a compound rotation, and there
   * was never anything to give: a world-axis turn applied to a piece already
   * leaning has no tidy euler, and the old code's tidy `e.x` was a number that
   * did not describe what had happened. The number that matters — the total
   * turn about the axis you dragged — is exactly on the step.
   *
   * Only that axis is touched. A piece deliberately tipped to a free angle
   * about X has no business being straightened because someone turned it
   * about Y.
   */
  _snapTurn(q, axisWorld) {
    const step = this.rotationSnap;
    if (!step || !this.axis || this.axis === 'view' || !axisWorld) return q;
    const now = twistAngle(q, axisWorld);
    const wanted = Math.round(now / step) * step;
    const correction = wanted - now;
    if (Math.abs(correction) < 1e-12) return q;
    return new THREE.Quaternion().setFromAxisAngle(axisWorld, correction).multiply(q);
  }

  /** Where the pointer ray meets a plane, as an offset from `origin`. */
  _planePoint(plane, origin) {
    const p = new THREE.Vector3();
    return this._ray.ray.intersectPlane(plane, p) ? p.sub(origin) : new THREE.Vector3();
  }

  /**
   * How far along `dir` from `origin` the pointer ray comes closest. The
   * standard closest-point-between-two-lines, with the degenerate case — the
   * axis pointing straight at the camera — falling back to no movement rather
   * than to infinity.
   */
  _axisPoint(origin, dir) {
    const ro = this._ray.ray.origin, rd = this._ray.ray.direction;
    const w = new THREE.Vector3().subVectors(origin, ro);
    const a = dir.dot(dir), b = dir.dot(rd), c = rd.dot(rd);
    const d = dir.dot(w), e = rd.dot(w);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-8) return this._lastAxisPoint ?? 0;
    this._lastAxisPoint = (b * e - c * d) / denom;
    return this._lastAxisPoint;
  }

  _drag(e) {
    if (!this.object) return;
    this._ray.setFromCamera(this._pointer(e), this.camera);
    const s = this._start;

    if (this.activeMode === 'translate') {
      const next = s.position.clone();
      if (this.axis === 'view') {
        const now = this._planePoint(s.plane, s.centre);
        next.add(now.sub(s.from));
        // Both points are in the same horizontal plane, so the height cannot
        // have moved — but say so rather than trusting the arithmetic, and snap
        // the two axes that did, the same way the arrows do.
        next.y = s.position.y;
        if (this.translationSnap) {
          next.x = Math.round(next.x / this.translationSnap) * this.translationSnap;
          next.z = Math.round(next.z / this.translationSnap) * this.translationSnap;
        }
      } else {
        let delta = this._axisPoint(s.centre, s.axisWorld) - s.offset;
        if (this.translationSnap) delta = Math.round(delta / this.translationSnap) * this.translationSnap;
        next.add(s.axisWorld.clone().multiplyScalar(delta));
      }
      if (this.translationSnap && this.axis !== 'view') {
        // Snap the moving component to the grid rather than the delta alone, so
        // repeated drags cannot accumulate a fraction of a step.
        for (const k of AXES) {
          if (Math.abs(s.axisWorld[k]) > 0.999) next[k] = Math.round(next[k] / this.translationSnap) * this.translationSnap;
        }
      }
      this.object.position.copy(next);
    } else if (this.activeMode === 'rotate') {
      const now = this._planePoint(s.plane, s.centre);
      if (now.lengthSq() < 1e-8) return;
      const angle = Math.atan2(
        new THREE.Vector3().crossVectors(s.from, now).dot(s.axisWorld),
        s.from.dot(now)
      );
      const q = new THREE.Quaternion().setFromAxisAngle(s.axisWorld, angle).multiply(s.quaternion);
      this.object.quaternion.copy(this._snapTurn(q, s.axisWorld));
    } else if (this.activeMode === 'scale') {
      const reach = this._axisPoint(s.centre, s.axisWorld);
      let ratio = reach / (s.offset || (s.offset = 1e-4));
      if (!Number.isFinite(ratio)) return;
      ratio = Math.max(0.01, ratio);
      if (this.scaleSnap) ratio = Math.max(0.01, Math.round(ratio / this.scaleSnap) * this.scaleSnap);
      const next = s.scale.clone();
      if (this.uniform) {
        next.multiplyScalar(ratio);
      } else {
        // A mirrored piece carries a negative scale on one axis, which is the
        // whole of how it is flipped. Resize its magnitude and leave the sign
        // where it was, or dragging a handle would quietly unflip it.
        const was = s.scale[this.axis];
        const sign = was < 0 ? -1 : 1;
        next[this.axis] = sign * Math.max(0.001, Math.abs(was) * ratio);
      }
      this.object.scale.copy(next);
    }

    this.dispatchEvent({ type: 'objectChange' });
  }
}
