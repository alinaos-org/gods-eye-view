// src/watch/watchlist.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WATCHLIST_POLICY,
  WATCH_EVENT_TYPES,
  WATCH_LAYERS,
  WATCH_PRESENCE,
  compileWatchlist,
  createWatchTracker,
  matchAsset,
  resolveWatchPresence,
  watchClassKnown,
  watchEligibility,
} from './watchlist.js';

const T0 = 1_760_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
const LONDON = Object.freeze({ lat: 51.47, lon: -0.45 });
const NEW_YORK = Object.freeze({ lat: 40.64, lon: -73.78 });
const DISC_438 = Object.freeze({
  kind: 'circle',
  lat: 51.5,
  lon: -0.25,
  radiusKm: 438,
});
const GLOBAL = Object.freeze({ kind: 'global' });

/** Every output collected by the tests, checked for banned words at the end. */
const OUTPUTS = [];
function keep(value) {
  OUTPUTS.push(value);
  return value;
}

// ---------------------------------------------------------------- helpers

const KIND_OF = {
  flights: 'aircraft',
  military: 'aircraft',
  'ais-live-vessels': 'vessel',
};

function aircraft(overrides = {}) {
  const id = overrides.id ?? 'abc123';
  return {
    key: id,
    kind: 'aircraft',
    id,
    label: 'UAL123',
    callsign: 'UAL123',
    lat: LONDON.lat,
    lon: LONDON.lon,
    altM: 3_000,
    speedMps: 200,
    headingDeg: 90,
    vRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    // Enriched: the guard can judge it (see watchClassKnown).
    typeCode: 'A320',
    squawk: null,
    emergency: false,
    emergencyKind: null,
    emergencySource: null,
    fixAtMs: T0,
    contactAtMs: T0,
    layerId: 'flights',
    ...overrides,
  };
}

function vessel(overrides = {}) {
  const id = overrides.id ?? '235000001';
  return {
    key: id,
    kind: 'vessel',
    id,
    label: 'NORTHERN STAR',
    lat: 50.9,
    lon: -1.4,
    speedKts: 12,
    courseDeg: 180,
    shipType: '71',
    fixAtMs: T0,
    layerId: 'ais-live-vessels',
    ...overrides,
  };
}

function frame(layerId, options = {}) {
  const {
    state = 'counted',
    reason = null,
    coverage = GLOBAL,
    assets = [],
    nowMs = T0,
  } = options;
  const answering = state === 'counted' || state === 'floor';
  const list = answering || options.forceAssets ? assets : [];
  return {
    layerId,
    kind: KIND_OF[layerId],
    nowMs,
    epochMs: state === 'off' ? null : nowMs,
    newEpoch: true,
    answer: { state, reason, asOfMs: state === 'off' ? null : nowMs },
    coverage: layerId === 'military' ? GLOBAL : coverage,
    complete: state === 'counted',
    assets: list,
    keys: new Set(list.map((asset) => asset.key)),
  };
}

function framesOf(...list) {
  return new Map(list.map((item) => [item.layerId, item]));
}

/** Both aircraft layers counted and global, with the given assets. */
function aircraftFrames({ flights = [], military = [], nowMs = T0 } = {}) {
  return framesOf(
    frame('flights', { assets: flights, nowMs }),
    frame('military', { assets: military, nowMs }),
  );
}

function entry(overrides = {}) {
  return {
    id: 'w-abcd',
    kind: 'aircraft',
    match: 'icao24',
    value: 'abc123',
    label: null,
    addedAtMs: T0 - 60 * MIN,
    declined: null,
    lastSeen: null,
    ...overrides,
  };
}

function vesselEntry(overrides = {}) {
  return entry({
    id: 'w-vess',
    kind: 'vessel',
    match: 'mmsi',
    value: '235000001',
    ...overrides,
  });
}

function satelliteEntry(overrides = {}) {
  return entry({
    id: 'w-iss1',
    kind: 'satellite',
    match: 'norad',
    value: '25544',
    ...overrides,
  });
}

function resolve(watchEntry, context) {
  const result = resolveWatchPresence(watchEntry, { nowMs: T0, ...context });
  return keep(result);
}

