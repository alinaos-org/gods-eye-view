import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFeedState, layerSnapshot } from '../data/layerSnapshot.js';
import { compileZone } from './geometry.js';
import {
  ANSWER,
  ANSWER_REASONS,
  GLOBAL_COVERAGE_LAYERS,
  HEALTHY_TRANSPORT_STATUSES,
  KIND_LAYERS,
  RECORD_CAP,
  TRANSPORT_REASON_PREFIX,
  VESSEL_FUTURE_FIX_MS,
  WATCH_SOURCES,
  assetInZone,
  assetKey,
  buildFrame,
  classifyFeed,
  isAnswering,
  isFreshFix,
  normalizeCoverage,
  refineAnswer,
  toAsset,
  zoneAnswer,
} from './frames.js';

const T = Date.UTC(2026, 9, 26, 12, 0, 0);
const ZONE_LAT = 40;
const ZONE_LON = -100;
/** About 438 km of latitude in degrees (one degree ≈ 111.2 km). */
const DEG_438_KM = 438 / 111.195;

const ZONE = Object.freeze({
  id: 'z-test',
  shape: 'circle',
  center: { lat: ZONE_LAT, lon: ZONE_LON },
  radiusM: 50_000,
  aircraft: { militaryOnly: false },
  fire: { minFrpMw: 0 },
  quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 },
});
const COMPILED = compileZone(ZONE);

const COVER_FULL = Object.freeze({
  kind: 'circle',
  lat: ZONE_LAT,
  lon: ZONE_LON,
  radiusKm: 438,
});
const COVER_PARTIAL = Object.freeze({
  kind: 'circle',
  lat: ZONE_LAT + DEG_438_KM,
  lon: ZONE_LON,
  radiusKm: 438,
});
const COVER_NONE = Object.freeze({
  kind: 'circle',
  lat: 10,
  lon: 20,
  radiusKm: 438,
});

function aircraftRow(icao24, overrides = {}) {
  return {
    id: overrides.callsign ?? icao24.toUpperCase(),
    icao24,
    callsign: null,
    lat: ZONE_LAT,
    lon: ZONE_LON,
    altitudeM: 3000,
    speedMps: 120,
    heading: 90,
    verticalRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    originCountry: 'Nowhere',
    operator: 'Example Air',
    squawk: '1200',
    emergency: false,
    emergencyKind: null,
    emergencySource: null,
    emergencyBroadcast: null,
    lastContactAtMs: T - 5_000,
    receivedAtMs: T,
    routeOrigin: null,
    routeDestination: null,
    ...overrides,
  };
}

function vesselRow(mmsi, overrides = {}) {
  return {
    id: `SHIP ${mmsi}`,
    mmsi,
    name: `SHIP ${mmsi}`,
    lat: ZONE_LAT,
    lon: ZONE_LON,
    speedKts: 12,
    courseDeg: 180,
    shipType: '70',
    destination: 'SOMEWHERE',
    navStatus: null,
    positionAtMs: T - 30_000,
    ...overrides,
  };
}

function fireRow(index, overrides = {}) {
  return {
    id: `FIRE-${String(index).padStart(5, '0')}`,
    lat: ZONE_LAT,
    lon: ZONE_LON,
    frp: 25,
    confidence: 0.8,
    satellite: 'N20',
    sensor: 'VIIRS',
    acqTime: T - 3_600_000,
    ...overrides,
  };
}

function quakeRow(id, overrides = {}) {
  return {
    id,
    magnitude: 4.2,
    depthKm: 10,
    lat: ZONE_LAT,
    lon: ZONE_LON,
    timeMs: T - 600_000,
    place: '10 km N of Somewhere',
    ...overrides,
  };
}

function freshStats(overrides = {}) {
  return { count: 3, lastUpdate: T, ...overrides };
}

/** A frame as the controller would build it from a `getAll()` row. */
function frameFor(
  layerId,
  { enabled = true, stats, rows = [], coverage } = {},
) {
  const row = { id: layerId, enabled, stats: stats ?? freshStats() };
  return buildFrame({
    layerId,
    nowMs: T + 1_000,
    snapshot: layerSnapshot(row, { now: T + 1_000 }),
    stats: row.stats,
    coverage,
    readRows: () => rows,
    previousEpochMs: null,
  });
}

