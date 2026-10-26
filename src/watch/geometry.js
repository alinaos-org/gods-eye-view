/**
 * Portable zone geometry for Watch: ring normalisation, circle checks,
 * compiled zones, signed distances, hysteresis margins, bounding-box
 * prefilters, feed-coverage tests and drawable outlines.
 *
 * Coordinates are degrees and rings are GeoJSON-ordered `[lon, lat]` pairs.
 * A polygon is projected azimuthal-equidistant about its centre (the mean of
 * its unwrapped vertices) and its edges are straight in that projection. The
 * outline from {@link outlineRing} is densified along those same straight
 * edges, so the drawn outline is the containment boundary. Circles use
 * great-circle distance from their centre.
 *
 * Pure module: no platform globals, timers, storage or clocks.
 */
import { EARTH_RADIUS_KM, greatCircleMeters } from '../geoDistance.js';

/**
 * Hard limits for zone geometry.
 *
 * - `minRadiusM` / `maxRadiusM`: circle radius range.
 * - `minVertices` / `maxVertices`: distinct polygon vertices after
 *   simplification.
 * - `maxInputVertices`: distinct vertices accepted before simplification.
 * - `minAreaM2` / `maxAreaM2`: polygon area range.
 * - `maxAbsLatDeg`: every polygon vertex and every circle centre lies within
 *   this latitude.
 * - `maxSpanLatDeg` / `maxSpanLonDeg`: polygon span (longitudes unwrapped).
 * - `densifyStepM` / `maxDensifyPerEdge`: outline densification of projected
 *   polygon edges.
 */
export const GEOMETRY_LIMITS = Object.freeze({
  minRadiusM: 1_000,
  maxRadiusM: 1_000_000,
  minVertices: 3,
  maxVertices: 64,
  maxInputVertices: 20_000,
  minAreaM2: 2e6,
  maxAreaM2: 1e13,
  maxAbsLatDeg: 85,
  maxSpanLatDeg: 40,
  maxSpanLonDeg: 60,
  densifyStepM: 50_000,
  maxDensifyPerEdge: 16,
});

/**
 * Hysteresis margin rules per asset kind: `clamp(share × scaleM, minM, maxM)`,
 * then capped at a quarter of the zone scale (see {@link marginM}).
 */
export const MARGIN_RULES = Object.freeze({
  aircraft: Object.freeze({ share: 0.02, minM: 300, maxM: 2_000 }),
  vessel: Object.freeze({ share: 0.02, minM: 150, maxM: 1_000 }),
});

/** Every code {@link normalizeRing} can return when it rejects a ring. */
export const RING_ERROR_CODES = Object.freeze([
  'non-finite',
  'too-few',
  'too-many',
  'pole',
  'span',
  'self-intersecting',
  'too-small',
  'too-large',
  'degenerate',
]);

/** Every code {@link validateCircle} can return when it rejects a circle. */
export const CIRCLE_ERROR_CODES = Object.freeze([
  'non-finite',
  'bad-radius',
  'pole',
]);

/**
 * Feed coverage, as reported by a layer's `getCoverageArea()`.
 *
 * @typedef {{kind: 'global'}
 *   | {kind: 'circle', lat: number, lon: number, radiusKm: number}
 *   | {kind: 'unknown'}} Coverage
 */

/**
 * Bounding box in degrees. When `wraps` is true the box crosses the
 * antimeridian and holds longitudes `>= west` or `<= east`. A box spanning
 * every longitude is `west: -180, east: 180, wraps: false`. The box is
 * conservative: it may be slightly larger than the zone, never smaller.
 *
 * @typedef {{south: number, north: number, west: number, east: number,
 *   wraps: boolean}} ZoneBbox
 */

/**
 * A zone compiled for fast containment tests. Frozen; `xy` is the open,
 * counter-clockwise ring of projected polygon vertices
 * `[x0, y0, x1, y1, …]` in metres (x east, y north) about `center`, or null
 * for circles. `scaleM` is the radius for circles and `sqrt(areaM2 / π)` for
 * polygons. `labelAnchor` is the northernmost outline point.
 *
 * @typedef {Readonly<{
 *   id: string|null,
 *   shape: 'circle'|'polygon',
 *   center: Readonly<{lat: number, lon: number}>,
 *   radiusM: number|null,
 *   scaleM: number,
 *   areaM2: number,
 *   bbox: Readonly<ZoneBbox>,
 *   xy: Float64Array|null,
 *   labelAnchor: Readonly<{lat: number, lon: number}>,
 * }>} CompiledZone
 */