function assertJsonSafe(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  const walk = (node) => {
    if (node === undefined) assert.fail('undefined value in output');
    if (typeof node === 'number') assert.ok(Number.isFinite(node));
    if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
}

// -------------------------------------------------------------- constants

test('constants are frozen and match the plan', () => {
  assert.ok(Object.isFrozen(WATCHLIST_POLICY));
  assert.ok(Object.isFrozen(WATCHLIST_POLICY.freshFixMs));
  assert.ok(Object.isFrozen(WATCHLIST_POLICY.declinedAircraftClasses));
  assert.ok(Object.isFrozen(WATCHLIST_POLICY.declinedVesselTypes));
  assert.deepEqual(
    { ...WATCHLIST_POLICY },
    {
      confirmEvals: 2,
      confirmMs: 45_000,
      reappearAfterMs: 1_200_000,
      coveredShare: 0.8,
      freshFixMs: { aircraft: 120_000, vessel: 900_000 },
      declinedAircraftClasses: ['light', 'glider', 'bizjet'],
      declinedVesselTypes: ['SAILING', 'PLEASURE'],
      satellitePollMs: 30_000,
    },
  );
  assert.ok(Object.isFrozen(WATCH_PRESENCE));
  assert.deepEqual(
    { ...WATCH_PRESENCE },
    {
      CHECKING: 'checking',
      LIVE: 'live',
      STALE_FIX: 'stale-fix',
      FEED_STALE: 'feed-stale',
      NOT_REPORTED: 'not-reported',
      OUTSIDE_COVERAGE: 'outside-coverage',
      FEED_OFF: 'feed-off',
      FEED_UNAVAILABLE: 'feed-unavailable',
      COMPUTED: 'computed',
      NOT_IN_CATALOG: 'not-in-catalog',
      DECLINED: 'declined',
    },
  );
  assert.ok(Object.isFrozen(WATCH_LAYERS));
  for (const layers of Object.values(WATCH_LAYERS)) {
    assert.ok(Object.isFrozen(layers));
  }
  assert.deepEqual(
    { ...WATCH_LAYERS },
    {
      aircraft: ['military', 'flights'],
      vessel: ['ais-live-vessels'],
      satellite: ['satellites'],
    },
  );
  assert.ok(Object.isFrozen(WATCH_EVENT_TYPES));
  assert.deepEqual(Object.values(WATCH_EVENT_TYPES).sort(), [
    'watch-not-reported',
    'watch-reappeared',
    'watch-seen',
  ]);
});

// ------------------------------------------------------- compile and match

test('compileWatchlist indexes normalized values and skips bad entries', () => {
  const compiled = compileWatchlist([
    entry({ id: 'w-icao', value: 'ABC123' }),
    entry({ id: 'w-call', match: 'callsign', value: 'ual 123' }),
    entry({ id: 'w-call2', match: 'callsign', value: 'UAL123' }),
    entry({ id: 'w-tisb', value: '~a1b2c3' }),
    vesselEntry({ id: 'w-ship' }),
    satelliteEntry({ id: 'w-sat1', value: '025544' }),
    entry({
      id: 'w-decl',
      value: 'def456',
      declined: 'private-aircraft-class',
    }),
    entry({ id: 'w-icao', value: 'fff000' }),
    entry({ id: 'w-bad1', match: 'owner', value: 'x' }),
    entry({ id: 'w-bad2', kind: 'vessel', match: 'icao24' }),
    entry({ id: 'w-bad3', value: '   ' }),
    entry({ id: 'w-bad4', value: 'a'.repeat(40) }),
    entry({ id: '', value: 'aaa111' }),
    satelliteEntry({ id: 'w-bad5', value: '0' }),
    null,
    'w-text',
  ]);
  assert.ok(compiled.byValue instanceof Map);
  assert.ok(compiled.entries instanceof Map);
  assert.deepEqual(
    [...compiled.entries.keys()],
    ['w-icao', 'w-call', 'w-call2', 'w-tisb', 'w-ship', 'w-sat1', 'w-decl'],
  );
  assert.deepEqual(compiled.byValue.get('icao24:abc123'), ['w-icao']);
  assert.deepEqual(compiled.byValue.get('callsign:UAL123'), [
    'w-call',
    'w-call2',
  ]);
  assert.deepEqual(compiled.byValue.get('icao24:~a1b2c3'), ['w-tisb']);
  assert.deepEqual(compiled.byValue.get('mmsi:235000001'), ['w-ship']);
  assert.deepEqual(compiled.byValue.get('norad:25544'), ['w-sat1']);
  assert.equal(compiled.byValue.has('icao24:def456'), false);
  assert.equal(compiled.byValue.has('icao24:fff000'), false);
  // The stored entry objects are kept as they are.
  assert.equal(
    compiled.entries.get('w-decl').declined,
    'private-aircraft-class',
  );
  assert.deepEqual(compileWatchlist(null).entries.size, 0);
  assert.deepEqual(compileWatchlist(undefined).byValue.size, 0);
});

test('matchAsset matches ICAO24 and exact callsign, vessels by MMSI', () => {
  const compiled = compileWatchlist([
    entry({ id: 'w-icao', value: 'abc123' }),
    entry({ id: 'w-call', match: 'callsign', value: 'UAL123' }),
    entry({ id: 'w-pref', match: 'callsign', value: 'UAL1' }),
    entry({ id: 'w-tisb', value: '~a1b2c3' }),
    vesselEntry({ id: 'w-ship' }),
    satelliteEntry({ id: 'w-sat1' }),
  ]);
  assert.deepEqual(matchAsset(compiled, aircraft()), ['w-icao', 'w-call']);
  assert.deepEqual(
    matchAsset(compiled, aircraft({ id: 'ABC123', callsign: 'ual 123' })),
    ['w-icao', 'w-call'],
  );
  assert.deepEqual(
    matchAsset(compiled, aircraft({ id: 'fff000', callsign: 'UAL123' })),
    ['w-call'],
  );
  // No callsign prefixes.
  assert.deepEqual(
    matchAsset(compiled, aircraft({ id: 'fff000', callsign: 'UAL1234' })),
    [],
  );
  assert.deepEqual(
    matchAsset(compiled, aircraft({ id: '~a1b2c3', callsign: null })),
    ['w-tisb'],
  );
  assert.deepEqual(matchAsset(compiled, vessel()), ['w-ship']);
  assert.deepEqual(matchAsset(compiled, vessel({ id: '235000002' })), []);
  // A vessel MMSI never matches an aircraft entry and vice versa.
  assert.deepEqual(matchAsset(compiled, vessel({ id: 'abc123' })), []);
  assert.deepEqual(
    matchAsset(compiled, { kind: 'satellite', id: '25544', key: '25544' }),
    [],
  );
  assert.deepEqual(
    matchAsset(compiled, { kind: 'fire', key: 'fire:1:2:0:N' }),
    [],
  );
  assert.deepEqual(matchAsset(null, aircraft()), []);
  assert.deepEqual(matchAsset({}, aircraft()), []);
  assert.deepEqual(matchAsset(compiled, null), []);
  // A fresh array each time.
  const first = matchAsset(compiled, aircraft());
  first.push('w-mutated');
  assert.deepEqual(matchAsset(compiled, aircraft()), ['w-icao', 'w-call']);
});

test('a declined entry never matches', () => {
  const compiled = compileWatchlist([
    entry({ id: 'w-decl', declined: 'private-aircraft-class' }),
  ]);
  assert.deepEqual(matchAsset(compiled, aircraft()), []);
});

// ---------------------------------------------------------- privacy guard

test('watchEligibility declines civil light, glider and bizjet aircraft', () => {
  for (const aircraftClass of ['light', 'glider', 'bizjet', 'BizJet']) {
    assert.deepEqual(keep(watchEligibility(aircraft({ aircraftClass }))), {
      ok: false,
      code: 'private-aircraft-class',
    });
  }
  for (const aircraftClass of [
    'airliner',
    'widebody',
    'helicopter',
    'turboprop',
    null,
  ]) {
    assert.deepEqual(watchEligibility(aircraft({ aircraftClass })), {
      ok: true,
    });
  }
});

test('a military bizjet is allowed', () => {
  assert.deepEqual(
    watchEligibility(aircraft({ aircraftClass: 'bizjet', military: true })),
    { ok: true },
  );
});

test('watchEligibility declines sailing and pleasure vessels', () => {
  for (const shipType of [
    '36',
    '37',
    'SAILING',
    'Pleasure',
    'Pleasure Craft',
    'sailing vessel',
    37,
  ]) {
    assert.deepEqual(
      keep(watchEligibility(vessel({ shipType }))),
      { ok: false, code: 'private-vessel-type' },
      `shipType ${shipType}`,
    );
  }
  for (const shipType of ['71', '30', '35', '0', 'Cargo', 'TANKER', null, '']) {
    assert.deepEqual(
      watchEligibility(vessel({ shipType })),
      { ok: true },
      `shipType ${shipType}`,
    );
  }
});

test('watchEligibility allows other kinds and honours a policy override', () => {
  assert.deepEqual(watchEligibility(null), { ok: true });
  assert.deepEqual(watchEligibility({ kind: 'quake' }), { ok: true });
  const policy = { ...WATCHLIST_POLICY, declinedAircraftClasses: ['uav'] };
  assert.deepEqual(
    watchEligibility(aircraft({ aircraftClass: 'bizjet' }), policy),
    { ok: true },
  );
  assert.deepEqual(
    watchEligibility(aircraft({ aircraftClass: 'uav' }), policy),
    { ok: false, code: 'private-aircraft-class' },
  );
});

test('a civil aircraft without a type code is never followed', async () => {
  const { classifyAircraft } = await import('../data/aircraftClass.js');
  // OpenSky gives no category for most aircraft, and small and large share
  // the airliner default: a business jet passes the class check alone.
  for (const category of [0, 1, 3, 4, null]) {
    const aircraftClass = classifyAircraft({ typeCode: null, category });
    assert.equal(aircraftClass, 'airliner', `category ${category}`);
    const asset = aircraft({ aircraftClass, typeCode: null });
    assert.deepEqual(watchEligibility(asset), { ok: true });
    assert.equal(watchClassKnown(asset), false);
    const unjudged = resolve(entry(), {
      frames: aircraftFrames({ flights: [asset] }),
    });
    assert.equal(unjudged.state, WATCH_PRESENCE.CHECKING);
    assert.equal(unjudged.reason, 'class-unknown');
    assert.equal(unjudged.fix, null);
    assert.equal(unjudged.asset, null);
    assert.equal(unjudged.matches, 1);
    assertJsonSafe(unjudged);
  }
  // Once enrichment finds the type, the guard decides.
  const bizjet = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ typeCode: 'GLF6', aircraftClass: 'bizjet' })],
    }),
  });
  assert.equal(bizjet.state, WATCH_PRESENCE.DECLINED);
  const airliner = resolve(entry(), {
    frames: aircraftFrames({ flights: [aircraft({ typeCode: 'A320' })] }),
  });
  assert.equal(airliner.state, WATCH_PRESENCE.LIVE);
  // Military aircraft and other kinds need no type code.
  const military = resolve(entry(), {
    frames: aircraftFrames({
      military: [aircraft({ typeCode: null, military: true })],
    }),
  });
  assert.equal(military.state, WATCH_PRESENCE.LIVE);
  assert.equal(watchClassKnown(vessel()), true);
  assert.equal(watchClassKnown(null), true);
});

