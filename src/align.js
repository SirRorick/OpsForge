// ---------------------------------------------------------------------------
// align.js — putting a map that came back from a headset back on the grid
// ---------------------------------------------------------------------------
// A map built here is built on the grid: pieces sit on quarter-metre lines and
// face along the axes, because that is what the editor snaps them to. Take that
// map into the headset, align it to the room you are standing in, save it, and
// bring it back, and every number in it has been through a rotation and a
// shift — the whole map at once, as one rigid body. Nothing is *wrong* with the
// file that comes back. It plays, and every piece still stands exactly where it
// stood relative to every other piece. It is simply no longer square to
// anything, so the next thing built on it cannot line up with it, the arrow
// keys nudge across the grain, and every field in the inspector has seven
// digits in it.
//
// The way back is that same rigid body in reverse: one rotation and one shift,
// applied to the whole map, chosen so that as much of it as possible lands back
// on the grid. **Nothing here ever moves one piece relative to another.** That
// is the promise the feature is built on, and it is what makes it safe to press
// on finished work — the worst it can do is put the map somewhere you did not
// want it, which is one undo away.
//
// Everything is worked out from the objects themselves, because they are the
// only evidence there is: the file records where things ended up and says
// nothing about where they started. Three questions, in this order, each
// answered from what the one before it left:
//
//   1. **Which way is up?** Every object carries three axes of its own, and on
//      a map built here one of those three is vertical. Take each object's
//      nearest-to-vertical axis as a vote, average the votes, and the answer is
//      which way "up" has been tipped to.
//
//   2. **Which way is north?** Level the map with the answer to (1), then look
//      at the axes that are now horizontal. On a map built here they run along
//      X and Z, which is to say they agree with each other modulo a quarter
//      turn — so average them modulo a quarter turn and the answer is how far
//      round the map has been turned.
//
//   3. **Where is the origin?** Turn the map back with (1) and (2), and ask how
//      far every object is from the nearest grid line. Average that, and the
//      answer is the shift that puts the most of them back on one.
//
// All three are averages of a circular quantity, and all three have to survive
// a map that is *mostly* square rather than entirely square — the one crate
// somebody turned forty degrees on purpose, the ramp that is meant to be a
// ramp. So each is a weighted mean iterated three times, with the weight
// falling away as a vote disagrees with the current estimate: an outlier stops
// counting without ever being thrown out by a threshold nobody chose. And each
// reports a confidence — the length of the mean vote — so a question with no
// consistent answer in the map can be *left alone* rather than answered with
// noise. A map with no grid in it to find is a map this must not move.
//
// The three answers are independent in that sense. Levelling a map whose
// heights are all over the place is still worth doing; shifting one that was
// never on a grid to begin with is not, and the shift is skipped on that axis
// alone.
//
// Pure geometry, and no viewport: everything here takes poses and hands back a
// transform, so it can be tested without a browser.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  DEG, RAD, wrap360, convertPosition, unityEulerToQuat, quatToUnityEuler,
} from './unity.js';

/** The lines the editor draws and snaps to, and what the game's own maps use. */
export const GRID_STEP = 0.25;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const BASIS_AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
];

// How far a vote may stray from the current estimate before it counts for half.
// Three degrees is wider than any drift a rigid re-alignment introduces and far
// narrower than anything anybody placed on purpose, so the two never meet.
const LEVEL_TOLERANCE = 3 * DEG;
const TURN_TOLERANCE = 3 * DEG;

// An axis within this of horizontal has an angle worth reading round the
// compass. Anything steeper is the object's vertical and says nothing about
// which way it faces.
const HORIZONTAL = 0.3;

// Below these the map is already where it should be, and the "straightening"
// would be floating point noise dressed up as an edit.
const MIN_ANGLE = 0.01 * DEG;
const MIN_SHIFT = 0.0005; // half a millimetre

