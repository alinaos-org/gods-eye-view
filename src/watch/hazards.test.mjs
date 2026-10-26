// src/watch/hazards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileZone, signedDistanceM } from './geometry.js';
import {
  DEFAULT_ALERT_MAGNITUDE,
  HAZARD_CAVEATS,
  HAZARD_KINDS,
  HAZARD_POLICY,
  HAZARD_TRANSITION,
  createHazardWatch,
} from './hazards.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_760_000_000_000;
const KM_PER_DEG_LAT = 111.195;

const CENTER = Object.freeze({ lat: 10, lon: 20 });

function circleZone(overrides = {}) {
  return {
    id: 'z-test01',
    name: 'Test zone',
    shape: 'circle',
    center: { ...CENTER },
    radiusM: 50_000,
    kinds: ['fire', 'quake'],
    notify: 'all',
    aircraft: { militaryOnly: false },
    fire: { minFrpMw: 0 },
    quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 },
    createdAtMs: T0,
    updatedAtMs: T0,
    ...overrides,
  };
}

function setup(overrides = {}) {
  const zone = circleZone(overrides);
  const compiled = compileZone(zone);
  assert.ok(compiled);
  return { zone, compiled };
}

/** A point `km` north of the zone centre. */
function north(km) {
  return { lat: CENTER.lat + km / KM_PER_DEG_LAT, lon: CENTER.lon };
}

function fixed4(value) {
  return value.toFixed(4);
}

/** A fire asset shaped like frames.js `toAsset('local-firms', row)`. */
function fire({
  km = 0,
  east = 0,
  frpMw = 10,
  acqMs = T0 - HOUR,
  satellite = 'N20',
  extra = {},
} = {}) {
  const lat = CENTER.lat + km / KM_PER_DEG_LAT;
  const lon = CENTER.lon + east;
  return {
    key: `fire:${fixed4(lat)}:${fixed4(lon)}:${acqMs}:${satellite}`,
    kind: 'fire',
    lat,
    lon,
    frpMw,
    confidence: 0.8,
    acqMs,
    satellite,
    ...extra,
  };
}

/** A quake asset shaped like frames.js `toAsset('earthquakes', row)`. */
function quake(
  id,
  {
    km = 0,
    magnitude = 3,
    depthKm = 10,
    timeMs = T0 - HOUR,
    place = null,
  } = {},
) {
  const { lat, lon } = north(km);
  return {
    key: id,
    kind: 'quake',
    id,
    lat,
    lon,
    magnitude,
    depthKm,
    timeMs,
    place,
  };
}

function counted(asOfMs, extra = {}) {
  return { state: 'counted', reason: null, asOfMs, coverage: 'full', ...extra };
}

function floorAnswer(asOfMs, reason = 'partial-snapshot') {
  return { state: 'floor', reason, asOfMs, coverage: 'full' };
}

function held(asOfMs) {
  return { state: 'held', reason: 'feed-stale', asOfMs, coverage: 'full' };
}

/** Runs one update with the shared zone and returns the transitions. */
function step(watch, ctx, kind, assets, answer, nowMs) {
  return watch.update({
    zone: ctx.zone,
    compiled: ctx.compiled,
    kind,
    assets,
    answer,
    nowMs,
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN_KEYS = new Set(['label', 'title', 'status', 'hint']);

function assertJsonSafe(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  const walk = (node) => {
    if (node === undefined) assert.fail('undefined value in output');
    if (typeof node === 'number') assert.ok(Number.isFinite(node), 'NaN');
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        assert.ok(!FORBIDDEN_KEYS.has(key), `forbidden key ${key}`);
        assert.doesNotMatch(key, /owner|registrant|person/i);
        walk(child);
      }
    }
  };
  walk(value);
}

const TRANSITION_KEYS = [
  'assetId',
  'assetKey',
  'assetLabel',
  'atMs',
  'caveats',
  'dataAtMs',
  'kind',
  'layerId',
  'params',
  'position',
  'severity',
  'type',
  'zoneId',
];

// ---------------------------------------------------------------- contract

test('constants match the plan and are frozen', () => {
  assert.deepEqual(HAZARD_POLICY, {
    seenCapPerZone: 5_000,
    seenTtlMs: 93_600_000,
    gapSummaryMs: 1_800_000,
    fireAlertFrpMw: 100,
  });
  assert.equal(HAZARD_POLICY.seenTtlMs, 26 * HOUR);
  assert.equal(HAZARD_POLICY.gapSummaryMs, 30 * MIN);
  assert.deepEqual(HAZARD_KINDS, ['fire', 'quake']);
  assert.deepEqual(HAZARD_TRANSITION, {
    FIRES_NEW: 'fires-new',
    QUAKE_NEW: 'quake-new',
    GAP_SUMMARY: 'hazard-gap-summary',
  });
  assert.deepEqual(HAZARD_CAVEATS, ['lower-bound', 'unobserved-interval']);
  assert.equal(DEFAULT_ALERT_MAGNITUDE, 5);
  for (const value of [
    HAZARD_POLICY,
    HAZARD_KINDS,
    HAZARD_TRANSITION,
    HAZARD_CAVEATS,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('the watch exposes update, view, dropZone, reset and diagnostics', () => {
  const watch = createHazardWatch();
  assert.deepEqual(Object.keys(watch).sort(), [
    'diagnostics',
    'dropZone',
    'reset',
    'update',
    'view',
  ]);
  assert.deepEqual(watch.diagnostics(), {
    tracked: 0,
    seen: 0,
    evicted: 0,
    suppressed: 0,
  });
});

// ---------------------------------------------------------------- baseline

test('the first counted evaluation is a silent baseline', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [
    fire({ km: 1, frpMw: 12, acqMs: T0 - 3 * HOUR }),
    fire({ km: 5, frpMw: 140, acqMs: T0 - 2 * HOUR }),
    fire({ km: 80, frpMw: 500 }),
  ];
  assert.deepEqual(step(watch, ctx, 'fire', fires, counted(T0), T0), []);
  const view = watch.view('z-test01', 'fire');
  assert.deepEqual(view, {
    count: 2,
    floor: false,
    maxFrpMw: 140,
    newestAtMs: T0 - 2 * HOUR,
    asOfMs: T0,
    state: 'counted',
    reason: null,
  });
  assertJsonSafe(view);
  // Only the two fires inside the zone are remembered.
  assert.deepEqual(watch.diagnostics(), {
    tracked: 1,
    seen: 2,
    evicted: 0,
    suppressed: 0,
  });
  // The same fires on the next epoch are not new.
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + 30 * MIN), T0 + 30 * MIN),
    [],
  );
});

test('a floor evaluation can be the baseline too', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const quakes = [quake('us1', { km: 3 })];
  assert.deepEqual(step(watch, ctx, 'quake', quakes, floorAnswer(T0), T0), []);
  const view = watch.view('z-test01', 'quake');
  assert.equal(view.count, 1);
  assert.equal(view.floor, true);
  assert.equal(view.maxMagnitude, 3);
  assert.ok(!('maxFrpMw' in view));
  assert.deepEqual(
    step(watch, ctx, 'quake', quakes, counted(T0 + MIN), T0 + MIN),
    [],
  );
});