test('a vessel without an AIS ship type is never followed', () => {
  // Pleasure craft often send no static data: no type, code 0 ("not
  // available") and the reserved codes name nothing the guard can judge.
  for (const shipType of [null, '', '0', '100', '255']) {
    const asset = vessel({ shipType });
    assert.deepEqual(watchEligibility(asset), { ok: true }, `${shipType}`);
    assert.equal(watchClassKnown(asset), false, `${shipType}`);
    const unjudged = resolve(vesselEntry(), {
      frames: framesOf(frame('ais-live-vessels', { assets: [asset] })),
    });
    assert.equal(unjudged.state, WATCH_PRESENCE.CHECKING);
    assert.equal(unjudged.reason, 'class-unknown');
    assert.equal(unjudged.fix, null);
    assert.equal(unjudged.asset, null);
    assertJsonSafe(unjudged);
  }
  // A known type lets the guard decide either way.
  const cargo = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', { assets: [vessel({ shipType: '71' })] }),
    ),
  });
  assert.equal(cargo.state, WATCH_PRESENCE.LIVE);
  const sailing = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', { assets: [vessel({ shipType: '36' })] }),
    ),
  });
  assert.equal(sailing.state, WATCH_PRESENCE.DECLINED);
});

// ------------------------------------------------------- presence: aircraft

test('LIVE: a fresh fix in an answering frame', () => {
  const asset = aircraft({ fixAtMs: T0 - 30 * SEC });
  const result = resolve(entry(), {
    frames: aircraftFrames({ flights: [asset] }),
  });
  assert.equal(result.state, WATCH_PRESENCE.LIVE);
  assert.equal(result.reason, null);
  assert.equal(result.layerId, 'flights');
  assert.equal(result.matches, 1);
  assert.deepEqual(result.fix, {
    lat: LONDON.lat,
    lon: LONDON.lon,
    atMs: T0 - 30 * SEC,
    altM: 3_000,
    onGround: false,
    vRateMps: 0,
  });
  assert.equal(result.asset.id, 'abc123');
  assert.notEqual(result.asset, asset, 'the asset is copied');
  assert.equal(result.covered, true);
  assertJsonSafe(result);
});

test('LIVE under a floor answer, and exactly at the freshness limit', () => {
  const asset = aircraft({ fixAtMs: T0 - 120 * SEC });
  const frames = framesOf(
    frame('flights', { state: 'floor', reason: 'truncated', assets: [asset] }),
    frame('military'),
  );
  const result = resolve(entry(), { frames });
  assert.equal(result.state, WATCH_PRESENCE.LIVE);
  assert.equal(result.covered, false, 'a floor answer is not covered');
});

test('STALE_FIX: an old fix, or a fix without a time', () => {
  const old = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ fixAtMs: T0 - 5 * MIN, contactAtMs: T0 - 5 * MIN })],
    }),
  });
  assert.equal(old.state, WATCH_PRESENCE.STALE_FIX);
  assert.equal(old.reason, 'fix-old');
  assert.equal(old.fix.atMs, T0 - 5 * MIN);
  const untimed = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ fixAtMs: null, contactAtMs: null })],
    }),
  });
  assert.equal(untimed.state, WATCH_PRESENCE.STALE_FIX);
  assert.equal(untimed.reason, 'fix-time-unknown');
  assert.equal(untimed.fix.atMs, null);
  assertJsonSafe(untimed);
  const noClock = resolveWatchPresence(entry(), {
    frames: aircraftFrames({ flights: [aircraft()] }),
  });
  assert.equal(noClock.state, WATCH_PRESENCE.STALE_FIX);
  assert.equal(noClock.reason, 'fix-time-unknown');
});

test('the contact time stands in for a missing receipt time', () => {
  const result = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ fixAtMs: null, contactAtMs: T0 - 10 * SEC })],
    }),
  });
  assert.equal(result.state, WATCH_PRESENCE.LIVE);
  assert.equal(result.fix.atMs, T0 - 10 * SEC);
});

test('NOT_REPORTED: every aircraft layer counted and global', () => {
  const result = resolve(entry(), { frames: aircraftFrames() });
  assert.equal(result.state, WATCH_PRESENCE.NOT_REPORTED);
  assert.equal(result.reason, null);
  assert.equal(result.fix, null);
  assert.equal(result.asset, null);
  assert.equal(result.matches, 0);
  assert.equal(result.covered, true);
  assertJsonSafe(result);
});

