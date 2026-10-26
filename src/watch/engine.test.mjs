import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRIEF_EVENT_PARAM_KEYS, BRIEF_SECTION_IDS } from './brief.js';
import {
  addWatchEntry,
  addZone,
  createCircleZone,
  emptyWatchDocument,
  replaceZone,
  setPrefs,
  updateZone,
} from './document.js';
import { buildFrame, isAnswering } from './frames.js';
import { coverageOfZone, compileZone } from './geometry.js';
import {
  WATCH_ENGINE_LIMITS,
  WATCH_EVENT_CATALOGUE,
  WATCH_EVENT_CAVEATS,
  createWatchEngine,
} from './engine.js';
import * as index from './index.js';
import * as geometryModule from './geometry.js';
import * as documentModule from './document.js';
import * as framesModule from './frames.js';
import * as presenceModule from './presence.js';
import * as watchlistModule from './watchlist.js';
import * as emergencyModule from './emergency.js';
import * as hazardsModule from './hazards.js';
import * as eventLogModule from './eventLog.js';
import * as occupancyModule from './occupancy.js';
import * as briefModule from './brief.js';
import * as engineModule from './engine.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const KM_PER_DEG = 111.195;
const ZLAT = 51.5;
const ZLON = -1;

/** Every event any test produced, for the catalogue coverage check. */
const ALL_EVENTS = [];

const EVENT_KEYS = Object.freeze([
  'id',
  'seq',
  'type',
  'severity',
  'atMs',
  'dataAtMs',
  'zoneId',
  'assetKey',
  'kind',
  'assetId',
  'assetLabel',
  'layerId',
  'position',
  'params',
  'caveats',
  'watchlisted',
  'dedupeKey',
]);
const FORBIDDEN_ON_BLIND = Object.freeze([
  'zone-exit',
  'zone-exit-window',
  'zone-exit-summary',
  'zone-no-longer-reported',
  'zone-traffic-summary',
  'watch-not-reported',
]);

// --------------------------------------------------------------- fixtures