// How concentrated the votes have to be before their answer is trusted.
//
// The re-weighting above makes this number mean something usefully concrete:
// measured on a hundred and twenty objects, the confidence comes out at very
// nearly *the fraction of the map that is on a grid at all* — 0.91 when nine
// objects in ten are square, 0.58 when half are, 0.33 when a fifth are, and
// 0.16 for a map of nothing but angles nobody chose. So these are not tuning
// constants so much as an answer to "how much of a map has to be square before
// straightening it is a thing somebody meant".
//
// A fifth, near enough, and the reason it is that low is that the *estimate*
// stays good long after the confidence stops looking impressive: with only a
// fifth of the map square the turn still comes back within a twentieth of a
// degree. What the floor is really protecting against is the map at the bottom
// of that list, where there is no grid to find and the answer is noise — and
// against that, the cost of being wrong is one undo.
const LEVEL_CONFIDENCE = 0.5;
const TURN_CONFIDENCE = 0.35;
const SLIDE_CONFIDENCE = 0.3;

/**
 * Why one of the three answers was or was not used, in the words the toast
 * needs: it was applied, the map was already there, or the map had no
 * consistent answer to give and was left alone rather than moved on a guess.
 *
 * The difference between the last two is the whole reason this is a string
 * rather than the boolean beside it. "Already square" and "too crooked to tell"
 * both come out as no change, and only one of them is worth saying.
 */
function verdict(applied, confidence, floor) {
  if (applied) return 'applied';
  return confidence < floor ? 'unclear' : 'already';
}

/**
 * How much a vote counts, given how far it disagrees.
 *
 * A Lorentzian rather than a cut-off: a vote at the tolerance counts half, one
 * at three times it counts a tenth, and nothing is ever discarded outright. The
 * point is that no threshold has to be right — a map that is 90% square and a
 * map that is 60% square are handled by the same curve, and the estimate moves
 * smoothly rather than jumping as one object crosses a line.
 */
function robustWeight(deviation, tolerance) {
  const t = deviation / tolerance;
  return 1 / (1 + t * t);
}

function angleBetween(a, b) {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
}

/**
 * Each object's own vertical, as it currently points.
 *
 * Whichever of the object's three axes is nearest the world's up, turned to
 * point up rather than down — a crate is the same crate upside down, and this
 * is asking about the map's tilt, not the crate's. On a map that was square
 * before it went into the headset every one of these votes is the *same*
 * direction, whatever each object was individually turned to: an object turned
 * about the vertical still has the same vertical.
 */
function verticalVotes(quaternions) {
  const votes = [];
  const v = new THREE.Vector3();
  for (const q of quaternions) {
    let best = null;
    let bestDot = -1;
    for (const axis of BASIS_AXES) {
      v.copy(axis).applyQuaternion(q);
      if (Math.abs(v.y) > bestDot) {
        bestDot = Math.abs(v.y);
        best = v.clone();
      }
    }
    if (!best) continue;
    if (best.y < 0) best.negate();
    votes.push(best.normalize());
  }
  return votes;
}

/**
 * The direction the votes agree on, and how much they agree.
 *
 * Confidence is the length of the mean vote measured against *every* vote, not
 * just the ones that ended up counting — otherwise five objects agreeing with
 * each other while two hundred disagreed would score the same as all two
 * hundred and five agreeing, which is the opposite of what the number is for.
 */
function meanDirection(votes, tolerance) {
  if (!votes.length) return null;
  const acc = new THREE.Vector3();
  for (const v of votes) acc.add(v);
  if (acc.lengthSq() < 1e-12) return null;
  const dir = acc.clone().normalize();
  let confidence = 0;
  for (let pass = 0; pass < 3; pass++) {
    acc.set(0, 0, 0);
    for (const v of votes) acc.addScaledVector(v, robustWeight(angleBetween(v, dir), tolerance));
    if (acc.lengthSq() < 1e-12) return null;
    confidence = acc.length() / votes.length;
    dir.copy(acc).normalize();
  }
  return { direction: dir, confidence };
}

/**
 * Which way each object faces, read off its horizontal axes.
 *
 * Read in the plane rather than as a single "forward", because an object has no
 * forward — a crate's X and its Z are the same evidence twice, and both of them
 * being available is what lets an object lying on its side still cast a vote.
 * `Math.atan2(z, x)` is the angle a turn about Y *reduces*: turning the world by
 * `a` about Y takes X to `(cos a, 0, -sin a)`, so the reading drops by exactly
 * `a`, and the angle found here is the angle to turn back by.
 */
