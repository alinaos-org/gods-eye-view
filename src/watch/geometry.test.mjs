import test from 'node:test';
import assert from 'node:assert/strict';
import { EARTH_RADIUS_KM, greatCircleMeters } from '../geoDistance.js';
import {
  CIRCLE_ERROR_CODES,
  GEOMETRY_LIMITS,
  MARGIN_RULES,
  RING_ERROR_CODES,
  bboxMayContain,
  compileZone,
  coverageContainsPoint,
  coverageOfZone,
  marginM,
  normalizeRing,
  outlineRing,
  signedDistanceM,
  validateCircle,
} from './geometry.js';

const KM_PER_DEG = (EARTH_RADIUS_KM * Math.PI) / 180;
const COVERAGE_438 = Object.freeze({
  kind: 'circle',
  lat: 40,
  lon: -100,
  radiusKm: 438,
});

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function square(lon, lat, size) {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
  ];
}

function polygon(ring, id = 'z-poly') {
  const compiled = compileZone({ id, shape: 'polygon', ring });
  assert.ok(compiled, 'polygon should compile');
  return compiled;
}

function circle(lat, lon, radiusM, id = 'z-circle') {
  const compiled = compileZone({
    id,
    shape: 'circle',
    center: { lat, lon },
    radiusM,
  });
  assert.ok(compiled, 'circle should compile');
  return compiled;
}

/** Points on a circle of `radiusKm` around a centre, in local degrees. */
function roundRing(count, lat0, lon0, radiusKm, wobble = () => 0) {
  const ring = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count;
    const r = radiusKm * (1 + wobble(i, angle));
    ring.push([
      lon0 +
        (r * Math.cos(angle)) / KM_PER_DEG / Math.cos((lat0 * Math.PI) / 180),
      lat0 + (r * Math.sin(angle)) / KM_PER_DEG,
    ]);
  }
  return ring;
}

function star(points, lat0, lon0, outerKm, innerKm) {
  return roundRing(2 * points, lat0, lon0, outerKm, (i) =>
    i % 2 === 0 ? 0 : innerKm / outerKm - 1,
  );
}

function shoelaceDeg(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function assertClose(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? 'value'}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

test('constants are frozen and match the plan', () => {
  assert.ok(Object.isFrozen(GEOMETRY_LIMITS));
  assert.deepEqual(GEOMETRY_LIMITS, {
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
  assert.ok(Object.isFrozen(MARGIN_RULES));
  assert.ok(Object.isFrozen(MARGIN_RULES.aircraft));
  assert.ok(Object.isFrozen(MARGIN_RULES.vessel));
  assert.deepEqual(MARGIN_RULES, {
    aircraft: { share: 0.02, minM: 300, maxM: 2_000 },
    vessel: { share: 0.02, minM: 150, maxM: 1_000 },
  });
  assert.ok(Object.isFrozen(RING_ERROR_CODES));
  assert.ok(Object.isFrozen(CIRCLE_ERROR_CODES));
  assert.deepEqual(
    [...CIRCLE_ERROR_CODES].sort(),
    ['bad-radius', 'non-finite', 'pole'].sort(),
  );
});

test('normalizeRing accepts open or closed rings and drops duplicates', () => {
  const open = normalizeRing(square(0, 0, 1));
  const closed = normalizeRing([...square(0, 0, 1), [0, 0]]);
  const duplicated = normalizeRing([
    [0, 0],
    [0, 0],
    [1, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 1],
    [0, 0],
    [0, 0],
  ]);
  assert.equal(open.ok, true);
  assert.equal(open.simplified, false);
  assert.deepEqual(open.ring, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);
  assert.deepEqual(closed, open);
  assert.deepEqual(duplicated, open);
});

test('normalizeRing stores rings closed and counter-clockwise', () => {
  const clockwise = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];
  assert.ok(shoelaceDeg([...clockwise, clockwise[0]]) < 0);
  const result = normalizeRing(clockwise);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ring[0], [0, 0], 'first vertex is kept first');
  assert.deepEqual(result.ring.at(-1), result.ring[0]);
  assert.ok(shoelaceDeg(result.ring) > 0, 'counter-clockwise');
  assert.equal(result.ring.length, 5);
});

test('normalizeRing wraps longitudes, ignores altitude and is idempotent', () => {
  const input = Object.freeze([
    Object.freeze([175, 10, 120]),
    Object.freeze([185, 10, 120]),
    Object.freeze([185, 12, 120]),
    Object.freeze([175, 12, 120]),
  ]);
  const first = normalizeRing(input);
  assert.equal(first.ok, true);
  for (const [lon, lat] of first.ring) {
    assert.ok(lon >= -180 && lon <= 180, `wrapped lon ${lon}`);
    assert.ok(lat === 10 || lat === 12);
  }
  assert.deepEqual(first.ring[1], [-175, 10]);
  for (const pair of first.ring) assert.equal(pair.length, 2);
  const second = normalizeRing(first.ring);
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first, 'JSON-safe');
});