test('NOT_REPORTED: a regional disc that contains the last position', () => {
  const frames = framesOf(
    frame('flights', { coverage: DISC_438, reason: 'regional-fallback' }),
    frame('military'),
  );
  const lastSeen = { atMs: T0 - 10 * MIN, ...LONDON, layerId: 'flights' };
  const result = resolve(entry({ lastSeen }), { frames });
  assert.equal(result.state, WATCH_PRESENCE.NOT_REPORTED);
  assert.equal(result.covered, true);
});

test('regional coverage with the asset absent gives OUTSIDE_COVERAGE, never NOT_REPORTED', () => {
  const frames = framesOf(
    frame('flights', { coverage: DISC_438, reason: 'regional-fallback' }),
    frame('military'),
  );
  const lastSeen = { atMs: T0 - 10 * MIN, ...NEW_YORK, layerId: 'flights' };
  const result = resolve(entry({ lastSeen }), { frames });
  assert.equal(result.state, WATCH_PRESENCE.OUTSIDE_COVERAGE);
  assert.equal(result.reason, 'outside-loaded-area');
  assert.equal(result.layerId, 'flights');
  assert.equal(result.covered, false);
  // No last position at all: still not a not-reported claim.
  const blind = resolve(entry(), { frames });
  assert.equal(blind.state, WATCH_PRESENCE.OUTSIDE_COVERAGE);
  assert.equal(blind.reason, 'no-last-position');
  // The context lastSeen wins over the stored one.
  const override = resolve(
    entry({ lastSeen: { atMs: T0, ...LONDON, layerId: 'flights' } }),
    { frames, lastSeen },
  );
  assert.equal(override.state, WATCH_PRESENCE.OUTSIDE_COVERAGE);
});

test('flights off with military global gives FEED_OFF', () => {
  const frames = framesOf(
    frame('flights', { state: 'off', reason: 'feed-off' }),
    frame('military'),
  );
  const result = resolve(entry(), { frames });
  assert.equal(result.state, WATCH_PRESENCE.FEED_OFF);
  assert.equal(result.reason, 'feed-off');
  assert.equal(result.layerId, 'flights');
  assert.equal(result.covered, false);
});

test('FEED_STALE and FEED_UNAVAILABLE carry the layer reason', () => {
  const stale = resolve(entry(), {
    frames: framesOf(
      frame('flights', { state: 'held', reason: 'feed-stale' }),
      frame('military'),
    ),
  });
  assert.equal(stale.state, WATCH_PRESENCE.FEED_STALE);
  assert.equal(stale.reason, 'feed-stale');
  const loading = resolve(entry(), {
    frames: framesOf(
      frame('flights', { state: 'unknown', reason: 'feed-loading' }),
      frame('military'),
    ),
  });
  assert.equal(loading.state, WATCH_PRESENCE.FEED_UNAVAILABLE);
  assert.equal(loading.reason, 'feed-loading');
  const noReason = resolve(entry(), {
    frames: framesOf(frame('flights', { state: 'held' }), frame('military')),
  });
  assert.equal(noReason.reason, 'feed-stale');
});

test('the worst layer wins among feed states', () => {
  const offBeatsHeld = resolve(entry(), {
    frames: framesOf(
      frame('flights', { state: 'held', reason: 'feed-degraded' }),
      frame('military', { state: 'off', reason: 'feed-off' }),
    ),
  });
  assert.equal(offBeatsHeld.state, WATCH_PRESENCE.FEED_OFF);
  assert.equal(offBeatsHeld.layerId, 'military');
  const unknownBeatsHeld = resolve(entry(), {
    frames: framesOf(
      frame('flights', { state: 'held', reason: 'feed-stale' }),
      frame('military', { state: 'unknown', reason: 'never-answered' }),
    ),
  });
  assert.equal(unknownBeatsHeld.state, WATCH_PRESENCE.FEED_UNAVAILABLE);
  assert.equal(unknownBeatsHeld.reason, 'never-answered');
});

test('a held frame never yields a fix, even if it carries assets', () => {
  const frames = framesOf(
    frame('flights', {
      state: 'held',
      reason: 'feed-stale',
      assets: [aircraft()],
      forceAssets: true,
    }),
    frame('military'),
  );
  const result = resolve(entry(), { frames });
  assert.equal(result.state, WATCH_PRESENCE.FEED_STALE);
  assert.equal(result.fix, null);
});

test('CHECKING: a missing frame, a floor answer, unknown coverage, a bad entry', () => {
  const missing = resolve(entry(), {
    frames: framesOf(frame('flights')),
  });
  assert.equal(missing.state, WATCH_PRESENCE.CHECKING);
  assert.equal(missing.reason, 'awaiting-frame');
  assert.equal(missing.layerId, 'military');
  const none = resolve(entry(), {});
  assert.equal(none.state, WATCH_PRESENCE.CHECKING);
  assert.equal(none.reason, 'awaiting-frame');
  const floor = resolve(entry(), {
    frames: framesOf(
      frame('flights', { state: 'floor', reason: 'partial-snapshot' }),
      frame('military'),
    ),
  });
  assert.equal(floor.state, WATCH_PRESENCE.CHECKING);
  assert.equal(floor.reason, 'partial-snapshot');
  const unknownCoverage = resolve(entry(), {
    frames: framesOf(
      frame('flights', { coverage: { kind: 'unknown' } }),
      frame('military'),
    ),
  });
  assert.equal(unknownCoverage.state, WATCH_PRESENCE.CHECKING);
  assert.equal(unknownCoverage.reason, 'coverage-unknown');
  assert.equal(unknownCoverage.layerId, 'flights');
  for (const bad of [
    null,
    {},
    entry({ match: 'owner' }),
    entry({ value: '' }),
    entry({ kind: 'satellite' }),
  ]) {
    const result = resolve(bad, { frames: aircraftFrames() });
    assert.equal(result.state, WATCH_PRESENCE.CHECKING);
    assert.equal(result.reason, 'bad-entry');
    assertJsonSafe(result);
  }
});

test('frames may be a Map, a keyed object or an array', () => {
  const flights = frame('flights', { assets: [aircraft()] });
  const military = frame('military');
  for (const frames of [
    new Map([
      ['flights', flights],
      ['military', military],
    ]),
    { flights, military },
    [frame('flights'), military, flights],
  ]) {
    assert.equal(resolve(entry(), { frames }).state, WATCH_PRESENCE.LIVE);
  }
});