test('a non-answering first evaluation is not a baseline', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [fire({ km: 2 })];
  assert.deepEqual(step(watch, ctx, 'fire', fires, held(T0), T0), []);
  // The first answering evaluation, hours later, is still the baseline and
  // never a gap summary.
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + 3 * HOUR), T0 + 3 * HOUR),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 1);
});

test('keyRequired gives unknown, not 0', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const answer = { state: 'unknown', reason: 'key-required', asOfMs: null };
  assert.deepEqual(step(watch, ctx, 'fire', [], answer, T0), []);
  const view = watch.view('z-test01', 'fire');
  assert.equal(view.count, null);
  assert.notEqual(view.count, 0);
  assert.equal(view.state, 'unknown');
  assert.equal(view.reason, 'key-required');
  assert.equal(view.maxFrpMw, null);
  assert.equal(view.newestAtMs, null);
  // When the key arrives, the first counted answer is a silent baseline.
  const fires = [fire({ km: 1 }), fire({ km: 2, frpMw: 300 })];
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + 10 * MIN), T0 + 10 * MIN),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 2);
});

test('held, off and malformed answers never report a count', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [fire({ km: 1 })];
  step(watch, ctx, 'fire', fires, counted(T0), T0);
  for (const answer of [
    held(T0),
    { state: 'off', reason: 'feed-off', asOfMs: null },
    { state: 'unknown', reason: 'feed-loading', asOfMs: null },
    { state: 'bogus' },
    null,
    'held',
  ]) {
    assert.deepEqual(step(watch, ctx, 'fire', fires, answer, T0 + MIN), []);
    const view = watch.view('z-test01', 'fire');
    assert.equal(view.count, null);
    assert.equal(view.floor, false);
    assertJsonSafe(view);
  }
  assert.equal(watch.view('z-test01', 'fire').state, 'held');
  step(watch, ctx, 'fire', fires, { state: 'bogus' }, T0 + MIN);
  assert.equal(watch.view('z-test01', 'fire').state, 'unknown');
  assert.equal(watch.view('z-test01', 'fire').reason, 'cannot-answer');
});

// ---------------------------------------------------------------- fires

test('new fires give one aggregated event per zone per epoch', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [fire({ km: 1, frpMw: 300 })], counted(T0), T0);
  const a = fire({ km: 2, frpMw: 5, acqMs: T0 - 50 * MIN });
  const b = fire({ km: 3, frpMw: 80, acqMs: T0 - 20 * MIN });
  const c = fire({ km: 4, frpMw: 20, acqMs: T0 + 5 * MIN });
  const outside = fire({ km: 70, frpMw: 900, acqMs: T0 });
  const now = T0 + 40 * MIN;
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 300 }), c, outside, a, b],
    counted(T0 + 35 * MIN),
    now,
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.deepEqual(Object.keys(event).sort(), TRANSITION_KEYS);
  assert.equal(event.type, 'fires-new');
  assert.equal(event.severity, 'notice');
  assert.equal(event.zoneId, 'z-test01');
  assert.equal(event.kind, 'fire');
  assert.equal(event.layerId, 'local-firms');
  assert.equal(event.atMs, now);
  assert.equal(event.dataAtMs, T0 + 35 * MIN);
  assert.equal(event.assetKey, b.key);
  assert.equal(event.assetId, null);
  assert.equal(event.assetLabel, null);
  assert.deepEqual(event.position, { lat: b.lat, lon: b.lon });
  assert.deepEqual(event.params, {
    count: 3,
    maxFrpMw: 80,
    firstAcqMs: T0 - 50 * MIN,
    lastAcqMs: T0 + 5 * MIN,
  });
  assert.deepEqual(event.caveats, []);
  assertJsonSafe(events);
  // The view counts every in-zone fire, old and new.
  assert.equal(watch.view('z-test01', 'fire').count, 4);
  assert.equal(watch.view('z-test01', 'fire').maxFrpMw, 300);
  assert.equal(watch.view('z-test01', 'fire').newestAtMs, T0 + 5 * MIN);
});

test('renumbered FIRE ids and reordered rows give no event', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const base = [
    fire({ km: 1, acqMs: T0 - 3 * HOUR, extra: { id: 'FIRE-00001' } }),
    fire({ km: 2, acqMs: T0 - 2 * HOUR, extra: { id: 'FIRE-00002' } }),
    fire({ km: 3, acqMs: T0 - HOUR, extra: { id: 'FIRE-00003' } }),
  ];
  step(watch, ctx, 'fire', base, counted(T0), T0);
  // The next snapshot holds one more fire elsewhere, so every index shifts.
  const renumbered = [
    fire({ km: 300, extra: { id: 'FIRE-00001' } }),
    fire({ km: 3, acqMs: T0 - HOUR, extra: { id: 'FIRE-00002' } }),
    fire({ km: 1, acqMs: T0 - 3 * HOUR, extra: { id: 'FIRE-00003' } }),
    fire({ km: 2, acqMs: T0 - 2 * HOUR, extra: { id: 'FIRE-00004' } }),
  ];
  assert.deepEqual(
    step(watch, ctx, 'fire', renumbered, counted(T0 + 40 * MIN), T0 + 40 * MIN),
    [],
  );
});