test('every normalizeRing code is reachable', () => {
  const tooMany = Array.from(
    { length: GEOMETRY_LIMITS.maxInputVertices + 2 },
    (_, i) => [(i % 1000) / 1000, Math.floor(i / 1000) / 1000],
  );
  const cases = {
    'non-finite': [
      null,
      'ring',
      [
        [0, 0],
        [1, Number.NaN],
        [1, 1],
      ],
      [[0, 0], [1], [1, 1]],
      [
        [0, 0],
        [1, 0],
        [1, 91],
      ],
      [
        [0, 0],
        [Number.POSITIVE_INFINITY, 0],
        [1, 1],
      ],
      [
        [0, 0],
        ['1', 0],
        [1, 1],
      ],
      [[0, 0], { lon: 1, lat: 0 }, [1, 1]],
    ],
    'too-few': [
      [],
      [
        [0, 0],
        [1, 1],
      ],
      [
        [0, 0],
        [1, 1],
        [1, 1],
        [0, 0],
      ],
      [
        [180, 0],
        [-180, 0],
        [0, 1],
      ].slice(0, 2),
    ],
    'too-many': [tooMany, star(40, 10, 10, 100, 10)],
    pole: [
      [
        [0, 84],
        [1, 86],
        [2, 84],
      ],
      [
        [0, -84],
        [1, -85.5],
        [2, -84],
      ],
    ],
    span: [
      square(0, 0, 70).map(([lon, lat]) => [lon, lat / 70]),
      [
        [0, 0],
        [1, 0],
        [1, 45],
        [0, 45],
      ],
      [0, 60, 120, 180, 240, 300].map((lon) => [lon, 80]),
    ],
    'self-intersecting': [
      [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0.5, 0.5],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [0.5, 0.5],
      ],
    ],
    'too-small': [square(0, 0, 0.001), square(30, 40, 0.01)],
    'too-large': [square(-30, -20, 40).map(([lon, lat]) => [lon * 1.5, lat])],
    degenerate: [
      [
        [10, 0],
        [10, 1],
        [10, 2],
      ],
      [
        ...Array.from({ length: 51 }, (_, i) => [10 + i * 0.02, 0]),
        ...Array.from({ length: 50 }, (_, i) => [11 - i * 0.02, 5e-7]),
      ],
    ],
  };
  assert.deepEqual(Object.keys(cases).sort(), [...RING_ERROR_CODES].sort());
  for (const [code, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      assert.deepEqual(normalizeRing(input), { ok: false, code }, code);
    }
  }
});

test('the span and size limits accept rings right at the boundary', () => {
  const wide = normalizeRing([
    [0, 0],
    [60, 0],
    [60, 1],
    [0, 1],
  ]);
  assert.equal(wide.ok, true);
  const tall = normalizeRing([
    [0, 0],
    [1, 0],
    [1, 40],
    [0, 40],
  ]);
  assert.equal(tall.ok, true);
  const atPole = normalizeRing([
    [0, 84],
    [1, 85],
    [2, 84],
  ]);
  assert.equal(atPole.ok, true);
  const ring = roundRing(GEOMETRY_LIMITS.maxInputVertices, 45, 7, 30);
  ring.push(ring[0]);
  assert.equal(ring.length, GEOMETRY_LIMITS.maxInputVertices + 1);
  const result = normalizeRing(ring);
  assert.equal(result.ok, true, 'a closed 20,000-vertex outline is accepted');
  assert.equal(result.simplified, true);
  assert.ok(result.ring.length - 1 <= GEOMETRY_LIMITS.maxVertices);
});