test('two callsign matches report matches: 2 and use the freshest fix', () => {
  const older = aircraft({
    id: 'aaa111',
    lat: 48.1,
    lon: 11.5,
    fixAtMs: T0 - 90 * SEC,
  });
  const newer = aircraft({ id: 'bbb222', fixAtMs: T0 - 5 * SEC });
  const result = resolve(entry({ match: 'callsign', value: 'UAL123' }), {
    frames: aircraftFrames({ flights: [older, newer] }),
  });
  assert.equal(result.state, WATCH_PRESENCE.LIVE);
  assert.equal(result.matches, 2);
  assert.equal(result.asset.id, 'bbb222');
  assert.equal(result.fix.atMs, T0 - 5 * SEC);
});

test('one aircraft in both layers is one match; ties prefer military', () => {
  const civil = aircraft({ layerId: 'flights' });
  const mil = aircraft({ layerId: 'military', military: true });
  const result = resolve(entry(), {
    frames: aircraftFrames({ flights: [civil], military: [mil] }),
  });
  assert.equal(result.matches, 1);
  assert.equal(result.layerId, 'military');
  const fresher = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ fixAtMs: T0 - SEC })],
      military: [
        aircraft({
          layerId: 'military',
          military: true,
          fixAtMs: T0 - 20 * SEC,
        }),
      ],
    }),
  });
  assert.equal(fresher.layerId, 'flights');
  assert.equal(fresher.asset.military, true, 'military is merged per key');
});

test('DECLINED: a stored decline, a private aircraft, a pleasure craft', () => {
  const stored = resolve(entry({ declined: 'private-aircraft-class' }), {
    frames: aircraftFrames({ flights: [aircraft()] }),
  });
  assert.equal(stored.state, WATCH_PRESENCE.DECLINED);
  assert.equal(stored.reason, 'private-aircraft-class');
  assert.equal(stored.fix, null);
  assert.equal(stored.asset, null);
  const bizjet = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ aircraftClass: 'bizjet' })],
    }),
  });
  assert.equal(bizjet.state, WATCH_PRESENCE.DECLINED);
  assert.equal(bizjet.reason, 'private-aircraft-class');
  assert.equal(bizjet.fix, null, 'a declined match never carries a position');
  assert.equal(bizjet.asset, null);
  assert.equal(bizjet.layerId, null);
  assertJsonSafe(bizjet);
  const pleasure = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', { assets: [vessel({ shipType: '37' })] }),
    ),
  });
  assert.equal(pleasure.state, WATCH_PRESENCE.DECLINED);
  assert.equal(pleasure.reason, 'private-vessel-type');
  assert.equal(pleasure.fix, null);
  // Any declined match declines a callsign entry.
  const mixed = resolve(entry({ match: 'callsign', value: 'UAL123' }), {
    frames: aircraftFrames({
      flights: [
        aircraft({ id: 'aaa111' }),
        aircraft({ id: 'bbb222', aircraftClass: 'light' }),
      ],
    }),
  });
  assert.equal(mixed.state, WATCH_PRESENCE.DECLINED);
  assert.equal(mixed.matches, 2);
});

test('a military bizjet resolves live', () => {
  const fromMilitary = resolve(entry(), {
    frames: aircraftFrames({
      military: [
        aircraft({
          aircraftClass: 'bizjet',
          military: true,
          layerId: 'military',
        }),
      ],
    }),
  });
  assert.equal(fromMilitary.state, WATCH_PRESENCE.LIVE);
  // Reported by both layers: the military copy marks it military.
  const both = resolve(entry(), {
    frames: aircraftFrames({
      flights: [aircraft({ aircraftClass: 'bizjet', military: false })],
      military: [
        aircraft({
          aircraftClass: 'bizjet',
          military: true,
          layerId: 'military',
        }),
      ],
    }),
  });
  assert.equal(both.state, WATCH_PRESENCE.LIVE);
});

// -------------------------------------------------------- presence: vessels

test('vessels: live within 15 minutes, stale after', () => {
  const live = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', {
        assets: [vessel({ fixAtMs: T0 - 10 * MIN })],
      }),
    ),
  });
  assert.equal(live.state, WATCH_PRESENCE.LIVE);
  assert.equal(live.fix.altM, null);
  assert.equal(live.fix.onGround, null);
  const stale = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', {
        assets: [vessel({ fixAtMs: T0 - 16 * MIN })],
      }),
    ),
  });
  assert.equal(stale.state, WATCH_PRESENCE.STALE_FIX);
  assert.equal(stale.reason, 'fix-old');
});

test('a vessel whose last position is outside the camera disc counts as uncovered', () => {
  const disc = { kind: 'circle', lat: 50.9, lon: -1.4, radiusKm: 120 };
  const frames = framesOf(frame('ais-live-vessels', { coverage: disc }));
  const outside = resolve(
    vesselEntry({
      lastSeen: {
        atMs: T0 - 20 * MIN,
        lat: 53.4,
        lon: 3.0,
        layerId: 'ais-live-vessels',
      },
    }),
    { frames },
  );
  assert.equal(outside.state, WATCH_PRESENCE.OUTSIDE_COVERAGE);
  assert.equal(outside.covered, false);
  const inside = resolve(
    vesselEntry({
      lastSeen: {
        atMs: T0 - 20 * MIN,
        lat: 50.8,
        lon: -1.3,
        layerId: 'ais-live-vessels',
      },
    }),
    { frames },
  );
  assert.equal(inside.state, WATCH_PRESENCE.NOT_REPORTED);
  assert.equal(inside.covered, true);
  // A wide view (global coverage) covers any last position.
  const wide = resolve(
    vesselEntry({
      lastSeen: {
        atMs: T0 - 20 * MIN,
        lat: 53.4,
        lon: 3.0,
        layerId: 'ais-live-vessels',
      },
    }),
    { frames: framesOf(frame('ais-live-vessels')) },
  );
  assert.equal(wide.state, WATCH_PRESENCE.NOT_REPORTED);
  // A held transport reads as a stale feed.
  const reconnecting = resolve(vesselEntry(), {
    frames: framesOf(
      frame('ais-live-vessels', {
        state: 'held',
        reason: 'transport-reconnecting',
        coverage: { kind: 'unknown' },
      }),
    ),
  });
  assert.equal(reconnecting.state, WATCH_PRESENCE.FEED_STALE);
  assert.equal(reconnecting.reason, 'transport-reconnecting');
});

// ------------------------------------------------------ presence: satellites