test('a same-epoch evaluation never reports, and the next epoch does', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [fire({ km: 1 })], counted(T0), T0);
  const extra = fire({ km: 2, frpMw: 40 });
  // Same asOfMs: one event per FIRMS epoch at most, and none here.
  assert.deepEqual(
    step(watch, ctx, 'fire', [fire({ km: 1 }), extra], counted(T0), T0 + MIN),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 2);
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1 }), extra],
    counted(T0 + 30 * MIN),
    T0 + 31 * MIN,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].params.count, 1);
  // Repeating that epoch reports nothing more.
  assert.deepEqual(
    step(
      watch,
      ctx,
      'fire',
      [fire({ km: 1 }), extra],
      counted(T0 + 30 * MIN),
      T0 + 32 * MIN,
    ),
    [],
  );
});

test('the FRP filter selects new fires and the view count', () => {
  const ctx = setup({ fire: { minFrpMw: 50 } });
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [fire({ km: 1, frpMw: 10 })], counted(T0), T0);
  assert.equal(watch.view('z-test01', 'fire').count, 0);
  assert.equal(watch.view('z-test01', 'fire').maxFrpMw, null);
  const weak = fire({ km: 2, frpMw: 49.9 });
  const edge = fire({ km: 3, frpMw: 50 });
  const unknownFrp = fire({ km: 4, frpMw: null });
  const strong = fire({ km: 5, frpMw: 75 });
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 10 }), weak, edge, unknownFrp, strong],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].params.count, 2);
  assert.equal(events[0].params.maxFrpMw, 75);
  assert.equal(events[0].assetKey, strong.key);
  const view = watch.view('z-test01', 'fire');
  assert.equal(view.count, 2);
  assert.equal(view.maxFrpMw, 75);
  // Fires below the filter were still remembered: they never report later.
  assert.deepEqual(
    step(
      watch,
      ctx,
      'fire',
      [weak, edge, unknownFrp, strong],
      counted(T0 + HOUR),
      T0 + HOUR,
    ),
    [],
  );
});

test('only weak new fires give no event', () => {
  const ctx = setup({ fire: { minFrpMw: 100 } });
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  assert.deepEqual(
    step(
      watch,
      ctx,
      'fire',
      [fire({ km: 1, frpMw: 20 }), fire({ km: 2, frpMw: null })],
      counted(T0 + 30 * MIN),
      T0 + 30 * MIN,
    ),
    [],
  );
});

test('null FRP fires count with no filter, and the strongest known wins', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  const unknown = fire({ km: 1, frpMw: null, acqMs: T0 });
  const known = fire({ km: 2, frpMw: 3, acqMs: T0 - HOUR });
  const [event] = step(
    watch,
    ctx,
    'fire',
    [unknown, known],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(event.params.count, 2);
  assert.equal(event.params.maxFrpMw, 3);
  assert.equal(event.assetKey, known.key);
  // All unknown FRP: the max is null and the latest acquisition leads.
  const [next] = step(
    watch,
    ctx,
    'fire',
    [
      fire({ km: 3, frpMw: null, acqMs: T0 + MIN }),
      fire({ km: 4, frpMw: null, acqMs: T0 + 2 * MIN }),
    ],
    counted(T0 + HOUR),
    T0 + HOUR,
  );
  assert.equal(next.params.maxFrpMw, null);
  assert.equal(next.severity, 'notice');
  assert.equal(next.assetKey, fire({ km: 4, acqMs: T0 + 2 * MIN }).key);
  assertJsonSafe(next);
});

test('the fire alert boundary is fireAlertFrpMw inclusive', () => {
  for (const [frpMw, severity] of [
    [99.99, 'notice'],
    [100, 'alert'],
    [450, 'alert'],
  ]) {
    const ctx = setup();
    const watch = createHazardWatch();
    step(watch, ctx, 'fire', [], counted(T0), T0);
    const [event] = step(
      watch,
      ctx,
      'fire',
      [fire({ km: 1, frpMw: 10 }), fire({ km: 2, frpMw })],
      counted(T0 + 30 * MIN),
      T0 + 30 * MIN,
    );
    assert.equal(event.severity, severity, String(frpMw));
  }
  // The boundary follows the policy.
  const ctx = setup();
  const watch = createHazardWatch({ fireAlertFrpMw: 20 });
  step(watch, ctx, 'fire', [], counted(T0), T0);
  const [event] = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 20 })],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(event.severity, 'alert');
});

test('floor answers report with a lower-bound caveat', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [fire({ km: 1 })], counted(T0), T0);
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1 }), fire({ km: 2 })],
    floorAnswer(T0 + 30 * MIN, 'truncated'),
    T0 + 30 * MIN,
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].caveats, ['lower-bound']);
  const view = watch.view('z-test01', 'fire');
  assert.equal(view.floor, true);
  assert.equal(view.state, 'floor');
  assert.equal(view.reason, 'truncated');
  assert.equal(view.count, 2);
});

test('fires in a polygon zone across the antimeridian', () => {
  const zone = {
    ...circleZone({ id: 'z-dateline' }),
    shape: 'polygon',
    center: undefined,
    radiusM: undefined,
    ring: [
      [170, -5],
      [-170, -5],
      [-170, 5],
      [170, 5],
      [170, -5],
    ],
  };
  const compiled = compileZone(zone);
  assert.ok(compiled);
  const ctx = { zone, compiled };
  const watch = createHazardWatch();
  const at = (lat, lon, acqMs = T0) => ({
    key: `fire:${fixed4(lat)}:${fixed4(lon)}:${acqMs}:N21`,
    kind: 'fire',
    lat,
    lon,
    frpMw: 30,
    confidence: null,
    acqMs,
    satellite: 'N21',
  });
  step(watch, ctx, 'fire', [at(0, 179.9)], counted(T0), T0);
  const events = step(
    watch,
    ctx,
    'fire',
    [at(0, 179.9), at(1, -179.9), at(0, 0)],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].zoneId, 'z-dateline');
  assert.equal(events[0].params.count, 1);
  assert.deepEqual(events[0].position, { lat: 1, lon: -179.9 });
});