let idCounter = 0;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}-test${String(idCounter).padStart(4, '0')}`;
}

/** A point `km` from (lat, lon) along `bearingDeg` (flat-earth, small km). */
function offset(lat, lon, km, bearingDeg = 0) {
  const b = (bearingDeg * Math.PI) / 180;
  const dLat = (km * Math.cos(b)) / KM_PER_DEG;
  const dLon =
    (km * Math.sin(b)) / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

/** A point `km` from the default zone centre. */
function at(km, bearingDeg = 0) {
  return offset(ZLAT, ZLON, km, bearingDeg);
}

const INSIDE = at(5);
const OUTSIDE = at(40);

function circleZone({
  name = 'Harbour approach',
  lat = ZLAT,
  lon = ZLON,
  radiusKm = 25,
  kinds = ['aircraft', 'vessel'],
  patch = null,
} = {}) {
  const made = createCircleZone(
    { name, center: { lat, lon }, radiusM: radiusKm * 1000, kinds },
    { nowMs: T0, makeId },
  );
  assert.ok(made.ok, made.code);
  if (!patch) return made.zone;
  const updated = updateZone(made.zone, patch, { nowMs: T0 + 1 });
  assert.ok(updated.ok, updated.code);
  return updated.zone;
}

function makeDoc({ zones = [], watch = [], prefs = null } = {}) {
  let doc = emptyWatchDocument();
  for (const zone of zones) {
    const added = addZone(doc, zone);
    assert.ok(added.ok, added.code);
    doc = added.doc;
  }
  for (const input of watch) {
    const added = addWatchEntry(doc, input, { nowMs: T0, makeId });
    assert.ok(added.ok, added.code);
    doc = added.doc;
  }
  if (prefs) {
    const updated = setPrefs(doc, prefs);
    assert.ok(updated.ok, updated.code);
    doc = updated.doc;
  }
  return doc;
}

function aircraft(icao24, point, t, overrides = {}) {
  return {
    id: overrides.callsign ?? icao24.toUpperCase(),
    icao24,
    callsign: null,
    lat: point.lat,
    lon: point.lon,
    altitudeM: 3000,
    speedMps: 120,
    heading: 90,
    verticalRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    // Enriched: the privacy guard can judge it (watchClassKnown).
    typeCode: 'A320',
    squawk: '1200',
    emergency: false,
    emergencyKind: null,
    emergencySource: null,
    lastContactAtMs: t - 2 * SEC,
    receivedAtMs: t,
    ...overrides,
  };
}

function emergencyAircraft(icao24, point, t, overrides = {}) {
  return aircraft(icao24, point, t, {
    squawk: '7700',
    emergency: true,
    emergencyKind: 'general',
    emergencySource: 'squawk',
    ...overrides,
  });
}

function vessel(mmsi, point, t, overrides = {}) {
  return {
    id: `SHIP ${mmsi}`,
    mmsi,
    lat: point.lat,
    lon: point.lon,
    speedKts: 12,
    courseDeg: 180,
    shipType: '70',
    positionAtMs: t - 10 * SEC,
    ...overrides,
  };
}

function fire(point, acqTime, frp = 20, overrides = {}) {
  return {
    id: 'FIRE-00001',
    lat: point.lat,
    lon: point.lon,
    frp,
    confidence: 0.8,
    satellite: 'N20',
    acqTime,
    ...overrides,
  };
}

function quake(id, point, magnitude, timeMs, overrides = {}) {
  return {
    id,
    lat: point.lat,
    lon: point.lon,
    magnitude,
    depthKm: 10,
    timeMs,
    place: 'near the test zone',
    ...overrides,
  };
}

const HELD_MODES = Object.freeze(['stale', 'degraded', 'unavailable']);

function defaultCoverage(layerId) {
  if (layerId === 'ais-live-vessels') {
    return { kind: 'circle', lat: ZLAT, lon: ZLON, radiusKm: 200 };
  }
  return { kind: 'global' };
}

/**
 * Builds a real frames.js frame. Modes: counted, partial, fallback, stale,
 * degraded, unavailable, loading, off, key-required.
 */
function makeFrame(
  layerId,
  { nowMs, rows = [], mode = 'counted', coverage, lastUpdate, previousEpochMs },
) {
  const enabled = mode !== 'off';
  let feedState = 'nominal';
  const stats = { count: rows.length, lastUpdate };
  if (mode === 'partial') {
    feedState = 'partial';
    stats.partial = true;
  } else if (mode === 'fallback') {
    feedState = 'fallback';
  } else if (mode === 'stale') {
    feedState = 'stale';
    stats.stale = true;
  } else if (mode === 'degraded') {
    stats.lastError = { code: 503 };
  } else if (mode === 'unavailable') {
    feedState = 'unavailable';
  } else if (mode === 'loading') {
    feedState = 'loading';
    stats.lastUpdate = null;
  } else if (mode === 'key-required') {
    stats.keyRequired = true;
  } else if (mode === 'off') {
    feedState = 'off';
  }
  return buildFrame({
    layerId,
    nowMs,
    enabled,
    snapshot: {
      enabled,
      feedState,
      count: rows.length,
      lastUpdate: stats.lastUpdate,
    },
    stats,
    coverage,
    readRows: () => rows,
    previousEpochMs,
  });
}

function checkEvents(events) {
  assert.ok(Array.isArray(events));
  for (const event of events) {
    assert.deepEqual(Object.keys(event), EVENT_KEYS);
    const entry = WATCH_EVENT_CATALOGUE[event.type];
    assert.ok(entry, `catalogued type ${event.type}`);
    assert.ok(['info', 'notice', 'alert'].includes(event.severity));
    assert.equal(event.id, `e-${event.seq}`);
    assert.ok(Number.isFinite(event.atMs));
    assert.deepEqual(Object.keys(event.params), [...entry.params]);
    for (const key of Object.keys(event.params)) {
      assert.ok(BRIEF_EVENT_PARAM_KEYS.includes(key), `param ${key}`);
    }
    for (const code of event.caveats) {
      assert.ok(WATCH_EVENT_CAVEATS.includes(code), `caveat ${code}`);
    }
    assert.ok(
      event.dedupeKey.startsWith(`${event.type}|${event.zoneId ?? ''}|`),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
    assert.equal(typeof event.watchlisted, 'boolean');
  }
  ALL_EVENTS.push(...events);
  return events;
}

function createHarness(doc, options = {}) {
  const engine = createWatchEngine(options);
  engine.setDocument(doc);
  const lastEpoch = new Map();
  const all = [];
  function frameFor(layerId, input) {
    const prev = lastEpoch.get(layerId) ?? null;
    const held = HELD_MODES.includes(input.mode);
    const lastUpdate =
      input.lastUpdate !== undefined
        ? input.lastUpdate
        : held
          ? (prev ?? input.nowMs)
          : input.nowMs;
    const frame = makeFrame(layerId, {
      ...input,
      lastUpdate,
      previousEpochMs: prev,
      coverage:
        input.coverage === undefined
          ? defaultCoverage(layerId)
          : input.coverage,
    });
    if (frame.epochMs !== null) lastEpoch.set(layerId, frame.epochMs);
    return frame;
  }
  function push(layerId, input) {
    const events = checkEvents(engine.ingest(frameFor(layerId, input)));
    all.push(...events);
    return events;
  }
  function tick(nowMs) {
    const events = checkEvents(engine.tick(nowMs));
    all.push(...events);
    return events;
  }
  return { engine, push, tick, all, frameFor };
}

function types(events) {
  return events.map((event) => event.type);
}

function zoneView(engine, zoneId, nowMs) {
  return engine.view(nowMs).zones.find((zone) => zone.id === zoneId);
}

// ----------------------------------------------------------------- shape

test('constants are frozen and the catalogue matches the plan', () => {
  assert.ok(Object.isFrozen(WATCH_ENGINE_LIMITS));
  assert.ok(Object.isFrozen(WATCH_EVENT_CATALOGUE));
  assert.ok(Object.isFrozen(WATCH_EVENT_CAVEATS));
  assert.equal(WATCH_ENGINE_LIMITS.maxMembersPerZone, 400);
  assert.equal(WATCH_ENGINE_LIMITS.maxMembersTotal, 10_000);
  assert.equal(WATCH_ENGINE_LIMITS.eventsPerIngest, 100);
  assert.equal(WATCH_ENGINE_LIMITS.coalesceAbove, 5);
  assert.equal(WATCH_ENGINE_LIMITS.busyEnterMedian, 30);
  assert.equal(WATCH_ENGINE_LIMITS.busyExitMedian, 20);
  assert.equal(WATCH_ENGINE_LIMITS.busyWindowSamples, 10);
  assert.equal(WATCH_ENGINE_LIMITS.busySummaryMs, 600_000);
  assert.equal(WATCH_ENGINE_LIMITS.recheckMinGapMs, 300_000);
  assert.equal(WATCH_ENGINE_LIMITS.feedPauseEvals, 2);
  assert.equal(WATCH_ENGINE_LIMITS.feedPauseMs, 120_000);
  assert.equal(WATCH_ENGINE_LIMITS.bboxPadMargins, 2);
  const severities = Object.fromEntries(
    Object.entries(WATCH_EVENT_CATALOGUE).map(([type, e]) => [
      type,
      e.severity,
    ]),
  );
  assert.deepEqual(severities, {
    'zone-enter': 'notice',
    'zone-exit': 'notice',
    'zone-exit-window': 'info',
    'zone-no-longer-reported': 'info',
    'zone-enter-summary': 'info',
    'zone-exit-summary': 'info',
    'zone-traffic-summary': 'info',
    'zone-rechecked': 'info',
    'feed-paused': 'notice',
    'feed-resumed': 'info',
    'fires-new': 'notice',
    'quake-new': 'notice',
    'hazard-gap-summary': 'info',
    'emergency-start': 'alert',
    'emergency-change': 'notice',
    'emergency-end': 'info',
    'emergency-unresolved': 'notice',
    'watch-seen': 'info',
    'watch-not-reported': 'notice',
    'watch-reappeared': 'alert',
  });
  for (const [type, entry] of Object.entries(WATCH_EVENT_CATALOGUE)) {
    assert.ok(Object.isFrozen(entry), type);
    assert.ok(Object.isFrozen(entry.params), type);
    for (const key of entry.params) {
      assert.ok(BRIEF_EVENT_PARAM_KEYS.includes(key), `${type}.${key}`);
    }
  }
  assert.deepEqual(WATCH_EVENT_CAVEATS, [
    'on-ground',
    'code-may-be-in-error',
    'unobserved-interval',
    'coverage-incomplete',
    'partial-coverage',
    'regional-fallback',
    'lower-bound',
  ]);
});

test('index.js re-exports every watch module without collisions', () => {
  const modules = [
    geometryModule,
    documentModule,
    framesModule,
    presenceModule,
    watchlistModule,
    emergencyModule,
    hazardsModule,
    eventLogModule,
    occupancyModule,
    briefModule,
    engineModule,
  ];
  const expected = new Set();
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      assert.ok(!expected.has(name), `duplicate export ${name}`);
      expected.add(name);
      assert.equal(index[name], value, name);
    }
  }
  assert.deepEqual(new Set(Object.keys(index)), expected);
});

// ---------------------------------------------------------- presence flow

test('assets present at start produce no events', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const rows = (time) => [
    aircraft('a00001', at(2), time),
    aircraft('a00002', at(8, 90), time),
    aircraft('a00003', at(20, 180), time),
    aircraft('a00004', at(40), time),
    aircraft('a00005', at(90, 270), time),
  ];
  const vessels = (time) => [
    vessel('235000001', at(3), time),
    vessel('235000002', at(12, 45), time),
  ];
  assert.deepEqual(h.push('flights', { nowMs: t, rows: rows(t) }), []);
  assert.deepEqual(
    h.push('ais-live-vessels', { nowMs: t, rows: vessels(t) }),
    [],
  );
  for (let i = 0; i < 6; i += 1) {
    t += 30 * SEC;
    assert.deepEqual(h.push('flights', { nowMs: t, rows: rows(t) }), []);
    assert.deepEqual(
      h.push('ais-live-vessels', { nowMs: t, rows: vessels(t) }),
      [],
    );
    assert.deepEqual(h.tick(t), []);
  }
  const view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.aircraft.answer, 'counted');
  assert.equal(view.perKind.aircraft.count, 3);
  assert.equal(view.perKind.vessel.count, 2);
  assert.equal(view.timed, true);
  assert.equal(view.occupants.length, 3);
  assert.ok(view.occupants.every((occupant) => occupant.lowerBound));
  assert.deepEqual(h.all, []);
});

test('a take-off inside the zone is first-seen, not an enter', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00010', OUTSIDE, t)] });
  for (let i = 0; i < 3; i += 1) {
    t += 30 * SEC;
    const events = h.push('flights', {
      nowMs: t,
      rows: [
        aircraft('a00010', OUTSIDE, t),
        aircraft('a00011', INSIDE, t, { onGround: i === 0 }),
      ],
    });
    assert.deepEqual(events, []);
  }
  const view = zoneView(h.engine, zone.id, t);
  const occupant = view.occupants.find((o) => o.assetKey === 'a00011');
  assert.ok(occupant);
  assert.equal(occupant.lowerBound, true);
  assert.equal(occupant.enteredAtMs, T0 + 30 * SEC);
});

test('seen outside, then two fixes inside, is an enter; then an exit', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const push = (point) =>
    h.push('flights', { nowMs: t, rows: [aircraft('a00020', point, t)] });
  assert.deepEqual(push(OUTSIDE), []);
  t += 30 * SEC;
  assert.deepEqual(push(INSIDE), []);
  const firstInside = t;
  t += 30 * SEC;
  const enter = push(INSIDE);
  assert.deepEqual(types(enter), ['zone-enter']);
  assert.equal(enter[0].severity, 'notice');
  assert.equal(enter[0].zoneId, zone.id);
  assert.equal(enter[0].assetKey, 'a00020');
  assert.equal(enter[0].kind, 'aircraft');
  assert.equal(enter[0].layerId, 'flights');
  assert.equal(enter[0].watchlisted, false);
  assert.deepEqual(enter[0].params, { sinceMs: firstInside, reentry: false });
  assert.equal(enter[0].dedupeKey, `zone-enter|${zone.id}|a00020`);
  assert.deepEqual(enter[0].position, {
    lat: INSIDE.lat,
    lon: INSIDE.lon,
  });

  t += 30 * SEC;
  assert.deepEqual(push(OUTSIDE), []);
  const firstOutside = t;
  t += 30 * SEC;
  const exit = push(OUTSIDE);
  assert.deepEqual(types(exit), ['zone-exit']);
  assert.deepEqual(exit[0].params, {
    exitAtMs: firstOutside,
    enteredAtMs: firstInside,
    dwellMs: firstOutside - firstInside,
    dwellLowerBound: false,
  });

  t += 30 * SEC;
  push(INSIDE);
  t += 30 * SEC;
  const back = push(INSIDE);
  assert.deepEqual(types(back), ['zone-enter']);
  assert.equal(back[0].params.reentry, true);
});

test('band jitter around the edge never makes events', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  // 25 km radius → 500 m margin; jitter ±50 m around the edge.
  for (let i = 0; i < 20; i += 1) {
    const km = 25 + (i % 2 ? 0.05 : -0.05);
    h.push('flights', { nowMs: t, rows: [aircraft('a00030', at(km), t)] });
    t += 30 * SEC;
  }
  assert.deepEqual(h.all, []);
});

test('a carried record never advances a streak', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00040', OUTSIDE, t)] });
  t += 30 * SEC;
  const fixAt = t;
  h.push('flights', { nowMs: t, rows: [aircraft('a00040', INSIDE, fixAt)] });
  for (let i = 0; i < 4; i += 1) {
    t += 30 * SEC;
    // A new epoch, but the record is carried with its old receipt time.
    assert.deepEqual(
      h.push('flights', {
        nowMs: t,
        rows: [aircraft('a00040', INSIDE, fixAt)],
      }),
      [],
    );
  }
  t += 30 * SEC;
  assert.deepEqual(
    types(
      h.push('flights', { nowMs: t, rows: [aircraft('a00040', INSIDE, t)] }),
    ),
    ['zone-enter'],
  );
});

test('a flights and military copy of one aircraft gives one enter', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const both = (point) => {
    const a = h.push('flights', {
      nowMs: t,
      rows: [aircraft('ae0001', point, t)],
    });
    const b = h.push('military', {
      nowMs: t + 2 * SEC,
      rows: [aircraft('ae0001', point, t + 2 * SEC, { military: true })],
    });
    return [...a, ...b];
  };
  assert.deepEqual(both(OUTSIDE), []);
  t += 30 * SEC;
  const second = both(INSIDE);
  t += 30 * SEC;
  const third = both(INSIDE);
  assert.deepEqual(types([...second, ...third]), ['zone-enter']);
});

test('a layer back after a long gap cannot show an arrival as an enter', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  for (let i = 0; i < 2; i += 1) {
    h.push('flights', { nowMs: t, rows: [aircraft('a00051', OUTSIDE, t)] });
    h.push('military', { nowMs: t + 1, rows: [] });
    t += 30 * SEC;
  }
  // Flights off for an hour while military keeps the zone answering.
  h.push('flights', { nowMs: t, rows: [], mode: 'off' });
  for (let i = 0; i < 120; i += 1) {
    t += 30 * SEC;
    h.push('military', { nowMs: t, rows: [] });
    h.tick(t);
  }
  assert.equal(zoneView(h.engine, zone.id, t).perKind.aircraft.answer, 'floor');
  // Flights back: the aircraft is inside, but its entry was never observed.
  const out = [];
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    out.push(
      ...h.push('flights', { nowMs: t, rows: [aircraft('a00051', INSIDE, t)] }),
    );
  }
  assert.deepEqual(types(out), []);
  const occupant = zoneView(h.engine, zone.id, t).occupants[0];
  assert.equal(occupant.assetKey, 'a00051');
  assert.equal(occupant.lowerBound, true);
});

test('an asset first reported in the band inside the edge is first-seen', () => {
  for (const [km, expected] of [
    [24.8, []],
    [25.2, ['zone-enter']],
  ]) {
    const zone = circleZone();
    const h = createHarness(makeDoc({ zones: [zone] }));
    let t = T0;
    h.push('flights', { nowMs: t, rows: [] });
    t += 30 * SEC;
    h.push('flights', { nowMs: t, rows: [aircraft('a00050', at(km), t)] });
    for (let i = 0; i < 2; i += 1) {
      t += 30 * SEC;
      h.push('flights', { nowMs: t, rows: [aircraft('a00050', at(20), t)] });
    }
    assert.deepEqual(types(h.all), expected, `first fix at ${km} km`);
    const occupant = zoneView(h.engine, zone.id, t).occupants[0];
    assert.equal(occupant.assetKey, 'a00050');
    assert.equal(occupant.lowerBound, expected.length === 0);
  }
});

test('a military-only zone counts military aircraft and reads floor without them', () => {
  const zone = circleZone({ patch: { aircraft: { militaryOnly: true } } });
  const h = createHarness(makeDoc({ zones: [zone] }));
  const t = T0;
  h.push('flights', {
    nowMs: t,
    rows: [
      aircraft('a01101', INSIDE, t),
      aircraft('ae1102', at(3), t, { military: true }),
    ],
  });
  let view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.aircraft.answer, 'unknown');
  assert.equal(view.perKind.aircraft.reason, 'never-answered');
  h.push('military', {
    nowMs: t + SEC,
    rows: [
      aircraft('ae1102', at(3), t + SEC, { military: true }),
      aircraft('ae1103', at(6), t + SEC, { military: true }),
    ],
  });
  view = zoneView(h.engine, zone.id, t + SEC);
  assert.equal(view.perKind.aircraft.answer, 'counted');
  assert.equal(view.perKind.aircraft.count, 2);
  assert.deepEqual(view.occupants.map((o) => o.assetKey).sort(), [
    'ae1102',
    'ae1103',
  ]);
  h.push('military', { nowMs: t + 2 * SEC, mode: 'off' });
  view = zoneView(h.engine, zone.id, t + 2 * SEC);
  assert.equal(view.perKind.aircraft.answer, 'floor');
  assert.equal(view.perKind.aircraft.reason, 'secondary-feed-only');
  assert.equal(view.perKind.aircraft.count, 1);
});

test('absence is no evidence while another layer that carried it is held', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('ae1201', INSIDE, t)] });
  h.push('military', {
    nowMs: t + SEC,
    rows: [aircraft('ae1201', INSIDE, t + SEC, { military: true })],
  });
  for (let i = 0; i < 5; i += 1) {
    t += 30 * SEC;
    h.push('military', { nowMs: t, mode: 'stale' });
    h.push('flights', { nowMs: t + SEC, rows: [] });
  }
  assert.deepEqual(h.tick(T0 + 20 * MIN), []);
  assert.ok(!types(h.all).includes('zone-no-longer-reported'));
});

test('six simultaneous enters give one summary; the watched one stays separate', () => {
  const zone = circleZone();
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'icao24', value: 'a00107' }] }),
  );
  const ids = [
    'a00101',
    'a00102',
    'a00103',
    'a00104',
    'a00105',
    'a00106',
    'a00107',
  ];
  let t = T0;
  const push = (point) =>
    h.push('flights', {
      nowMs: t,
      rows: ids.map((id, i) =>
        aircraft(id, offset(point.lat, point.lon, i * 0.5, 90), t, {
          callsign: `TST${i}`,
        }),
      ),
    });
  push(OUTSIDE);
  t += 30 * SEC;
  assert.deepEqual(push(INSIDE), []);
  const firstInside = t;
  t += 30 * SEC;
  const events = push(INSIDE);
  assert.deepEqual(types(events).sort(), ['zone-enter', 'zone-enter-summary']);
  const summary = events.find((e) => e.type === 'zone-enter-summary');
  assert.equal(summary.severity, 'info');
  assert.equal(summary.params.count, 6);
  assert.deepEqual(summary.params.labels, ['TST0', 'TST1', 'TST2']);
  assert.deepEqual(summary.params.assetKeys, ids.slice(0, 6));
  assert.equal(summary.assetKey, null);
  assert.equal(summary.position, null);
  const watched = events.find((e) => e.type === 'zone-enter');
  assert.equal(watched.assetKey, 'a00107');
  assert.equal(watched.severity, 'alert');
  assert.equal(watched.watchlisted, true);
  assert.equal(watched.params.sinceMs, firstInside);
});

test('two enter batches give two summaries that never merge in the inbox', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  const batch = (prefix, count) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  const first = batch('a0031', 8);
  const second = batch('a0032', 6);
  let t = T0;
  const push = (outside, inside) =>
    h.push('flights', {
      nowMs: t,
      rows: [
        ...outside.map((id, i) =>
          aircraft(id, offset(OUTSIDE.lat, OUTSIDE.lon, i * 0.5, 90), t),
        ),
        ...inside.map((id, i) =>
          aircraft(id, offset(INSIDE.lat, INSIDE.lon, i * 0.5, 90), t),
        ),
      ],
    });
  const summaries = [];
  push([...first, ...second], []);
  for (const [outside, inside] of [
    [second, first],
    [second, first],
    [[], [...first, ...second]],
    [[], [...first, ...second]],
  ]) {
    t += 30 * SEC;
    summaries.push(
      ...push(outside, inside).filter((e) => e.type === 'zone-enter-summary'),
    );
  }
  assert.deepEqual(
    summaries.map((e) => e.params.count),
    [8, 6],
  );
  assert.notEqual(summaries[0].dedupeKey, summaries[1].dedupeKey);
  const log = eventLogModule.createWatchEventLog();
  log.add(summaries, { nowMs: t });
  assert.deepEqual(
    log.list().map((row) => [row.params.count, row.repeat]),
    [
      [6, 1],
      [8, 1],
    ],
  );
});

test('five simultaneous enters stay individual events', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  const ids = ['a00201', 'a00202', 'a00203', 'a00204', 'a00205'];
  let t = T0;
  const push = (point) =>
    h.push('flights', {
      nowMs: t,
      rows: ids.map((id) => aircraft(id, point, t)),
    });
  push(OUTSIDE);
  t += 30 * SEC;
  push(INSIDE);
  t += 30 * SEC;
  assert.deepEqual(types(push(INSIDE)), Array(5).fill('zone-enter'));
});

test('six simultaneous exits give one exit summary', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  const ids = ['a00301', 'a00302', 'a00303', 'a00304', 'a00305', 'a00306'];
  let t = T0;
  const push = (point) =>
    h.push('flights', {
      nowMs: t,
      rows: ids.map((id) => aircraft(id, point, t)),
    });
  push(INSIDE);
  t += 30 * SEC;
  push(OUTSIDE);
  t += 30 * SEC;
  const events = push(OUTSIDE);
  assert.deepEqual(types(events), ['zone-exit-summary']);
  assert.equal(events[0].params.count, 6);
  assert.deepEqual(events[0].caveats, []);
});

test('six exit windows coalesce with an unobserved-interval caveat', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  const ids = ['a00401', 'a00402', 'a00403', 'a00404', 'a00405', 'a00406'];
  let t = T0;
  h.push('flights', {
    nowMs: t,
    rows: ids.map((id) => aircraft(id, INSIDE, t)),
  });
  t += 30 * SEC;
  assert.deepEqual(h.push('flights', { nowMs: t, mode: 'stale' }), []);
  t += 30 * SEC;
  const events = h.push('flights', {
    nowMs: t,
    rows: ids.map((id) => aircraft(id, OUTSIDE, t)),
  });
  assert.deepEqual(types(events), ['zone-exit-summary']);
  assert.deepEqual(events[0].caveats, ['unobserved-interval']);
});

// --------------------------------------------------------- feed honesty

test('a held feed mid-dwell gives unknown; recovery outside is an exit window', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00501', INSIDE, t)] });
  const lastInside = t;
  t += 30 * SEC;
  assert.deepEqual(
    h.push('flights', {
      nowMs: t,
      mode: 'stale',
      rows: [aircraft('a00501', OUTSIDE, t)],
    }),
    [],
  );
  const held = zoneView(h.engine, zone.id, t);
  assert.equal(held.perKind.aircraft.answer, 'held');
  assert.equal(held.perKind.aircraft.reason, 'feed-stale');
  assert.equal(held.perKind.aircraft.count, null);
  assert.deepEqual(held.occupants, []);
  t += 30 * SEC;
  const events = h.push('flights', {
    nowMs: t,
    rows: [aircraft('a00501', OUTSIDE, t)],
  });
  assert.deepEqual(types(events), ['zone-exit-window']);
  assert.equal(events[0].severity, 'info');
  assert.deepEqual(events[0].params, { fromMs: lastInside, toMs: t });
});

test('recovery inside resumes the dwell without an event', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00502', OUTSIDE, t)] });
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    h.push('flights', { nowMs: t, rows: [aircraft('a00502', INSIDE, t)] });
  }
  const enteredAt = T0 + 30 * SEC;
  assert.deepEqual(types(h.all), ['zone-enter']);
  for (const mode of ['unavailable', 'off', 'loading', 'degraded']) {
    t += 30 * SEC;
    assert.deepEqual(h.push('flights', { nowMs: t, mode }), []);
  }
  t += 30 * SEC;
  assert.deepEqual(
    h.push('flights', { nowMs: t, rows: [aircraft('a00502', INSIDE, t)] }),
    [],
  );
  const view = zoneView(h.engine, zone.id, t);
  assert.equal(view.occupants[0].enteredAtMs, enteredAt);
  assert.equal(view.occupants[0].lowerBound, false);
});

test('counted absence for 3 aircraft epochs plus 10 min is no longer reported', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', {
    nowMs: t,
    rows: [
      aircraft('a00601', INSIDE, t, { verticalRateMps: -6, altitudeM: 900 }),
      aircraft('a00602', INSIDE, t),
    ],
  });
  const lastFix = t;
  // a00601 is missing from three counted epochs; a00602 from two, then it
  // is reported inside again and resumes.
  for (let i = 0; i < 3; i += 1) {
    t += 30 * SEC;
    const rows = i < 2 ? [] : [aircraft('a00602', INSIDE, t)];
    h.push('flights', { nowMs: t, rows });
  }
  assert.deepEqual(h.tick(T0 + 9 * MIN), []);
  const events = h.tick(T0 + 11 * MIN);
  assert.deepEqual(types(events), ['zone-no-longer-reported']);
  assert.equal(events[0].assetKey, 'a00601');
  assert.equal(events[0].severity, 'info');
  assert.deepEqual(events[0].params, {
    lastFixAtMs: lastFix,
    lastAltM: 900,
    lastOnGround: false,
    descending: true,
  });
});

test('fewer absent epochs expire silently', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00603', INSIDE, t)] });
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    h.push('flights', { nowMs: t, rows: [] });
  }
  assert.deepEqual(h.tick(T0 + 30 * MIN), []);
  assert.deepEqual(zoneView(h.engine, zone.id).occupants, []);
});

test('a vessel needs 1 counted epoch plus 60 min to be no longer reported', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235000601', INSIDE, t)],
  });
  t += MIN;
  h.push('ais-live-vessels', { nowMs: t, rows: [] });
  assert.deepEqual(h.tick(T0 + 50 * MIN), []);
  const events = h.tick(T0 + 62 * MIN);
  assert.deepEqual(types(events), ['zone-no-longer-reported']);
  assert.equal(events[0].kind, 'vessel');
  assert.equal(events[0].params.lastAltM, null);
  assert.equal(events[0].params.descending, null);
});

test('no-longer-reported waits while the feed is held', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const both = (rows, mode = 'counted') => [
    ...h.push('flights', { nowMs: t, rows, mode }),
    ...h.push('military', { nowMs: t + 1, rows: [], mode }),
  ];
  both([aircraft('a00611', INSIDE, t)]);
  // Counted epochs without it until T0 + 8 min (unknown since T0 + 30 s,
  // so due at T0 + 10.5 min), then a held feed across the due time.
  while (t < T0 + 8 * MIN) {
    t += 30 * SEC;
    both([]);
  }
  const held = [];
  while (t < T0 + 12 * MIN) {
    t += 30 * SEC;
    held.push(...both([], 'stale'), ...h.tick(t));
  }
  assert.equal(zoneView(h.engine, zone.id, t).perKind.aircraft.answer, 'held');
  assert.ok(!types(held).includes('zone-no-longer-reported'));
  // A counted answer again: the deferred event can now be reported.
  t += 30 * SEC;
  both([]);
  assert.deepEqual(types(h.tick(t)), ['zone-no-longer-reported']);
});

test('no-longer-reported never fires while the zone is outside the loaded area', () => {
  const zone = circleZone({ kinds: ['vessel'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235000611', INSIDE, t)],
  });
  t += MIN;
  h.push('ais-live-vessels', { nowMs: t, rows: [] });
  // Pan away: the loaded area no longer covers the zone.
  const away = { kind: 'circle', lat: 40, lon: 10, radiusKm: 200 };
  const events = [];
  for (t += MIN; t <= T0 + 150 * MIN; t += MIN) {
    events.push(
      ...h.push('ais-live-vessels', { nowMs: t, rows: [], coverage: away }),
      ...h.tick(t),
    );
  }
  assert.equal(
    zoneView(h.engine, zone.id, t).perKind.vessel.reason,
    'outside-loaded-area',
  );
  assert.ok(!types(events).includes('zone-no-longer-reported'));
  // Past twice the expiry time the member expires silently.
  assert.deepEqual(zoneView(h.engine, zone.id, t).occupants, []);
});

test('a fallback disc partly over the zone gives floor, never no-longer-reported', () => {
  const zone = circleZone();
  const compiled = compileZone(zone);
  // A 438 km disc whose edge crosses the zone.
  const centre = at(438, 0);
  const disc = {
    kind: 'circle',
    lat: centre.lat,
    lon: centre.lon,
    radiusKm: 438,
  };
  assert.equal(coverageOfZone(disc, compiled), 'partial');
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', {
    nowMs: t,
    mode: 'fallback',
    coverage: disc,
    rows: [aircraft('a00701', INSIDE, t)],
  });
  for (let i = 0; i < 8; i += 1) {
    t += 30 * SEC;
    h.push('flights', { nowMs: t, mode: 'fallback', coverage: disc, rows: [] });
  }
  const view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.aircraft.answer, 'floor');
  assert.equal(view.perKind.aircraft.reason, 'partial-coverage');
  assert.equal(view.perKind.aircraft.floor, true);
  assert.deepEqual(h.tick(T0 + 30 * MIN), []);
  assert.deepEqual(h.tick(T0 + 120 * MIN), []);
  assert.ok(!types(h.all).includes('zone-no-longer-reported'));
});

test('enters under a fallback floor carry their caveats', () => {
  const zone = circleZone();
  const centre = at(438, 0);
  const disc = {
    kind: 'circle',
    lat: centre.lat,
    lon: centre.lon,
    radiusKm: 438,
  };
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const push = (point) =>
    h.push('flights', {
      nowMs: t,
      mode: 'fallback',
      coverage: disc,
      rows: [aircraft('a00702', point, t)],
    });
  push(at(30, 0));
  t += 30 * SEC;
  push(at(15, 0));
  t += 30 * SEC;
  const events = push(at(15, 0));
  assert.deepEqual(types(events), ['zone-enter']);
  assert.deepEqual(events[0].caveats, [
    'partial-coverage',
    'regional-fallback',
  ]);
});

test('vessel disc panned away is unknown; back within 30 min resumes; later rechecks', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  const away = { kind: 'circle', lat: ZLAT + 10, lon: ZLON, radiusKm: 100 };
  let t = T0;
  const inZone = (time) => [
    vessel('235000801', INSIDE, time),
    vessel('235000802', at(10, 90), time),
  ];
  h.push('ais-live-vessels', { nowMs: t, rows: inZone(t) });
  t += 5 * MIN;
  assert.deepEqual(
    h.push('ais-live-vessels', {
      nowMs: t,
      coverage: away,
      rows: [vessel('235000899', { lat: ZLAT + 10, lon: ZLON }, t)],
    }),
    [],
  );
  let view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.vessel.answer, 'unknown');
  assert.equal(view.perKind.vessel.reason, 'outside-loaded-area');
  assert.equal(view.perKind.vessel.count, null);
  t = T0 + 20 * MIN;
  assert.deepEqual(
    h.push('ais-live-vessels', { nowMs: t, rows: inZone(t) }),
    [],
  );
  view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.vessel.answer, 'counted');
  assert.equal(view.perKind.vessel.count, 2);
  assert.equal(view.occupants.length, 2);
  assert.ok(view.occupants.every((o) => o.enteredAtMs === T0 - 10 * SEC));

  t += 5 * MIN;
  h.push('ais-live-vessels', { nowMs: t, coverage: away, rows: [] });
  t = T0 + 20 * MIN + 35 * MIN;
  const events = h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235000801', INSIDE, t)],
  });
  assert.deepEqual(types(events), ['zone-rechecked']);
  assert.deepEqual(events[0].params, {
    gapMs: 35 * MIN,
    before: 2,
    after: 1,
    beforeFloor: false,
    afterFloor: false,
  });
  assert.deepEqual(events[0].caveats, []);
  assert.equal(events[0].kind, 'vessel');
  view = zoneView(h.engine, zone.id, t);
  assert.equal(view.occupants.length, 1);
  assert.equal(view.occupants[0].lowerBound, true);
});

test('a recheck against a floor answer marks that count a lower bound', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('military', { nowMs: t, rows: [] });
  h.push('flights', { nowMs: t, rows: [aircraft('a00911', INSIDE, t)] });
  t += 12 * MIN;
  // Military is held now, so the zone answer is a floor.
  h.push('military', { nowMs: t, mode: 'stale' });
  const events = h.push('flights', {
    nowMs: t,
    rows: [aircraft('a00911', INSIDE, t), aircraft('a00912', at(3), t)],
  });
  assert.equal(zoneView(h.engine, zone.id, t).perKind.aircraft.answer, 'floor');
  assert.deepEqual(types(events), ['zone-rechecked']);
  assert.deepEqual(events[0].params, {
    gapMs: 12 * MIN,
    before: 1,
    after: 2,
    beforeFloor: false,
    afterFloor: true,
  });
  assert.deepEqual(events[0].caveats, ['lower-bound']);
});

test('a long aircraft gap re-baselines silently when the count is unchanged', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a00901', INSIDE, t)] });
  t += 20 * MIN;
  // a00901 left and a00902 arrived while the tab was hidden: same count.
  assert.deepEqual(
    h.push('flights', { nowMs: t, rows: [aircraft('a00902', INSIDE, t)] }),
    [],
  );
  t += 30 * SEC;
  assert.deepEqual(
    h.push('flights', { nowMs: t, rows: [aircraft('a00902', INSIDE, t)] }),
    [],
  );
  assert.deepEqual(h.tick(t + 30 * MIN), []);
});

test('same-epoch frames are no-ops', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a01001', OUTSIDE, t)] });
  t += 30 * SEC;
  h.push('flights', { nowMs: t, rows: [aircraft('a01001', INSIDE, t)] });
  const epoch = t;
  const before = h.engine.diagnostics();
  for (let i = 1; i <= 3; i += 1) {
    const events = h.push('flights', {
      nowMs: epoch + i * 5 * SEC,
      lastUpdate: epoch,
      rows: [aircraft('a01001', INSIDE, epoch + i * 5 * SEC)],
    });
    assert.deepEqual(events, []);
  }
  const after = h.engine.diagnostics();
  assert.equal(after.noops - before.noops, 3);
  // The candidate streak is untouched: the next real epoch confirms it.
  t += 60 * SEC;
  assert.deepEqual(
    types(
      h.push('flights', { nowMs: t, rows: [aircraft('a01001', INSIDE, t)] }),
    ),
    ['zone-enter'],
  );
});

// ---------------------------------------------------------------- busy

test('busy mode starts above a median of 30 and ends below 20', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  const ids = Array.from(
    { length: 40 },
    (_, i) => `b${String(i).padStart(5, '0')}`,
  );
  const inside = new Set(ids.slice(0, 35));
  let t = T0;
  const push = () =>
    h.push('flights', {
      nowMs: t,
      rows: ids.map((id, i) =>
        aircraft(id, inside.has(id) ? at(i * 0.3, 90) : at(45, i * 9), t),
      ),
    });
  const busy = () => zoneView(h.engine, zone.id, t).perKind.aircraft.busy;
  for (let i = 0; i < 9; i += 1) {
    push();
    assert.equal(busy(), false, `sample ${i + 1}`);
    t += 30 * SEC;
  }
  push();
  assert.equal(busy(), true);
  // One enters: it is counted, not reported.
  inside.add(ids[35]);
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    assert.deepEqual(push(), []);
  }
  // Eleven leave (36 → 25 inside): still busy at a median of 25.
  for (const id of ids.slice(0, 11)) inside.delete(id);
  for (let i = 0; i < 12; i += 1) {
    t += 30 * SEC;
    assert.deepEqual(push(), []);
  }
  assert.equal(busy(), true);
  assert.ok(h.engine.diagnostics().busyCounted >= 12);
  // Ten more leave (25 → 15): five samples of 15 give a median of 20, which
  // is not below 20; the sixth ends busy mode with one summary.
  for (const id of ids.slice(11, 21)) inside.delete(id);
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    t += 30 * SEC;
    seen.push(...push());
    assert.equal(busy(), true, `still busy after ${i + 1}`);
  }
  assert.deepEqual(seen, []);
  t += 30 * SEC;
  const events = push();
  assert.equal(busy(), false);
  assert.deepEqual(types(events), ['zone-traffic-summary']);
  assert.equal(events[0].params.entered, 1);
  assert.equal(events[0].params.exited, 21);
  assert.equal(events[0].params.noLongerReported, 0);
  assert.equal(events[0].params.median, 15);
  assert.equal(events[0].kind, 'aircraft');
  assert.equal(
    events[0].dedupeKey,
    `zone-traffic-summary|${zone.id}|aircraft:${events[0].params.sinceMs}`,
  );
});

test('a busy zone reports its counters every 10 minutes; watched assets pass', () => {
  const zone = circleZone();
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'icao24', value: 'c00099' }] }),
    { limits: { busyWindowSamples: 2, busyEnterMedian: 1, busyExitMedian: 0 } },
  );
  const crowd = ['c00001', 'c00002', 'c00003'];
  let t = T0;
  const push = (extra) =>
    h.push('flights', {
      nowMs: t,
      rows: [...crowd.map((id) => aircraft(id, INSIDE, t)), ...extra(t)],
    });
  push(() => [aircraft('c00010', OUTSIDE, t), aircraft('c00099', OUTSIDE, t)]);
  t += 30 * SEC;
  push(() => [aircraft('c00010', INSIDE, t), aircraft('c00099', INSIDE, t)]);
  assert.equal(zoneView(h.engine, zone.id, t).perKind.aircraft.busy, true);
  t += 30 * SEC;
  const events = push(() => [
    aircraft('c00010', INSIDE, t),
    aircraft('c00099', INSIDE, t),
  ]);
  assert.deepEqual(types(events), ['zone-enter']);
  assert.equal(events[0].assetKey, 'c00099');
  assert.equal(events[0].severity, 'alert');
  assert.deepEqual(h.tick(T0 + 5 * MIN), []);
  const summary = h.tick(T0 + 12 * MIN);
  assert.deepEqual(types(summary), ['zone-traffic-summary']);
  assert.equal(summary[0].params.entered, 1);
  assert.equal(summary[0].params.sinceMs, T0 + 30 * SEC);
});

// ------------------------------------------------------- hazards scoping

test('fires: one aggregated event per epoch, alert at 100 MW, gap summary', () => {
  const zone = circleZone({ kinds: ['fire'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const known = fire(at(3), T0 - 3 * 60 * MIN, 30);
  h.push('local-firms', { nowMs: t, rows: [known] });
  t += 10 * MIN;
  const events = h.push('local-firms', {
    nowMs: t,
    rows: [
      known,
      fire(at(6, 90), T0 - 60 * MIN, 20, { id: 'FIRE-00002' }),
      fire(at(9, 180), T0 - 30 * MIN, 45, { id: 'FIRE-00003' }),
      fire(at(60), T0 - 30 * MIN, 400, { id: 'FIRE-00004' }),
    ],
  });
  assert.deepEqual(types(events), ['fires-new']);
  assert.equal(events[0].severity, 'notice');
  assert.equal(events[0].kind, 'fire');
  assert.equal(events[0].layerId, 'local-firms');
  assert.deepEqual(events[0].params, {
    count: 2,
    maxFrpMw: 45,
    firstAcqMs: T0 - 60 * MIN,
    lastAcqMs: T0 - 30 * MIN,
  });
  t += 10 * MIN;
  const strong = h.push('local-firms', {
    nowMs: t,
    rows: [known, fire(at(4, 270), T0 - 5 * MIN, 150)],
  });
  assert.deepEqual(types(strong), ['fires-new']);
  assert.equal(strong[0].severity, 'alert');
  // A 40-minute outage, then two new small fires: one gap summary.
  t += 10 * MIN;
  assert.deepEqual(h.push('local-firms', { nowMs: t, mode: 'stale' }), []);
  t += 40 * MIN;
  const gap = h.push('local-firms', {
    nowMs: t,
    rows: [
      known,
      fire(at(5, 30), t - 20 * MIN, 10),
      fire(at(5, 60), t - 10 * MIN, 12),
    ],
  });
  assert.deepEqual(types(gap), ['hazard-gap-summary']);
  assert.deepEqual(gap[0].params, {
    hazard: 'fire',
    count: 2,
    gapMs: 40 * MIN,
  });
  const view = zoneView(h.engine, zone.id, t);
  assert.equal(view.perKind.fire.answer, 'counted');
  assert.equal(view.perKind.fire.count, 3);
});

test('a FIRMS key requirement reads unknown, never 0', () => {
  const zone = circleZone({ kinds: ['fire'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  assert.deepEqual(
    h.push('local-firms', { nowMs: T0, mode: 'key-required' }),
    [],
  );
  const view = zoneView(h.engine, zone.id, T0);
  assert.equal(view.perKind.fire.answer, 'unknown');
  assert.equal(view.perKind.fire.reason, 'key-required');
  assert.equal(view.perKind.fire.count, null);
});

test('quakes: buffer, minimum magnitude and alert magnitude', () => {
  const zone = circleZone({
    kinds: ['quake'],
    patch: { quake: { bufferKm: 25, minMagnitude: 2.5, alertMagnitude: 5 } },
  });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  const old = quake('us7000aaaa', at(5), 3.1, T0 - 60 * MIN);
  h.push('earthquakes', { nowMs: t, rows: [old] });
  t += 5 * MIN;
  const events = h.push('earthquakes', {
    nowMs: t,
    rows: [
      old,
      quake('us7000bbbb', at(35), 4.2, t - MIN),
      quake('us7000cccc', at(80), 6.5, t - MIN),
      quake('us7000dddd', at(3), 2.0, t - MIN),
      quake('QUAKE-0007', at(3), 4.0, t - MIN),
    ],
  });
  assert.deepEqual(types(events), ['quake-new']);
  assert.equal(events[0].severity, 'notice');
  assert.equal(events[0].assetId, 'us7000bbbb');
  assert.equal(events[0].params.usgsId, 'us7000bbbb');
  assert.equal(events[0].params.magnitude, 4.2);
  assert.ok(Math.abs(events[0].params.outsideByKm - 10) < 0.3);
  assert.equal(events[0].params.reportedAfterBaseline, false);
  t += 5 * MIN;
  const strong = h.push('earthquakes', {
    nowMs: t,
    rows: [old, quake('us7000eeee', at(2), 5.4, t - MIN)],
  });
  assert.deepEqual(types(strong), ['quake-new']);
  assert.equal(strong[0].severity, 'alert');
});

// --------------------------------------------------- emergency scoping

test('emergencies outside zones are tracked silently unless all are wanted', () => {
  const zone = circleZone();
  const far = at(300, 90);
  for (const allEmergencies of [false, true]) {
    const h = createHarness(
      makeDoc({ zones: [zone], prefs: { allEmergencies } }),
    );
    let t = T0;
    h.push('flights', {
      nowMs: t,
      rows: [emergencyAircraft('d00001', far, t)],
    });
    t += 30 * SEC;
    const events = h.push('flights', {
      nowMs: t,
      rows: [emergencyAircraft('d00001', far, t)],
    });
    const view = h.engine.view(t);
    assert.equal(view.emergencies.length, 1);
    assert.equal(view.emergencies[0].icao24, 'd00001');
    assert.equal(view.emergencies[0].phase, 'active');
    if (!allEmergencies) {
      assert.deepEqual(events, []);
    } else {
      assert.deepEqual(types(events), ['emergency-start']);
      assert.equal(events[0].zoneId, null);
      assert.equal(events[0].severity, 'alert');
      assert.deepEqual(events[0].params, {
        kind: 'general',
        squawk: '7700',
        source: 'squawk',
        sinceMs: T0,
      });
    }
  }
});

test('an emergency inside a zone is reported; on the ground it is a notice', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', {
    nowMs: t,
    rows: [aircraft('d00002', INSIDE, t), aircraft('d00003', at(2), t)],
  });
  t += 30 * SEC;
  const first = t;
  h.push('flights', {
    nowMs: t,
    rows: [
      emergencyAircraft('d00002', INSIDE, t),
      emergencyAircraft('d00003', at(2), t, { onGround: true }),
    ],
  });
  t += 30 * SEC;
  const events = h.push('flights', {
    nowMs: t,
    rows: [
      emergencyAircraft('d00002', INSIDE, t),
      emergencyAircraft('d00003', at(2), t, { onGround: true }),
    ],
  });
  assert.deepEqual(types(events), ['emergency-start', 'emergency-start']);
  const air = events.find((e) => e.assetKey === 'd00002');
  const ground = events.find((e) => e.assetKey === 'd00003');
  assert.equal(air.zoneId, zone.id);
  assert.equal(air.severity, 'alert');
  assert.equal(air.params.sinceMs, first);
  assert.equal(ground.severity, 'notice');
  assert.deepEqual(ground.caveats, ['on-ground']);
  assert.equal(zoneView(h.engine, zone.id, t).alert, true);

  // A kind change, then the end.
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    const changed = h.push('flights', {
      nowMs: t,
      rows: [
        emergencyAircraft('d00002', INSIDE, t, {
          squawk: '7600',
          emergencyKind: 'nordo',
        }),
        aircraft('d00003', at(2), t, { onGround: true }),
      ],
    });
    if (i === 1) {
      assert.deepEqual(types(changed).sort(), [
        'emergency-change',
        'emergency-end',
      ]);
      const change = changed.find((e) => e.type === 'emergency-change');
      assert.deepEqual(change.params, {
        fromKind: 'general',
        kind: 'nordo',
        squawk: '7600',
        source: 'squawk',
      });
      const end = changed.find((e) => e.type === 'emergency-end');
      assert.equal(end.assetKey, 'd00003');
      assert.equal(end.severity, 'info');
      assert.equal(end.params.kind, 'general');
    }
  }
});

test('a watched aircraft emergency is reported anywhere; unresolved after 3 epochs', () => {
  const zone = circleZone();
  const h = createHarness(
    makeDoc({
      zones: [zone],
      watch: [{ match: 'callsign', value: 'TEST 77' }],
    }),
  );
  const far = at(400, 200);
  let t = T0;
  for (let i = 0; i < 2; i += 1) {
    const events = h.push('flights', {
      nowMs: t,
      rows: [emergencyAircraft('d00004', far, t, { callsign: 'TEST77' })],
    });
    if (i === 1) {
      assert.deepEqual(types(events), ['emergency-start']);
      assert.equal(events[0].watchlisted, true);
      assert.equal(events[0].assetLabel, 'TEST77');
    }
    t += 30 * SEC;
  }
  let unresolved = [];
  for (let i = 0; i < 3; i += 1) {
    unresolved = h.push('flights', { nowMs: t, rows: [] });
    t += 30 * SEC;
  }
  assert.ok(types(unresolved).includes('emergency-unresolved'));
  const event = unresolved.find((e) => e.type === 'emergency-unresolved');
  assert.equal(event.params.kind, 'general');
  assert.equal(event.params.squawk, '7700');
  assert.equal(event.params.lastFixAtMs, T0 + 30 * SEC);
});

test('an emergency reported in a zone stays in scope after it leaves', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('d00005', INSIDE, t)] });
  const seq = [
    [INSIDE, true],
    [INSIDE, true],
    [OUTSIDE, true],
    [OUTSIDE, true],
    [at(60), false],
    [at(70), false],
  ];
  for (const [point, squawking] of seq) {
    t += 30 * SEC;
    h.push('flights', {
      nowMs: t,
      rows: [
        squawking
          ? emergencyAircraft('d00005', point, t)
          : aircraft('d00005', point, t),
      ],
    });
  }
  assert.deepEqual(types(h.all), [
    'emergency-start',
    'zone-exit',
    'emergency-end',
  ]);
  const end = h.all[2];
  assert.equal(end.zoneId, null);
  assert.equal(end.params.durationMs, 90 * SEC);
});

test('a reported emergency forgotten silently leaves no follow-up in scope', () => {
  const h = createHarness(
    makeDoc({ watch: [{ match: 'icao24', value: 'd00006' }] }),
  );
  const far = at(500);
  let t = T0;
  const poll = (rows, mode = 'counted') =>
    h.push('flights', { nowMs: t, rows, mode });
  h.push('military', { nowMs: t, rows: [] });
  poll([emergencyAircraft('d00006', far, t)]);
  t += 30 * SEC;
  assert.deepEqual(types(poll([emergencyAircraft('d00006', far, t)])), [
    'emergency-start',
  ]);
  // Held for over an hour: the track turns unknown and is forgotten.
  for (let i = 0; i < 62; i += 1) {
    t += MIN;
    poll([], 'stale');
  }
  assert.equal(h.engine.diagnostics().emergency.forgotten, 1);
  // Unwatched now; a new emergency outside every zone is out of scope,
  // its end included.
  h.engine.setDocument(makeDoc());
  t += 60 * MIN;
  const out = [];
  for (const squawking of [true, true, false, false]) {
    out.push(
      ...poll([
        squawking
          ? emergencyAircraft('d00006', far, t)
          : aircraft('d00006', far, t),
      ]),
    );
    t += 30 * SEC;
  }
  assert.deepEqual(types(out), []);
  assert.equal(h.engine.diagnostics().emergencyOutOfScope, 2);
});

// ---------------------------------------------------------- document edits

test('a geometry edit re-baselines only that zone', () => {
  const z1 = circleZone({ name: 'One' });
  const otherCentre = offset(ZLAT, ZLON, 200, 90);
  const z2 = circleZone({
    name: 'Two',
    lat: otherCentre.lat,
    lon: otherCentre.lon,
  });
  let doc = makeDoc({ zones: [z1, z2] });
  const h = createHarness(doc);
  const nearOne = at(35);
  const outTwo = offset(otherCentre.lat, otherCentre.lon, 40, 0);
  const inTwo = offset(otherCentre.lat, otherCentre.lon, 5, 0);
  let t = T0;
  const push = (bPoint) =>
    h.push('flights', {
      nowMs: t,
      rows: [aircraft('e00001', nearOne, t), aircraft('e00002', bPoint, t)],
    });
  push(outTwo);
  t += 30 * SEC;
  push(inTwo);
  // Grow zone one to 50 km: e00001 is now inside it.
  const grown = updateZone(z1, { radiusM: 50_000 }, { nowMs: t });
  assert.ok(grown.ok && grown.geometryChanged);
  const replaced = replaceZone(doc, grown.zone);
  assert.ok(replaced.ok, replaced.code);
  doc = replaced.doc;
  h.engine.setDocument(doc);
  t += 30 * SEC;
  const events = push(inTwo);
  assert.deepEqual(types(events), ['zone-enter']);
  assert.equal(events[0].zoneId, z2.id);
  t += 30 * SEC;
  assert.deepEqual(push(inTwo), []);
  const one = zoneView(h.engine, z1.id, t);
  assert.equal(one.occupants[0].assetKey, 'e00001');
  assert.equal(one.occupants[0].lowerBound, true);
});

test('a filter edit re-baselines only that kind; removed zones drop state', () => {
  const zone = circleZone();
  let doc = makeDoc({ zones: [zone] });
  const h = createHarness(doc);
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('e00010', INSIDE, t)] });
  h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235001001', OUTSIDE, t)],
  });
  t += 30 * SEC;
  h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235001001', INSIDE, t)],
  });
  const military = updateZone(
    zone,
    { aircraft: { militaryOnly: true } },
    { nowMs: t },
  );
  doc = replaceZone(doc, military.zone).doc;
  h.engine.setDocument(doc);
  let view = zoneView(h.engine, zone.id, t);
  assert.deepEqual(view.occupants, []);
  t += 30 * SEC;
  const events = h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235001001', INSIDE, t)],
  });
  assert.deepEqual(types(events), ['zone-enter']);
  assert.equal(events[0].kind, 'vessel');
  h.engine.setDocument(emptyWatchDocument());
  view = h.engine.view(t);
  assert.deepEqual(view.zones, []);
  assert.equal(h.engine.diagnostics().members, 0);
});

test('notify watchlisted and none suppress unwatched zone events', () => {
  for (const notify of ['watchlisted', 'none']) {
    const zone = circleZone({
      kinds: ['aircraft', 'fire'],
      patch: { notify },
    });
    const h = createHarness(
      makeDoc({ zones: [zone], watch: [{ match: 'icao24', value: 'f00002' }] }),
    );
    let t = T0;
    const push = (point) =>
      h.push('flights', {
        nowMs: t,
        rows: [aircraft('f00001', point, t), aircraft('f00002', point, t)],
      });
    push(OUTSIDE);
    t += 30 * SEC;
    push(INSIDE);
    t += 30 * SEC;
    const events = push(INSIDE);
    assert.deepEqual(types(events), ['zone-enter']);
    assert.equal(events[0].assetKey, 'f00002');
    assert.equal(events[0].severity, 'alert');
    h.push('local-firms', { nowMs: t, rows: [] });
    t += 10 * MIN;
    assert.deepEqual(
      h.push('local-firms', { nowMs: t, rows: [fire(INSIDE, t - MIN, 500)] }),
      [],
    );
    assert.ok(h.engine.diagnostics().suppressedByNotify >= 2);
  }
});

// ---------------------------------------------------------------- feeds

test('a needed feed pauses once after 2 evaluations over 2 minutes, then resumes', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [] });
  h.push('ais-live-vessels', { nowMs: t, rows: [] });
  t += 30 * SEC;
  assert.deepEqual(h.push('flights', { nowMs: t, mode: 'stale' }), []);
  assert.deepEqual(h.push('ais-live-vessels', { nowMs: t, mode: 'stale' }), []);
  t += 60 * SEC;
  assert.deepEqual(h.push('flights', { nowMs: t, mode: 'stale' }), []);
  t += 60 * SEC;
  const paused = h.push('flights', { nowMs: t, mode: 'stale' });
  assert.deepEqual(types(paused), ['feed-paused']);
  assert.equal(paused[0].layerId, 'flights');
  assert.equal(paused[0].zoneId, null);
  assert.deepEqual(paused[0].params, {
    reason: 'feed-stale',
    sinceMs: T0 + 30 * SEC,
  });
  assert.equal(paused[0].dedupeKey, 'feed-paused||flights');
  // Vessels are not needed by any zone or watched asset: no event.
  assert.deepEqual(h.push('ais-live-vessels', { nowMs: t, mode: 'stale' }), []);
  t += 60 * SEC;
  assert.deepEqual(h.push('flights', { nowMs: t, mode: 'stale' }), []);
  assert.equal(h.engine.view(t).feeds.flights.paused, true);
  t += 30 * SEC;
  const resumed = h.push('flights', { nowMs: t, rows: [] });
  assert.deepEqual(types(resumed), ['feed-resumed']);
  assert.deepEqual(resumed[0].params, { pausedMs: t - (T0 + 30 * SEC) });
  assert.equal(h.engine.view(t).feeds.flights.paused, false);
});

test('a feed turned off never reads paused', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [] });
  for (let i = 0; i < 6; i += 1) {
    t += 60 * SEC;
    assert.deepEqual(h.push('flights', { nowMs: t, mode: 'off' }), []);
  }
  t += 60 * SEC;
  assert.deepEqual(h.push('flights', { nowMs: t, rows: [] }), []);
  const view = h.engine.view(t);
  assert.equal(view.feeds.flights.answer, 'counted');
  assert.equal(view.feeds.military.answer, 'unknown');
  assert.equal(view.feeds.military.reason, 'never-answered');
});

// ------------------------------------------------------------ watchlist

test('watched aircraft: not reported, then reappeared; last seen updates', () => {
  const h = createHarness(
    makeDoc({ watch: [{ match: 'icao24', value: 'a0beef', label: 'Test 1' }] }),
  );
  const point = at(100, 45);
  let t = T0;
  const pushBoth = (present) => {
    const events = [
      ...h.push('flights', {
        nowMs: t,
        rows: present ? [aircraft('a0beef', point, t)] : [],
      }),
      ...h.push('military', { nowMs: t + SEC, rows: [] }),
    ];
    t += 30 * SEC;
    return events;
  };
  assert.deepEqual(pushBoth(true), []);
  const updates = h.engine.lastSeenUpdates();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].lastSeen, {
    atMs: T0,
    lat: point.lat,
    lon: point.lon,
    layerId: 'flights',
  });
  assert.deepEqual(h.engine.lastSeenUpdates(), []);
  let row = h.engine.view(t).watchlist[0];
  assert.equal(row.presence.state, 'live');
  assert.equal(row.label, 'Test 1');
  assert.equal(row.kind, 'aircraft');
  const absent = [];
  for (let i = 0; i < 3; i += 1) absent.push(...pushBoth(false));
  assert.deepEqual(types(absent), ['watch-not-reported']);
  const notReported = absent[0];
  assert.equal(notReported.severity, 'notice');
  assert.equal(notReported.watchlisted, true);
  assert.deepEqual(notReported.params, { lastSeenAtMs: T0 });
  assert.deepEqual(notReported.position, { lat: point.lat, lon: point.lon });
  assert.equal(notReported.dedupeKey, 'watch-not-reported||icao24:a0beef');
  row = h.engine.view(t).watchlist[0];
  assert.equal(row.presence.state, 'not-reported');
  // Ticks without new frames are no new absence evidence.
  assert.deepEqual(h.tick(t), []);
  for (let i = 0; i < 44; i += 1) assert.deepEqual(pushBoth(false), []);
  const back = pushBoth(true);
  assert.deepEqual(types(back), ['watch-reappeared']);
  assert.equal(back[0].severity, 'alert');
  assert.ok(back[0].params.absentMs >= 20 * MIN);
  assert.ok(back[0].params.coveredShare >= 0.8);
});

test('watched aircraft: back after a stale stretch is seen with a caveat', () => {
  const h = createHarness(
    makeDoc({ watch: [{ match: 'icao24', value: 'a0cafe' }] }),
  );
  const point = at(10);
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a0cafe', point, t)] });
  for (let i = 0; i < 3; i += 1) {
    t += 30 * SEC;
    assert.deepEqual(h.push('flights', { nowMs: t, mode: 'stale' }), []);
  }
  assert.equal(h.engine.view(t).watchlist[0].presence.state, 'feed-stale');
  t += 30 * SEC;
  const events = h.push('flights', {
    nowMs: t,
    rows: [aircraft('a0cafe', point, t)],
  });
  assert.deepEqual(types(events), ['watch-seen']);
  assert.deepEqual(events[0].params, { layerId: 'flights' });
  assert.deepEqual(events[0].caveats, ['coverage-incomplete']);
});

test('watched aircraft: a paused feed is no stale stretch of the asset', () => {
  const h = createHarness(
    makeDoc({ watch: [{ match: 'icao24', value: 'a0cab1' }] }),
  );
  const point = at(5);
  let t = T0;
  const both = () => [
    ...h.push('flights', { nowMs: t, rows: [aircraft('a0cab1', point, t)] }),
    ...h.push('military', { nowMs: t + 1, rows: [] }),
  ];
  for (let i = 0; i < 3; i += 1) {
    both();
    t += 30 * SEC;
  }
  // Polling pauses for 5 minutes (a hidden tab); only ticks run.
  const paused = [];
  for (const end = t + 5 * MIN; t < end; t += 30 * SEC) {
    paused.push(...h.tick(t));
  }
  assert.equal(h.engine.view(t).watchlist[0].presence.state, 'stale-fix');
  assert.deepEqual(paused, []);
  assert.deepEqual(types(both()), []);
});

test('a watched vessel inside a zone lists the zone and escalates its exit', () => {
  const zone = circleZone({ kinds: ['vessel'] });
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'mmsi', value: '235002001' }] }),
  );
  let t = T0;
  h.push('ais-live-vessels', {
    nowMs: t,
    rows: [vessel('235002001', INSIDE, t)],
  });
  let row = h.engine.view(t).watchlist[0];
  assert.deepEqual(row.zoneIds, [zone.id]);
  assert.equal(row.presence.state, 'live');
  const exits = [];
  for (let i = 0; i < 2; i += 1) {
    t += MIN;
    exits.push(
      ...h.push('ais-live-vessels', {
        nowMs: t,
        rows: [vessel('235002001', OUTSIDE, t)],
      }),
    );
  }
  assert.deepEqual(types(exits), ['zone-exit']);
  assert.equal(exits[0].severity, 'alert');
  assert.equal(exits[0].watchlisted, true);
  assert.deepEqual(exits[0].caveats, ['lower-bound']);
  assert.equal(exits[0].params.dwellLowerBound, true);
  row = h.engine.view(t).watchlist[0];
  assert.deepEqual(row.zoneIds, []);
});

test('the privacy guard declines civil bizjets and pleasure craft', () => {
  const zone = circleZone();
  const calls = [];
  const h = createHarness(
    makeDoc({
      zones: [zone],
      watch: [
        { match: 'icao24', value: 'b0b0b0' },
        { match: 'mmsi', value: '235003001' },
        { match: 'icao24', value: 'b1b1b1' },
      ],
    }),
    { onDeclined: (entryId, code) => calls.push([entryId, code]) },
  );
  let t = T0;
  const push = (point) => [
    ...h.push('flights', {
      nowMs: t,
      rows: [
        aircraft('b0b0b0', point, t, { aircraftClass: 'bizjet' }),
        aircraft('b1b1b1', point, t, {
          aircraftClass: 'bizjet',
          military: true,
        }),
      ],
    }),
    ...h.push('ais-live-vessels', {
      nowMs: t,
      rows: [vessel('235003001', point, t, { shipType: '37' })],
    }),
  ];
  push(OUTSIDE);
  const declined = h.engine.declinedUpdates();
  const [civil, boat, mil] = h.engine.view(t).watchlist;
  assert.deepEqual(declined, [
    { entryId: civil.entryId, code: 'private-aircraft-class' },
    { entryId: boat.entryId, code: 'private-vessel-type' },
  ]);
  assert.deepEqual(h.engine.declinedUpdates(), []);
  assert.equal(civil.presence.state, 'declined');
  assert.equal(civil.fix, null);
  assert.equal(mil.presence.state, 'live');
  const updates = h.engine.lastSeenUpdates().map((u) => u.entryId);
  assert.deepEqual(updates, [mil.entryId]);
  t += MIN;
  push(INSIDE);
  t += MIN;
  const events = push(INSIDE);
  const enters = events.filter((e) => e.type === 'zone-enter');
  assert.equal(enters.length, 3);
  const byKey = Object.fromEntries(enters.map((e) => [e.assetKey, e]));
  assert.equal(byKey.b0b0b0.watchlisted, false);
  assert.equal(byKey.b0b0b0.severity, 'notice');
  assert.equal(byKey['235003001'].watchlisted, false);
  assert.equal(byKey.b1b1b1.watchlisted, true);
  assert.equal(byKey.b1b1b1.severity, 'alert');
  assert.deepEqual(
    calls,
    declined.map((d) => [d.entryId, d.code]),
  );
});

test('a watched civil aircraft without a type code is not followed', () => {
  const zone = circleZone({ kinds: ['aircraft'] });
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'callsign', value: 'N628TS' }] }),
  );
  let t = T0;
  // Not enriched yet: its class is only the OpenSky default.
  const jet = (point) =>
    aircraft('a1b2c3', point, t, { callsign: 'N628TS', typeCode: null });
  const push = (point) => [
    ...h.push('flights', { nowMs: t, rows: [jet(point)] }),
    ...h.push('military', { nowMs: t + 1, rows: [] }),
  ];
  const events = [...push(OUTSIDE)];
  for (let i = 0; i < 3; i += 1) {
    t += 30 * SEC;
    events.push(...push(INSIDE));
  }
  const row = h.engine.view(t).watchlist[0];
  assert.deepEqual(row.presence, {
    state: 'checking',
    reason: 'class-unknown',
  });
  assert.equal(row.fix, null);
  assert.deepEqual(row.zoneIds, []);
  // The brief does not list it as a watched asset inside the zone.
  const brief = h.engine.brief(zone.id, { nowMs: t });
  assert.equal(
    brief.sections.find((section) => section.id === 'watched')?.highlights
      .length ?? 0,
    0,
  );
  // It leaves the feed and comes back: still no watch events.
  for (let i = 0; i < 4; i += 1) {
    t += 30 * SEC;
    events.push(...h.push('flights', { nowMs: t, rows: [] }), ...h.tick(t));
  }
  t += 30 * MIN;
  for (let i = 0; i < 2; i += 1) {
    t += 30 * SEC;
    events.push(...push(INSIDE));
  }
  assert.deepEqual(h.engine.lastSeenUpdates(), []);
  assert.deepEqual(h.engine.declinedUpdates(), []);
  // Zone events treat it as any unwatched aircraft; no watch events at all.
  assert.ok(!events.some((e) => e.type.startsWith('watch-')));
  const enter = events.find((e) => e.type === 'zone-enter');
  assert.equal(enter.watchlisted, false);
  assert.equal(enter.severity, 'notice');
});

test('watched satellites resolve from lookups with an exact NORAD match', () => {
  const h = createHarness(
    makeDoc({ watch: [{ match: 'norad', value: '25544' }] }),
  );
  let row = h.engine.view(T0).watchlist[0];
  assert.equal(row.presence.state, 'checking');
  const events = h.engine.setSatellites(
    [
      {
        norad: '25544',
        enabled: true,
        ready: true,
        result: { noradId: 25544, name: 'ISS', latitude: 10, longitude: 20 },
        atMs: T0,
      },
    ],
    T0,
  );
  assert.deepEqual(events, []);
  row = h.engine.view(T0).watchlist[0];
  assert.equal(row.presence.state, 'computed');
  assert.equal(row.fix.lat, 10);
  assert.equal(row.layerId, 'satellites');
  h.engine.setSatellites(
    new Map([
      [
        '25544',
        {
          enabled: true,
          ready: true,
          result: { noradId: 255440, latitude: 1, longitude: 2 },
        },
      ],
    ]),
    T0 + MIN,
  );
  row = h.engine.view(T0 + MIN).watchlist[0];
  assert.equal(row.presence.state, 'not-in-catalog');
  assert.equal(row.presence.reason, 'id-mismatch');
  h.engine.setSatellites({ 25544: { enabled: false } }, T0 + 2 * MIN);
  assert.equal(
    h.engine.view(T0 + 2 * MIN).watchlist[0].presence.state,
    'feed-off',
  );
  assert.deepEqual(h.engine.lastSeenUpdates(), []);
});

// ------------------------------------------------------------- limits

test('member caps mark zones capped', () => {
  const z1 = circleZone({ name: 'One' });
  const c2 = offset(ZLAT, ZLON, 200, 90);
  const z2 = circleZone({ name: 'Two', lat: c2.lat, lon: c2.lon });
  const h = createHarness(makeDoc({ zones: [z1, z2] }), {
    limits: { maxMembersPerZone: 3, maxMembersTotal: 5 },
  });
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(aircraft(`f1000${i}`, at(i), T0));
    rows.push(aircraft(`f2000${i}`, offset(c2.lat, c2.lon, i, 0), T0));
  }
  h.push('flights', { nowMs: T0, rows });
  const view = h.engine.view(T0);
  assert.equal(view.zones[0].capped, true);
  assert.equal(view.zones[1].capped, true);
  assert.equal(h.engine.diagnostics().members, 5);
  assert.equal(view.zones[0].perKind.aircraft.count, 5);
  assert.ok(view.zones[0].occupants.length <= 3);
});

test('events per ingest are capped, lowest severity dropped first', () => {
  const zone = circleZone();
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'icao24', value: 'f30009' }] }),
    { limits: { eventsPerIngest: 2, coalesceAbove: 100 } },
  );
  const ids = ['f30001', 'f30002', 'f30003', 'f30009'];
  let t = T0;
  const push = (point) =>
    h.push('flights', {
      nowMs: t,
      rows: ids.map((id) => aircraft(id, point, t)),
    });
  push(OUTSIDE);
  t += 30 * SEC;
  push(INSIDE);
  t += 30 * SEC;
  const events = push(INSIDE);
  assert.equal(events.length, 2);
  assert.ok(
    events.some((e) => e.assetKey === 'f30009' && e.severity === 'alert'),
  );
  assert.equal(h.engine.diagnostics().dropped, 2);
  assert.ok(events[0].seq < events[1].seq);
});

// --------------------------------------------------------- view & brief

test('the view and the brief are JSON-safe', () => {
  const zone = circleZone({ kinds: ['aircraft', 'vessel', 'fire', 'quake'] });
  const h = createHarness(
    makeDoc({ zones: [zone], watch: [{ match: 'icao24', value: 'a0f00d' }] }),
  );
  const t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a0f00d', INSIDE, t)] });
  h.push('ais-live-vessels', { nowMs: t, mode: 'stale' });
  h.push('local-firms', { nowMs: t, rows: [fire(INSIDE, t - MIN)] });
  h.push('earthquakes', { nowMs: t, mode: 'off' });
  const view = h.engine.view(t);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.equal(view.generatedAtMs, t);
  const zv = view.zones[0];
  assert.deepEqual(Object.keys(zv), [
    'id',
    'name',
    'shape',
    'kinds',
    'notify',
    'alert',
    'labelAnchor',
    'outline',
    'perKind',
    'occupants',
    'timed',
    'capped',
    'series',
  ]);
  assert.equal(zv.outline.length, 97);
  assert.deepEqual(zv.kinds, ['aircraft', 'vessel', 'fire', 'quake']);
  assert.equal(zv.perKind.aircraft.answer, 'counted');
  assert.equal(zv.perKind.vessel.answer, 'held');
  assert.equal(zv.perKind.vessel.count, null);
  assert.equal(zv.perKind.fire.count, 1);
  assert.equal(zv.perKind.quake.answer, 'off');
  assert.equal(zv.perKind.quake.count, null);
  assert.equal(zv.series.aircraft.median, 1);
  assert.equal(zv.series.vessel, null);
  assert.deepEqual(Object.keys(view.watchlist[0]), [
    'entryId',
    'kind',
    'match',
    'value',
    'label',
    'presence',
    'fix',
    'layerId',
    'zoneIds',
    'matches',
    'lastSeen',
    'sinceMs',
  ]);
  assert.deepEqual(view.watchlist[0].zoneIds, [zone.id]);
  assert.deepEqual(Object.keys(view.feeds), [
    'flights',
    'military',
    'ais-live-vessels',
    'local-firms',
    'earthquakes',
  ]);
  const text = JSON.stringify(view);
  assert.equal(/\b(?:owner|registrant|operator)\b/i.test(text), false);
  assert.equal(/dark|disappear|vanish|hijack/i.test(text), false);

  const brief = h.engine.brief(zone.id, { nowMs: t, recentEvents: h.all });
  assert.deepEqual(JSON.parse(JSON.stringify(brief)), brief);
  assert.equal(brief.zoneId, zone.id);
  assert.deepEqual(
    brief.sections.map((s) => s.id),
    [...BRIEF_SECTION_IDS],
  );
  const air = brief.sections.find((s) => s.id === 'aircraft');
  assert.equal(air.answer, 'counted');
  assert.equal(air.count, 1);
  const vessels = brief.sections.find((s) => s.id === 'vessels');
  assert.equal(vessels.count, null);
  const watched = brief.sections.find((s) => s.id === 'watched');
  assert.equal(watched.count, 1);
  assert.equal(h.engine.brief('z-missing', { nowMs: t }), null);
});

test('reset forgets runtime state and baselines again silently', () => {
  const zone = circleZone();
  const h = createHarness(makeDoc({ zones: [zone] }));
  let t = T0;
  h.push('flights', { nowMs: t, rows: [aircraft('a0ab01', OUTSIDE, t)] });
  t += 30 * SEC;
  h.push('flights', { nowMs: t, rows: [aircraft('a0ab01', INSIDE, t)] });
  const seq = h.engine.diagnostics().seq;
  h.engine.reset();
  const view = h.engine.view(t);
  assert.equal(view.zones.length, 1);
  assert.equal(view.feeds.flights.reason, 'never-answered');
  t += 30 * SEC;
  // A fresh engine state: the aircraft inside is a baseline member.
  assert.deepEqual(
    h.push('flights', { nowMs: t, rows: [aircraft('a0ab01', INSIDE, t)] }),
    [],
  );
  t += 30 * SEC;
  h.push('flights', { nowMs: t, rows: [aircraft('a0ab01', OUTSIDE, t)] });
  t += 30 * SEC;
  const exit = h.push('flights', {
    nowMs: t,
    rows: [aircraft('a0ab01', OUTSIDE, t)],
  });
  assert.deepEqual(types(exit), ['zone-exit']);
  assert.ok(exit[0].seq > seq);
});

test('an injected clock times each ingest; a failing callback is ignored', () => {
  let fake = 0;
  const zone = circleZone();
  const doc = makeDoc({
    zones: [zone],
    watch: [{ match: 'icao24', value: 'b2b2b2' }],
  });
  const engine = createWatchEngine({
    measureMs: () => (fake += 2),
    onDeclined: () => {
      throw new Error('controller failure');
    },
  });
  engine.setDocument(doc);
  const frame = makeFrame('flights', {
    nowMs: T0,
    lastUpdate: T0,
    rows: [aircraft('b2b2b2', INSIDE, T0, { aircraftClass: 'glider' })],
    coverage: { kind: 'global' },
    previousEpochMs: null,
  });
  assert.deepEqual(engine.ingest(frame), []);
  const diag = engine.diagnostics();
  assert.deepEqual(diag.evalMsByLayer.flights, {
    count: 1,
    lastMs: 2,
    maxMs: 2,
    totalMs: 2,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(diag)), diag);
  assert.equal(engine.view(T0).watchlist[0].presence.state, 'declined');
  assert.equal(engine.declinedUpdates().length, 1);
  const plain = createWatchEngine();
  plain.setDocument(doc);
  plain.ingest(frame);
  assert.deepEqual(plain.diagnostics().evalMsByLayer, {});
});

test('a fire-only zone is never timed and has no series', () => {
  const zone = circleZone({ kinds: ['fire'] });
  const h = createHarness(makeDoc({ zones: [zone] }));
  h.push('local-firms', { nowMs: T0, rows: [fire(INSIDE, T0 - MIN)] });
  const view = zoneView(h.engine, zone.id, T0);
  assert.equal(view.timed, false);
  assert.deepEqual(view.series, {});
  assert.deepEqual(view.occupants, []);
  assert.deepEqual(Object.keys(view.perKind), ['fire']);
});

test('malformed input is ignored', () => {
  const engine = createWatchEngine();
  engine.setDocument(null);
  assert.deepEqual(engine.ingest(null), []);
  assert.deepEqual(engine.ingest({ layerId: 'satellites', nowMs: T0 }), []);
  assert.deepEqual(engine.ingest({ layerId: 'flights' }), []);
  assert.deepEqual(engine.tick(Number.NaN), []);
  const view = engine.view();
  assert.deepEqual(view.zones, []);
  assert.deepEqual(view.watchlist, []);
  assert.deepEqual(view.emergencies, []);
  engine.setDocument({
    zones: [{ id: 'z-bad1', shape: 'circle', center: { lat: 99, lon: 0 } }],
    watchlist: [{ id: 'w-bad1', match: 'name', value: 'x' }],
    prefs: {},
  });
  assert.deepEqual(engine.view(T0).zones, []);
  assert.deepEqual(engine.view(T0).watchlist, []);
  assert.equal(engine.diagnostics().invalidZones, 1);
});

test('engine.js and index.js are portable and keep to src/watch imports', () => {
  for (const [file, expected] of [
    [
      './engine.js',
      [
        './brief.js',
        './document.js',
        './emergency.js',
        './frames.js',
        './geometry.js',
        './hazards.js',
        './occupancy.js',
        './presence.js',
        './watchlist.js',
      ],
    ],
    [
      './index.js',
      [
        './brief.js',
        './document.js',
        './emergency.js',
        './engine.js',
        './eventLog.js',
        './frames.js',
        './geometry.js',
        './hazards.js',
        './occupancy.js',
        './presence.js',
        './watchlist.js',
      ],
    ],
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/\bfrom '([^']+)';/g)].map(
      (match) => match[1],
    );
    assert.deepEqual([...new Set(imports)].sort(), expected, file);
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/^(?:import|export)[^;]*?from '[^']+';$/gms, '');
    for (const banned of [
      /\bDate\.now\b/,
      /\bnew Date\b/,
      /\bMath\.random\b/,
      /\bperformance\b/,
      /\bset(?:Timeout|Interval)\b/,
      /\brequestAnimationFrame\b/,
      // 'zone-exit-window' is an event code, not the browser global.
      /\b(?:window|document)\s*[.[]/,
      /\b(?:globalThis|localStorage|sessionStorage)\b/,
      /\bCesium\b/,
      /\bdark\b/i,
      /\b(?:t|tn|msg)\(/,
      /(?:label|title|status|hint)\s*:\s*['"`]/,
    ]) {
      assert.equal(banned.test(code), false, `${file}: banned ${banned}`);
    }
    assert.equal(
      /\b(?:owner|registrant|operator|person)\b/i.test(code),
      false,
      file,
    );
  }
});