test('satellites: computed, not in catalog, feed off, checking', () => {
  const result = {
    noradId: 25544,
    name: 'ISS (ZARYA) ',
    position: { x: 1, y: 2, z: 3, clone() {} },
    latitude: 12.5,
    longitude: -45.25,
    altitudeM: 420_000,
  };
  const computed = resolve(satelliteEntry(), {
    satellite: { enabled: true, result, atMs: T0 - SEC },
  });
  assert.equal(computed.state, WATCH_PRESENCE.COMPUTED);
  assert.equal(computed.reason, null);
  assert.equal(computed.layerId, 'satellites');
  assert.equal(computed.matches, 1);
  assert.deepEqual(computed.fix, {
    lat: 12.5,
    lon: -45.25,
    atMs: T0 - SEC,
    altM: 420_000,
    onGround: null,
    vRateMps: null,
  });
  assert.equal(computed.asset.name, 'ISS (ZARYA)');
  assert.equal('position' in computed.asset, false);
  assertJsonSafe(computed);
  const clockFix = resolve(satelliteEntry(), {
    satellite: { enabled: true, result },
  });
  assert.equal(clockFix.fix.atMs, T0);
  const missing = resolve(satelliteEntry(), {
    satellite: { enabled: true, complete: true, result: null },
  });
  assert.equal(missing.state, WATCH_PRESENCE.NOT_IN_CATALOG);
  assert.equal(missing.reason, 'not-in-catalog');
  // A partial, stale or still-loading catalog cannot prove absence.
  for (const complete of [false, undefined]) {
    const partial = resolve(satelliteEntry(), {
      satellite: { enabled: true, ready: true, complete, result: null },
    });
    assert.equal(partial.state, WATCH_PRESENCE.CHECKING);
    assert.equal(partial.reason, 'catalog-partial');
  }
  const unavailable = resolve(satelliteEntry(), {
    satellite: { enabled: true, ready: false, unavailable: true, result: null },
  });
  assert.equal(unavailable.state, WATCH_PRESENCE.FEED_UNAVAILABLE);
  assert.equal(unavailable.reason, 'feed-unavailable');
  assert.equal(unavailable.layerId, 'satellites');
  for (const satellite of [null, undefined, { enabled: false, result }]) {
    const off = resolve(satelliteEntry(), { satellite });
    assert.equal(off.state, WATCH_PRESENCE.FEED_OFF);
    assert.equal(off.layerId, 'satellites');
  }
  const loading = resolve(satelliteEntry(), {
    satellite: { enabled: true, ready: false, result: null },
  });
  assert.equal(loading.state, WATCH_PRESENCE.CHECKING);
  assert.equal(loading.reason, 'catalog-loading');
  const noPosition = resolve(satelliteEntry(), {
    satellite: { enabled: true, result: { noradId: 25544, latitude: NaN } },
  });
  assert.equal(noPosition.state, WATCH_PRESENCE.CHECKING);
  assert.equal(noPosition.reason, 'no-position');
});

test('a satellite substring hit is not accepted', () => {
  // findByQuery('25544') can fall back to a name match ("…25544…").
  const hit = resolve(satelliteEntry(), {
    satellite: {
      enabled: true,
      result: {
        noradId: 48274,
        name: 'OBJECT 25544',
        latitude: 1,
        longitude: 2,
      },
    },
  });
  assert.equal(hit.state, WATCH_PRESENCE.NOT_IN_CATALOG);
  assert.equal(hit.reason, 'id-mismatch');
  assert.equal(hit.fix, null);
  const textId = resolve(satelliteEntry(), {
    satellite: {
      enabled: true,
      result: { noradId: '25544', latitude: 1, longitude: 2 },
    },
  });
  assert.equal(textId.state, WATCH_PRESENCE.COMPUTED);
});

// ---------------------------------------------------------------- tracker

/** Presence fixtures. */
const LIVE = (atMs, layerId = 'flights') => ({
  state: WATCH_PRESENCE.LIVE,
  reason: null,
  fix: { lat: 51, lon: 0, atMs, altM: null, onGround: null, vRateMps: null },
  layerId,
  matches: 1,
  asset: null,
  covered: true,
});
const NOT_REPORTED = {
  state: WATCH_PRESENCE.NOT_REPORTED,
  reason: null,
  fix: null,
  layerId: null,
  matches: 0,
  asset: null,
  covered: true,
};
const FEED_STALE = {
  state: WATCH_PRESENCE.FEED_STALE,
  reason: 'feed-stale',
  fix: null,
  layerId: 'flights',
  matches: 0,
  asset: null,
  covered: false,
};
const OUTSIDE = {
  state: WATCH_PRESENCE.OUTSIDE_COVERAGE,
  reason: 'outside-loaded-area',
  fix: null,
  layerId: 'ais-live-vessels',
  matches: 0,
  asset: null,
  covered: false,
};

/** Runs presences at a fixed cadence and returns the non-null events. */
function run(tracker, id, steps, { startMs = T0, stepMs = 30 * SEC } = {}) {
  const events = [];
  let nowMs = startMs;
  for (const step of steps) {
    const presence = typeof step === 'function' ? step(nowMs) : step;
    const event = tracker.update(id, presence, { nowMs });
    if (event) events.push(keep(event));
    nowMs += stepMs;
  }
  return { events, nowMs };
}

function repeat(count, presence) {
  return Array.from({ length: count }, () => presence);
}

test('the first evaluation is a silent baseline', () => {
  const tracker = createWatchTracker();
  assert.equal(tracker.update('w-a', LIVE(T0), { nowMs: T0 }), null);
  assert.equal(tracker.update('w-b', NOT_REPORTED, { nowMs: T0 }), null);
  assert.equal(tracker.update('w-c', FEED_STALE, { nowMs: T0 }), null);
  const status = keep(tracker.status('w-a'));
  assert.equal(status.state, WATCH_PRESENCE.LIVE);
  assert.equal(status.baseline, true);
  assert.equal(status.evals, 1);
  assertJsonSafe(status);
  assert.equal(tracker.status('w-unknown'), null);
});

test('a live entry at the baseline that stays live emits nothing', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-a', repeat(10, LIVE(T0)));
  assert.deepEqual(events, []);
});

test('baseline not live then live emits nothing (startup)', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-a', [
    { ...FEED_STALE, state: WATCH_PRESENCE.FEED_UNAVAILABLE },
    FEED_STALE,
    (nowMs) => LIVE(nowMs),
  ]);
  assert.deepEqual(events, []);
});