test('a 512-vertex drawn ring simplifies to at most 64 vertices', () => {
  const random = prng(512);
  const drawn = roundRing(
    512,
    51.5,
    -0.12,
    25,
    (i, angle) => 0.15 * Math.sin(3 * angle) + 0.01 * (random() - 0.5),
  );
  // r(θ) = 25 km × (1 + 0.15 sin 3θ): area = π r₀² (1 + 0.15² / 2).
  const expectedAreaM2 = Math.PI * 25_000 ** 2 * (1 + 0.15 ** 2 / 2);
  const result = normalizeRing(drawn);
  assert.equal(result.ok, true);
  assert.equal(result.simplified, true);
  const distinct = result.ring.length - 1;
  assert.ok(distinct <= GEOMETRY_LIMITS.maxVertices, `${distinct} vertices`);
  assert.ok(distinct >= GEOMETRY_LIMITS.minVertices);
  assert.deepEqual(result.ring.at(-1), result.ring[0]);
  for (const vertex of result.ring) {
    assert.ok(
      drawn.some(([lon, lat]) => lon === vertex[0] && lat === vertex[1]),
      'simplification keeps original vertices',
    );
  }
  const simplified = polygon(result.ring);
  assert.ok(
    Math.abs(simplified.areaM2 - expectedAreaM2) / expectedAreaM2 < 0.05,
    `shape is preserved (${simplified.areaM2} m²)`,
  );
  assert.deepEqual(normalizeRing(result.ring), {
    ok: true,
    ring: result.ring,
    simplified: false,
  });
});

