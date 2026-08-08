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

/** Unity euler degrees {x,y,z} -> three.js quaternion [x,y,z,w]. */
export function unityEulerToQuat(r) {
  return quatFromEulerYXZ(-r.x * DEG, -r.y * DEG, r.z * DEG);
}

/** three.js quaternion [x,y,z,w] -> Unity euler degrees {x,y,z} in [0, 360). */
export function quatToUnityEuler(q) {
  const [ex, ey, ez] = eulerYXZFromQuat(q);
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