function turnVotes(quaternions) {
  const votes = [];
  const v = new THREE.Vector3();
  for (const q of quaternions) {
    for (const axis of BASIS_AXES) {
      v.copy(axis).applyQuaternion(q);
      if (Math.abs(v.y) > HORIZONTAL) continue;
      votes.push(Math.atan2(v.z, v.x));
    }
  }
  return votes;
}

/**
 * The mean of a set of values modulo `period`, and how concentrated they are.
 *
 * Modulo a quarter turn for the compass, because a map's four axis directions
 * are the same grid — a wall along X and a wall along Z say the same thing
 * about which way the map is turned. Modulo the grid step for a position, for
 * exactly the same reason: a crate one line over is a crate on the grid.
 * Multiplying by `2*pi/period` maps that period onto a full circle, where a
 * mean is just the direction of the sum, and dividing back gives the answer in
 * the range `±period/2`.
 *
 * Three re-weighted passes, like the directions: the crate somebody turned
 * forty degrees on purpose, or nudged half a centimetre off the line, is a vote
 * that has to stop counting rather than one that moves the answer. With twenty
 * objects square and four not, a plain mean leaves all twenty a couple of
 * millimetres off the grid — near enough to look right and not near enough to
 * type a round number into afterwards, which is the whole point of pressing
 * the button.
 */
function robustCircularMean(values, period, tolerance) {
  if (!values.length) return null;
  const k = (2 * Math.PI) / period;
  let cos = 0;
  let sin = 0;
  for (const v of values) { cos += Math.cos(v * k); sin += Math.sin(v * k); }
  if (cos === 0 && sin === 0) return null;
  let mean = Math.atan2(sin, cos) / k;
  let confidence = Math.hypot(cos, sin) / values.length;
  for (let pass = 0; pass < 3; pass++) {
    cos = 0; sin = 0;
    for (const v of values) {
      // The shortest way from this vote to the current estimate, which is what
      // "disagrees" has to mean on a circle.
      const w = robustWeight(Math.abs(wrapTo(v - mean, period)), tolerance);
      cos += w * Math.cos(v * k);
      sin += w * Math.sin(v * k);
    }
    if (cos === 0 && sin === 0) break;
    mean = Math.atan2(sin, cos) / k;
    confidence = Math.hypot(cos, sin) / values.length;
  }
  return { mean, confidence };
}

/** `v` folded into the half-open range `±period/2`. */
function wrapTo(v, period) {
  const m = ((v % period) + period) % period;
  return m > period / 2 ? m - period : m;
}

/**
 * How far one axis of the map is off the grid, and how much of a grid there is
 * to be off.
 *
 * The same mean over again with the grid step as the period: the objects'
 * distances from the lines they are nearest, averaged, negated. The tolerance
 * is a tenth of a step — a couple of centimetres at the usual quarter metre —
 * which is far wider than the drift a re-alignment leaves and far narrower than
 * anything anybody dragged off the line on purpose.
 */
function gridShift(values, step) {
  const found = robustCircularMean(values, step, step / 10);
  return found ? { shift: -found.mean, confidence: found.confidence } : null;
}

/**
 * The one rotation and one shift that put `poses` back on the grid.
 *
 * `poses` are `{ p, q }` in the map's own frame — `Viewport.designPose` hands
 * back exactly that. `level: false` asks for a turn and a shift and no tilt,
 * for a caller that has somewhere to carry those two and nowhere to carry a
 * third — see `rebasePlacement`. The answer is a rotation about `pivot`
 * followed by `shift`, and `changed` says whether any of it amounts to
 * anything; the three reports beside it say what was decided and what was left
 * alone, which is what the toast is written from.
 *
 * Returns null only when there is nothing to work from at all.
 */