const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const MARGIN_SCALE_CAP = 0.25;
const SIMPLIFY_START_SHARE = 0.005;
const SIMPLIFY_ROUNDS = 8;
const DUPLICATE_EPS_DEG = 1e-9;
const WINDING_EPS_DEG = 1e-6;
const DEGENERATE_AREA_M2 = 1;
const AREA_STEP_M = 50_000;
const AREA_MAX_STEPS_PER_EDGE = 64;
const BBOX_SAMPLE_STEP_M = 2_000;
const BBOX_MAX_SAMPLES_PER_EDGE = 512;
const BBOX_SAFETY_M = 100;
const FULL_COVERAGE_SLACK_M = 100;
const DEFAULT_CIRCLE_SEGMENTS = 96;
const MIN_CIRCLE_SEGMENTS = 3;
const MAX_CIRCLE_SEGMENTS = 1_440;

/** Per-compiled-zone memo of derived polygon data (projection, outline). */
const derivedCache = new WeakMap();

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(lat, lon) {
  return (
    isFiniteNumber(lat) &&
    isFiniteNumber(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Longitude into [-180, 180]; in-range values are returned untouched. */
function wrapLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Longitude difference into [-180, 180]. */
function wrapDelta(delta) {
  return delta - 360 * Math.round(delta / 360);
}

function fail(code) {
  return { ok: false, code };
}

// ---------------------------------------------------------------------------
// Azimuthal-equidistant projection (spherical, EARTH_RADIUS_KM).
// ---------------------------------------------------------------------------

function makeProjection(lat0, lon0) {
  const phi0 = lat0 * DEG;
  return {
    lat0,
    lon0,
    lam0: lon0 * DEG,
    sin0: Math.sin(phi0),
    cos0: Math.cos(phi0),
  };
}

/** Forward projection; returns `[x, y]` in metres. */
function forward(proj, lat, lon) {
  const phi = lat * DEG;
  const dLam = lon * DEG - proj.lam0;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const cosDLam = Math.cos(dLam);
  const east = cosPhi * Math.sin(dLam);
  const north = proj.cos0 * sinPhi - proj.sin0 * cosPhi * cosDLam;
  const cosC = proj.sin0 * sinPhi + proj.cos0 * cosPhi * cosDLam;
  const sinC = Math.hypot(east, north);
  if (sinC === 0) {
    // The centre itself, or its exact antipode (any bearing, maximum range).
    return cosC >= 0 ? [0, 0] : [0, -Math.PI * EARTH_RADIUS_M];
  }
  const scale = (EARTH_RADIUS_M * Math.atan2(sinC, cosC)) / sinC;
  return [east * scale, north * scale];
}

/**
 * Inverse projection; returns `[lon, lat]` with the longitude unwrapped to
 * within 180° of the projection centre.
 */
function inverse(proj, x, y) {
  const rho = Math.hypot(x, y);
  if (rho === 0) return [proj.lon0, proj.lat0];
  const c = rho / EARTH_RADIUS_M;
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);
  const sinPhi = cosC * proj.sin0 + (y * sinC * proj.cos0) / rho;
  const phi = Math.asin(Math.max(-1, Math.min(1, sinPhi)));
  const lam =
    proj.lam0 +
    Math.atan2(x * sinC, rho * proj.cos0 * cosC - y * proj.sin0 * sinC);
  return [lam * RAD, phi * RAD];
}

/** Point at `distM` along `bearingRad` from a centre; `[lon, lat]`, unwrapped. */
function destination(lat, lon, bearingRad, distM) {
  const delta = distM / EARTH_RADIUS_M;
  const phi1 = lat * DEG;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinPhi2 =
    sinPhi1 * Math.cos(delta) +
    cosPhi1 * Math.sin(delta) * Math.cos(bearingRad);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lam2 =
    lon * DEG +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(delta) * cosPhi1,
      Math.cos(delta) - sinPhi1 * Math.sin(phi2),
    );
  return [lam2 * RAD, phi2 * RAD];
}

// ---------------------------------------------------------------------------
// Planar helpers on flat projected rings `[x0, y0, x1, y1, …]`.
// ---------------------------------------------------------------------------

function segmentDistanceSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(ax, ay, bx, by, px, py) {
  return (
    Math.min(ax, bx) <= px &&
    px <= Math.max(ax, bx) &&
    Math.min(ay, by) <= py &&
    py <= Math.max(ay, by)
  );
}

function segmentsIntersect(xy, a, b, c, d) {
  const ax = xy[2 * a];
  const ay = xy[2 * a + 1];
  const bx = xy[2 * b];
  const by = xy[2 * b + 1];
  const cx = xy[2 * c];
  const cy = xy[2 * c + 1];
  const dx = xy[2 * d];
  const dy = xy[2 * d + 1];
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  if (d1 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

/** Adjacent edges overlap when they leave their shared vertex the same way. */
function adjacentEdgesOverlap(xy, shared, endA, endB) {
  const ux = xy[2 * endA] - xy[2 * shared];
  const uy = xy[2 * endA + 1] - xy[2 * shared + 1];
  const vx = xy[2 * endB] - xy[2 * shared];
  const vy = xy[2 * endB + 1] - xy[2 * shared + 1];
  const cross = ux * vy - uy * vx;
  const dot = ux * vx + uy * vy;
  return (
    dot > 0 &&
    Math.abs(cross) <= 1e-12 * Math.hypot(ux, uy) * Math.hypot(vx, vy)
  );
}

/** O(n²) simple-polygon test over a closed projected ring of `n` vertices. */
function ringSelfIntersects(xy, n) {
  for (let i = 0; i < n; i += 1) {
    const i2 = (i + 1) % n;
    for (let j = i + 1; j < n; j += 1) {
      const j2 = (j + 1) % n;
      if (j === i + 1) {
        if (adjacentEdgesOverlap(xy, i2, i, j2)) return true;
        continue;
      }
      if (i === 0 && j === n - 1) {
        if (adjacentEdgesOverlap(xy, 0, i2, j)) return true;
        continue;
      }
      if (segmentsIntersect(xy, i, i2, j, j2)) return true;
    }
  }
  return false;
}

/** Sum of absolute fan-triangle areas from vertex 0; ~0 only when collinear. */
function fanAbsAreaM2(xy, n) {
  let sum = 0;
  const x0 = xy[0];
  const y0 = xy[1];
  for (let i = 1; i < n - 1; i += 1) {
    const ax = xy[2 * i] - x0;
    const ay = xy[2 * i + 1] - y0;
    const bx = xy[2 * i + 2] - x0;
    const by = xy[2 * i + 3] - y0;
    sum += Math.abs(ax * by - ay * bx);
  }
  return sum / 2;
}

function planarSignedAreaM2(xy, n) {
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += xy[2 * j] * xy[2 * i + 1] - xy[2 * i] * xy[2 * j + 1];
  }
  return sum / 2;
}

/** (1 − cos(ρ/R)) R² / ρ²: sphere area per planar area of a radial fan. */
function areaKernel(rho) {
  const x = rho / EARTH_RADIUS_M;
  if (x < 1e-4) return 0.5 - (x * x) / 24;
  const s = Math.sin(x / 2);
  return (2 * s * s) / (x * x);
}

/**
 * Signed sphere area of the region bounded by the projected ring, using
 * A = Σ cross(A, B) ∫₀¹ k(|A + t(B − A)|) dt with composite Simpson steps.
 * Counter-clockwise rings are positive.
 */
function sphereSignedAreaM2(xy, n) {
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const ax = xy[2 * i];
    const ay = xy[2 * i + 1];
    const bx = xy[2 * j];
    const by = xy[2 * j + 1];
    const cross = ax * by - ay * bx;
    if (cross === 0) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const steps = Math.min(
      AREA_MAX_STEPS_PER_EDGE,
      Math.max(1, Math.ceil(Math.hypot(dx, dy) / AREA_STEP_M)),
    );
    const intervals = 2 * steps;
    let sum = areaKernel(Math.hypot(ax, ay)) + areaKernel(Math.hypot(bx, by));
    for (let k = 1; k < intervals; k += 1) {
      const t = k / intervals;
      const weight = k % 2 === 1 ? 4 : 2;
      sum += weight * areaKernel(Math.hypot(ax + t * dx, ay + t * dy));
    }
    total += (cross * sum) / (3 * intervals);
  }
  return total;
}

/**
 * Douglas-Peucker over a closed projected ring, in metres. Keeps vertex 0 and
 * the vertex farthest from it, then simplifies both halves. Returns the kept
 * indices in ring order.
 */
function douglasPeuckerClosed(xy, n, tolM) {
  if (n <= 3) return Array.from({ length: n }, (_, i) => i);
  const x0 = xy[0];
  const y0 = xy[1];
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i += 1) {
    const dx = xy[2 * i] - x0;
    const dy = xy[2 * i + 1] - y0;
    const d = dx * dx + dy * dy;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const tol2 = tolM * tolM;
  const stack = [0, far, far, n];
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    if (last - first < 2) continue;
    const b = last % n;
    const ax = xy[2 * first];
    const ay = xy[2 * first + 1];
    const bx = xy[2 * b];
    const by = xy[2 * b + 1];
    let index = -1;
    let maxD = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistanceSq(xy[2 * i], xy[2 * i + 1], ax, ay, bx, by);
      if (d > maxD) {
        maxD = d;
        index = i;
      }
    }
    if (index > first && maxD > tol2) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Polygon model shared by normalizeRing and compileZone.
// ---------------------------------------------------------------------------

/** Projects the chosen vertices about the mean of their unwrapped coordinates. */
function polygonModel(lonsU, lats, indices) {
  const n = indices.length;
  let sumLat = 0;
  let sumLon = 0;
  for (const i of indices) {
    sumLat += lats[i];
    sumLon += lonsU[i];
  }
  const center = { lat: sumLat / n, lon: wrapLon(sumLon / n) };
  const proj = makeProjection(center.lat, center.lon);
  const xy = new Float64Array(2 * n);
  for (let k = 0; k < n; k += 1) {
    const [x, y] = forward(proj, lats[indices[k]], lonsU[indices[k]]);
    xy[2 * k] = x;
    xy[2 * k + 1] = y;
  }
  return { center, proj, xy, n };
}

/** Degenerate, self-intersection and area checks for one vertex selection. */
function checkCandidate(lonsU, lats, indices) {
  if (indices.length < GEOMETRY_LIMITS.minVertices) return fail('degenerate');
  const model = polygonModel(lonsU, lats, indices);
  if (fanAbsAreaM2(model.xy, model.n) < DEGENERATE_AREA_M2) {
    return fail('degenerate');
  }
  if (ringSelfIntersects(model.xy, model.n)) return fail('self-intersecting');
  const signedAreaM2 = sphereSignedAreaM2(model.xy, model.n);
  const areaM2 = Math.abs(signedAreaM2);
  if (areaM2 < GEOMETRY_LIMITS.minAreaM2) return fail('too-small');
  if (areaM2 > GEOMETRY_LIMITS.maxAreaM2) return fail('too-large');
  return { ok: true, model, signedAreaM2, areaM2 };
}

/** Doubling-tolerance simplification down to `maxVertices`. */
function simplifyToLimit(lonsU, lats, n) {
  const all = Array.from({ length: n }, (_, i) => i);
  const model = polygonModel(lonsU, lats, all);
  const scaleM = Math.sqrt(
    Math.abs(planarSignedAreaM2(model.xy, model.n)) / Math.PI,
  );
  if (!(scaleM > 0)) return fail('degenerate');
  let tolM = SIMPLIFY_START_SHARE * scaleM;
  let sawCrossing = false;
  for (let round = 0; round < SIMPLIFY_ROUNDS; round += 1) {
    const kept = douglasPeuckerClosed(model.xy, n, tolM);
    if (kept.length <= GEOMETRY_LIMITS.maxVertices) {
      const check = checkCandidate(lonsU, lats, kept);
      if (check.ok) return { ok: true, indices: kept, check };
      if (check.code !== 'self-intersecting') return check;
      // A coarser pass can remove a crossing that simplification introduced.
      sawCrossing = true;
    }
    tolM *= 2;
  }
  return fail(sawCrossing ? 'self-intersecting' : 'too-many');
}

function unwrapLons(lons) {
  const out = new Array(lons.length);
  out[0] = lons[0];
  for (let i = 1; i < lons.length; i += 1) {
    out[i] = out[i - 1] + wrapDelta(lons[i] - lons[i - 1]);
  }
  return out;
}

function samePoint(lonA, latA, lonB, latB) {
  return (
    Math.abs(latA - latB) <= DUPLICATE_EPS_DEG &&
    Math.abs(wrapDelta(lonA - lonB)) <= DUPLICATE_EPS_DEG
  );
}

/** Full normalisation; also returns the projected model for compileZone. */
function normalizeInternal(pairs) {
  const limits = GEOMETRY_LIMITS;
  if (!Array.isArray(pairs)) return fail('non-finite');
  if (pairs.length > limits.maxInputVertices + 1) return fail('too-many');
  const lons = [];
  const lats = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) return fail('non-finite');
    const lon = pair[0];
    const lat = pair[1];
    if (!isFiniteNumber(lon) || !isFiniteNumber(lat) || Math.abs(lat) > 90) {
      return fail('non-finite');
    }
    const wrapped = wrapLon(lon);
    const last = lons.length - 1;
    if (last >= 0 && samePoint(lons[last], lats[last], wrapped, lat)) continue;
    lons.push(wrapped);
    lats.push(lat);
  }
  while (
    lons.length > 1 &&
    samePoint(lons[0], lats[0], lons[lons.length - 1], lats[lats.length - 1])
  ) {
    lons.pop();
    lats.pop();
  }
  const n = lons.length;
  if (n < limits.minVertices) return fail('too-few');
  if (n > limits.maxInputVertices) return fail('too-many');
  for (const lat of lats) {
    if (Math.abs(lat) > limits.maxAbsLatDeg) return fail('pole');
  }

  const lonsU = unwrapLons(lons);
  // A ring that winds around a pole cannot close without a 360° jump.
  const closing = lonsU[n - 1] + wrapDelta(lons[0] - lons[n - 1]);
  if (Math.abs(closing - lonsU[0]) > WINDING_EPS_DEG) return fail('span');
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
    if (lonsU[i] < minLon) minLon = lonsU[i];
    if (lonsU[i] > maxLon) maxLon = lonsU[i];
  }
  if (
    maxLat - minLat > limits.maxSpanLatDeg ||
    maxLon - minLon > limits.maxSpanLonDeg
  ) {
    return fail('span');
  }

  let indices;
  let check;
  let simplified = false;
  if (n > limits.maxVertices) {
    const result = simplifyToLimit(lonsU, lats, n);
    if (!result.ok) return result;
    indices = result.indices;
    check = result.check;
    simplified = true;
  } else {
    indices = Array.from({ length: n }, (_, i) => i);
    check = checkCandidate(lonsU, lats, indices);
    if (!check.ok) return check;
  }

  let { model } = check;
  if (check.signedAreaM2 < 0) {
    // Reverse to counter-clockwise, keeping the first vertex first.
    indices = [indices[0], ...indices.slice(1).reverse()];
    const xy = new Float64Array(model.xy.length);
    for (let k = 0; k < model.n; k += 1) {
      const from = k === 0 ? 0 : model.n - k;
      xy[2 * k] = model.xy[2 * from];
      xy[2 * k + 1] = model.xy[2 * from + 1];
    }
    model = { ...model, xy };
  }
  const ring = indices.map((i) => [lons[i], lats[i]]);
  ring.push([lons[indices[0]], lats[indices[0]]]);
  return { ok: true, ring, simplified, model, areaM2: check.areaM2 };
}