// ---------------------------------------------------------------- quakes

test('a new quake gives quake-new with its USGS facts', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [quake('us7000a', { km: 2 })], counted(T0), T0);
  const fresh = quake('us7000b', {
    km: 10,
    magnitude: 4.2,
    depthKm: 33.5,
    timeMs: T0 + 2 * MIN,
    place: '12 km NNE of Somewhere',
  });
  const now = T0 + 5 * MIN;
  const events = step(
    watch,
    ctx,
    'quake',
    [quake('us7000a', { km: 2 }), fresh],
    counted(T0 + 4 * MIN),
    now,
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.deepEqual(Object.keys(event).sort(), TRANSITION_KEYS);
  assert.equal(event.type, 'quake-new');
  assert.equal(event.severity, 'notice');
  assert.equal(event.kind, 'quake');
  assert.equal(event.layerId, 'earthquakes');
  assert.equal(event.assetKey, 'us7000b');
  assert.equal(event.assetId, 'us7000b');
  assert.equal(event.atMs, now);
  assert.equal(event.dataAtMs, T0 + 4 * MIN);
  assert.deepEqual(event.position, { lat: fresh.lat, lon: fresh.lon });
  assert.deepEqual(event.params, {
    magnitude: 4.2,
    depthKm: 33.5,
    timeMs: T0 + 2 * MIN,
    place: '12 km NNE of Somewhere',
    usgsId: 'us7000b',
    reportedAfterBaseline: false,
    outsideByKm: 0,
  });
  assert.deepEqual(event.caveats, []);
  assertJsonSafe(events);
  assert.deepEqual(watch.view('z-test01', 'quake'), {
    count: 2,
    floor: false,
    maxMagnitude: 4.2,
    newestAtMs: T0 + 2 * MIN,
    asOfMs: T0 + 4 * MIN,
    state: 'counted',
    reason: null,
  });
});

test('several new quakes give one event each, oldest first', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  const events = step(
    watch,
    ctx,
    'quake',
    [
      quake('us-c', { km: 3, timeMs: T0 + 3 * MIN }),
      quake('us-a', { km: 1, timeMs: T0 + MIN }),
      quake('us-b', { km: 2, timeMs: T0 + 2 * MIN }),
    ],
    counted(T0 + 4 * MIN),
    T0 + 4 * MIN,
  );
  assert.deepEqual(
    events.map((event) => event.assetKey),
    ['us-a', 'us-b', 'us-c'],
  );
});

test('the quake alert boundary is the zone alertMagnitude', () => {
  const cases = [
    [{ minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 }, 4.9, 'notice'],
    [{ minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 }, 5, 'alert'],
    [{ minMagnitude: 2.5, alertMagnitude: 4, bufferKm: 0 }, 4.1, 'alert'],
    // A missing alert magnitude falls back to 5.
    [{ minMagnitude: 2.5, bufferKm: 0 }, 4.9, 'notice'],
    [{ minMagnitude: 2.5, bufferKm: 0 }, 5.1, 'alert'],
    [{ minMagnitude: 2.5, alertMagnitude: 'x', bufferKm: 0 }, 5, 'alert'],
  ];
  for (const [filters, magnitude, severity] of cases) {
    const ctx = setup({ quake: filters });
    const watch = createHazardWatch();
    step(watch, ctx, 'quake', [], counted(T0), T0);
    const [event] = step(
      watch,
      ctx,
      'quake',
      [quake('us1', { km: 1, magnitude })],
      counted(T0 + MIN),
      T0 + MIN,
    );
    assert.equal(event.severity, severity, JSON.stringify(filters));
  }
});

test('the magnitude filter selects new quakes and the view count', () => {
  const ctx = setup({ quake: { minMagnitude: 4, alertMagnitude: 6 } });
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  const events = step(
    watch,
    ctx,
    'quake',
    [
      quake('small', { km: 1, magnitude: 3.9 }),
      quake('edge', { km: 2, magnitude: 4 }),
      quake('nomag', { km: 3, magnitude: null }),
    ],
    counted(T0 + MIN),
    T0 + MIN,
  );
  assert.deepEqual(
    events.map((event) => event.assetKey),
    ['edge'],
  );
  assert.equal(watch.view('z-test01', 'quake').count, 1);
  assert.equal(watch.view('z-test01', 'quake').maxMagnitude, 4);
});

test('a quake without a magnitude passes when the zone has no filter', () => {
  const ctx = setup({ quake: { bufferKm: 0 } });
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  const [event] = step(
    watch,
    ctx,
    'quake',
    [quake('nomag', { km: 1, magnitude: null, depthKm: null, timeMs: null })],
    counted(T0 + MIN),
    T0 + MIN,
  );
  assert.equal(event.severity, 'notice');
  assert.equal(event.params.magnitude, null);
  assert.equal(event.params.depthKm, null);
  assert.equal(event.params.timeMs, null);
  assert.equal(event.params.reportedAfterBaseline, null);
  assertJsonSafe(event);
});

test('the quake buffer reaches outside the zone and reports the distance', () => {
  const ctx = setup({
    quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 25 },
  });
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  const near = quake('near', { km: 70 });
  const far = quake('far', { km: 80 });
  const distanceKm = signedDistanceM(ctx.compiled, near.lat, near.lon) / 1000;
  assert.ok(distanceKm > 19.5 && distanceKm < 20.5);
  const events = step(
    watch,
    ctx,
    'quake',
    [near, far],
    counted(T0 + MIN),
    T0 + MIN,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].assetKey, 'near');
  assert.equal(events[0].params.outsideByKm, Math.round(distanceKm * 10) / 10);
  assert.equal(watch.view('z-test01', 'quake').count, 1);
});

test('a late-origin quake carries reportedAfterBaseline', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0 + 10_000);
  const events = step(
    watch,
    ctx,
    'quake',
    [
      quake('late', { km: 1, timeMs: T0 - 40 * MIN }),
      quake('prompt', { km: 2, timeMs: T0 + 30_000 }),
    ],
    counted(T0 + MIN),
    T0 + MIN,
  );
  const flags = Object.fromEntries(
    events.map((event) => [event.assetKey, event.params.reportedAfterBaseline]),
  );
  assert.deepEqual(flags, { late: true, prompt: false });
});