export function straighteningTransform(poses, { step = GRID_STEP, level: mayLevel = true } = {}) {
  if (!poses?.length) return null;

  const quaternions = poses.map((o) => o.q);

  // 1. Which way is up.
  const vertical = meanDirection(verticalVotes(quaternions), LEVEL_TOLERANCE);
  const levelAngle = vertical ? angleBetween(vertical.direction, WORLD_UP) : 0;
  const levelConfidence = vertical?.confidence ?? 0;
  const levelApplied = mayLevel && !!vertical
    && levelConfidence >= LEVEL_CONFIDENCE && levelAngle >= MIN_ANGLE;
  const level = {
    degrees: levelAngle * RAD,
    confidence: levelConfidence,
    applied: levelApplied,
    reason: mayLevel ? verdict(levelApplied, levelConfidence, LEVEL_CONFIDENCE) : 'refused',
  };
  const tilt = levelApplied
    ? new THREE.Quaternion().setFromUnitVectors(vertical.direction, WORLD_UP)
    : new THREE.Quaternion();

  // 2. Which way is north — asked of the map as levelling will leave it, so the
  //    axes being read round the compass are horizontal ones.
  const levelled = quaternions.map((q) => tilt.clone().multiply(q));
  const compass = robustCircularMean(turnVotes(levelled), Math.PI / 2, TURN_TOLERANCE);
  const turnConfidence = compass?.confidence ?? 0;
  const turnApplied = !!compass
    && turnConfidence >= TURN_CONFIDENCE && Math.abs(compass.mean) >= MIN_ANGLE;
  const turn = {
    degrees: compass ? compass.mean * RAD : 0,
    confidence: turnConfidence,
    applied: turnApplied,
    reason: verdict(turnApplied, turnConfidence, TURN_CONFIDENCE),
  };
  const yaw = turnApplied
    ? new THREE.Quaternion().setFromAxisAngle(WORLD_UP, compass.mean)
    : new THREE.Quaternion();

  const rotation = yaw.clone().multiply(tilt);

  // 3. Where the origin is, asked of the map as the rotation will leave it. The
  //    pivot is the middle of the map so that a turn does not also throw it
  //    across the arena — any pivot gives the same shape, and this one keeps
  //    the numbers small and the map roughly where the user left it.
  const pivot = new THREE.Vector3();
  for (const o of poses) pivot.add(o.p);
  pivot.divideScalar(poses.length);

  const turned = poses.map((o) => o.p.clone().sub(pivot).applyQuaternion(rotation).add(pivot));
  const shift = new THREE.Vector3();
  const slide = {};
  for (const axis of ['x', 'y', 'z']) {
    const found = gridShift(turned.map((p) => p[axis]), step);
    const applied = !!found
      && found.confidence >= SLIDE_CONFIDENCE && Math.abs(found.shift) >= MIN_SHIFT;
    slide[axis] = {
      metres: found ? found.shift : 0,
      confidence: found?.confidence ?? 0,
      applied,
      reason: verdict(applied, found?.confidence ?? 0, SLIDE_CONFIDENCE),
    };
    if (applied) shift[axis] = found.shift;
  }

  return {
    rotation,
    pivot,
    shift,
    step,
    level,
    turn,
    slide,
    changed: level.applied || turn.applied || slide.x.applied || slide.y.applied || slide.z.applied,
  };
}

/** Where a point in the map ends up. */
export function straightenPoint(xf, p) {
  return p.clone().sub(xf.pivot).applyQuaternion(xf.rotation).add(xf.pivot).add(xf.shift);
}

/** Which way a piece in the map ends up facing. */
export function straightenQuaternion(xf, q) {
  return xf.rotation.clone().multiply(q);
}

/**
 * The same transform written the way the file writes a placement — a yaw in
 * degrees and an offset, both in Unity values, about the world origin rather
 * than about the pivot.
 *
 * Two things outside the objects need it. The nav cloud carries a position and
 * a yaw of its own, and the play grid has to come round with the map it
 * describes. And in LBE mode every venue's alignment is "where the design
 * stands in this hall" — straightening the design underneath one without
 * moving its placement to match would slide that hall's whole map sideways, so
 * the placements are corrected by the same amount in the other direction.
 *
 * The yaw is the Y term of a `YXZ` decomposition, which is the map's own
 * convention and is exact whenever the transform carries no tilt. When it does
 * carry one, a placement has nowhere to put it: the format has never had a
 * tilted hall or a tilted floor mask, and `level.applied` is what tells a
 * caller to say so.
 */