/**
 * Normalises a drawn or imported polygon ring.
 *
 * Accepts open or closed rings of `[lon, lat]` pairs (extra elements such as
 * altitude are ignored). Drops consecutive duplicates, wraps longitudes to
 * ±180 and unwraps them so each step is at most 180°. Rings with more than
 * `maxVertices` distinct vertices are simplified with a closed-ring
 * Douglas-Peucker in projected metres, starting at 0.5% of the zone scale and
 * doubling (at most 8 rounds) until at most 64 vertices remain. The result is
 * then checked for degeneracy, self-intersection (O(n²)) and area.
 *
 * Codes: 'non-finite' (not an array, a bad pair, a non-finite value or
 * |lat| > 90), 'too-few' (< 3 distinct vertices), 'too-many' (> 20,000
 * distinct vertices, or still > 64 after simplification), 'pole'
 * (|lat| > 85), 'span' (> 40° latitude or > 60° longitude, or the ring winds
 * around a pole), 'degenerate' (collinear, or collapsed by simplification),
 * 'self-intersecting', 'too-small' (< 2 km²) and 'too-large' (> 10⁷ km²).
 *
 * @param {Array<[number, number]>} pairs
 * @returns {{ok: true, ring: Array<[number, number]>, simplified: boolean}
 *   | {ok: false, code: string}} `ring` is closed (first vertex repeated),
 *   counter-clockwise and wrapped to ±180. Normalising a normalised ring
 *   returns the same ring.
 */