// ----------------------------------------------------------- property

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const REGION_KM = Object.freeze([2, 12, 24.9, 25.1, 27, 40, 90]);
const MODES = Object.freeze([
  ['counted', 0.32],
  ['partial', 0.08],
  ['fallback-partial', 0.08],
  ['outside', 0.08],
  ['stale', 0.1],
  ['degraded', 0.06],
  ['unavailable', 0.08],
  ['loading', 0.06],
  ['off', 0.14],
]);

function pickMode(rnd) {
  let r = rnd();
  for (const [mode, weight] of MODES) {
    if (r < weight) return mode;
    r -= weight;
  }
  return 'counted';
}

test('property: held, unknown or off frames never report exits or absence', () => {
  const zone = circleZone();
  const compiled = compileZone(zone);
  const partialDisc = (() => {
    const c = at(438, 0);
    return { kind: 'circle', lat: c.lat, lon: c.lon, radiusKm: 438 };
  })();
  const awayDisc = { kind: 'circle', lat: ZLAT + 12, lon: ZLON, radiusKm: 100 };
  assert.equal(coverageOfZone(awayDisc, compiled), 'none');
  const doc = makeDoc({
    zones: [zone],
    watch: [
      { match: 'icao24', value: 'a90001' },
      { match: 'icao24', value: 'a90004' },
      { match: 'mmsi', value: '235900002' },
    ],
  });
  const answeringTotals = new Map();
  let blindFrames = 0;
  let blackoutRuns = 0;
  for (let run = 0; run < 500; run += 1) {
    const rnd = mulberry32(run + 1);
    const engine = createWatchEngine();
    engine.setDocument(doc);
    const blackout = run % 5 === 0;
    if (blackout) blackoutRuns += 1;
    const assets = [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `a9000${i + 1}`,
        kind: 'aircraft',
        region: Math.floor(rnd() * REGION_KM.length),
        bearing: rnd() * 360,
        fix: new Map(),
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `23590000${i + 1}`,
        kind: 'vessel',
        region: Math.floor(rnd() * REGION_KM.length),
        bearing: rnd() * 360,
        fix: new Map(),
      })),
    ];
    const lastEpoch = new Map();
    let t = T0;
    const steps = 20 + Math.floor(rnd() * 25);
    const layers = ['flights', 'military', 'ais-live-vessels'];
    for (let step = 0; step < steps; step += 1) {
      t += 5 * SEC + Math.floor(rnd() * 85 * SEC);
      if (rnd() < 0.05) t += Math.floor(rnd() * 40 * MIN);
      if (rnd() < 0.15) {
        const ticked = checkEvents(engine.tick(t));
        if (blackout && step >= 3) {
          for (const event of ticked) {
            assert.ok(
              !FORBIDDEN_ON_BLIND.includes(event.type),
              `run ${run} blackout tick gave ${event.type}`,
            );
          }
        }
      }
      const layerId =
        blackout && step < 3 ? layers[step] : layers[Math.floor(rnd() * 3)];
      let mode = blackout && step < 3 ? 'counted' : pickMode(rnd);
      if (
        blackout &&
        step >= 3 &&
        ['counted', 'partial', 'fallback-partial', 'outside'].includes(mode)
      ) {
        mode = ['stale', 'unavailable', 'off', 'loading', 'degraded'][
          Math.floor(rnd() * 5)
        ];
      }
      for (const asset of assets) {
        if (rnd() < 0.3) {
          asset.region = Math.max(
            0,
            Math.min(
              REGION_KM.length - 1,
              asset.region + (rnd() < 0.5 ? -1 : 1),
            ),
          );
        }
      }
      const kind = layerId === 'ais-live-vessels' ? 'vessel' : 'aircraft';
      const rows = [];
      for (const asset of assets) {
        if (asset.kind !== kind || rnd() < 0.15) continue;
        const point = at(REGION_KM[asset.region], asset.bearing);
        const fresh = rnd() < 0.8 || !asset.fix.has(layerId);
        const fixAt = fresh ? t : asset.fix.get(layerId);
        asset.fix.set(layerId, fixAt);
        rows.push(
          kind === 'aircraft'
            ? aircraft(asset.id, point, fixAt, {
                military: layerId === 'military',
              })
            : vessel(asset.id, point, fixAt + 10 * SEC),
        );
      }
      const prev = lastEpoch.get(layerId) ?? null;
      const held = HELD_MODES.includes(mode);
      let coverage = defaultCoverage(layerId);
      let frameMode = mode;
      if (mode === 'fallback-partial') {
        coverage = partialDisc;
        frameMode = 'fallback';
      } else if (mode === 'outside') {
        coverage = awayDisc;
        frameMode = 'counted';
      }
      const frame = makeFrame(layerId, {
        nowMs: t,
        rows,
        mode: frameMode,
        coverage,
        lastUpdate: held ? (prev ?? t) : t,
        previousEpochMs: prev,
      });
      if (frame.epochMs !== null) lastEpoch.set(layerId, frame.epochMs);
      const events = checkEvents(engine.ingest(frame));
      const blind =
        !isAnswering(frame.answer) ||
        (layerId !== 'military' &&
          coverageOfZone(frame.coverage, compiled) === 'none');
      if (blind || (blackout && step >= 3)) {
        blindFrames += 1;
        for (const event of events) {
          assert.ok(
            !FORBIDDEN_ON_BLIND.includes(event.type),
            `run ${run} step ${step}: ${frame.answer.state} ${layerId} gave ${event.type}`,
          );
        }
      } else {
        for (const event of events) {
          answeringTotals.set(
            event.type,
            (answeringTotals.get(event.type) ?? 0) + 1,
          );
        }
      }
    }
  }
  assert.equal(blackoutRuns, 100);
  assert.ok(blindFrames > 2_000, `blind frames ${blindFrames}`);
  // The property is not vacuous: answering frames do produce these events.
  for (const type of ['zone-exit', 'zone-exit-window', 'zone-enter']) {
    assert.ok((answeringTotals.get(type) ?? 0) > 0, `answering ${type}`);
  }
});

// ------------------------------------------------------- catalogue check

test('every catalogued event type was produced with allow-listed params', () => {
  const produced = new Set(ALL_EVENTS.map((event) => event.type));
  for (const type of Object.keys(WATCH_EVENT_CATALOGUE)) {
    assert.ok(produced.has(type), `no test produced ${type}`);
  }
  const ids = new Set();
  for (const event of ALL_EVENTS) {
    const allowed = WATCH_EVENT_CATALOGUE[event.type].params;
    for (const key of Object.keys(event.params)) {
      assert.ok(allowed.includes(key), `${event.type}.${key}`);
    }
    ids.add(event.id);
  }
  assert.ok(ids.size > 0);
});