test('magnitude revisions are silent', () => {
  const ctx = setup({ quake: { minMagnitude: 4, alertMagnitude: 5 } });
  const watch = createHazardWatch();
  step(
    watch,
    ctx,
    'quake',
    [quake('rev', { km: 1, magnitude: 3.6 })],
    counted(T0),
    T0,
  );
  // Revised across the filter, then across the alert magnitude.
  for (const [i, magnitude] of [4.4, 5.6, 5.2].entries()) {
    assert.deepEqual(
      step(
        watch,
        ctx,
        'quake',
        [quake('rev', { km: 1, magnitude })],
        counted(T0 + (i + 1) * MIN),
        T0 + (i + 1) * MIN,
      ),
      [],
    );
  }
  assert.equal(watch.view('z-test01', 'quake').maxMagnitude, 5.2);
});

// ---------------------------------------------------------------- re-baselines

test('a buffer change re-baselines the quake kind silently', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const outsideQuake = quake('ring', { km: 60 });
  step(watch, ctx, 'quake', [outsideQuake], counted(T0), T0);
  assert.equal(watch.view('z-test01', 'quake').count, 0);
  const widened = setup({
    quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 25 },
  });
  assert.deepEqual(
    step(watch, widened, 'quake', [outsideQuake], counted(T0 + MIN), T0 + MIN),
    [],
  );
  assert.equal(watch.view('z-test01', 'quake').count, 1);
  // After the new baseline, a new quake reports as usual.
  const events = step(
    watch,
    widened,
    'quake',
    [outsideQuake, quake('next', { km: 65 })],
    counted(T0 + 2 * MIN),
    T0 + 2 * MIN,
  );
  assert.deepEqual(
    events.map((event) => event.assetKey),
    ['next'],
  );
});

test('a filter change re-baselines even inside the same epoch', () => {
  const ctx = setup({ fire: { minFrpMw: 50 } });
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  const lowered = setup({ fire: { minFrpMw: 0 } });
  const fires = [fire({ km: 1, frpMw: 5 }), fire({ km: 2, frpMw: 500 })];
  assert.deepEqual(
    step(watch, lowered, 'fire', fires, counted(T0), T0 + MIN),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 2);
  assert.deepEqual(
    step(watch, lowered, 'fire', fires, counted(T0 + HOUR), T0 + HOUR),
    [],
  );
});

test('a geometry change re-baselines silently', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const ringFire = fire({ km: 70, frpMw: 200 });
  step(watch, ctx, 'fire', [ringFire], counted(T0), T0);
  assert.equal(watch.view('z-test01', 'fire').count, 0);
  const grown = setup({ radiusM: 100_000 });
  assert.deepEqual(
    step(watch, grown, 'fire', [ringFire], counted(T0 + HOUR), T0 + HOUR),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 1);
});

test('recompiling the same zone, or changing alertMagnitude, keeps state', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [quake('old', { km: 1 })], counted(T0), T0);
  const same = setup({
    quake: { minMagnitude: 2.5, alertMagnitude: 3, bufferKm: 0 },
  });
  assert.notEqual(same.compiled, ctx.compiled);
  const events = step(
    watch,
    same,
    'quake',
    [quake('old', { km: 1 }), quake('new', { km: 2, magnitude: 3.5 })],
    counted(T0 + MIN),
    T0 + MIN,
  );
  assert.deepEqual(
    events.map((event) => [event.assetKey, event.severity]),
    [['new', 'alert']],
  );
});

test('dropZone and reset forget state so the next evaluation is a baseline', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [fire({ km: 1 })];
  step(watch, ctx, 'fire', [], counted(T0), T0);
  step(watch, ctx, 'quake', [], counted(T0), T0);
  assert.equal(watch.dropZone('z-test01'), true);
  assert.equal(watch.dropZone('z-test01'), false);
  assert.equal(watch.dropZone(null), false);
  assert.equal(watch.diagnostics().tracked, 0);
  assert.equal(watch.view('z-test01', 'fire').reason, 'never-answered');
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + HOUR), T0 + HOUR),
    [],
  );
  watch.reset();
  assert.deepEqual(watch.diagnostics(), {
    tracked: 0,
    seen: 0,
    evicted: 0,
    suppressed: 0,
  });
  const more = [...fires, fire({ km: 2 })];
  assert.deepEqual(
    step(watch, ctx, 'fire', more, counted(T0 + 2 * HOUR), T0 + 2 * HOUR),
    [],
  );
  assert.equal(watch.view('z-test01', 'fire').count, 2);
});

test('zones and kinds are tracked separately', () => {
  const a = setup();
  const b = setup({ id: 'z-test02', radiusM: 30_000 });
  const watch = createHazardWatch();
  step(watch, a, 'fire', [], counted(T0), T0);
  step(watch, b, 'fire', [], counted(T0), T0);
  step(watch, a, 'quake', [], counted(T0), T0);
  const shared = fire({ km: 10, frpMw: 60 });
  const onlyA = fire({ km: 40, frpMw: 70 });
  const eventsA = step(
    watch,
    a,
    'fire',
    [shared, onlyA],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  const eventsB = step(
    watch,
    b,
    'fire',
    [shared, onlyA],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(eventsA[0].zoneId, 'z-test01');
  assert.equal(eventsA[0].params.count, 2);
  assert.equal(eventsB[0].zoneId, 'z-test02');
  assert.equal(eventsB[0].params.count, 1);
  // Assets of the other kind are ignored.
  assert.deepEqual(
    step(watch, a, 'quake', [shared], counted(T0 + MIN), T0 + MIN),
    [],
  );
  assert.equal(watch.view('z-test01', 'quake').count, 0);
  assert.equal(watch.diagnostics().tracked, 3);
  watch.dropZone('z-test01');
  assert.equal(watch.diagnostics().tracked, 1);
});

// ---------------------------------------------------------------- expiry

test('keys present for 24 h, then forgotten after 26 h, emit nothing', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [fire({ km: 1, acqMs: T0 }), fire({ km: 2, acqMs: T0 })];
  let now = T0;
  step(watch, ctx, 'fire', fires, counted(now), now);
  // Every 40 minutes for 24 hours the same detections are served.
  for (; now <= T0 + 24 * HOUR; now += 40 * MIN) {
    assert.deepEqual(step(watch, ctx, 'fire', fires, counted(now), now), []);
  }
  const lastSeen = now - 40 * MIN;
  assert.equal(watch.diagnostics().seen, 2);
  // They leave the 24 h window; the empty feed reports nothing.
  for (; now <= lastSeen + 26 * HOUR; now += 2 * HOUR) {
    assert.deepEqual(step(watch, ctx, 'fire', [], counted(now), now), []);
  }
  assert.equal(watch.diagnostics().seen, 2);
  now = lastSeen + 26 * HOUR + MIN;
  assert.deepEqual(step(watch, ctx, 'fire', [], counted(now), now), []);
  assert.equal(watch.diagnostics().seen, 0);
});

test('a key still in the feed past 26 h is never announced again', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const quakes = [quake('long', { km: 1 })];
  let now = T0;
  step(watch, ctx, 'quake', quakes, counted(now), now);
  for (; now <= T0 + 30 * HOUR; now += HOUR) {
    assert.deepEqual(step(watch, ctx, 'quake', quakes, counted(now), now), []);
  }
  assert.equal(watch.diagnostics().seen, 1);
});