test('a bow-tie is rejected', () => {
  assert.deepEqual(
    normalizeRing([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ]),
    { ok: false, code: 'self-intersecting' },
  );
  assert.equal(
    compileZone({
      shape: 'polygon',
      ring: [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
    }),
    null,
  );
});

test('validateCircle covers every code and the radius bounds', () => {
  assert.deepEqual(validateCircle({ lat: 10, lon: 20 }, 5_000), { ok: true });
  assert.deepEqual(validateCircle({ lat: 85, lon: 180 }, 1_000), { ok: true });
  assert.deepEqual(validateCircle({ lat: -85, lon: -180 }, 1_000_000), {
    ok: true,
  });
  for (const center of [
    null,
    undefined,
    7,
    {},
    { lat: Number.NaN, lon: 0 },
    { lat: 0, lon: Number.POSITIVE_INFINITY },
    { lat: 91, lon: 0 },
    { lat: 0, lon: 180.5 },
    { lat: '10', lon: 20 },
  ]) {
    assert.deepEqual(validateCircle(center, 5_000), {
      ok: false,
      code: 'non-finite',
    });
  }
  assert.deepEqual(validateCircle({ lat: 85.01, lon: 0 }, 5_000), {
    ok: false,
    code: 'pole',
  });
  assert.deepEqual(validateCircle({ lat: -89, lon: 0 }, 5_000), {
    ok: false,
    code: 'pole',
  });
  for (const radius of [999, 1_000_001, 0, -5, Number.NaN, '5000', null]) {
    assert.deepEqual(validateCircle({ lat: 0, lon: 0 }, radius), {
      ok: false,
      code: 'bad-radius',
    });
  }
  const seen = new Set(
    [
      validateCircle(null, 5_000),
      validateCircle({ lat: 86, lon: 0 }, 5_000),
      validateCircle({ lat: 0, lon: 0 }, 1),
    ].map((result) => result.code),
  );
  assert.deepEqual([...seen].sort(), [...CIRCLE_ERROR_CODES].sort());
});

test('compileZone builds a frozen circle', () => {
  const compiled = circle(10, 20, 5_000, 'z-abcd');
  assert.ok(Object.isFrozen(compiled));
  assert.ok(Object.isFrozen(compiled.center));
  assert.ok(Object.isFrozen(compiled.bbox));
  assert.ok(Object.isFrozen(compiled.labelAnchor));
  assert.deepEqual(Object.keys(compiled).sort(), [
    'areaM2',
    'bbox',
    'center',
    'id',
    'labelAnchor',
    'radiusM',
    'scaleM',
    'shape',
    'xy',
  ]);
  assert.equal(compiled.id, 'z-abcd');
  assert.equal(compiled.shape, 'circle');
  assert.deepEqual(compiled.center, { lat: 10, lon: 20 });
  assert.equal(compiled.radiusM, 5_000);
  assert.equal(compiled.scaleM, 5_000);
  assert.equal(compiled.xy, null);
  assertClose(compiled.areaM2, Math.PI * 5_000 ** 2, 1e3, 'cap area');
  assertClose(compiled.bbox.south, 10 - 5 / KM_PER_DEG, 0.002, 'south');
  assertClose(compiled.bbox.north, 10 + 5 / KM_PER_DEG, 0.002, 'north');
  assert.equal(compiled.bbox.wraps, false);
  assertClose(compiled.labelAnchor.lat, 10 + 5 / KM_PER_DEG, 1e-9, 'anchor');
  assertClose(compiled.labelAnchor.lon, 20, 1e-9, 'anchor lon');
});

test('compileZone builds a frozen polygon', () => {
  const compiled = polygon(square(0, 0, 1), 'z-square');
  assert.ok(Object.isFrozen(compiled));
  assert.equal(compiled.id, 'z-square');
  assert.equal(compiled.shape, 'polygon');
  assert.equal(compiled.radiusM, null);
  assert.ok(compiled.xy instanceof Float64Array);
  assert.equal(compiled.xy.length, 8);
  assert.deepEqual(compiled.center, { lat: 0.5, lon: 0.5 });
  assertClose(compiled.scaleM, Math.sqrt(compiled.areaM2 / Math.PI), 1e-6);
  let signed = 0;
  for (let i = 0, j = 3; i < 4; j = i++) {
    signed +=
      compiled.xy[2 * j] * compiled.xy[2 * i + 1] -
      compiled.xy[2 * i] * compiled.xy[2 * j + 1];
  }
  assert.ok(signed > 0, 'projected ring is counter-clockwise');
});

test('compileZone rejects anything that is not a valid circle or polygon', () => {
  for (const zone of [
    null,
    undefined,
    'zone',
    {},
    { shape: 'circle', center: { lat: 0, lon: 0 }, radiusM: 10 },
    { shape: 'circle', center: { lat: 88, lon: 0 }, radiusM: 5_000 },
    { shape: 'circle', radiusM: 5_000 },
    { shape: 'polygon', ring: [[0, 0]] },
    { shape: 'polygon' },
    { shape: 'line', ring: square(0, 0, 1) },
  ]) {
    assert.equal(compileZone(zone), null);
  }
  const noId = compileZone({ id: 7, shape: 'polygon', ring: square(0, 0, 1) });
  assert.equal(noId.id, null);
});

test('an antimeridian ring from 170°E to 170°W contains ±179.9 but not 0', () => {
  const compiled = polygon([
    [170, -5],
    [-170, -5],
    [-170, 5],
    [170, 5],
  ]);
  assert.ok(signedDistanceM(compiled, 0, 179.9) < 0);
  assert.ok(signedDistanceM(compiled, 0, -179.9) < 0);
  assert.ok(signedDistanceM(compiled, 0, 180) < 0);
  assert.ok(signedDistanceM(compiled, 0, 0) > 0);
  assert.ok(signedDistanceM(compiled, 0, 160) > 0);
  assert.ok(signedDistanceM(compiled, 0, -160) > 0);
  assert.equal(compiled.bbox.wraps, true);
  assert.ok(compiled.bbox.west > 169 && compiled.bbox.west <= 170);
  assert.ok(compiled.bbox.east < -169 && compiled.bbox.east >= -170);
  assert.equal(bboxMayContain(compiled, 0, 179.9), true);
  assert.equal(bboxMayContain(compiled, 0, -179.9), true);
  assert.equal(bboxMayContain(compiled, 0, 0), false);
  for (const [lon, lat] of outlineRing(compiled)) {
    assert.ok(lon >= -180 && lon <= 180);
    assert.ok(Math.abs(lat) <= 6);
  }
  assertClose(Math.abs(compiled.center.lon), 180, 1e-9, 'centre lon');
});

test('a circle centred near 80°N contains its centre', () => {
  const compiled = circle(80, 10, 50_000);
  assert.equal(signedDistanceM(compiled, 80, 10), -50_000);
  assert.equal(bboxMayContain(compiled, 80, 10), true);
  assert.ok(signedDistanceM(compiled, 80, 12) < 0);
  assert.ok(signedDistanceM(compiled, 80, 14) > 0);
  assert.ok(compiled.bbox.west < 8 && compiled.bbox.east > 12);
});

test('a circle that reaches the pole spans every longitude', () => {
  const compiled = circle(85, 10, 1_000_000);
  assert.ok(signedDistanceM(compiled, 90, 0) < 0);
  assert.ok(signedDistanceM(compiled, 87, -170) < 0);
  assert.deepEqual(
    { west: compiled.bbox.west, east: compiled.bbox.east },
    { west: -180, east: 180 },
  );
  assert.equal(compiled.bbox.north, 90);
  assert.equal(compiled.bbox.wraps, false);
  assert.equal(bboxMayContain(compiled, 88, -170), true);
  assert.ok(compiled.labelAnchor.lat > 85);
});

test('a high-latitude polygon follows its straight projected edges', () => {
  const compiled = polygon([
    [-30, 84],
    [30, 84],
    [30, 85],
    [-30, 85],
  ]);
  // Straight edges in the zone's projection bow towards the pole, and the
  // bbox and outline follow them.
  assert.ok(signedDistanceM(compiled, 85.5, 0) < 0);
  assert.ok(compiled.bbox.north > 85.5);
  assert.ok(compiled.labelAnchor.lat > 85.5);
  for (const [lon, lat] of outlineRing(compiled)) {
    assert.ok(Math.abs(signedDistanceM(compiled, lat, lon)) < 0.01);
  }
});

test('distance is negative at the centre and positive outside', () => {
  const round = circle(30, -97, 20_000);
  assert.equal(signedDistanceM(round, 30, -97), -20_000);
  assertClose(
    signedDistanceM(round, 30 + 40 / KM_PER_DEG, -97),
    20_000,
    1,
    'circle outside',
  );
  const box = polygon(square(0, 0, 1));
  assertClose(signedDistanceM(box, 0.5, 0.5), -KM_PER_DEG * 500, 300, 'centre');
  assertClose(signedDistanceM(box, 0.5, 2), KM_PER_DEG * 1000, 500, 'east');
  assertClose(signedDistanceM(box, -1, 0.5), KM_PER_DEG * 1000, 500, 'south');
  assert.ok(signedDistanceM(box, 0.5, 1.001) > 0);
  assert.ok(signedDistanceM(box, 0.5, 0.999) < 0);
  assert.ok(signedDistanceM(box, -45, -170) > 0, 'far away');
  assert.ok(signedDistanceM(box, -0.5, -179.5) > 0, 'antipode');
  for (const args of [
    [Number.NaN, 0],
    [0, Number.NaN],
    [91, 0],
    [0, 181],
    ['0', 0],
  ]) {
    assert.equal(signedDistanceM(box, ...args), Number.POSITIVE_INFINITY);
    assert.equal(signedDistanceM(round, ...args), Number.POSITIVE_INFINITY);
  }
  assert.equal(signedDistanceM(null, 0, 0), Number.POSITIVE_INFINITY);
  assert.equal(
    signedDistanceM({ shape: 'polygon', center: { lat: 0, lon: 0 } }, 0, 0),
    Number.POSITIVE_INFINITY,
  );
});

test('a 1°×1° equatorial square has an area of about 12,364 km²', () => {
  const compiled = polygon(square(0, 0, 1));
  assertClose(compiled.areaM2 / 1e6, 12_364, 12_364 * 0.005, 'area km²');
  const shifted = polygon(square(-0.5, -0.5, 1));
  assertClose(shifted.areaM2, compiled.areaM2, compiled.areaM2 * 0.001);
});

test('margins clamp to each rule and to a quarter of the scale', () => {
  const big = circle(0, 0, 500_000);
  assert.equal(marginM(big, 'aircraft'), 2_000);
  assert.equal(marginM(big, 'vessel'), 1_000);
  const mid = circle(0, 0, 50_000);
  assert.equal(marginM(mid, 'aircraft'), 1_000);
  assert.equal(marginM(mid, 'vessel'), 1_000);
  const small = circle(0, 0, 5_000);
  assert.equal(marginM(small, 'aircraft'), 300);
  assert.equal(marginM(small, 'vessel'), 150);
  const tiny = circle(0, 0, 1_000);
  assert.equal(marginM(tiny, 'aircraft'), 250, '25% cap on a 1 km circle');
  assert.equal(marginM(tiny, 'vessel'), 150);
  const box = polygon(square(0, 0, 1));
  assertClose(marginM(box, 'aircraft'), 0.02 * box.scaleM, 1e-9);
  for (const kind of ['fire', 'quake', 'toString', '__proto__', null, 7]) {
    assert.equal(marginM(big, kind), 0);
  }
  assert.equal(marginM(null, 'aircraft'), 0);
  assert.equal(marginM({ scaleM: Number.NaN }, 'aircraft'), 0);
});

test('property: a false bboxMayContain implies a positive distance', () => {
  const zones = [
    circle(10, 20, 5_000),
    circle(80, 10, 50_000),
    circle(85, 10, 1_000_000),
    circle(-60, 179.5, 300_000),
    polygon([
      [170, -5],
      [-170, -5],
      [-170, 5],
      [170, 5],
    ]),
    polygon([
      [-30, 84],
      [30, 84],
      [30, 85],
      [-30, 85],
    ]),
    polygon([
      [0, 0],
      [2, 0],
      [2, 2],
      [1, 0.5],
      [0, 2],
    ]),
    polygon(square(-100.5, 39.5, 1)),
  ];
  const random = prng(10_000);
  let rejected = 0;
  let accepted = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const zone = zones[i % zones.length];
    const { south, north, west, east, wraps } = zone.bbox;
    let lat;
    let lon;
    if (i % 4 === 0) {
      lat = random() * 180 - 90;
      lon = random() * 360 - 180;
    } else {
      const width = wraps ? east + 360 - west : east - west;
      lat = Math.max(
        -90,
        Math.min(90, south - 1 + random() * (north - south + 2)),
      );
      lon = west - 2 + random() * (width + 4);
      lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    }
    const pad = i % 3 === 0 ? 4_000 : 0;
    const distance = signedDistanceM(zone, lat, lon);
    if (!bboxMayContain(zone, lat, lon, pad)) {
      rejected += 1;
      assert.ok(
        distance > pad,
        `zone ${i % zones.length} (${lat}, ${lon}) pad ${pad}: ${distance}`,
      );
    } else {
      accepted += 1;
    }
  }
  assert.ok(rejected > 1_000, `rejected ${rejected}`);
  assert.ok(accepted > 1_000, `accepted ${accepted}`);
});