function assertJsonSafe(value) {
  const walk = (node, path) => {
    assert.notEqual(node, undefined, `undefined at ${path}`);
    if (typeof node === 'number') {
      assert.ok(Number.isFinite(node), `non-finite number at ${path}`);
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(value, '$');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

test('constants are frozen and match the plan contract', () => {
  for (const value of [
    WATCH_SOURCES,
    KIND_LAYERS,
    ANSWER,
    ANSWER_REASONS,
    GLOBAL_COVERAGE_LAYERS,
    HEALTHY_TRANSPORT_STATUSES,
    ...Object.values(WATCH_SOURCES),
    ...Object.values(KIND_LAYERS),
  ]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(WATCH_SOURCES).map(([id, source]) => [id, source.kind]),
    ),
    {
      flights: 'aircraft',
      military: 'aircraft',
      'ais-live-vessels': 'vessel',
      'local-firms': 'fire',
      earthquakes: 'quake',
    },
  );
  assert.deepEqual(
    { ...KIND_LAYERS },
    {
      aircraft: ['flights', 'military'],
      vessel: ['ais-live-vessels'],
      fire: ['local-firms'],
      quake: ['earthquakes'],
    },
  );
  assert.deepEqual(
    { ...ANSWER },
    {
      COUNTED: 'counted',
      FLOOR: 'floor',
      HELD: 'held',
      UNKNOWN: 'unknown',
      OFF: 'off',
    },
  );
  assert.equal(RECORD_CAP, 250_000);
  assert.equal(VESSEL_FUTURE_FIX_MS, 120_000);
  assert.equal(TRANSPORT_REASON_PREFIX, 'transport-');
  for (const [kind, layers] of Object.entries(KIND_LAYERS)) {
    for (const layerId of layers) {
      assert.equal(WATCH_SOURCES[layerId].kind, kind);
    }
  }
});

test('isAnswering accepts counted and floor states or answers only', () => {
  assert.equal(isAnswering('counted'), true);
  assert.equal(isAnswering({ state: 'floor' }), true);
  for (const state of ['held', 'unknown', 'off', null, undefined, {}]) {
    assert.equal(isAnswering(state), false);
  }
});

// The feed states src/data/feedState.js can return for an enabled layer
// (including 'partial', which LAYER_FEED_STATES omits), plus 'off'.
const FEED_STATES = [
  'nominal',
  'loading',
  'degraded',
  'stale',
  'partial',
  'fallback',
  'unavailable',
  'off',
];
const STATS_VARIANTS = {
  fresh: freshStats(),
  never: { count: 0, lastUpdate: null },
  stale: freshStats({ stale: true }),
  error: freshStats({ error: 'Source snapshot 12 min old' }),
  lastError: freshStats({ lastError: new Error('boom') }),
  managerError: freshStats({ managerRefreshError: 'refresh failed' }),
  partial: freshStats({ partial: true }),
};
const COUNTED = ['counted', null];
const NEVER = ['unknown', 'never-answered'];
const HELD_STALE = ['held', 'feed-stale'];
const HELD_DEGRADED = ['held', 'feed-degraded'];
const MATRIX = {
  nominal: {
    fresh: COUNTED,
    never: NEVER,
    stale: HELD_STALE,
    error: HELD_DEGRADED,
    lastError: HELD_DEGRADED,
    managerError: HELD_DEGRADED,
    partial: COUNTED,
  },
  loading: {
    fresh: COUNTED,
    never: ['unknown', 'feed-loading'],
    stale: HELD_STALE,
    error: HELD_DEGRADED,
    lastError: HELD_DEGRADED,
    managerError: HELD_DEGRADED,
    partial: COUNTED,
  },
  degraded: {
    fresh: HELD_DEGRADED,
    never: HELD_DEGRADED,
    stale: HELD_STALE,
    error: HELD_DEGRADED,
    lastError: HELD_DEGRADED,
    managerError: HELD_DEGRADED,
    partial: HELD_DEGRADED,
  },
  stale: {
    fresh: HELD_STALE,
    never: HELD_STALE,
    stale: HELD_STALE,
    error: HELD_STALE,
    lastError: HELD_STALE,
    managerError: HELD_STALE,
    partial: HELD_STALE,
  },
  partial: {
    fresh: COUNTED,
    never: NEVER,
    stale: HELD_STALE,
    error: HELD_DEGRADED,
    lastError: HELD_DEGRADED,
    managerError: HELD_DEGRADED,
    partial: COUNTED,
  },
  fallback: {
    fresh: COUNTED,
    never: NEVER,
    stale: HELD_STALE,
    error: HELD_DEGRADED,
    lastError: HELD_DEGRADED,
    managerError: HELD_DEGRADED,
    partial: COUNTED,
  },
  unavailable: Object.fromEntries(
    Object.keys(STATS_VARIANTS).map((name) => [
      name,
      ['unknown', 'feed-unavailable'],
    ]),
  ),
  off: Object.fromEntries(
    Object.keys(STATS_VARIANTS).map((name) => [name, ['off', 'feed-off']]),
  ),
};

test('classifyFeed: the full feedState × stats matrix', () => {
  for (const feedState of FEED_STATES) {
    for (const [variant, stats] of Object.entries(STATS_VARIANTS)) {
      for (const kind of ['aircraft', 'vessel', 'fire', 'quake']) {
        const result = classifyFeed({
          enabled: feedState !== 'off',
          feedState,
          stats,
          kind,
        });
        const [state, reason] = MATRIX[feedState][variant];
        assert.deepEqual(
          [result.state, result.reason],
          [state, reason],
          `${feedState} × ${variant} (${kind})`,
        );
        const expectedAsOf =
          state === 'off' ||
          reason === 'feed-loading' ||
          reason === 'never-answered'
            ? null
            : stats.lastUpdate;
        assert.equal(result.asOfMs, expectedAsOf, `${feedState} × ${variant}`);
        assertJsonSafe(result);
      }
    }
  }
});

test('classifyFeed: a disabled layer is off whatever its stats say', () => {
  for (const enabled of [false, undefined, null, 0]) {
    assert.deepEqual(
      classifyFeed({ enabled, feedState: 'nominal', stats: freshStats() }),
      { state: 'off', reason: 'feed-off', asOfMs: null },
    );
  }
  assert.deepEqual(
    classifyFeed({ enabled: true, feedState: 'off', stats: freshStats() }),
    { state: 'off', reason: 'feed-off', asOfMs: null },
  );
  assert.deepEqual(classifyFeed(), {
    state: 'off',
    reason: 'feed-off',
    asOfMs: null,
  });
});

test('classifyFeed: a stale regional fallback reads FALLBACK but is held', () => {
  const stats = {
    coverage: '250nm regional fallback',
    stale: true,
    count: 120,
    lastUpdate: T,
  };
  assert.equal(layerFeedState(stats), 'fallback');
  const snapshot = layerSnapshot({ id: 'flights', enabled: true, stats });
  assert.equal(snapshot.feedState, 'fallback');
  assert.deepEqual(
    classifyFeed({
      enabled: true,
      feedState: snapshot.feedState,
      stats,
      kind: 'aircraft',
    }),
    { state: 'held', reason: 'feed-stale', asOfMs: T },
  );
  // An erroring fallback (backoff keeps _lastError set) is held too.
  const failing = { ...stats, stale: false, error: 'HTTP 503' };
  assert.equal(layerFeedState(failing), 'fallback');
  assert.equal(
    classifyFeed({
      enabled: true,
      feedState: 'fallback',
      stats: failing,
      kind: 'aircraft',
    }).state,
    'held',
  );
  // A fresh fallback is counted, with the reason added once rows are read.
  const fresh = { ...stats, stale: false };
  const counted = classifyFeed({
    enabled: true,
    feedState: layerFeedState(fresh),
    stats: fresh,
    kind: 'aircraft',
  });
  assert.deepEqual(counted, { state: 'counted', reason: null, asOfMs: T });
  assert.deepEqual(
    refineAnswer(counted, {
      rowCount: 120,
      statsCount: 120,
      feedState: 'fallback',
    }),
    { state: 'counted', reason: 'regional-fallback', asOfMs: T },
  );
});

test('classifyFeed: real layer stats shapes', () => {
  const classify = (stats, kind) =>
    classifyFeed({
      enabled: true,
      feedState: layerFeedState(stats),
      stats,
      kind,
    });
  // FIRMS without a key: feedState reads UNAVAILABLE, the reason says why.
  const keyless = {
    count: 0,
    lastUpdate: null,
    keyRequired: true,
    error: 'KEY REQUIRED',
    loading: false,
    stale: false,
  };
  assert.equal(layerFeedState(keyless), 'unavailable');
  assert.deepEqual(classify(keyless, 'fire'), {
    state: 'unknown',
    reason: 'key-required',
    asOfMs: null,
  });
  // keyRequired is a fire-feed rule; elsewhere the unavailable rule decides.
  assert.equal(classify(keyless, 'quake').reason, 'feed-unavailable');
  // Loading with prior data (a FIRMS refetch) is still classified.
  const refetching = freshStats({ loading: true, stale: false });
  assert.equal(layerFeedState(refetching), 'loading');
  assert.equal(classify(refetching, 'fire').state, 'counted');
  assert.deepEqual(classify({ ...refetching, stale: true }, 'fire'), {
    state: 'held',
    reason: 'feed-stale',
    asOfMs: T,
  });
  // Loading with no data yet (the vessel first connect).
  assert.deepEqual(
    classify({ count: 0, lastUpdate: null, loading: true }, 'vessel'),
    { state: 'unknown', reason: 'feed-loading', asOfMs: null },
  );
  // The lifecycle reports an unavailable source through status.
  assert.equal(
    classify(
      { ...freshStats(), status: 'unavailable', sourceUnavailable: true },
      'aircraft',
    ).reason,
    'feed-unavailable',
  );
  // A stats status without a feedState still reads unavailable.
  assert.equal(
    classifyFeed({
      enabled: true,
      stats: { ...freshStats(), status: 'Offline' },
      kind: 'quake',
    }).reason,
    'feed-unavailable',
  );
  // Explicit unavailable flags with prior data are degraded, so held.
  for (const flag of [{ unavailable: true }, { available: false }]) {
    const stats = freshStats(flag);
    assert.equal(layerFeedState(stats), 'degraded');
    assert.deepEqual(classify(stats, 'quake'), {
      state: 'held',
      reason: 'feed-degraded',
      asOfMs: T,
    });
  }
  // Military reports fallback:false explicitly, so adsb.lol is not FALLBACK.
  const military = freshStats({ source: 'adsb.lol', fallback: false });
  assert.equal(layerFeedState(military), 'nominal');
  assert.equal(classify(military, 'aircraft').state, 'counted');
  // Flights statuses are numeric HTTP codes and never match a status rule.
  assert.equal(
    classify(freshStats({ status: 200 }), 'aircraft').state,
    'counted',
  );
});

test('classifyFeed: vessel transport status', () => {
  const vessel = (overrides) =>
    classifyFeed({
      enabled: true,
      feedState: 'nominal',
      stats: freshStats(overrides),
      kind: 'vessel',
    });
  assert.deepEqual(vessel({ transportStatus: 'reconnecting', error: null }), {
    state: 'held',
    reason: 'transport-reconnecting',
    asOfMs: T,
  });
  // The real layer also sets an error for a degraded transport: still held.
  assert.deepEqual(
    vessel({ transportStatus: 'reconnecting', error: 'reconnecting…' }),
    { state: 'held', reason: 'feed-degraded', asOfMs: T },
  );
  assert.equal(
    vessel({ transportStatus: 'closed' }).reason,
    'transport-closed',
  );
  assert.equal(
    vessel({ transportStatus: ' Auth Failed! ' }).reason,
    'transport-auth-failed',
  );
  assert.equal(vessel({ transportStatus: '!!!' }).reason, 'transport-unknown');
  assert.ok(
    vessel({ transportStatus: 'x'.repeat(100) }).reason.length <=
      TRANSPORT_REASON_PREFIX.length + 32,
  );
  for (const transportStatus of ['live', 'open', 'LIVE', null, '', 7]) {
    assert.equal(vessel({ transportStatus }).state, 'counted');
  }
  // Transport is a vessel-feed rule only.
  assert.equal(
    classifyFeed({
      enabled: true,
      feedState: 'nominal',
      stats: freshStats({ transportStatus: 'down' }),
      kind: 'aircraft',
    }).state,
    'counted',
  );
});

test('classifyFeed: asOfMs accepts numbers and Dates only', () => {
  const at = (lastUpdate) =>
    classifyFeed({
      enabled: true,
      feedState: 'nominal',
      stats: { count: 1, lastUpdate },
    });
  assert.equal(at(new Date(T)).asOfMs, T);
  for (const bad of [0, -5, Number.NaN, Infinity, '2026-10-26', true, {}]) {
    assert.deepEqual(at(bad), {
      state: 'unknown',
      reason: 'never-answered',
      asOfMs: null,
    });
  }
  // Malformed stats are treated as empty.
  for (const stats of [null, undefined, 'x', [1, 2]]) {
    assert.equal(
      classifyFeed({ enabled: true, feedState: 'nominal', stats }).reason,
      'never-answered',
    );
  }
});

test('refineAnswer: no rows, truncation, partial snapshots and fallback', () => {
  const counted = Object.freeze({ state: 'counted', reason: null, asOfMs: T });
  assert.deepEqual(refineAnswer(counted, { rowCount: 0, statsCount: 4 }), {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: T,
  });
  assert.deepEqual(refineAnswer(counted, { rowCount: 0, statsCount: 0 }), {
    state: 'counted',
    reason: null,
    asOfMs: T,
  });
  assert.deepEqual(
    refineAnswer(counted, { rowCount: 9, statsCount: 9, truncated: true }),
    { state: 'floor', reason: 'truncated', asOfMs: T },
  );
  assert.deepEqual(
    refineAnswer(counted, { rowCount: 9, statsCount: 9, feedState: 'partial' }),
    { state: 'floor', reason: 'partial-snapshot', asOfMs: T },
  );
  assert.deepEqual(
    refineAnswer(counted, { rowCount: 9, statsCount: 9, partial: true }),
    { state: 'floor', reason: 'partial-snapshot', asOfMs: T },
  );
  // First match wins: no rows beats truncation, truncation beats partial.
  assert.equal(
    refineAnswer(counted, {
      rowCount: 0,
      statsCount: 9,
      truncated: true,
      partial: true,
    }).reason,
    'cannot-answer',
  );
  assert.equal(
    refineAnswer(counted, {
      rowCount: 9,
      statsCount: 9,
      truncated: true,
      partial: true,
      feedState: 'fallback',
    }).reason,
    'truncated',
  );
  // Fallback only names a plain counted answer.
  const floor = { state: 'floor', reason: 'truncated', asOfMs: T };
  assert.deepEqual(
    refineAnswer(floor, { rowCount: 3, statsCount: 3, feedState: 'fallback' }),
    floor,
  );
  // Non-answering answers pass through; malformed ones cannot answer.
  for (const state of ['held', 'unknown', 'off']) {
    const answer = { state, reason: 'feed-stale', asOfMs: T };
    assert.deepEqual(
      refineAnswer(answer, { rowCount: 0, statsCount: 9, truncated: true }),
      answer,
    );
  }
  assert.deepEqual(refineAnswer(null, {}), {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: null,
  });
  assert.deepEqual(refineAnswer({ state: 'live' }), {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: null,
  });
  // Missing facts: no rows and no stats count is a counted zero.
  assert.deepEqual(refineAnswer(counted), counted);
  assert.notEqual(refineAnswer(counted), counted);
});

test('normalizeCoverage: global layers, valid discs and malformed input', () => {
  for (const layerId of ['military', 'local-firms', 'earthquakes']) {
    for (const raw of [undefined, null, COVER_NONE, { kind: 'unknown' }]) {
      assert.deepEqual(normalizeCoverage(layerId, raw), { kind: 'global' });
    }
  }
  assert.deepEqual(normalizeCoverage('flights', { kind: 'global' }), {
    kind: 'global',
  });
  const disc = normalizeCoverage('flights', { ...COVER_FULL, extra: 1 });
  assert.deepEqual(disc, { ...COVER_FULL });
  assert.notEqual(disc, COVER_FULL);
  for (const raw of [
    undefined,
    null,
    'global',
    { kind: 'unknown' },
    { kind: 'square' },
    { kind: 'circle', lat: 95, lon: 0, radiusKm: 10 },
    { kind: 'circle', lat: 0, lon: 181, radiusKm: 10 },
    { kind: 'circle', lat: Number.NaN, lon: 0, radiusKm: 10 },
    { kind: 'circle', lat: '1', lon: 0, radiusKm: 10 },
    { kind: 'circle', lat: 1, lon: 1, radiusKm: 0 },
    { kind: 'circle', lat: 1, lon: 1, radiusKm: -5 },
    { kind: 'circle', lat: 1, lon: 1 },
  ]) {
    assert.deepEqual(normalizeCoverage('ais-live-vessels', raw), {
      kind: 'unknown',
    });
  }
});

test('assetKey: per-kind identity', () => {
  assert.equal(assetKey('aircraft', ' A1B2C3 '), 'a1b2c3');
  assert.equal(assetKey('aircraft', '~ABC123'), '~abc123');
  assert.equal(assetKey('vessel', '366123456'), '366123456');
  assert.equal(assetKey('vessel', 366123456), '366123456');
  assert.equal(assetKey('quake', 'us7000abcd'), 'us7000abcd');
  assert.equal(assetKey('quake', 'QUAKE-0007'), null);
  assert.equal(assetKey('quake', 'quake-12'), null);
  for (const bad of [null, undefined, '', '   ', 'a b', 'x'.repeat(33), {}]) {
    assert.equal(assetKey('aircraft', bad), null);
    assert.equal(assetKey('vessel', bad), null);
    assert.equal(assetKey('quake', bad), null);
  }
  assert.equal(assetKey('satellite', '25544'), null);
  assert.equal(assetKey(undefined, 'a1b2c3'), null);
});

test('assetKey: fire keys are content keys that survive renumbering', () => {
  const first = fireRow(1, { lat: 12.345678, lon: -98.76543 });
  const renumbered = { ...first, id: 'FIRE-00042' };
  const key = assetKey('fire', first);
  assert.equal(key, `fire:12.3457:-98.7654:${T - 3_600_000}:N20`);
  assert.equal(assetKey('fire', renumbered), key);
  // The asset shape (acqMs) keys the same as the row shape (acqTime).
  assert.equal(assetKey('fire', toAsset('local-firms', renumbered)), key);
  assert.equal(
    assetKey('fire', { lat: 1, lon: 2, acqTime: null, satellite: ' n 21 ' }),
    'fire:1.0000:2.0000:0:N-21',
  );
  assert.equal(
    assetKey('fire', { lat: -0.00001, lon: 2, satellite: null }),
    'fire:0.0000:2.0000:0:',
  );
  assert.equal(
    assetKey('fire', { lat: 1, lon: 2, acqTime: 5, satellite: 'a:b' }),
    'fire:1.0000:2.0000:5:A-B',
  );
  assert.notEqual(
    assetKey('fire', fireRow(1, { satellite: 'N21' })),
    assetKey('fire', fireRow(1)),
  );
  for (const bad of [null, 'FIRE-00001', { lat: 1 }, { lat: 'x', lon: 1 }]) {
    assert.equal(assetKey('fire', bad), null);
  }
});

test('toAsset: aircraft shape carries asset identifiers only', () => {
  const asset = toAsset(
    'flights',
    aircraftRow('A1B2C3', {
      callsign: 'UAL123',
      squawk: '7700',
      emergency: true,
      emergencyKind: 'general',
      emergencySource: 'squawk',
    }),
  );
  assert.deepEqual(asset, {
    key: 'a1b2c3',
    kind: 'aircraft',
    id: 'a1b2c3',
    label: 'UAL123',
    callsign: 'UAL123',
    lat: ZONE_LAT,
    lon: ZONE_LON,
    altM: 3000,
    speedMps: 120,
    headingDeg: 90,
    vRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    typeCode: null,
    squawk: '7700',
    emergency: true,
    emergencyKind: 'general',
    emergencySource: 'squawk',
    fixAtMs: T,
    contactAtMs: T - 5_000,
    layerId: 'flights',
  });
  for (const field of ['operator', 'originCountry', 'registration', 'owner']) {
    assert.equal(Object.hasOwn(asset, field), false, field);
  }
  assertJsonSafe(asset);
  // Missing analyst fields become null, never NaN or undefined.
  const sparse = toAsset('flights', {
    icao24: 'abcdef',
    lat: 1,
    lon: 2,
    altitudeM: Number.NaN,
    onGround: 'yes',
  });
  assert.equal(sparse.altM, null);
  assert.equal(sparse.onGround, null);
  assert.equal(sparse.fixAtMs, null);
  assert.equal(sparse.label, null);
  assert.equal(sparse.emergency, false);
  assertJsonSafe(sparse);
  // Every military-layer record is military.
  assert.equal(
    toAsset('military', aircraftRow('ae1234', { military: false })).military,
    true,
  );
  assert.equal(toAsset('flights', aircraftRow('ae1234')).military, false);
  assert.equal(
    toAsset('flights', aircraftRow('ae1234', { military: true })).military,
    true,
  );
});

test('toAsset: vessel, fire and quake shapes', () => {
  const vessel = toAsset('ais-live-vessels', vesselRow('366123456'), {
    epochMs: T,
  });
  assert.deepEqual(vessel, {
    key: '366123456',
    kind: 'vessel',
    id: '366123456',
    label: 'SHIP 366123456',
    lat: ZONE_LAT,
    lon: ZONE_LON,
    speedKts: 12,
    courseDeg: 180,
    shipType: '70',
    fixAtMs: T - 30_000,
    layerId: 'ais-live-vessels',
  });
  assert.equal(Object.hasOwn(vessel, 'destination'), false);
  const fire = toAsset('local-firms', fireRow(3));
  assert.deepEqual(fire, {
    key: `fire:40.0000:-100.0000:${T - 3_600_000}:N20`,
    kind: 'fire',
    lat: ZONE_LAT,
    lon: ZONE_LON,
    frpMw: 25,
    confidence: 0.8,
    acqMs: T - 3_600_000,
    satellite: 'N20',
  });
  const quake = toAsset('earthquakes', quakeRow('us7000abcd'));
  assert.deepEqual(quake, {
    key: 'us7000abcd',
    kind: 'quake',
    id: 'us7000abcd',
    lat: ZONE_LAT,
    lon: ZONE_LON,
    magnitude: 4.2,
    depthKm: 10,
    timeMs: T - 600_000,
    place: '10 km N of Somewhere',
  });
  assert.equal(toAsset('earthquakes', quakeRow('QUAKE-0003')), null);
  for (const asset of [vessel, fire, quake]) assertJsonSafe(asset);
});

test('toAsset: rejects (0,0), bad positions, future vessel fixes and unknown layers', () => {
  const positions = [
    [0, 0],
    [91, 0],
    [-90.5, 10],
    [10, 180.5],
    [10, -181],
    [Number.NaN, 1],
    [1, Infinity],
    ['10', 10],
    [null, 10],
    [undefined, undefined],
  ];
  for (const [lat, lon] of positions) {
    assert.equal(toAsset('flights', aircraftRow('a1b2c3', { lat, lon })), null);
    assert.equal(
      toAsset('ais-live-vessels', vesselRow('366123456', { lat, lon })),
      null,
    );
    assert.equal(toAsset('local-firms', fireRow(1, { lat, lon })), null);
    assert.equal(toAsset('earthquakes', quakeRow('us1', { lat, lon })), null);
  }
  // Exactly on an axis but not (0,0) is a real position.
  assert.ok(toAsset('flights', aircraftRow('a1b2c3', { lat: 0, lon: 10 })));
  assert.ok(toAsset('flights', aircraftRow('a1b2c3', { lat: 90, lon: 180 })));
  // Vessel fixes more than 120 s after the epoch are rejected.
  const at = (positionAtMs) =>
    toAsset('ais-live-vessels', vesselRow('366123456', { positionAtMs }), {
      epochMs: T,
    });
  assert.equal(at(T + VESSEL_FUTURE_FIX_MS + 1), null);
  assert.ok(at(T + VESSEL_FUTURE_FIX_MS));
  assert.ok(at(T - 86_400_000));
  assert.equal(at(null).fixAtMs, null);
  // Without an epoch nothing is judged to be in the future.
  assert.ok(
    toAsset('ais-live-vessels', vesselRow('366123456', { positionAtMs: T })),
  );
  // Aircraft receipt times are not checked against the source epoch.
  assert.ok(
    toAsset('flights', aircraftRow('a1b2c3', { receivedAtMs: T + 600_000 }), {
      epochMs: T,
    }),
  );
  for (const layerId of ['local-adsb', 'satellites', 'cctv', '', null]) {
    assert.equal(toAsset(layerId, aircraftRow('a1b2c3')), null);
  }
  assert.equal(toAsset('flights', null), null);
  assert.equal(toAsset('flights', [1, 2]), null);
  assert.equal(toAsset('flights', aircraftRow('', {})), null);
  assert.equal(toAsset('ais-live-vessels', vesselRow(null)), null);
});

test('isFreshFix: receipt and contact times', () => {
  const prev = toAsset('flights', aircraftRow('a1b2c3'));
  assert.equal(isFreshFix(null, prev), true);
  assert.equal(isFreshFix(undefined, prev), true);
  assert.equal(isFreshFix(prev, null), false);
  // A carried record keeps its receipt time (and its squawk): not fresh.
  const carried = { ...prev, squawk: '7700', emergency: true };
  assert.equal(isFreshFix(prev, carried), false);
  // A cached 200 re-received: new receipt, same contact time: not fresh.
  assert.equal(isFreshFix(prev, { ...prev, fixAtMs: T + 30_000 }), false);
  // A new poll row with an advanced contact time is fresh.
  assert.equal(
    isFreshFix(prev, {
      ...prev,
      fixAtMs: T + 30_000,
      contactAtMs: T + 25_000,
    }),
    true,
  );
  // A null contact time on either side does not block freshness.
  assert.equal(
    isFreshFix(prev, { ...prev, fixAtMs: T + 30_000, contactAtMs: null }),
    true,
  );
  assert.equal(
    isFreshFix({ ...prev, contactAtMs: null }, { ...prev, fixAtMs: T + 1 }),
    true,
  );
  // An older or unknown fix time is never fresh after a previous fix.
  assert.equal(isFreshFix(prev, { ...prev, fixAtMs: T - 1 }), false);
  assert.equal(isFreshFix(prev, { ...prev, fixAtMs: null }), false);
  assert.equal(isFreshFix({ ...prev, fixAtMs: null }, prev), false);
  // A presence member's lastFix carries atMs instead of fixAtMs.
  const lastFix = { lat: 1, lon: 2, atMs: T, altM: 100, onGround: false };
  assert.equal(isFreshFix(lastFix, { ...prev, fixAtMs: T + 1 }), true);
  assert.equal(isFreshFix(lastFix, prev), false);
});

test('isFreshFix: vessels compare position times only', () => {
  const prev = toAsset('ais-live-vessels', vesselRow('366123456'));
  assert.equal(isFreshFix(prev, { ...prev }), false);
  assert.equal(isFreshFix(prev, { ...prev, fixAtMs: prev.fixAtMs + 1 }), true);
  assert.equal(isFreshFix(prev, { ...prev, fixAtMs: prev.fixAtMs - 1 }), false);
});

test('buildFrame: readRows is called once, with RECORD_CAP + 1, only when counted', () => {
  const calls = [];
  const rows = [aircraftRow('a1b2c3'), aircraftRow('d4e5f6')];
  const frame = buildFrame({
    layerId: 'flights',
    nowMs: T + 500,
    snapshot: layerSnapshot({
      id: 'flights',
      enabled: true,
      stats: freshStats({ count: 2 }),
    }),
    stats: freshStats({ count: 2 }),
    coverage: { kind: 'global' },
    readRows: (cap) => {
      calls.push(cap);
      return rows;
    },
  });
  assert.deepEqual(calls, [RECORD_CAP + 1]);
  assert.equal(frame.layerId, 'flights');
  assert.equal(frame.kind, 'aircraft');
  assert.equal(frame.nowMs, T + 500);
  assert.equal(frame.epochMs, T);
  assert.equal(frame.newEpoch, true);
  assert.deepEqual(frame.answer, { state: 'counted', reason: null, asOfMs: T });
  assert.deepEqual(frame.coverage, { kind: 'global' });
  assert.equal(frame.complete, true);
  assert.deepEqual(
    frame.assets.map((asset) => asset.key),
    ['a1b2c3', 'd4e5f6'],
  );
  assert.ok(frame.keys instanceof Set);
  assert.deepEqual([...frame.keys], ['a1b2c3', 'd4e5f6']);
  assert.equal(frame.rejected, 0);

  for (const [stats, enabled, state] of [
    [freshStats({ stale: true }), true, 'held'],
    [freshStats({ error: 'HTTP 503' }), true, 'held'],
    [{ count: 0, lastUpdate: null }, true, 'unknown'],
    [{ count: 0, lastUpdate: null, status: 'unavailable' }, true, 'unknown'],
    [freshStats(), false, 'off'],
  ]) {
    let read = 0;
    const result = buildFrame({
      layerId: 'flights',
      nowMs: T,
      snapshot: layerSnapshot({ id: 'flights', enabled, stats }),
      stats,
      coverage: { kind: 'global' },
      readRows: () => {
        read += 1;
        return rows;
      },
    });
    assert.equal(read, 0, state);
    assert.equal(result.answer.state, state);
    assert.deepEqual(result.assets, []);
    assert.equal(result.keys.size, 0);
    assert.equal(result.complete, false);
  }
});

test('buildFrame: epochs', () => {
  const build = (previousEpochMs, stats = freshStats(), enabled = true) =>
    buildFrame({
      layerId: 'ais-live-vessels',
      nowMs: T,
      enabled,
      stats,
      coverage: { kind: 'global' },
      readRows: () => [vesselRow('366123456')],
      previousEpochMs,
    });
  assert.equal(build(T).newEpoch, false);
  assert.equal(build(T).epochMs, T);
  assert.equal(build(T - 30_000).newEpoch, true);
  assert.equal(build(null).newEpoch, true);
  assert.equal(build(undefined).newEpoch, true);
  // A held frame still carries its data epoch.
  const held = build(T - 30_000, freshStats({ stale: true }));
  assert.equal(held.answer.state, 'held');
  assert.equal(held.epochMs, T);
  assert.equal(held.newEpoch, true);
  // Off and never-answered frames have no epoch.
  const off = build(T - 30_000, freshStats(), false);
  assert.equal(off.epochMs, null);
  assert.equal(off.newEpoch, false);
  const never = build(null, { count: 0, lastUpdate: null });
  assert.equal(never.epochMs, null);
  assert.equal(never.newEpoch, false);
});

test('buildFrame: no rows with a count is unknown; with count 0 it is a counted zero', () => {
  const cannot = frameFor('ais-live-vessels', {
    stats: freshStats({ count: 7 }),
    rows: [],
  });
  assert.deepEqual(cannot.answer, {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: T,
  });
  assert.deepEqual(cannot.assets, []);
  assert.equal(cannot.complete, false);
  const empty = frameFor('ais-live-vessels', {
    stats: freshStats({ count: 0 }),
    rows: [],
  });
  assert.deepEqual(empty.answer, { state: 'counted', reason: null, asOfMs: T });
  assert.equal(empty.assets.length, 0);
  assert.equal(empty.complete, true);
  // A provider that returns nothing (not an array) is no rows.
  const nothing = buildFrame({
    layerId: 'earthquakes',
    enabled: true,
    stats: freshStats({ count: 2 }),
    readRows: () => null,
  });
  assert.equal(nothing.answer.reason, 'cannot-answer');
});

test('buildFrame: a missing or throwing reader cannot answer', () => {
  for (const readRows of [
    undefined,
    'rows',
    () => {
      throw new Error('boom');
    },
  ]) {
    const frame = buildFrame({
      layerId: 'flights',
      enabled: true,
      stats: freshStats(),
      coverage: { kind: 'global' },
      readRows,
    });
    assert.deepEqual(frame.answer, {
      state: 'unknown',
      reason: 'cannot-answer',
      asOfMs: T,
    });
    assert.deepEqual(frame.assets, []);
  }
});

test('buildFrame: partial snapshots and truncation give floor', () => {
  const partial = frameFor('ais-live-vessels', {
    stats: freshStats({ count: 1, partial: true }),
    rows: [vesselRow('366123456')],
    coverage: COVER_FULL,
  });
  assert.equal(layerFeedState(freshStats({ partial: true })), 'partial');
  assert.deepEqual(partial.answer, {
    state: 'floor',
    reason: 'partial-snapshot',
    asOfMs: T,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.assets.length, 1);

  const rows = Array.from({ length: RECORD_CAP + 1 }, (_, i) => ({
    id: `us${i}`,
    lat: -60 + (i % 1200) / 10,
    lon: -170 + Math.floor(i / 1200) / 10,
    magnitude: 3,
    depthKm: 5,
    timeMs: T - i,
    place: null,
  }));
  const truncated = frameFor('earthquakes', {
    stats: freshStats({ count: rows.length }),
    rows,
  });
  assert.deepEqual(truncated.answer, {
    state: 'floor',
    reason: 'truncated',
    asOfMs: T,
  });
  assert.equal(truncated.assets.length, RECORD_CAP);
  assert.equal(truncated.keys.has(`us${RECORD_CAP}`), false);
  assert.equal(truncated.complete, false);
});

test('buildFrame: unusable and duplicate rows are dropped and counted', () => {
  const frame = frameFor('local-firms', {
    stats: freshStats({ count: 4 }),
    rows: [
      fireRow(1),
      fireRow(2), // same detection under a new FIRE id
      fireRow(3, { lat: 0, lon: 0 }),
      fireRow(4, { lat: 41 }),
      null,
    ],
  });
  assert.equal(frame.answer.state, 'counted');
  assert.equal(frame.assets.length, 2);
  assert.equal(frame.keys.size, 2);
  assert.equal(frame.rejected, 3);
  assert.deepEqual(frame.coverage, { kind: 'global' });
});

test('buildFrame: vessel future fixes are judged against the frame epoch', () => {
  const frame = frameFor('ais-live-vessels', {
    stats: freshStats({ count: 2 }),
    coverage: COVER_FULL,
    rows: [
      vesselRow('366000001'),
      vesselRow('366000002', { positionAtMs: T + VESSEL_FUTURE_FIX_MS + 5 }),
    ],
  });
  assert.deepEqual([...frame.keys], ['366000001']);
  assert.equal(frame.rejected, 1);
});

test('buildFrame: fallbacks to the snapshot, unknown layers and coverage', () => {
  // lastUpdate and count may come from the snapshot when stats lack them.
  const frame = buildFrame({
    layerId: 'military',
    snapshot: {
      enabled: true,
      feedState: 'nominal',
      count: 1,
      lastUpdate: T,
    },
    stats: null,
    coverage: COVER_NONE,
    readRows: () => [aircraftRow('ae0001')],
  });
  assert.equal(frame.answer.state, 'counted');
  assert.equal(frame.epochMs, T);
  assert.deepEqual(frame.coverage, { kind: 'global' });
  assert.equal(frame.assets[0].military, true);
  // A stale snapshot feedState wins over clean stats.
  const stale = buildFrame({
    layerId: 'flights',
    snapshot: { enabled: true, feedState: 'stale' },
    stats: freshStats(),
    readRows: () => [],
  });
  assert.equal(stale.answer.reason, 'feed-stale');
  // Unknown layers never read and cannot answer.
  let read = 0;
  const unknown = buildFrame({
    layerId: 'local-adsb',
    enabled: true,
    stats: freshStats(),
    readRows: () => {
      read += 1;
      return [];
    },
  });
  assert.equal(read, 0);
  assert.equal(unknown.kind, null);
  assert.deepEqual(unknown.answer, {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: T,
  });
  const empty = buildFrame();
  assert.equal(empty.layerId, null);
  assert.equal(empty.answer.state, 'off');
  assert.equal(empty.nowMs, null);
  assert.deepEqual(empty.coverage, { kind: 'unknown' });
  // The frame minus its Set is JSON-safe.
  const { keys, ...rest } = frame;
  assert.ok(keys instanceof Set);
  assertJsonSafe(rest);
});

/** Latest frames per layer for zoneAnswer, built from simple specs. */
function aircraftFrames({ flights, military }) {
  const frames = {};
  const spec = (layerId, value) => {
    if (value === undefined) return;
    if (value === 'off') {
      frames[layerId] = frameFor(layerId, { enabled: false });
    } else if (value === 'held') {
      frames[layerId] = frameFor(layerId, {
        stats: freshStats({ stale: true }),
      });
    } else if (value === 'unknown') {
      frames[layerId] = frameFor(layerId, {
        stats: { count: 0, lastUpdate: null },
      });
    } else {
      frames[layerId] = frameFor(layerId, {
        stats: freshStats({ count: value.rows.length }),
        rows: value.rows,
        coverage: value.coverage ?? { kind: 'global' },
      });
    }
  };
  spec('flights', flights);
  spec('military', military);
  return frames;
}

const CIVIL = [aircraftRow('a00001'), aircraftRow('a00002')];
const MIL = [
  aircraftRow('ae0001', { military: true }),
  aircraftRow('a00001'), // also in flights: counted once
];

test('zoneAnswer: aircraft primary and secondary combinations', () => {
  const answer = (frames, zone = ZONE) =>
    zoneAnswer({ kind: 'aircraft', zone, compiled: COMPILED, frames });
  const pick = ({ state, reason, count }) => [state, reason, count];

  // Both answering: counted, with the union of keys.
  assert.deepEqual(
    answer(
      aircraftFrames({ flights: { rows: CIVIL }, military: { rows: MIL } }),
    ),
    {
      state: 'counted',
      reason: null,
      asOfMs: T,
      coverage: 'full',
      count: 3,
    },
  );
  // Secondary off: the primary alone is complete.
  assert.deepEqual(
    pick(answer(aircraftFrames({ flights: { rows: CIVIL }, military: 'off' }))),
    ['counted', null, 2],
  );
  // No secondary frame at all reads as off.
  assert.deepEqual(pick(answer(aircraftFrames({ flights: { rows: CIVIL } }))), [
    'counted',
    null,
    2,
  ]);
  // Primary off, secondary answering: a floor from the secondary only.
  assert.deepEqual(
    answer(aircraftFrames({ flights: 'off', military: { rows: MIL } })),
    {
      state: 'floor',
      reason: 'secondary-feed-only',
      asOfMs: T,
      coverage: 'full',
      count: 2,
    },
  );
  // Both off.
  assert.deepEqual(
    pick(answer(aircraftFrames({ flights: 'off', military: 'off' }))),
    ['off', 'feed-off', null],
  );
  // Primary off and the secondary not answering stays off.
  assert.deepEqual(
    pick(answer(aircraftFrames({ flights: 'off', military: 'held' }))),
    ['off', 'feed-off', null],
  );
  // Primary held or unknown: that state, whatever the secondary does.
  assert.deepEqual(
    pick(answer(aircraftFrames({ flights: 'held', military: { rows: MIL } }))),
    ['held', 'feed-stale', null],
  );
  assert.deepEqual(
    pick(
      answer(aircraftFrames({ flights: 'unknown', military: { rows: MIL } })),
    ),
    ['unknown', 'never-answered', null],
  );
  // A missing primary frame has never answered.
  assert.deepEqual(pick(answer(aircraftFrames({ military: { rows: MIL } }))), [
    'unknown',
    'never-answered',
    null,
  ]);
  // Primary answering, secondary enabled but held or unknown: floor.
  for (const military of ['held', 'unknown']) {
    assert.deepEqual(
      pick(answer(aircraftFrames({ flights: { rows: CIVIL }, military }))),
      ['floor', 'secondary-feed-stale', 2],
    );
  }
  // Primary already floor (partial coverage) keeps its own reason.
  assert.deepEqual(
    pick(
      answer(
        aircraftFrames({
          flights: { rows: CIVIL, coverage: COVER_PARTIAL },
          military: 'held',
        }),
      ),
    ),
    ['floor', 'partial-coverage', 2],
  );
});

test('zoneAnswer: militaryOnly zones make military the primary', () => {
  const zone = { ...ZONE, aircraft: { militaryOnly: true } };
  const answer = (frames) =>
    zoneAnswer({ kind: 'aircraft', zone, compiled: COMPILED, frames });
  const flightsWithMil = [...CIVIL, aircraftRow('ae0002', { military: true })];
  // Only military assets count, from both layers. Every military-layer
  // record is military, so a00001 counts through that layer.
  assert.deepEqual(
    answer(
      aircraftFrames({
        flights: { rows: flightsWithMil },
        military: { rows: MIL },
      }),
    ),
    { state: 'counted', reason: null, asOfMs: T, coverage: 'full', count: 3 },
  );
  // Military off, flights answering: floor from the secondary.
  const secondaryOnly = answer(
    aircraftFrames({ flights: { rows: flightsWithMil }, military: 'off' }),
  );
  assert.deepEqual(
    [secondaryOnly.state, secondaryOnly.reason, secondaryOnly.count],
    ['floor', 'secondary-feed-only', 1],
  );
  // Military held: held, even with flights answering.
  assert.equal(
    answer(aircraftFrames({ flights: { rows: CIVIL }, military: 'held' }))
      .state,
    'held',
  );
  // Military answering, flights held: downgraded to floor.
  const stale = answer(
    aircraftFrames({ flights: 'held', military: { rows: MIL } }),
  );
  assert.deepEqual(
    [stale.state, stale.reason, stale.count],
    ['floor', 'secondary-feed-stale', 2],
  );
  // Flights off as the secondary is no downgrade.
  assert.equal(
    answer(aircraftFrames({ flights: 'off', military: { rows: MIL } })).state,
    'counted',
  );
});

test('zoneAnswer: coverage mapping for regional feeds', () => {
  const vessels = (coverage, extraStats = {}) => ({
    'ais-live-vessels': frameFor('ais-live-vessels', {
      stats: freshStats({ count: 1, ...extraStats }),
      rows: [vesselRow('366123456')],
      coverage,
    }),
  });
  const answer = (frames) =>
    zoneAnswer({ kind: 'vessel', zone: ZONE, compiled: COMPILED, frames });
  assert.deepEqual(answer(vessels(COVER_FULL)), {
    state: 'counted',
    reason: null,
    asOfMs: T,
    coverage: 'full',
    count: 1,
  });
  assert.deepEqual(answer(vessels(COVER_PARTIAL)), {
    state: 'floor',
    reason: 'partial-coverage',
    asOfMs: T,
    coverage: 'partial',
    count: 1,
  });
  assert.deepEqual(answer(vessels(COVER_NONE)), {
    state: 'unknown',
    reason: 'outside-loaded-area',
    asOfMs: T,
    coverage: 'none',
    count: null,
  });
  assert.deepEqual(answer(vessels({ kind: 'unknown' })), {
    state: 'floor',
    reason: 'coverage-unknown',
    asOfMs: T,
    coverage: 'unknown',
    count: 1,
  });
  // A partial snapshot already at floor keeps its reason under partial coverage.
  assert.deepEqual(
    [
      answer(vessels(COVER_PARTIAL, { partial: true })).state,
      answer(vessels(COVER_PARTIAL, { partial: true })).reason,
    ],
    ['floor', 'partial-snapshot'],
  );
  // Outside the loaded area wins over a floor feed answer.
  assert.equal(
    answer(vessels(COVER_NONE, { partial: true })).reason,
    'outside-loaded-area',
  );
  // The 438 km flights fallback disc partly over a zone is a floor.
  const fallback = {
    flights: frameFor('flights', {
      stats: freshStats({
        count: 2,
        coverage: '250nm regional fallback',
      }),
      rows: CIVIL,
      coverage: COVER_PARTIAL,
    }),
  };
  assert.equal(fallback.flights.answer.reason, 'regional-fallback');
  assert.deepEqual(
    zoneAnswer({
      kind: 'aircraft',
      zone: ZONE,
      compiled: COMPILED,
      frames: fallback,
    }),
    {
      state: 'floor',
      reason: 'partial-coverage',
      asOfMs: T,
      coverage: 'partial',
      count: 2,
    },
  );
  // A fallback disc that covers the whole zone stays counted, and says so.
  const covered = {
    flights: frameFor('flights', {
      stats: freshStats({ count: 2, coverage: '250nm regional fallback' }),
      rows: CIVIL,
      coverage: COVER_FULL,
    }),
  };
  assert.deepEqual(
    zoneAnswer({
      kind: 'aircraft',
      zone: ZONE,
      compiled: COMPILED,
      frames: covered,
    }),
    {
      state: 'counted',
      reason: 'regional-fallback',
      asOfMs: T,
      coverage: 'full',
      count: 2,
    },
  );
});

test('zoneAnswer: the count is geometric and follows the zone filters', () => {
  const outside = aircraftRow('a00009', { lat: ZONE_LAT + 1 }); // ~111 km N
  const edge = aircraftRow('a00010', { lat: ZONE_LAT + 0.4 }); // ~44 km N
  const frames = aircraftFrames({
    flights: { rows: [...CIVIL, outside, edge] },
  });
  assert.equal(
    zoneAnswer({ kind: 'aircraft', zone: ZONE, compiled: COMPILED, frames })
      .count,
    3,
  );
  assert.equal(
    zoneAnswer({
      kind: 'aircraft',
      zone: ZONE,
      compiled: COMPILED,
      frames,
      countAssets: false,
    }).count,
    null,
  );

  const fires = {
    'local-firms': frameFor('local-firms', {
      stats: freshStats({ count: 3 }),
      rows: [
        fireRow(1, { frp: 5 }),
        fireRow(2, { frp: 60, satellite: 'N21' }),
        fireRow(3, { frp: 120, lat: ZONE_LAT + 2 }),
      ],
    }),
  };
  const fireCount = (minFrpMw) =>
    zoneAnswer({
      kind: 'fire',
      zone: { ...ZONE, fire: { minFrpMw } },
      compiled: COMPILED,
      frames: fires,
    }).count;
  assert.equal(fireCount(0), 2);
  assert.equal(fireCount(50), 1);
  assert.equal(fireCount(100), 0);

  const quakes = {
    earthquakes: frameFor('earthquakes', {
      stats: freshStats({ count: 3 }),
      rows: [
        quakeRow('us1', { magnitude: 2.0 }),
        quakeRow('us2', { magnitude: 4.5 }),
        // About 80 km outside the 50 km circle.
        quakeRow('us3', { magnitude: 5.5, lat: ZONE_LAT + 1.17 }),
      ],
    }),
  };
  const quakeCount = (quake) =>
    zoneAnswer({
      kind: 'quake',
      zone: { ...ZONE, quake },
      compiled: COMPILED,
      frames: quakes,
    }).count;
  assert.equal(quakeCount({ minMagnitude: 2.5, bufferKm: 0 }), 1);
  assert.equal(quakeCount({ minMagnitude: 2.5, bufferKm: 100 }), 2);
  assert.equal(quakeCount({ minMagnitude: 5, bufferKm: 100 }), 1);
  assert.equal(quakeCount({ minMagnitude: 1, bufferKm: 0 }), 2);
});

test('zoneAnswer: frames as a Map, an array or an object; bad input', () => {
  const frame = frameFor('ais-live-vessels', {
    stats: freshStats({ count: 1 }),
    rows: [vesselRow('366123456')],
    coverage: COVER_FULL,
  });
  const older = frameFor('ais-live-vessels', {
    stats: { count: 0, lastUpdate: null },
  });
  for (const frames of [
    new Map([['ais-live-vessels', frame]]),
    [older, frame],
    { 'ais-live-vessels': frame },
  ]) {
    assert.deepEqual(
      zoneAnswer({ kind: 'vessel', zone: ZONE, compiled: COMPILED, frames }),
      { state: 'counted', reason: null, asOfMs: T, coverage: 'full', count: 1 },
    );
  }
  for (const frames of [undefined, null, [], new Map(), {}]) {
    assert.deepEqual(
      zoneAnswer({ kind: 'vessel', zone: ZONE, compiled: COMPILED, frames }),
      {
        state: 'unknown',
        reason: 'never-answered',
        asOfMs: null,
        coverage: 'unknown',
        count: null,
      },
    );
  }
  const cannot = {
    state: 'unknown',
    reason: 'cannot-answer',
    asOfMs: null,
    coverage: 'unknown',
    count: null,
  };
  assert.deepEqual(
    zoneAnswer({ kind: 'satellite', compiled: COMPILED, frames: {} }),
    cannot,
  );
  assert.deepEqual(
    zoneAnswer({ kind: 'vessel', compiled: null, frames: { frame } }),
    cannot,
  );
  assert.deepEqual(zoneAnswer(), cannot);
  // An off vessel layer reads off.
  assert.deepEqual(
    zoneAnswer({
      kind: 'vessel',
      zone: ZONE,
      compiled: COMPILED,
      frames: {
        'ais-live-vessels': frameFor('ais-live-vessels', { enabled: false }),
      },
    }).state,
    'off',
  );
  // A frame with a malformed answer cannot answer.
  assert.equal(
    zoneAnswer({
      kind: 'vessel',
      zone: ZONE,
      compiled: COMPILED,
      frames: { 'ais-live-vessels': { ...frame, answer: { state: 'live' } } },
    }).reason,
    'cannot-answer',
  );
});

test('zoneAnswer: asOfMs is the oldest answering layer', () => {
  const flights = frameFor('flights', {
    stats: freshStats({ count: 2, lastUpdate: T - 20_000 }),
    rows: CIVIL,
    coverage: { kind: 'global' },
  });
  const military = frameFor('military', {
    stats: freshStats({ count: 2 }),
    rows: MIL,
  });
  const result = zoneAnswer({
    kind: 'aircraft',
    zone: ZONE,
    compiled: COMPILED,
    frames: { flights, military },
  });
  assert.equal(result.asOfMs, T - 20_000);
  assertJsonSafe(result);
});

test('assetInZone: kind, position, filters and polygon zones', () => {
  const asset = toAsset('flights', aircraftRow('a1b2c3'));
  assert.equal(assetInZone('aircraft', ZONE, COMPILED, asset), true);
  assert.equal(assetInZone('vessel', ZONE, COMPILED, asset), false);
  assert.equal(
    assetInZone('aircraft', ZONE, COMPILED, { ...asset, lat: 0, lon: 0 }),
    false,
  );
  assert.equal(assetInZone('aircraft', ZONE, null, asset), false);
  assert.equal(assetInZone('aircraft', ZONE, COMPILED, null), false);
  assert.equal(
    assetInZone(
      'aircraft',
      { aircraft: { militaryOnly: true } },
      COMPILED,
      asset,
    ),
    false,
  );
  // An antimeridian polygon zone.
  const polygon = compileZone({
    id: 'z-pacific',
    shape: 'polygon',
    ring: [
      [170, -5],
      [-170, -5],
      [-170, 5],
      [170, 5],
      [170, -5],
    ],
  });
  assert.ok(polygon);
  const at = (lon) =>
    toAsset('ais-live-vessels', vesselRow('366123456', { lat: 0.5, lon }));
  assert.equal(assetInZone('vessel', null, polygon, at(179.9)), true);
  assert.equal(assetInZone('vessel', null, polygon, at(-179.9)), true);
  assert.equal(assetInZone('vessel', null, polygon, at(10)), false);
});