test('a key absent for longer than the TTL counts as new when it returns', () => {
  const ctx = setup();
  const watch = createHazardWatch({ seenTtlMs: 2 * HOUR });
  const quakes = [quake('back', { km: 1 })];
  step(watch, ctx, 'quake', quakes, counted(T0), T0);
  step(watch, ctx, 'quake', [], counted(T0 + HOUR), T0 + HOUR);
  step(watch, ctx, 'quake', [], counted(T0 + 3 * HOUR), T0 + 3 * HOUR);
  assert.equal(watch.diagnostics().seen, 0);
  const events = step(
    watch,
    ctx,
    'quake',
    quakes,
    counted(T0 + 3 * HOUR + MIN),
    T0 + 3 * HOUR + MIN,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['quake-new'],
  );
});

// ---------------------------------------------------------------- gaps

test('a gap over 30 minutes gives one summary instead of events', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [quake('us0', { km: 1 })], counted(T0), T0);
  assert.deepEqual(step(watch, ctx, 'quake', [], held(T0), T0 + 2 * MIN), []);
  assert.deepEqual(step(watch, ctx, 'quake', [], held(T0), T0 + 20 * MIN), []);
  const recovered = T0 + 2 * MIN + 31 * MIN;
  const events = step(
    watch,
    ctx,
    'quake',
    [
      quake('us0', { km: 1 }),
      quake('us1', { km: 2, magnitude: 3.1 }),
      quake('us2', { km: 3, magnitude: 4.5 }),
      quake('us3', { km: 4, magnitude: 2.7 }),
    ],
    counted(recovered),
    recovered,
  );
  assert.equal(events.length, 1);
  const [summary] = events;
  assert.deepEqual(Object.keys(summary).sort(), TRANSITION_KEYS);
  assert.equal(summary.type, 'hazard-gap-summary');
  assert.equal(summary.severity, 'info');
  assert.equal(summary.zoneId, 'z-test01');
  assert.equal(summary.kind, 'quake');
  assert.equal(summary.layerId, 'earthquakes');
  assert.equal(summary.assetKey, null);
  assert.equal(summary.position, null);
  assert.deepEqual(summary.params, {
    hazard: 'quake',
    count: 3,
    gapMs: 31 * MIN,
  });
  assert.deepEqual(summary.caveats, []);
  assertJsonSafe(events);
  // The gap is spent: the next new quake reports normally.
  const next = step(
    watch,
    ctx,
    'quake',
    [quake('us4', { km: 5 })],
    counted(recovered + MIN),
    recovered + MIN,
  );
  assert.deepEqual(
    next.map((event) => event.type),
    ['quake-new'],
  );
});

test('a gap of 30 minutes or less still reports each quake', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  step(watch, ctx, 'quake', [], held(T0), T0 + MIN);
  const events = step(
    watch,
    ctx,
    'quake',
    [quake('us1', { km: 1 }), quake('us2', { km: 2 })],
    counted(T0 + 31 * MIN),
    T0 + 31 * MIN,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['quake-new', 'quake-new'],
  );
});

test('a long gap between answering epochs alone is not a gap', () => {
  // FIRMS epochs are the proxy's fetch times, normally 30-40 min apart.
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1 })],
    counted(T0 + 45 * MIN),
    T0 + 45 * MIN,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['fires-new'],
  );
});

test('alert-level items are never folded into a gap summary', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'quake', [], counted(T0), T0);
  step(watch, ctx, 'quake', [], held(T0), T0 + MIN);
  const now = T0 + 2 * HOUR;
  const events = step(
    watch,
    ctx,
    'quake',
    [
      quake('big', { km: 1, magnitude: 6.1, timeMs: T0 + HOUR }),
      quake('small1', { km: 2, magnitude: 3 }),
      quake('small2', { km: 3, magnitude: 3.5 }),
    ],
    counted(now),
    now,
  );
  assert.deepEqual(
    events.map((event) => [event.type, event.severity]),
    [
      ['quake-new', 'alert'],
      ['hazard-gap-summary', 'info'],
    ],
  );
  assert.equal(events[0].assetKey, 'big');
  assert.deepEqual(events[0].caveats, ['unobserved-interval']);
  assert.equal(events[1].params.count, 2);
  assert.equal(events[1].params.gapMs, now - (T0 + MIN));
});

test('only alert-level items after a gap give no summary', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  step(watch, ctx, 'fire', [], held(T0), T0 + MIN);
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 150 }), fire({ km: 2, frpMw: 300 })],
    counted(T0 + HOUR),
    T0 + HOUR,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'fires-new');
  assert.equal(events[0].severity, 'alert');
  assert.equal(events[0].params.count, 2);
  assert.deepEqual(events[0].caveats, ['unobserved-interval']);
});