test('bboxMayContain widens with the pad and rejects invalid input', () => {
  const compiled = circle(0, 0, 10_000);
  const justEast = 10 / KM_PER_DEG + 0.02;
  assert.equal(bboxMayContain(compiled, 0, justEast), false);
  assert.equal(bboxMayContain(compiled, 0, justEast, 5_000), true);
  assert.equal(bboxMayContain(compiled, 0, justEast, -5_000), false);
  assert.equal(bboxMayContain(compiled, 0, justEast, Number.NaN), false);
  assert.equal(bboxMayContain(compiled, Number.NaN, 0), false);
  assert.equal(bboxMayContain(compiled, 0, 200), false);
  assert.equal(bboxMayContain(null, 0, 0), false);
  assert.equal(bboxMayContain({}, 0, 0), false);
});

test('coverageContainsPoint answers true, false or null', () => {
  assert.equal(coverageContainsPoint({ kind: 'global' }, 10, 10), true);
  assert.equal(coverageContainsPoint({ kind: 'unknown' }, 10, 10), null);
  assert.equal(coverageContainsPoint(null, 10, 10), null);
  assert.equal(coverageContainsPoint(undefined, 10, 10), null);
  assert.equal(coverageContainsPoint({ kind: 'region' }, 10, 10), null);
  assert.equal(coverageContainsPoint(COVERAGE_438, 40, -100), true);
  assert.equal(
    coverageContainsPoint(COVERAGE_438, 40 + 437 / KM_PER_DEG, -100),
    true,
  );
  assert.equal(
    coverageContainsPoint(COVERAGE_438, 40 + 439 / KM_PER_DEG, -100),
    false,
  );
  const dateline = { kind: 'circle', lat: 0, lon: 179.5, radiusKm: 438 };
  assert.equal(coverageContainsPoint(dateline, 0, -177), true);
  assert.equal(coverageContainsPoint(dateline, 0, -175), false);
  for (const malformed of [
    { kind: 'circle', lat: 0, lon: 0 },
    { kind: 'circle', lat: 0, lon: 0, radiusKm: 0 },
    { kind: 'circle', lat: 0, lon: 0, radiusKm: -1 },
    { kind: 'circle', lat: 95, lon: 0, radiusKm: 438 },
    { kind: 'circle', lat: 0, lon: Number.NaN, radiusKm: 438 },
    { kind: 'circle', lat: '0', lon: 0, radiusKm: 438 },
  ]) {
    assert.equal(coverageContainsPoint(malformed, 0, 0), null);
  }
  assert.equal(coverageContainsPoint({ kind: 'global' }, Number.NaN, 0), null);
  assert.equal(coverageContainsPoint(COVERAGE_438, 40, 190), null);
});