export function normalizeRing(pairs) {
  const result = normalizeInternal(pairs);
  if (!result.ok) return result;
  return { ok: true, ring: result.ring, simplified: result.simplified };
}

/**
 * Validates a circle zone's centre and radius.
 *
 * Codes: 'non-finite' (centre missing, non-finite or outside ±90/±180),
 * 'pole' (centre beyond ±85° latitude) and 'bad-radius' (radius not a finite
 * number between 1 km and 1,000 km).
 *
 * @param {{lat: number, lon: number}} center
 * @param {number} radiusM
 * @returns {{ok: true} | {ok: false, code: 'non-finite'|'bad-radius'|'pole'}}
 */
export function validateCircle(center, radiusM) {
  const lat = center?.lat;
  const lon = center?.lon;
  if (!isPoint(lat, lon)) return fail('non-finite');
  if (Math.abs(lat) > GEOMETRY_LIMITS.maxAbsLatDeg) return fail('pole');
  if (
    !isFiniteNumber(radiusM) ||
    radiusM < GEOMETRY_LIMITS.minRadiusM ||
    radiusM > GEOMETRY_LIMITS.maxRadiusM
  ) {
    return fail('bad-radius');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Bounding boxes.
// ---------------------------------------------------------------------------

/**
 * Pads latitude/unwrapped-longitude bounds by `padM` so every point within
 * `padM` (great-circle) of a point inside the bounds is inside the result.
 * Uses sin²(d/2R) ≥ cos φ₁ cos φ₂ sin²(Δλ/2).
 */
function padBounds(south, north, westU, eastU, padM) {
  const dLat = (padM / EARTH_RADIUS_M) * RAD;
  const out = {
    south: Math.max(-90, south - dLat),
    north: Math.min(90, north + dLat),
    westU,
    eastU,
    full: eastU - westU >= 360,
  };
  if (out.full || padM <= 0) return out;
  const edgeLat = Math.max(Math.abs(south), Math.abs(north)) + dLat;
  if (edgeLat >= 90) {
    out.full = true;
    return out;
  }
  const s = Math.sin(padM / (2 * EARTH_RADIUS_M)) / Math.cos(edgeLat * DEG);
  if (s >= 1) {
    out.full = true;
    return out;
  }
  const dLon = 2 * Math.asin(s) * RAD;
  out.westU = westU - dLon;
  out.eastU = eastU + dLon;
  out.full = out.eastU - out.westU >= 360;
  return out;
}

function finishBbox(bounds) {
  if (bounds.full) {
    return Object.freeze({
      south: bounds.south,
      north: bounds.north,
      west: -180,
      east: 180,
      wraps: false,
    });
  }
  const west = wrapLon(bounds.westU);
  const east = wrapLon(bounds.eastU);
  return Object.freeze({
    south: bounds.south,
    north: bounds.north,
    west,
    east,
    wraps: west > east,
  });
}

function circleBbox(center, radiusM) {
  const deltaDeg = (radiusM / EARTH_RADIUS_M) * RAD;
  const south = Math.max(-90, center.lat - deltaDeg);
  const north = Math.min(90, center.lat + deltaDeg);
  // sin δ ≥ cos φ exactly when the cap reaches a pole: every longitude.
  const ratio = Math.sin(radiusM / EARTH_RADIUS_M) / Math.cos(center.lat * DEG);
  const dLon = ratio >= 1 ? 180 : Math.asin(ratio) * RAD;
  return finishBbox(
    padBounds(
      south,
      north,
      center.lon - dLon,
      center.lon + dLon,
      BBOX_SAFETY_M,
    ),
  );
}

/** Bounds from a fine sampling of every straight projected edge. */
function polygonBbox(proj, xy, n) {
  let south = Infinity;
  let north = -Infinity;
  let westU = Infinity;
  let eastU = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const ax = xy[2 * i];
    const ay = xy[2 * i + 1];
    const dx = xy[2 * j] - ax;
    const dy = xy[2 * j + 1] - ay;
    const count = Math.min(
      BBOX_MAX_SAMPLES_PER_EDGE,
      Math.max(1, Math.ceil(Math.hypot(dx, dy) / BBOX_SAMPLE_STEP_M)),
    );
    for (let k = 0; k < count; k += 1) {
      const t = k / count;
      const [lon, lat] = inverse(proj, ax + t * dx, ay + t * dy);
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < westU) westU = lon;
      if (lon > eastU) eastU = lon;
    }
  }
  return finishBbox(padBounds(south, north, westU, eastU, BBOX_SAFETY_M));
}