test('a fire gap splits strong fires from the summary', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  step(watch, ctx, 'fire', [], { state: 'off', reason: 'feed-off' }, T0 + MIN);
  step(watch, ctx, 'fire', [], held(T0), T0 + 10 * MIN);
  const strong = fire({ km: 1, frpMw: 120 });
  const events = step(
    watch,
    ctx,
    'fire',
    [
      strong,
      fire({ km: 2, frpMw: 10 }),
      fire({ km: 3, frpMw: 20 }),
      fire({ km: 4, frpMw: 30 }),
    ],
    floorAnswer(T0 + HOUR),
    T0 + HOUR,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['fires-new', 'hazard-gap-summary'],
  );
  assert.equal(events[0].params.count, 1);
  assert.equal(events[0].assetKey, strong.key);
  assert.deepEqual(events[0].caveats, ['lower-bound', 'unobserved-interval']);
  assert.deepEqual(events[1].params, {
    hazard: 'fire',
    count: 3,
    gapMs: HOUR - MIN,
  });
  assert.deepEqual(events[1].caveats, ['lower-bound']);
});

test('a gap with nothing new reports nothing', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const quakes = [quake('us0', { km: 1 })];
  step(watch, ctx, 'quake', quakes, counted(T0), T0);
  step(watch, ctx, 'quake', quakes, held(T0), T0 + MIN);
  assert.deepEqual(
    step(watch, ctx, 'quake', quakes, counted(T0 + HOUR), T0 + HOUR),
    [],
  );
  // The gap is spent even though nothing was reported.
  const events = step(
    watch,
    ctx,
    'quake',
    [...quakes, quake('us1', { km: 2 })],
    counted(T0 + HOUR + MIN),
    T0 + HOUR + MIN,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['quake-new'],
  );
});

test('a gap stays pending through a same-epoch recovery', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  step(watch, ctx, 'fire', [], counted(T0), T0);
  step(watch, ctx, 'fire', [], held(T0), T0 + MIN);
  // Back to counted with the same data: nothing new can be reported yet.
  assert.deepEqual(
    step(watch, ctx, 'fire', [], counted(T0), T0 + 40 * MIN),
    [],
  );
  const events = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 5 })],
    counted(T0 + 50 * MIN),
    T0 + 50 * MIN,
  );
  assert.deepEqual(
    events.map((event) => [event.type, event.params.gapMs]),
    [['hazard-gap-summary', 39 * MIN]],
  );
});

test('gapSummaryMs follows the policy', () => {
  const ctx = setup();
  const watch = createHazardWatch({ gapSummaryMs: 5 * MIN });
  step(watch, ctx, 'quake', [], counted(T0), T0);
  step(watch, ctx, 'quake', [], held(T0), T0 + MIN);
  const events = step(
    watch,
    ctx,
    'quake',
    [quake('us1', { km: 1 })],
    counted(T0 + 7 * MIN),
    T0 + 7 * MIN,
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['hazard-gap-summary'],
  );
});

// ---------------------------------------------------------------- cap

test('the cap is first-in, first-out, and evicted keys stay quiet', () => {
  const ctx = setup();
  const watch = createHazardWatch({ seenCapPerZone: 5 });
  const fires = Array.from({ length: 8 }, (_, i) =>
    fire({ km: 1 + i, acqMs: T0 - (10 - i) * HOUR }),
  );
  // Fed newest first; the oldest acquisitions are evicted first.
  step(watch, ctx, 'fire', [...fires].reverse(), counted(T0), T0);
  assert.deepEqual(watch.diagnostics(), {
    tracked: 1,
    seen: 5,
    evicted: 3,
    suppressed: 0,
  });
  // The three evicted fires are still served: they are not announced.
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + 30 * MIN), T0 + 30 * MIN),
    [],
  );
  assert.equal(watch.diagnostics().suppressed, 3);
  assert.equal(watch.view('z-test01', 'fire').count, 8);
  // A genuinely new, later detection still reports and evicts the oldest.
  const fresh = fire({ km: 20, acqMs: T0 });
  const events = step(
    watch,
    ctx,
    'fire',
    [...fires, fresh],
    counted(T0 + HOUR),
    T0 + HOUR,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].params.count, 1);
  assert.equal(events[0].assetKey, fresh.key);
  assert.deepEqual(watch.diagnostics(), {
    tracked: 1,
    seen: 5,
    evicted: 4,
    suppressed: 6,
  });
  // The fourth fire was evicted while still served; it stays quiet too.
  assert.deepEqual(
    step(
      watch,
      ctx,
      'fire',
      [...fires, fresh],
      counted(T0 + 2 * HOUR),
      T0 + 2 * HOUR,
    ),
    [],
  );
});

test('the default cap holds 5,000 keys per zone', () => {
  const ctx = setup({ radiusM: 500_000 });
  const watch = createHazardWatch();
  const fires = [];
  for (let i = 0; i < 5_003; i += 1) {
    fires.push({
      key: `fire:k${i}`,
      kind: 'fire',
      lat: CENTER.lat + ((i % 71) - 35) * 0.05,
      lon: CENTER.lon + (Math.floor(i / 71) - 35) * 0.05,
      frpMw: 5,
      confidence: null,
      acqMs: T0 - 5_003 + i,
      satellite: 'N20',
    });
  }
  step(watch, ctx, 'fire', fires, counted(T0), T0);
  assert.equal(watch.view('z-test01', 'fire').count, 5_003);
  assert.equal(watch.diagnostics().seen, 5_000);
  assert.equal(watch.diagnostics().evicted, 3);
  assert.deepEqual(
    step(watch, ctx, 'fire', fires, counted(T0 + HOUR), T0 + HOUR),
    [],
  );
});

test('the eviction watermark lapses after the TTL', () => {
  const ctx = setup();
  const watch = createHazardWatch({ seenCapPerZone: 1, seenTtlMs: 2 * HOUR });
  const old = quake('old', { km: 1, timeMs: T0 - 2 * HOUR });
  const mid = quake('mid', { km: 2, timeMs: T0 - HOUR });
  step(watch, ctx, 'quake', [old, mid], counted(T0), T0);
  assert.equal(watch.diagnostics().evicted, 1);
  // Both leave the feed and the watermark lapses.
  step(watch, ctx, 'quake', [], counted(T0 + HOUR), T0 + HOUR);
  step(watch, ctx, 'quake', [], counted(T0 + 4 * HOUR), T0 + 4 * HOUR);
  assert.equal(watch.diagnostics().seen, 0);
  const late = quake('late', { km: 3, timeMs: T0 - 3 * HOUR });
  const events = step(
    watch,
    ctx,
    'quake',
    [late],
    counted(T0 + 4 * HOUR + MIN),
    T0 + 4 * HOUR + MIN,
  );
  assert.deepEqual(
    events.map((event) => event.assetKey),
    ['late'],
  );
});