test('watch-not-reported needs confirmEvals evaluations and confirmMs', () => {
  const tracker = createWatchTracker();
  assert.equal(tracker.update('w-a', LIVE(T0), { nowMs: T0 }), null);
  assert.equal(
    tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 30 * SEC }),
    null,
  );
  // Two evaluations, but only 30 s.
  assert.equal(
    tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 60 * SEC }),
    null,
  );
  const event = keep(
    tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 90 * SEC }),
  );
  assert.deepEqual(event, {
    type: 'watch-not-reported',
    entryId: 'w-a',
    atMs: T0 + 90 * SEC,
    layerId: 'flights',
    params: { lastSeenAtMs: T0 },
    caveats: [],
  });
  assertJsonSafe(event);
  // Once per absence.
  assert.equal(
    tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 120 * SEC }),
    null,
  );
  assert.equal(tracker.status('w-a').notReported, true);
});

test('watch-not-reported: 2 evaluations 45 s apart are enough', () => {
  const tracker = createWatchTracker();
  tracker.update('w-a', LIVE(T0), { nowMs: T0 });
  assert.equal(
    tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 10 * SEC }),
    null,
  );
  const event = tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 55 * SEC });
  assert.equal(event?.type, WATCH_EVENT_TYPES.NOT_REPORTED);
  // One evaluation over a long time is not enough.
  const slow = createWatchTracker();
  slow.update('w-b', LIVE(T0), { nowMs: T0 });
  assert.equal(
    slow.update('w-b', NOT_REPORTED, { nowMs: T0 + 10 * MIN }),
    null,
  );
});

test('watch-not-reported needs an earlier report in the session', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-a', repeat(20, NOT_REPORTED));
  assert.deepEqual(events, []);
  // The stored last-seen time is used once a report arms it.
  const hinted = createWatchTracker();
  hinted.update(
    'w-b',
    { ...LIVE(null), fix: null },
    { nowMs: T0, lastSeenAtMs: T0 - 5 * MIN },
  );
  hinted.update('w-b', NOT_REPORTED, { nowMs: T0 + 30 * SEC });
  const event = hinted.update('w-b', NOT_REPORTED, { nowMs: T0 + 90 * SEC });
  assert.equal(event.params.lastSeenAtMs, T0 - 5 * MIN);
});

test('a one-evaluation flip emits nothing', () => {
  for (const flip of [NOT_REPORTED, FEED_STALE, OUTSIDE]) {
    const tracker = createWatchTracker();
    const { events } = run(tracker, 'w-a', [
      (nowMs) => LIVE(nowMs),
      (nowMs) => LIVE(nowMs),
      flip,
      (nowMs) => LIVE(nowMs),
      (nowMs) => LIVE(nowMs),
    ]);
    assert.deepEqual(events, [], `flip through ${flip.state}`);
  }
  // Two quick non-live evaluations (under confirmMs) are still a flip.
  const tracker = createWatchTracker();
  const { events } = run(
    tracker,
    'w-a',
    [
      (nowMs) => LIVE(nowMs),
      NOT_REPORTED,
      NOT_REPORTED,
      (nowMs) => LIVE(nowMs),
    ],
    { stepMs: 15 * SEC },
  );
  assert.deepEqual(events, []);
});

test('reappearance after 25 min live and global gives an alert', () => {
  const tracker = createWatchTracker();
  // Live at T0, not reported for 25 min (49 evaluations), live again.
  const steps = [
    (nowMs) => LIVE(nowMs),
    ...repeat(49, NOT_REPORTED),
    (nowMs) => LIVE(nowMs, 'military'),
  ];
  const { events } = run(tracker, 'w-a', steps);
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-not-reported', 'watch-reappeared'],
  );
  const reappeared = events[1];
  assert.equal(reappeared.atMs, T0 + 25 * MIN);
  assert.deepEqual(reappeared.params, { absentMs: 25 * MIN, coveredShare: 1 });
  assert.deepEqual(reappeared.caveats, []);
  assert.equal(reappeared.layerId, 'military');
  assertJsonSafe(reappeared);
  // The next absence starts afresh.
  const status = tracker.status('w-a');
  assert.equal(status.notReported, false);
  assert.equal(status.absentSinceMs, null);
  assert.equal(status.coveredUnseenMs, 0);
});

test('with 10 of those minutes stale, it gives seen plus the caveat', () => {
  const tracker = createWatchTracker();
  const steps = [
    (nowMs) => LIVE(nowMs),
    ...repeat(10, NOT_REPORTED),
    ...repeat(20, FEED_STALE),
    ...repeat(19, NOT_REPORTED),
    (nowMs) => LIVE(nowMs),
  ];
  const { events } = run(tracker, 'w-a', steps);
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-not-reported', 'watch-seen'],
  );
  const seen = events[1];
  assert.deepEqual(seen.params, { layerId: 'flights' });
  assert.deepEqual(seen.caveats, ['coverage-incomplete']);
  assert.equal(seen.atMs, T0 + 25 * MIN);
});

test('a short covered absence is seen without a caveat', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-a', [
    (nowMs) => LIVE(nowMs),
    ...repeat(10, NOT_REPORTED),
    (nowMs) => LIVE(nowMs),
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-not-reported', 'watch-seen'],
  );
  assert.deepEqual(events[1].caveats, []);
});

test('a long uncovered absence (outside the disc) is seen with the caveat', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-v', [
    (nowMs) => LIVE(nowMs, 'ais-live-vessels'),
    ...repeat(59, OUTSIDE),
    (nowMs) => LIVE(nowMs, 'ais-live-vessels'),
  ]);
  assert.deepEqual(
    events.map((event) => [event.type, event.caveats]),
    [['watch-seen', ['coverage-incomplete']]],
  );
});

test('an entry absent since the start is seen once confirmed absent', () => {
  const tracker = createWatchTracker();
  const { events } = run(tracker, 'w-a', [
    NOT_REPORTED,
    NOT_REPORTED,
    NOT_REPORTED,
    NOT_REPORTED,
    (nowMs) => LIVE(nowMs),
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-seen'],
  );
});

test('a return after a gap with no evaluations is seen with a caveat', () => {
  const tracker = createWatchTracker();
  // Not reported for 90 s, then nothing evaluated for 25 min (a hidden
  // tab), then live again: only 90 s of the absence was observed.
  const { events, nowMs } = run(tracker, 'w-a', [
    (atMs) => LIVE(atMs),
    ...repeat(3, NOT_REPORTED),
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-not-reported'],
  );
  const back = nowMs + 25 * MIN;
  const event = keep(tracker.update('w-a', LIVE(back), { nowMs: back }));
  assert.equal(event.type, WATCH_EVENT_TYPES.SEEN);
  assert.deepEqual(event.caveats, ['coverage-incomplete']);
});

test('covered time follows the covered option, the epoch delta and the cap', () => {
  const tracker = createWatchTracker();
  tracker.update('w-a', LIVE(T0), { nowMs: T0 });
  tracker.update('w-a', NOT_REPORTED, {
    nowMs: T0 + MIN,
    epochDeltaMs: 20 * SEC,
  });
  assert.equal(tracker.status('w-a').coveredUnseenMs, 20 * SEC);
  tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + 2 * MIN, covered: false });
  assert.equal(tracker.status('w-a').coveredUnseenMs, 20 * SEC);
  tracker.update('w-a', FEED_STALE, { nowMs: T0 + 3 * MIN, covered: true });
  assert.equal(tracker.status('w-a').coveredUnseenMs, 80 * SEC);
  // A huge delta never covers more than the absence.
  tracker.update('w-a', NOT_REPORTED, {
    nowMs: T0 + 4 * MIN,
    epochDeltaMs: 60 * MIN,
  });
  const status = keep(tracker.status('w-a'));
  assert.equal(status.coveredUnseenMs, 4 * MIN);
  assert.equal(status.coveredShare, 1);
  assert.equal(status.absentSinceMs, T0);
  assertJsonSafe(status);
});