// ---------------------------------------------------------------------------
// Compiled zones.
// ---------------------------------------------------------------------------

/** Densified projected outline: vertices plus interior edge points. */
function densifyXY(xy, n) {
  const out = [];
  const limits = GEOMETRY_LIMITS;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const ax = xy[2 * i];
    const ay = xy[2 * i + 1];
    const dx = xy[2 * j] - ax;
    const dy = xy[2 * j + 1] - ay;
    const segments = Math.min(
      limits.maxDensifyPerEdge,
      Math.max(1, Math.ceil(Math.hypot(dx, dy) / limits.densifyStepM)),
    );
    out.push(ax, ay);
    for (let k = 1; k < segments; k += 1) {
      out.push(ax + (k / segments) * dx, ay + (k / segments) * dy);
    }
  }
  return out;
}

function computePolygonDerived(center, xy) {
  const proj = makeProjection(center.lat, center.lon);
  const dense = densifyXY(xy, xy.length / 2);
  const count = dense.length / 2;
  const outline = [];
  const samples = new Float64Array(4 * count);
  for (let k = 0; k < count; k += 1) {
    const ax = dense[2 * k];
    const ay = dense[2 * k + 1];
    const next = (k + 1) % count;
    const bx = dense[2 * next];
    const by = dense[2 * next + 1];
    const [lon, lat] = inverse(proj, ax, ay);
    const point = [wrapLon(lon), lat];
    outline.push(point);
    const [midLon, midLat] = inverse(proj, (ax + bx) / 2, (ay + by) / 2);
    samples[4 * k] = point[0];
    samples[4 * k + 1] = lat;
    samples[4 * k + 2] = wrapLon(midLon);
    samples[4 * k + 3] = midLat;
  }
  return { proj, outline, samples };
}