// ---------------------------------------------------------------- robustness

test('bad input returns no transitions and never throws', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  const fires = [fire({ km: 1 })];
  const cases = [
    undefined,
    null,
    'fire',
    { ...ctx, kind: 'aircraft', assets: fires, answer: counted(T0), nowMs: T0 },
    { ...ctx, kind: 'fire', assets: fires, answer: counted(T0), nowMs: NaN },
    { ...ctx, kind: 'fire', assets: fires, answer: counted(T0) },
    {
      zone: ctx.zone,
      compiled: null,
      kind: 'fire',
      assets: fires,
      answer: counted(T0),
      nowMs: T0,
    },
    {
      zone: null,
      compiled: { ...ctx.compiled, id: null },
      kind: 'fire',
      assets: fires,
      answer: counted(T0),
      nowMs: T0,
    },
  ];
  for (const input of cases) {
    assert.deepEqual(watch.update(input), []);
  }
  assert.equal(watch.diagnostics().tracked, 0);
  // Malformed assets are skipped.
  const assets = [
    null,
    'x',
    { kind: 'fire', lat: 10, lon: 20 },
    { key: 'bad-lat', kind: 'fire', lat: NaN, lon: 20 },
    { key: 'too-far', kind: 'fire', lat: 95, lon: 20 },
    fire({ km: 1 }),
    fire({ km: 1, frpMw: 999 }),
  ];
  step(watch, ctx, 'fire', assets, counted(T0), T0);
  assert.equal(watch.view('z-test01', 'fire').count, 1);
  assert.equal(watch.view('z-test01', 'fire').maxFrpMw, 10);
  step(watch, ctx, 'fire', 'not-an-array', counted(T0 + HOUR), T0 + HOUR);
  assert.equal(watch.view('z-test01', 'fire').count, 0);
});

test('the zone id falls back to the compiled id', () => {
  const ctx = setup();
  const watch = createHazardWatch();
  watch.update({
    compiled: ctx.compiled,
    kind: 'fire',
    assets: [],
    answer: counted(T0),
    nowMs: T0,
  });
  const [event] = watch.update({
    compiled: ctx.compiled,
    kind: 'fire',
    assets: [fire({ km: 1 })],
    answer: counted(T0 + HOUR),
    nowMs: T0 + HOUR,
  });
  assert.equal(event.zoneId, 'z-test01');
});

test('views are copies and cover unknown zones and kinds', () => {
  const watch = createHazardWatch();
  assert.equal(watch.view('z-test01', 'aircraft'), null);
  assert.deepEqual(watch.view('z-none', 'fire'), {
    count: null,
    floor: false,
    maxFrpMw: null,
    newestAtMs: null,
    asOfMs: null,
    state: 'unknown',
    reason: 'never-answered',
  });
  assert.deepEqual(watch.view('z-none', 'quake'), {
    count: null,
    floor: false,
    maxMagnitude: null,
    newestAtMs: null,
    asOfMs: null,
    state: 'unknown',
    reason: 'never-answered',
  });
  const ctx = setup();
  step(watch, ctx, 'fire', [fire({ km: 1 })], counted(T0), T0);
  const view = watch.view('z-test01', 'fire');
  view.count = 99;
  assert.equal(watch.view('z-test01', 'fire').count, 1);
});

test('invalid policy values keep the defaults', () => {
  const ctx = setup();
  const watch = createHazardWatch({
    seenCapPerZone: 0,
    seenTtlMs: -1,
    gapSummaryMs: 'x',
    fireAlertFrpMw: NaN,
  });
  step(watch, ctx, 'fire', [], counted(T0), T0);
  step(watch, ctx, 'fire', [], held(T0), T0 + MIN);
  // 29 minutes is not a gap under the default 30.
  const [event] = step(
    watch,
    ctx,
    'fire',
    [fire({ km: 1, frpMw: 100 })],
    counted(T0 + 30 * MIN),
    T0 + 30 * MIN,
  );
  assert.equal(event.type, 'fires-new');
  assert.equal(event.severity, 'alert');
});

test('outputs are deterministic for the same inputs', () => {
  const run = () => {
    const ctx = setup();
    const watch = createHazardWatch();
    const out = [];
    out.push(step(watch, ctx, 'fire', [fire({ km: 1 })], counted(T0), T0));
    out.push(
      step(
        watch,
        ctx,
        'fire',
        [fire({ km: 1 }), fire({ km: 2, frpMw: 70 }), fire({ km: 3 })],
        counted(T0 + HOUR),
        T0 + HOUR,
      ),
    );
    out.push(watch.view('z-test01', 'fire'));
    return out;
  };
  assert.deepEqual(run(), run());
  assertJsonSafe(run());
});

// ---------------------------------------------------------------- portability

test('hazards.js stays portable and identifier-only', () => {
  const source = readFileSync(new URL('./hazards.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports, ['./geometry.js']);
  const code = stripComments(source);
  assert.doesNotMatch(code, /\bimport\s*\(/);
  assert.doesNotMatch(code, /\brequire\s*\(/);
  for (const pattern of [
    /\bDate\.now\b/,
    /\bnew Date\b/,
    /\bMath\.random\b/,
    /\b(?:localStorage|sessionStorage|indexedDB)\b/,
    /\bglobalThis\b/,
    /\b(?:window|document|navigator)\s*(?:\.|\?\.|\[)/,
    /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/,
    /cesium/i,
    /i18n|\bmsg\(/,
    /frames\.js/,
    /\b(?:label|title|status|hint)\s*:\s*['"`]/,
    /owner|registrant|person/i,
  ]) {
    assert.ok(!pattern.test(code), String(pattern));
  }
});