test('coverageOfZone returns full, partial and none against a 438 km disc', () => {
  const north = (km) => 40 + km / KM_PER_DEG;
  assert.equal(coverageOfZone(COVERAGE_438, circle(40, -100, 50_000)), 'full');
  assert.equal(
    coverageOfZone(COVERAGE_438, circle(north(380), -100, 50_000)),
    'full',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, circle(north(400), -100, 100_000)),
    'partial',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, circle(north(600), -100, 100_000)),
    'none',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, circle(north(540), -100, 100_000)),
    'none',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, circle(40, -100, 1_000_000)),
    'partial',
  );

  assert.equal(
    coverageOfZone(COVERAGE_438, polygon(square(-100.5, 39.5, 1))),
    'full',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, polygon(square(-100.5, 43.5, 1))),
    'partial',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, polygon(square(-100.5, 45, 1))),
    'none',
  );
  assert.equal(
    coverageOfZone(COVERAGE_438, polygon(square(-104, 36, 8))),
    'partial',
    'a zone larger than the disc',
  );
});

test('coverageOfZone works across the antimeridian', () => {
  const disc = { kind: 'circle', lat: 0, lon: 179.5, radiusKm: 438 };
  const across = polygon([
    [179, -1],
    [-179, -1],
    [-179, 1],
    [179, 1],
  ]);
  assert.equal(coverageOfZone(disc, across), 'full');
  const straddling = polygon([
    [-177, -1],
    [-175, -1],
    [-175, 1],
    [-177, 1],
  ]);
  assert.equal(coverageOfZone(disc, straddling), 'partial');
  const beyond = polygon([
    [-175.5, -1],
    [-174, -1],
    [-174, 1],
    [-175.5, 1],
  ]);
  assert.equal(coverageOfZone(disc, beyond), 'none');
  assert.equal(coverageOfZone(disc, circle(0, -179.5, 100_000)), 'full');
  assert.equal(coverageOfZone(disc, circle(0, -176, 100_000)), 'partial');
  assert.equal(coverageOfZone(disc, circle(0, -170, 100_000)), 'none');
});