function polygonDerived(compiled) {
  let derived = derivedCache.get(compiled);
  if (!derived) {
    derived = computePolygonDerived(compiled.center, compiled.xy);
    derivedCache.set(compiled, derived);
  }
  return derived;
}

function isCompiled(compiled) {
  if (!compiled || typeof compiled !== 'object') return false;
  const center = compiled.center;
  if (!center || !isPoint(center.lat, center.lon)) return false;
  if (compiled.shape === 'circle') {
    return isFiniteNumber(compiled.radiusM) && compiled.radiusM > 0;
  }
  if (compiled.shape === 'polygon') {
    const xy = compiled.xy;
    return xy instanceof Float64Array && xy.length >= 6 && xy.length % 2 === 0;
  }
  return false;
}

function normalizeSegments(value) {
  if (!isFiniteNumber(value)) return DEFAULT_CIRCLE_SEGMENTS;
  return Math.min(
    MAX_CIRCLE_SEGMENTS,
    Math.max(MIN_CIRCLE_SEGMENTS, Math.round(value)),
  );
}

function circleOutline(center, radiusM, segments) {
  const out = [];
  for (let i = 0; i < segments; i += 1) {
    // Counter-clockwise from due north, matching stored polygon rings.
    const bearing = (-2 * Math.PI * i) / segments;
    const [lon, lat] = destination(center.lat, center.lon, bearing, radiusM);
    out.push([wrapLon(lon), lat]);
  }
  return out;
}