export function straighteningPlacement(xf) {
  const euler = new THREE.Euler().setFromQuaternion(xf.rotation, 'YXZ');
  // Rotating about the pivot and then shifting is the same as rotating about
  // the origin and then shifting by this, which is the form a placement takes.
  const offset = xf.pivot.clone()
    .sub(xf.pivot.clone().applyQuaternion(xf.rotation))
    .add(xf.shift);
  return {
    yaw: wrap360(-euler.y * RAD),
    offset: { x: offset.x, y: offset.y, z: -offset.z },
  };
}

/**
 * One map object, in the file's own values, put through the transform.
 *
 * For the objects a venue has forked or added. Those are stored in the design's
 * coordinates like everything else and are banked as values rather than meshes
 * while another venue is on screen, so they are not among the poses the
 * transform was worked out from — and leaving them behind would slide every
 * fork out from under the design it was forked from.
 *
 * Exact, through the same two conversions the viewport uses on the way in and
 * on the way out, rather than through `alignMapObject`'s yaw-and-shift: this
 * one may have a tilt in it, and a fork has to keep its place to the
 * millimetre or it is not a fork of anything.
 *
 * `raw` and `dirty` go the way `alignMapObject` sends them for the same reason:
 * it has moved, so the bytes it arrived as no longer describe it.
 */
export function straightenMapObject(xf, mo) {
  const p = straightenPoint(xf, new THREE.Vector3(...convertPosition(mo.position)));
  const q = straightenQuaternion(
    xf, new THREE.Quaternion().fromArray(unityEulerToQuat(mo.rotation)),
  );
  return {
    ...mo,
    position: { x: p.x, y: p.y, z: -p.z },
    rotation: quatToUnityEuler(q.toArray()),
    raw: null,
    dirty: true,
  };
}

/**
 * A nav cloud's own placement, carried round with the map it describes.
 *
 * The play grid is not a map object and is not in the list the transform was
 * worked out from, but it stands in the same room as everything that is: leave
 * it behind and the ground the bots may walk on is somewhere the map no longer
 * is. Its position goes through the *whole* transform, tilt included, so the
 * grid keeps its distance from the map exactly. Its rotation can only take the
 * yaw — a floor mask has one angle and the format has never written a tilted
 * one — which is the same thing `alignMapObject` says about a hall.
 */
export function straightenNavCloud(xf, navCloud) {
  const p = straightenPoint(
    xf,
    new THREE.Vector3(
      navCloud.position?.x || 0, navCloud.position?.y || 0, -(navCloud.position?.z || 0),
    ),
  );
  return {
    position: { x: p.x, y: p.y, z: -p.z },
    rotation: {
      ...navCloud.rotation,
      y: wrap360((navCloud.rotation?.y || 0) + straighteningPlacement(xf).yaw),
    },
  };
}

/**
 * A venue placement corrected for the design having been straightened under it,
 * so the hall plays exactly what it played before.
 *
 * The design's objects have moved by `A` — a turn of `a` about the origin and a
 * shift of `b` — and the hall's placement `F` is a turn of `yaw` and a shift of
 * `offset` applied on top. For the objects to land where they landed before,
 * the new placement has to satisfy `F' . A = F`, which for two turns about the
 * same vertical axis is simply `yaw' = yaw - a` and `offset' = offset - F'(b)`.
 *
 * **Two turns about the same vertical axis**, which is the whole of why the
 * caller asks for `level: false` when any hall has been aligned. A placement is
 * a yaw and a shift and has nowhere to put a tilt, so a straightening carrying
 * one could not be undone here and every aligned hall would come out a
 * centimetre or two adrift. A map with halls in it is squared up and left
 * level, which is what the format says a hall is anyway.
 */
export function rebasePlacement(placement, applied) {
  const yaw = wrap360((placement.yaw || 0) - applied.yaw);
  const rad = yaw * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { x, y, z } = applied.offset;
  const o = placement.offset || { x: 0, y: 0, z: 0 };
  return {
    yaw,
    offset: {
      x: (o.x || 0) - (x * cos + z * sin),
      y: (o.y || 0) - y,
      z: (o.z || 0) - (-x * sin + z * cos),
    },
  };
}