test('tracker ignores bad input and forget drops state', () => {
  const tracker = createWatchTracker();
  assert.equal(tracker.update('', LIVE(T0), { nowMs: T0 }), null);
  assert.equal(tracker.update('w-a', LIVE(T0), {}), null);
  assert.equal(tracker.update('w-a', LIVE(T0), { nowMs: NaN }), null);
  assert.equal(tracker.status('w-a'), null);
  tracker.update('w-a', { state: 'bogus' }, { nowMs: T0 });
  assert.equal(tracker.status('w-a').state, WATCH_PRESENCE.CHECKING);
  assert.equal(tracker.forget('w-a'), true);
  assert.equal(tracker.forget('w-a'), false);
  assert.equal(tracker.status('w-a'), null);
  // After forget the next update is a fresh baseline.
  assert.equal(tracker.update('w-a', LIVE(T0), { nowMs: T0 }), null);
  assert.equal(tracker.status('w-a').baseline, true);
  assert.ok(Object.isFrozen(tracker));
});

test('a policy override changes the debounce', () => {
  const tracker = createWatchTracker({ confirmEvals: 1, confirmMs: 0 });
  tracker.update('w-a', LIVE(T0), { nowMs: T0 });
  const event = tracker.update('w-a', NOT_REPORTED, { nowMs: T0 + SEC });
  assert.equal(event?.type, WATCH_EVENT_TYPES.NOT_REPORTED);
  // Invalid overrides fall back to the defaults.
  const fallback = createWatchTracker({ confirmEvals: -1, confirmMs: 'x' });
  fallback.update('w-b', LIVE(T0), { nowMs: T0 });
  assert.equal(fallback.update('w-b', NOT_REPORTED, { nowMs: T0 + SEC }), null);
});

test('declined and computed entries never raise watch events', () => {
  const tracker = createWatchTracker();
  const declined = {
    ...NOT_REPORTED,
    state: WATCH_PRESENCE.DECLINED,
    covered: false,
  };
  const computed = {
    ...LIVE(T0, 'satellites'),
    state: WATCH_PRESENCE.COMPUTED,
  };
  const off = {
    ...FEED_STALE,
    state: WATCH_PRESENCE.FEED_OFF,
    layerId: 'satellites',
  };
  assert.deepEqual(run(tracker, 'w-d', repeat(10, declined)).events, []);
  assert.deepEqual(
    run(tracker, 'w-s', [
      ...repeat(5, computed),
      ...repeat(5, off),
      ...repeat(5, computed),
    ]).events,
    [],
  );
});

// ------------------------------------------------------------ end to end

test('resolver and tracker together: a 25 minute absence over real frames', () => {
  const tracker = createWatchTracker();
  const watch = entry();
  const events = [];
  let lastSeen = null;
  for (let step = 0; step <= 50; step += 1) {
    const nowMs = T0 + step * 30 * SEC;
    const present = step === 0 || step === 50;
    const frames = aircraftFrames({
      flights: present ? [aircraft({ fixAtMs: nowMs - 2 * SEC })] : [],
      nowMs,
    });
    const presence = resolveWatchPresence(watch, { nowMs, frames, lastSeen });
    if (presence.state === WATCH_PRESENCE.LIVE) {
      lastSeen = { ...presence.fix, layerId: presence.layerId };
    }
    const event = tracker.update(watch.id, presence, {
      nowMs,
      epochDeltaMs: step === 0 ? null : 30 * SEC,
    });
    if (event) events.push(keep(event));
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ['watch-not-reported', 'watch-reappeared'],
  );
  assert.equal(events[0].params.lastSeenAtMs, T0 - 2 * SEC);
  assert.equal(events[1].params.absentMs, 25 * MIN);
});

test('held frames never produce not-reported', () => {
  const tracker = createWatchTracker();
  const watch = entry();
  const events = [];
  for (let step = 0; step <= 40; step += 1) {
    const nowMs = T0 + step * 30 * SEC;
    const state = step === 0 ? 'counted' : ['held', 'unknown', 'off'][step % 3];
    const frames = framesOf(
      frame('flights', {
        state,
        assets: step === 0 ? [aircraft({ fixAtMs: nowMs })] : [],
        nowMs,
      }),
      frame('military', { nowMs }),
    );
    const presence = resolveWatchPresence(watch, { nowMs, frames });
    const event = tracker.update(watch.id, presence, { nowMs });
    if (event) events.push(event);
  }
  assert.deepEqual(events, []);
});

// ------------------------------------------------------- module hygiene

test('no output contains "dark"', () => {
  assert.ok(OUTPUTS.length > 20);
  const text = JSON.stringify([
    OUTPUTS,
    WATCHLIST_POLICY,
    WATCH_PRESENCE,
    WATCH_LAYERS,
    WATCH_EVENT_TYPES,
  ]);
  assert.equal(/dark/i.test(text), false);
});

test('the module is portable and keeps to its imports', () => {
  const source = readFileSync(
    new URL('./watchlist.js', import.meta.url),
    'utf8',
  );
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), ['../data/vesselTypes.js', './geometry.js']);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of [
    /\bDate\.now\b/,
    /\bnew Date\b/,
    /\bMath\.random\b/,
    /\bset(?:Timeout|Interval)\b/,
    /\brequestAnimationFrame\b/,
    /\b(?:window|document|globalThis|localStorage|sessionStorage)\b/,
    /\bCesium\b/,
    /\bdark\b/i,
    /(?:label|title|status|hint)\s*:\s*['"`]/,
  ]) {
    assert.equal(banned.test(code), false, `banned pattern ${banned}`);
  }
  // No owner, registrant or person fields.
  assert.equal(/\b(?:owner|registrant|operator|person)\b/i.test(code), false);
});