function northernmost(points) {
  let best = points[0];
  for (const point of points) if (point[1] > best[1]) best = point;
  return Object.freeze({ lat: best[1], lon: best[0] });
}

/**
 * Compiles a stored zone for containment tests.
 *
 * Circles need `{shape:'circle', center:{lat, lon}, radiusM}` passing
 * {@link validateCircle}. Polygons need `{shape:'polygon', ring}`; the ring is
 * run through {@link normalizeRing} (a no-op for a stored, normalised ring).
 *
 * @param {{id?: string, shape: 'circle'|'polygon',
 *   center?: {lat: number, lon: number}, radiusM?: number,
 *   ring?: Array<[number, number]>}} zone
 * @returns {CompiledZone|null} null when the zone is not a valid circle or
 *   polygon.
 */
export function compileZone(zone) {
  if (!zone || typeof zone !== 'object') return null;
  const id = typeof zone.id === 'string' ? zone.id : null;
  if (zone.shape === 'circle') {
    if (!validateCircle(zone.center, zone.radiusM).ok) return null;
    const center = Object.freeze({
      lat: zone.center.lat,
      lon: zone.center.lon,
    });
    const radiusM = zone.radiusM;
    const capAreaM2 =
      4 *
      Math.PI *
      EARTH_RADIUS_M ** 2 *
      Math.sin(radiusM / (2 * EARTH_RADIUS_M)) ** 2;
    return Object.freeze({
      id,
      shape: 'circle',
      center,
      radiusM,
      scaleM: radiusM,
      areaM2: capAreaM2,
      bbox: circleBbox(center, radiusM),
      xy: null,
      labelAnchor: northernmost(
        circleOutline(center, radiusM, DEFAULT_CIRCLE_SEGMENTS),
      ),
    });
  }
  if (zone.shape !== 'polygon') return null;
  const normalized = normalizeInternal(zone.ring);
  if (!normalized.ok) return null;
  const { model, areaM2 } = normalized;
  const center = Object.freeze({ ...model.center });
  const derived = computePolygonDerived(center, model.xy);
  const compiled = Object.freeze({
    id,
    shape: 'polygon',
    center,
    radiusM: null,
    scaleM: Math.sqrt(areaM2 / Math.PI),
    areaM2,
    bbox: polygonBbox(model.proj, model.xy, model.n),
    xy: model.xy,
    labelAnchor: northernmost(derived.outline),
  });
  derivedCache.set(compiled, derived);
  return compiled;
}

/**
 * Signed distance from a point to a compiled zone's boundary, in metres.
 * Negative inside, positive outside. Circles use great-circle distance minus
 * the radius; polygons use the nearest straight projected edge, signed by an
 * even-odd point-in-polygon test in the same projection.
 *
 * @param {CompiledZone} compiled
 * @param {number} lat
 * @param {number} lon
 * @returns {number} Infinity for an invalid zone or point.
 */
export function signedDistanceM(compiled, lat, lon) {
  if (!isCompiled(compiled) || !isPoint(lat, lon)) {
    return Number.POSITIVE_INFINITY;
  }
  if (compiled.shape === 'circle') {
    return greatCircleMeters(compiled.center, { lat, lon }) - compiled.radiusM;
  }
  const { proj } = polygonDerived(compiled);
  const [px, py] = forward(proj, lat, lon);
  const xy = compiled.xy;
  const n = xy.length / 2;
  let inside = false;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xy[2 * i];
    const yi = xy[2 * i + 1];
    const xj = xy[2 * j];
    const yj = xy[2 * j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    const d2 = segmentDistanceSq(px, py, xj, yj, xi, yi);
    if (d2 < best) best = d2;
  }
  const distance = Math.sqrt(best);
  return inside && distance > 0 ? -distance : distance;
}

/**
 * Hysteresis margin for a kind: `clamp(share × scaleM, minM, maxM)`, and at
 * most `0.25 × scaleM`.
 *
 * @param {CompiledZone} compiled
 * @param {string} kind 'aircraft' or 'vessel'.
 * @returns {number} metres; 0 for kinds without a rule or an invalid zone.
 */
export function marginM(compiled, kind) {
  const rule =
    typeof kind === 'string' && Object.hasOwn(MARGIN_RULES, kind)
      ? MARGIN_RULES[kind]
      : null;
  const scaleM = compiled?.scaleM;
  if (!rule || !isFiniteNumber(scaleM) || scaleM <= 0) return 0;
  const clamped = Math.min(rule.maxM, Math.max(rule.minM, rule.share * scaleM));
  return Math.min(clamped, MARGIN_SCALE_CAP * scaleM);
}

/**
 * Cheap prefilter: false means the point is definitely farther than `padM`
 * (great-circle) from the zone, so its signed distance exceeds `padM`. True
 * means "maybe"; call {@link signedDistanceM} to decide.
 *
 * @param {CompiledZone} compiled
 * @param {number} lat
 * @param {number} lon
 * @param {number} [padM=0]
 * @returns {boolean} false for an invalid zone or point.
 */
