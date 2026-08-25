// course.mjs — piecewise cubic Bezier course path with banked camera orientation.
// Control points are sampled from the heightfield along the analytic centerline;
// Catmull-Rom tangents are converted to Bezier handles (b1 = P0 + T0/3, b2 = P1 - T1/3)
// so the path is a true piecewise cubic Bezier, C1-continuous.

import { sampleHeight, courseX, COURSE_Z0, COURSE_Z1 } from './heightfield.mjs';

const N = 24; // control points

export function buildCoursePath(lift = 16) {
  const P = [];
  for (let i = 0; i <= N; i++) {
    const z = COURSE_Z0 + (COURSE_Z1 - COURSE_Z0) * (i / N);
    const x = courseX(z);
    P.push([x, sampleHeight(x, z) + lift, z]);
  }
  // Catmull-Rom tangents (clamped ends)
  const T = [];
  for (let i = 0; i <= N; i++) {
    const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, N)];
    const s = (i === 0 || i === N) ? 1.0 : 0.5;
    T.push([(b[0] - a[0]) * s, (b[1] - a[1]) * s, (b[2] - a[2]) * s]);
  }

  function point(t, out) {
    t = Math.min(Math.max(t, 0), 1);
    const s = t * N;
    let i = Math.min(Math.floor(s), N - 1);
    const u = s - i;
    const p0 = P[i], p1 = P[i + 1], t0 = T[i], t1 = T[i + 1];
    // Bezier control points from Hermite form
    const iu = 1 - u;
    const b0 = iu * iu * iu, b1 = 3 * iu * iu * u, b2 = 3 * iu * u * u, b3 = u * u * u;
    for (let k = 0; k < 3; k++) {
      const c1 = p0[k] + t0[k] / 3, c2 = p1[k] - t1[k] / 3;
      out[k] = b0 * p0[k] + b1 * c1 + b2 * c2 + b3 * p1[k];
    }
    return out;
  }

  // XZ heading (radians) of the path at t
  const _a = [0, 0, 0], _b = [0, 0, 0];
  function heading(t) {
    const e = 0.004;
    point(Math.max(t - e, 0), _a);
    point(Math.min(t + e, 1), _b);
    return Math.atan2(_b[0] - _a[0], _b[2] - _a[2]);
  }

  return { point, heading };
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