test('coverageOfZone handles global, unknown and malformed input', () => {
  const zone = polygon(square(0, 0, 1));
  assert.equal(coverageOfZone({ kind: 'global' }, zone), 'full');
  assert.equal(coverageOfZone({ kind: 'global' }, circle(0, 0, 5_000)), 'full');
  assert.equal(coverageOfZone({ kind: 'unknown' }, zone), 'unknown');
  assert.equal(coverageOfZone(null, zone), 'unknown');
  assert.equal(coverageOfZone(undefined, zone), 'unknown');
  assert.equal(
    coverageOfZone({ kind: 'circle', lat: 0, lon: 0, radiusKm: 'x' }, zone),
    'unknown',
  );
  assert.equal(coverageOfZone({ kind: 'global' }, null), 'unknown');
  assert.equal(coverageOfZone(COVERAGE_438, {}), 'unknown');
});

test('a circle outline is closed and has 97 positions', () => {
  const compiled = circle(-33.9, 151.2, 25_000);
  const ring = outlineRing(compiled);
  assert.equal(ring.length, 97);
  assert.deepEqual(ring.at(-1), ring[0]);
  assert.notEqual(ring.at(-1), ring[0], 'closing point is a copy');
  for (const [lon, lat] of ring) {
    assert.ok(lon >= -180 && lon <= 180);
    assertClose(
      greatCircleMeters(compiled.center, { lat, lon }),
      25_000,
      0.01,
      'on the circle',
    );
  }
  assert.ok(shoelaceDeg(ring) > 0, 'counter-clockwise');
  assert.equal(outlineRing(compiled, { circleSegments: 8 }).length, 9);
  assert.equal(outlineRing(compiled, { circleSegments: 1 }).length, 4);
  assert.equal(
    outlineRing(compiled, { circleSegments: Number.NaN }).length,
    97,
  );
  assert.equal(outlineRing(compiled, null).length, 97);
  const dateline = outlineRing(circle(0, 179.9, 50_000));
  for (const [lon] of dateline) assert.ok(lon >= -180 && lon <= 180);
  assert.ok(dateline.some(([lon]) => lon < 0));
  assert.ok(dateline.some(([lon]) => lon > 0));
});