export function bboxMayContain(compiled, lat, lon, padM = 0) {
  const bbox = compiled?.bbox;
  if (!bbox || !isPoint(lat, lon)) return false;
  const { south, north, west, east, wraps } = bbox;
  if (
    !isFiniteNumber(south) ||
    !isFiniteNumber(north) ||
    !isFiniteNumber(west) ||
    !isFiniteNumber(east)
  ) {
    return false;
  }
  const pad = isFiniteNumber(padM) && padM > 0 ? padM : 0;
  const width = wraps ? east + 360 - west : east - west;
  const bounds = padBounds(south, north, west, west + width, pad);
  if (lat < bounds.south || lat > bounds.north) return false;
  if (bounds.full) return true;
  const span = bounds.eastU - bounds.westU;
  const offset = (((lon - bounds.westU) % 360) + 360) % 360;
  return offset <= span;
}

const GLOBAL_COVERAGE = 'global';

function coverageDisc(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  if (coverage.kind === 'global') return GLOBAL_COVERAGE;
  if (coverage.kind !== 'circle') return null;
  const { lat, lon, radiusKm } = coverage;
  if (!isPoint(lat, lon) || !isFiniteNumber(radiusKm) || radiusKm <= 0) {
    return null;
  }
  return { lat, lon, radiusM: radiusKm * 1000 };
}

/**
 * Whether a feed's coverage contains a point.
 *
 * @param {Coverage|null|undefined} coverage
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean|null} null when the coverage is unknown or malformed, or
 *   the point is not a valid coordinate.
 */
export function coverageContainsPoint(coverage, lat, lon) {
  const disc = coverageDisc(coverage);
  if (!disc || !isPoint(lat, lon)) return null;
  if (disc === GLOBAL_COVERAGE) return true;
  return greatCircleMeters(disc, { lat, lon }) <= disc.radiusM;
}

/**
 * How much of a zone a feed's coverage reaches.
 *
 * Global coverage gives 'full'; unknown, null or malformed coverage (or an
 * invalid zone) gives 'unknown'. Against a coverage disc of radius R:
 * - circle zones: 'full' when centre distance + radius ≤ R, 'none' when
 *   centre distance − radius ≥ R;
 * - polygon zones: 'full' when every densified outline point and segment
 *   midpoint is within R (less a 100 m slack), 'none' when the disc centre is
 *   outside the zone and its signed distance is ≥ R;
 * - everything else is 'partial'.
 *
 * @param {Coverage|null|undefined} coverage
 * @param {CompiledZone} compiled
 * @returns {'full'|'partial'|'none'|'unknown'}
 */
export function coverageOfZone(coverage, compiled) {
  const disc = coverageDisc(coverage);
  if (!disc || !isCompiled(compiled)) return 'unknown';
  if (disc === GLOBAL_COVERAGE) return 'full';
  const radiusM = disc.radiusM;
  if (compiled.shape === 'circle') {
    const centreM = greatCircleMeters(disc, compiled.center);
    if (centreM + compiled.radiusM <= radiusM) return 'full';
    if (centreM - compiled.radiusM >= radiusM) return 'none';
    return 'partial';
  }
  const { samples } = polygonDerived(compiled);
  const limit = radiusM - FULL_COVERAGE_SLACK_M;
  let full = limit > 0;
  for (let k = 0; full && k < samples.length; k += 2) {
    const d = greatCircleMeters(disc, { lat: samples[k + 1], lon: samples[k] });
    if (!(d <= limit)) full = false;
  }
  if (full) return 'full';
  const distanceM = signedDistanceM(compiled, disc.lat, disc.lon);
  if (distanceM > 0 && distanceM >= radiusM) return 'none';
  return 'partial';
}

/**
 * Drawable outline of a compiled zone: a closed ring of `[lon, lat]` pairs
 * with longitudes wrapped to ±180. Circles have `circleSegments` points plus
 * the closing point, counter-clockwise from due north. Polygons follow the
 * containment boundary: each straight projected edge longer than 50 km is
 * split into at most 16 segments.
 *
 * @param {CompiledZone} compiled
 * @param {{circleSegments?: number}} [options] circleSegments defaults to 96
 *   and is clamped to 3-1,440.
 * @returns {Array<[number, number]>} empty for an invalid zone.
 */
export function outlineRing(compiled, options = {}) {
  if (!isCompiled(compiled)) return [];
  let points;
  if (compiled.shape === 'circle') {
    points = circleOutline(
      compiled.center,
      compiled.radiusM,
      normalizeSegments(options?.circleSegments ?? DEFAULT_CIRCLE_SEGMENTS),
    );
  } else {
    points = polygonDerived(compiled).outline.map(([lon, lat]) => [lon, lat]);
  }
  points.push([points[0][0], points[0][1]]);
  return points;
}
