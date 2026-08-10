// ---------------------------------------------------------------------------
// Unity <-> three.js transform conversion
// ---------------------------------------------------------------------------
// Unity is left-handed (X right, Y up, Z forward-into-the-scene) and composes
// euler angles as Ry * Rx * Rz. three.js is right-handed with Z toward the
// viewer. Feeding Unity numbers straight into three.js mirrors the whole map,
// which matters as soon as an asymmetric piece like BarrierCorner is placed.
//
// The fix is the reflection M(x, y, z) = (x, y, -z). Under a reflection a
// rotation about axis a by angle t becomes a rotation about M(a) by -t, so:
//
//   q_three = Ry(-uy) * Rx(-ux) * Rz(uz)   ==  THREE.Euler(-ux, -uy, uz, 'YXZ')
//
// Written out longhand here rather than leaning on three.js so it can be
// tested standalone.
//
// **Then every object is turned half a turn about its own vertical axis.**
// Confirmed in the headset against the editor: positions land where the editor
// says, but a crate's lettering sits on the opposite face and a corner
// barrier's arms wrap the opposite corner — the text still reads left to right,
// so it is a rotation and not a mirror. `MODEL_YAW` below is that half turn.
//
// It is applied on the right, in the object's own frame, because that is where
// the evidence puts it. A world-side half turn is the difference between
// reflecting Z and reflecting X, and that would move every object as well as
// turn it — positions are right, so it is not that. What is left is the meshes'
// own forward axis pointing the other way to the map's, which is a property of
// each mesh. Rotating all 167 prefabs and placeholders would say the same
// thing; doing it here says it once, and keeps the measured `anchor` values
// pointing at the corner the tracer actually found.
// ---------------------------------------------------------------------------

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Quaternion (as [x,y,z,w]) from euler radians applied in three.js 'YXZ' order. */
export function quatFromEulerYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

/** Euler radians in 'YXZ' order from a normalised quaternion [x,y,z,w]. */
export function eulerYXZFromQuat(q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const m11 = 1 - (yy + zz), m13 = xz + wy;
  const m21 = xy + wz,       m22 = 1 - (xx + zz), m23 = yz - wx;
  const m31 = xz - wy,       m33 = 1 - (xx + yy);

  const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
  const ex = Math.asin(-clamp(m23));
  let ey, ez;
  if (Math.abs(m23) < 0.9999999) {
    ey = Math.atan2(m13, m33);
    ez = Math.atan2(m21, m22);
  } else {
    ey = Math.atan2(-m31, m11);
    ez = 0;
  }
  return [ex, ey, ez];
}

/** Unity position {x,y,z} -> three.js [x, y, z]. Self-inverse. */
export function convertPosition(p) {
  return [p.x, p.y, -p.z];
}

/**
 * The half turn about the object's own Y that sits between a map file's
 * rotation and the way the mesh faces. See the note at the top of the file.
 * As a quaternion about +Y by pi: [0, 1, 0, 0].
 */
export const MODEL_YAW = [0, 1, 0, 0];

/** Hamilton product, [x,y,z,w] convention. */
function mulQuat(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Unity euler degrees {x,y,z} -> three.js quaternion [x,y,z,w]. */
export function unityEulerToQuat(r) {
  const q = quatFromEulerYXZ(-r.x * DEG, -r.y * DEG, r.z * DEG);
  return mulQuat(q, MODEL_YAW);
}

/** three.js quaternion [x,y,z,w] -> Unity euler degrees {x,y,z} in [0, 360). */
export function quatToUnityEuler(q) {
  // Undo the half turn first. It is its own inverse, so the same multiply
  // serves both ways round and the round trip cannot drift.
  const [ex, ey, ez] = eulerYXZFromQuat(mulQuat(q, MODEL_YAW));
  return {
    x: wrap360(-ex * RAD),
    y: wrap360(-ey * RAD),
    z: wrap360(ez * RAD),
  };
}

export function wrap360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  // Kill -0 and floating point fuzz right below 360 so exports stay tidy.
  if (Math.abs(d) < 1e-6 || Math.abs(d - 360) < 1e-6) d = 0;
  return d;
}