test('a polygon outline is the densified containment boundary', () => {
  const compiled = polygon(square(0, 0, 1));
  const ring = outlineRing(compiled);
  // Each 111 km edge is split into 3 segments of at most 50 km.
  assert.equal(ring.length, 4 * 3 + 1);
  assert.deepEqual(ring.at(-1), ring[0]);
  for (const [lon, lat] of ring) {
    assert.ok(Math.abs(signedDistanceM(compiled, lat, lon)) < 0.01);
  }
  const long = polygon([
    [0, 0],
    [40, 0],
    [40, 1],
    [0, 1],
  ]);
  const longRing = outlineRing(long);
  // 4,450 km edges are capped at 16 segments; the 111 km edges get 3.
  assert.equal(longRing.length, 2 * 16 + 2 * 3 + 1);
  for (const [lon, lat] of longRing) {
    assert.ok(Math.abs(signedDistanceM(long, lat, lon)) < 0.05);
  }
  assert.deepEqual(outlineRing(null), []);
  assert.deepEqual(outlineRing({ shape: 'polygon' }), []);
});

test('labelAnchor is the northernmost outline point', () => {
  for (const compiled of [
    circle(10, 20, 5_000),
    circle(85, 10, 1_000_000),
    polygon(square(0, 0, 1)),
    polygon([
      [0, 0],
      [2, 0],
      [2, 2],
      [1, 0.5],
      [0, 2],
    ]),
  ]) {
    const ring = outlineRing(compiled);
    const maxLat = Math.max(...ring.map(([, lat]) => lat));
    assert.equal(compiled.labelAnchor.lat, maxLat);
    assert.ok(
      ring.some(
        ([lon, lat]) =>
          lat === compiled.labelAnchor.lat && lon === compiled.labelAnchor.lon,
      ),
    );
  }
});
