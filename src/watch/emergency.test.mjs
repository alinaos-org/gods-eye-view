// src/watch/emergency.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aircraftEmergency } from '../data/aircraftEmergency.js';
import { buildFrame } from './frames.js';
import {
  EMERGENCY_CAVEATS,
  EMERGENCY_KINDS,
  EMERGENCY_PHASE,
  EMERGENCY_POLICY,
  EMERGENCY_TRANSITION,
  PRIORITY_KINDS,
  SQUAWK_EMERGENCY_KINDS,
  createEmergencyTracker,
} from './emergency.js';

const SEC = 1_000;
const MIN = 60 * SEC;
const T0 = 1_760_000_000_000;
const HEX = 'abc123';

/**
 * An analyst aircraft record as flights/military `getAnalystRecords()`
 * returns it, with the emergency fields derived the way the layers derive
 * them (src/data/aircraftEmergency.js). `atMs` is this browser's receipt
 * time of the poll row; the contact time trails it by half a second.
 */
function row(atMs, overrides = {}) {
  const {
    icao24 = HEX,
    callsign = 'TEST1',
    squawk = '7700',
    adsb = undefined,
    ...rest
  } = overrides;
  const status = aircraftEmergency({ squawk, emergency: adsb });
  return {
    id: callsign || icao24,
    icao24,
    callsign,
    lat: 10,
    lon: 20,
    altitudeM: 3_000,
    speedMps: 200,
    heading: 90,
    verticalRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: null,
    squawk,
    emergency: status?.severity === 'emergency',
    emergencyKind: status?.kind ?? null,
    emergencySource: status?.source ?? null,
    lastContactAtMs: atMs === null ? null : atMs - 500,
    receivedAtMs: atMs,
    ...rest,
  };
}

/** One layer's observation frame, built by the real frames module. */
function frame({
  layerId = 'flights',
  epochMs,
  nowMs = epochMs,
  rows = [],
  enabled = true,
  feedState = 'nominal',
  stats = {},
  coverage = { kind: 'global' },
  previousEpochMs = null,
} = {}) {
  return buildFrame({
    layerId,
    nowMs,
    enabled,
    snapshot: { enabled, feedState, count: rows.length, lastUpdate: epochMs },
    stats: { lastUpdate: epochMs, count: rows.length, ...stats },
    coverage,
    readRows: () => rows,
    previousEpochMs,
  });
}

/**
 * A tracker plus a feed that remembers each layer's previous epoch, like
 * the engine does. `poll(layerId, epochMs, rows, options)` returns the
 * transitions of that frame.
 */
function setup(policy) {
  const tracker = createEmergencyTracker(policy);
  const previous = new Map();
  function poll(layerId, epochMs, rows = [], options = {}) {
    const built = frame({
      layerId,
      epochMs,
      rows,
      previousEpochMs: previous.get(layerId) ?? null,
      ...options,
    });
    if (epochMs !== null && epochMs !== undefined) {
      previous.set(layerId, epochMs);
    }
    return tracker.observe(built);
  }
  return { tracker, poll };
}

/** Polls `flights` every `stepMs` from `startMs`, one row per poll. */
function pollSeries(poll, startMs, stepMs, rowsFor) {
  const out = [];
  rowsFor.forEach((makeRows, i) => {
    const atMs = startMs + i * stepMs;
    out.push(...poll('flights', atMs, makeRows(atMs)));
  });
  return out;
}

/** Starts a confirmed 7700 for HEX at T0 and T0 + 30 s. */
function confirmed(policy, overrides = {}) {
  const ctx = setup(policy);
  assert.deepEqual(ctx.poll('flights', T0, [row(T0, overrides)]), []);
  const start = ctx.poll('flights', T0 + 30 * SEC, [
    row(T0 + 30 * SEC, overrides),
  ]);
  assert.equal(start.length, 1);
  assert.equal(start[0].type, EMERGENCY_TRANSITION.START);
  return { ...ctx, start: start[0] };
}

function phaseOf(tracker, key = HEX) {
  return tracker.active().find((item) => item.key === key)?.phase ?? null;
}

function types(transitions) {
  return transitions.map((item) => item.type);
}

const TRANSITION_KEYS = [
  'caveats',
  'durationMs',
  'fromKind',
  'icao24',
  'key',
  'kind',
  'label',
  'lastFixAtMs',
  'layerId',
  'onGround',
  'position',
  'sinceMs',
  'source',
  'squawk',
  'type',
];

const ACTIVE_KEYS = [
  'altM',
  'confirmedAtMs',
  'firstSeenAtMs',
  'icao24',
  'key',
  'kind',
  'label',
  'lastSeenAtMs',
  'lat',
  'layerId',
  'lon',
  'onGround',
  'phase',
  'source',
  'squawk',
];

test('constants are frozen and match the plan', () => {
  assert.ok(Object.isFrozen(EMERGENCY_POLICY));
  assert.deepEqual(EMERGENCY_POLICY, {
    confirmPolls: 2,
    minSpanMs: 20_000,
    maxGapMs: 300_000,
    clearPolls: 2,
    absentEpochs: 3,
    capacity: 100,
    forgetUnknownMs: 3_600_000,
  });
  for (const value of [
    EMERGENCY_TRANSITION,
    EMERGENCY_PHASE,
    EMERGENCY_KINDS,
    PRIORITY_KINDS,
    SQUAWK_EMERGENCY_KINDS,
    EMERGENCY_CAVEATS,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(Object.values(EMERGENCY_TRANSITION), [
    'emergency-start',
    'emergency-change',
    'emergency-end',
    'emergency-unresolved',
  ]);
  assert.deepEqual(Object.values(EMERGENCY_PHASE), [
    'candidate',
    'active',
    'clearing',
    'unknown',
  ]);
  assert.deepEqual(EMERGENCY_CAVEATS, [
    'on-ground',
    'code-may-be-in-error',
    'unobserved-interval',
  ]);
});

test('kinds agree with src/data/aircraftEmergency.js severities', () => {
  for (const kind of EMERGENCY_KINDS) {
    assert.equal(aircraftEmergency({ emergency: kind })?.severity, 'emergency');
  }
  for (const kind of PRIORITY_KINDS) {
    assert.equal(aircraftEmergency({ emergency: kind })?.severity, 'priority');
  }
  for (const [squawk, kind] of Object.entries(SQUAWK_EMERGENCY_KINDS)) {
    assert.equal(aircraftEmergency({ squawk })?.kind, kind);
  }
});

test('a single 7700 poll gives no event, only a candidate', () => {
  const { tracker, poll } = setup();
  assert.deepEqual(poll('flights', T0, [row(T0)]), []);
  const [item] = tracker.active();
  assert.equal(item.phase, EMERGENCY_PHASE.CANDIDATE);
  assert.equal(item.kind, 'general');
  assert.equal(item.squawk, '7700');
  assert.equal(item.confirmedAtMs, null);
  assert.equal(item.firstSeenAtMs, T0);
  assert.equal(tracker.diagnostics().tracked, 1);
  assert.equal(tracker.diagnostics().candidates, 1);
});

test('polls 30 s apart give a start whose sinceMs is the first poll', () => {
  const { tracker, start } = confirmed();
  assert.deepEqual(start, {
    type: 'emergency-start',
    key: HEX,
    icao24: HEX,
    label: 'TEST1',
    kind: 'general',
    fromKind: null,
    squawk: '7700',
    source: 'squawk',
    sinceMs: T0,
    durationMs: null,
    lastFixAtMs: T0 + 30 * SEC,
    onGround: false,
    position: { lat: 10, lon: 20 },
    layerId: 'flights',
    caveats: [],
  });
  assert.deepEqual(Object.keys(start).sort(), TRANSITION_KEYS);
  assert.deepEqual(JSON.parse(JSON.stringify(start)), start);
  const [item] = tracker.active();
  assert.deepEqual(Object.keys(item).sort(), ACTIVE_KEYS);
  assert.equal(item.phase, EMERGENCY_PHASE.ACTIVE);
  assert.equal(item.firstSeenAtMs, T0);
  assert.equal(item.confirmedAtMs, T0 + 30 * SEC);
  assert.equal(item.lastSeenAtMs, T0 + 30 * SEC);
  assert.equal(item.altM, 3_000);
  assert.deepEqual(JSON.parse(JSON.stringify(item)), item);
});

test('polls 10 s apart confirm only once 20 s have passed', () => {
  const { poll } = setup();
  const out = pollSeries(poll, T0, 10 * SEC, [
    (at) => [row(at)],
    (at) => [row(at)],
    (at) => [row(at)],
  ]);
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].sinceMs, T0);
  assert.equal(out[0].lastFixAtMs, T0 + 20 * SEC);
});

test('the start window ends at 5 minutes and a late poll restarts', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(T0)]);
  // 5 min 10 s later: too late to confirm, so a new candidate opens there.
  const lateMs = T0 + 5 * MIN + 10 * SEC;
  assert.deepEqual(poll('flights', lateMs, [row(lateMs)]), []);
  assert.equal(tracker.diagnostics().transientIgnored, 1);
  assert.equal(tracker.active()[0].firstSeenAtMs, lateMs);
  const out = poll('flights', lateMs + 30 * SEC, [row(lateMs + 30 * SEC)]);
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].sinceMs, lateMs);
});

test('a poll exactly 5 minutes after the first still confirms', () => {
  const { poll } = setup();
  poll('flights', T0, [row(T0)]);
  const out = poll('flights', T0 + 5 * MIN, [row(T0 + 5 * MIN)]);
  assert.deepEqual(types(out), ['emergency-start']);
});

test('a carried record does not confirm', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(T0)]);
  // The record is carried through missed polls: same receipt and contact.
  for (let i = 1; i <= 4; i += 1) {
    const epoch = T0 + i * 15 * SEC;
    assert.deepEqual(poll('flights', epoch, [row(T0)]), []);
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CANDIDATE);
  // Never confirmed within 5 min, so the candidate is dropped as transient.
  assert.deepEqual(poll('flights', T0 + 6 * MIN, [row(T0)]), []);
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().transientIgnored, 1);
  // The carried copy is still not fresh, so it opens no new candidate.
  poll('flights', T0 + 7 * MIN, [row(T0)]);
  assert.deepEqual(tracker.active(), []);
});

test('a re-received row whose contact time did not advance is not fresh', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(T0)]);
  const out = poll('flights', T0 + 30 * SEC, [
    row(T0 + 30 * SEC, { lastContactAtMs: T0 - 500 }),
  ]);
  assert.deepEqual(out, []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CANDIDATE);
});

test('observations without a fix time are ignored', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(null)]);
  poll('flights', T0 + 30 * SEC, [row(null)]);
  poll('flights', T0 + 60 * SEC, [row(null)]);
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().untimedIgnored, 3);
});

test('7600 then 7700 restarts the candidate', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(T0, { squawk: '7600' })]);
  assert.deepEqual(
    poll('flights', T0 + 30 * SEC, [row(T0 + 30 * SEC, { squawk: '7700' })]),
    [],
  );
  assert.equal(tracker.diagnostics().transientIgnored, 1);
  assert.equal(tracker.active()[0].kind, 'general');
  const out = poll('flights', T0 + 60 * SEC, [row(T0 + 60 * SEC)]);
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].kind, 'general');
  assert.equal(out[0].sinceMs, T0 + 30 * SEC);
});

test('a confirmed 7700 then 7600 twice gives a change', () => {
  const { tracker, poll } = confirmed();
  assert.deepEqual(
    poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { squawk: '7600' })]),
    [],
  );
  const out = poll('flights', T0 + 50 * SEC, [
    row(T0 + 50 * SEC, { squawk: '7600' }),
  ]);
  assert.deepEqual(types(out), ['emergency-change']);
  assert.equal(out[0].fromKind, 'general');
  assert.equal(out[0].kind, 'nordo');
  assert.equal(out[0].squawk, '7600');
  assert.equal(out[0].source, 'squawk');
  assert.equal(out[0].sinceMs, T0);
  assert.equal(out[0].durationMs, null);
  assert.equal(tracker.active()[0].kind, 'nordo');
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
});

test('a single different kind between the original kind changes nothing', () => {
  const { tracker, poll } = confirmed();
  const out = pollSeries(poll, T0 + 40 * SEC, 10 * SEC, [
    (at) => [row(at, { squawk: '7600' })],
    (at) => [row(at, { squawk: '7700' })],
    (at) => [row(at, { squawk: '7600' })],
    (at) => [row(at, { squawk: '7700' })],
  ]);
  assert.deepEqual(out, []);
  assert.equal(tracker.active()[0].kind, 'general');
});

test('a change to unlawful interference carries code-may-be-in-error', () => {
  const { poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { squawk: '7500' })]);
  const out = poll('flights', T0 + 50 * SEC, [
    row(T0 + 50 * SEC, { squawk: '7500' }),
  ]);
  assert.equal(out[0].kind, 'unlawful');
  assert.deepEqual(out[0].caveats, ['code-may-be-in-error']);
});

test('a clear needs 2 consecutive fresh polls', () => {
  const { tracker, poll } = confirmed();
  assert.deepEqual(
    poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { squawk: '2000' })]),
    [],
  );
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CLEARING);
  // The code returns: back to active, and the clear count restarts.
  assert.deepEqual(poll('flights', T0 + 50 * SEC, [row(T0 + 50 * SEC)]), []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
  assert.deepEqual(
    poll('flights', T0 + 60 * SEC, [row(T0 + 60 * SEC, { squawk: '2000' })]),
    [],
  );
  // A carried copy of the clear poll is not a second clear.
  assert.deepEqual(
    poll('flights', T0 + 70 * SEC, [row(T0 + 60 * SEC, { squawk: '2000' })]),
    [],
  );
  const out = poll('flights', T0 + 80 * SEC, [
    row(T0 + 80 * SEC, { squawk: '2000' }),
  ]);
  assert.deepEqual(types(out), ['emergency-end']);
  assert.equal(out[0].kind, 'general');
  assert.equal(out[0].squawk, '7700');
  assert.equal(out[0].sinceMs, T0);
  assert.equal(out[0].durationMs, 50 * SEC);
  assert.equal(out[0].lastFixAtMs, T0 + 80 * SEC);
  assert.deepEqual(out[0].caveats, []);
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().tracked, 0);
  assert.equal(tracker.diagnostics().retained, 1);
});

test('a fresh poll without the code drops a candidate as transient', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [row(T0)]);
  assert.deepEqual(
    poll('flights', T0 + 10 * SEC, [row(T0 + 10 * SEC, { squawk: '1200' })]),
    [],
  );
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().transientIgnored, 1);
  // The code again: a new candidate, not a start.
  assert.deepEqual(poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC)]), []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CANDIDATE);
});

test('stale then recovery while broadcasting gives no second start', () => {
  const { tracker, poll } = confirmed();
  assert.deepEqual(
    poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC)], {
      stats: { stale: true },
    }),
    [],
  );
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  // Off and unknown answers are silent too.
  assert.deepEqual(
    poll('flights', T0 + 50 * SEC, [], { feedState: 'unavailable' }),
    [],
  );
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  const out = pollSeries(poll, T0 + 2 * MIN, 10 * SEC, [
    (at) => [row(at)],
    (at) => [row(at)],
    (at) => [row(at)],
  ]);
  assert.deepEqual(out, []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
  // A later observed clear carries no caveat: the code was seen again.
  const end = pollSeries(poll, T0 + 3 * MIN, 10 * SEC, [
    (at) => [row(at, { squawk: '2000' })],
    (at) => [row(at, { squawk: '2000' })],
  ]);
  assert.deepEqual(types(end), ['emergency-end']);
  assert.deepEqual(end[0].caveats, []);
});

test('an off layer turns the track unknown silently', () => {
  const { tracker, poll } = confirmed();
  assert.deepEqual(poll('flights', T0 + 40 * SEC, [], { enabled: false }), []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
});

test('recovery without the code ends with unobserved-interval', () => {
  const { tracker, poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [], { stats: { stale: true } });
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  assert.deepEqual(
    poll('flights', T0 + 3 * MIN, [row(T0 + 3 * MIN, { squawk: '2000' })]),
    [],
  );
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CLEARING);
  const out = poll('flights', T0 + 3 * MIN + 10 * SEC, [
    row(T0 + 3 * MIN + 10 * SEC, { squawk: '2000' }),
  ]);
  assert.deepEqual(types(out), ['emergency-end']);
  assert.deepEqual(out[0].caveats, ['unobserved-interval']);
  assert.equal(out[0].durationMs, 30 * SEC);
});

test('a feed loss while clearing restarts the clear count', () => {
  const { poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { squawk: '2000' })]);
  poll('flights', T0 + 50 * SEC, [], { stats: { stale: true } });
  assert.deepEqual(
    poll('flights', T0 + 60 * SEC, [row(T0 + 60 * SEC, { squawk: '2000' })]),
    [],
  );
  const out = poll('flights', T0 + 70 * SEC, [
    row(T0 + 70 * SEC, { squawk: '2000' }),
  ]);
  assert.deepEqual(types(out), ['emergency-end']);
  assert.deepEqual(out[0].caveats, ['unobserved-interval']);
});

test('absent for 3 counted epochs gives unresolved and drops the track', () => {
  const { tracker, poll } = confirmed({}, { onGround: true });
  const other = (at) => [row(at, { icao24: 'def456', squawk: '1000' })];
  assert.deepEqual(poll('flights', T0 + 40 * SEC, other(T0 + 40 * SEC)), []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  assert.deepEqual(poll('flights', T0 + 50 * SEC, other(T0 + 50 * SEC)), []);
  const out = poll('flights', T0 + 60 * SEC, other(T0 + 60 * SEC));
  assert.deepEqual(types(out), ['emergency-unresolved']);
  assert.deepEqual(out[0], {
    type: 'emergency-unresolved',
    key: HEX,
    icao24: HEX,
    label: 'TEST1',
    kind: 'general',
    fromKind: null,
    squawk: '7700',
    source: 'squawk',
    sinceMs: T0,
    durationMs: 30 * SEC,
    lastFixAtMs: T0 + 30 * SEC,
    onGround: true,
    position: { lat: 10, lon: 20 },
    layerId: 'flights',
    caveats: ['on-ground'],
  });
  assert.deepEqual(tracker.active(), []);
  // Further absence reports nothing more.
  assert.deepEqual(poll('flights', T0 + 70 * SEC, other(T0 + 70 * SEC)), []);
});

test('repeated epochs are not new absence evidence', () => {
  const { tracker, poll } = confirmed();
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(poll('flights', T0 + 40 * SEC, []), []);
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  assert.deepEqual(poll('flights', T0 + 50 * SEC, []), []);
  const out = poll('flights', T0 + 60 * SEC, []);
  assert.deepEqual(types(out), ['emergency-unresolved']);
});

test('a frame flagged as a repeated epoch is not absence evidence', () => {
  const { tracker } = confirmed();
  for (let i = 1; i <= 4; i += 1) {
    const built = frame({ epochMs: T0 + (30 + i * 10) * SEC });
    built.newEpoch = false;
    assert.deepEqual(tracker.observe(built), []);
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
});

test('uncovered positions and floor answers are never absence evidence', () => {
  const { tracker, poll } = confirmed();
  // A regional fallback disc that does not reach the last position.
  const away = { kind: 'circle', lat: -40, lon: -60, radiusKm: 438 };
  for (let i = 1; i <= 4; i += 1) {
    assert.deepEqual(
      poll('flights', T0 + (30 + i * 10) * SEC, [], { coverage: away }),
      [],
    );
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  // Unknown coverage, and a partial snapshot (floor), are not evidence.
  for (let i = 5; i <= 8; i += 1) {
    assert.deepEqual(
      poll('flights', T0 + (30 + i * 10) * SEC, [], {
        coverage: { kind: 'unknown' },
      }),
      [],
    );
  }
  const other = (at) => [row(at, { icao24: 'def456', squawk: '1000' })];
  for (let i = 9; i <= 12; i += 1) {
    const at = T0 + (30 + i * 10) * SEC;
    assert.deepEqual(
      poll('flights', at, other(at), { feedState: 'partial' }),
      [],
    );
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  // A disc that covers the position counts.
  const near = { kind: 'circle', lat: 10.5, lon: 20, radiusKm: 438 };
  const out = [];
  for (let i = 13; i <= 15; i += 1) {
    out.push(
      ...poll('flights', T0 + (30 + i * 10) * SEC, [], { coverage: near }),
    );
  }
  assert.deepEqual(types(out), ['emergency-unresolved']);
});

test('a carried record keeps the track reported but never counts', () => {
  const { tracker, poll } = confirmed();
  for (let i = 1; i <= 5; i += 1) {
    assert.deepEqual(
      poll('flights', T0 + (30 + i * 10) * SEC, [row(T0 + 30 * SEC)]),
      [],
    );
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
});

test('a flights and military duplicate in the same epoch gives one start', () => {
  const { tracker, poll } = setup();
  const out = [];
  for (let i = 0; i < 4; i += 1) {
    const at = T0 + i * 15 * SEC;
    out.push(...poll('flights', at, [row(at)]));
    out.push(...poll('military', at, [row(at + 200, { military: true })]));
  }
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].sinceMs, T0);
  assert.equal(tracker.active().length, 1);
  assert.equal(tracker.diagnostics().tracked, 1);
});

test('unresolved needs counted absence from every layer that carried it', () => {
  const { tracker, poll } = setup();
  for (let i = 0; i < 3; i += 1) {
    const at = T0 + i * 15 * SEC;
    poll('flights', at, [row(at)]);
    poll('military', at, [row(at + 200)]);
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
  // Flights loses it while military keeps reporting it: still active.
  const out = [];
  for (let i = 3; i < 8; i += 1) {
    const at = T0 + i * 15 * SEC;
    out.push(...poll('flights', at, []));
    out.push(...poll('military', at, [row(at + 200)]));
  }
  assert.deepEqual(out, []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
  // Military loses it too: unresolved after its third missing epoch.
  for (let i = 8; i < 11; i += 1) {
    const at = T0 + i * 15 * SEC;
    out.push(...poll('flights', at, []));
    out.push(...poll('military', at, []));
  }
  assert.deepEqual(types(out), ['emergency-unresolved']);
});

test('a layer that never carried the aircraft does not affect it', () => {
  const { tracker, poll } = confirmed();
  for (let i = 1; i <= 5; i += 1) {
    const at = T0 + (30 + i * 10) * SEC;
    assert.deepEqual(poll('military', at, [], { stats: { stale: true } }), []);
    assert.deepEqual(poll('military', at + SEC, []), []);
  }
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.ACTIVE);
});

test('an older observation from the other layer never overrides', () => {
  const { tracker, poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { squawk: '2000' })]);
  // Military's first sight of it is an older 7700 receipt: per-layer fresh,
  // but older than the clear already applied, so it does not reset it.
  poll('military', T0 + 41 * SEC, [row(T0 + 35 * SEC)]);
  const out = poll('flights', T0 + 50 * SEC, [
    row(T0 + 50 * SEC, { squawk: '2000' }),
  ]);
  assert.deepEqual(types(out), ['emergency-end']);
  // After the end, military's lagging copy opens no new candidate.
  poll('military', T0 + 60 * SEC, [row(T0 + 35 * SEC)]);
  assert.deepEqual(tracker.active(), []);
});

test('priority kinds are ignored', () => {
  const { tracker, poll } = setup();
  for (let i = 0; i < 4; i += 1) {
    const at = T0 + i * 15 * SEC;
    poll('flights', at, [
      row(at, { icao24: 'aaa001', squawk: '1000', adsb: 'minfuel' }),
      row(at, { icao24: 'aaa002', squawk: '1000', adsb: 'lifeguard' }),
      // Malformed: flagged an emergency, but the kind is a priority status.
      row(at, {
        icao24: 'aaa003',
        squawk: '1000',
        emergency: true,
        emergencyKind: 'lifeguard',
      }),
    ]);
  }
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().retained, 0);
});

test('a priority status after a confirmed emergency counts as a clear', () => {
  const { poll } = confirmed();
  const out = pollSeries(poll, T0 + 40 * SEC, 10 * SEC, [
    (at) => [row(at, { squawk: '1000', adsb: 'minfuel' })],
    (at) => [row(at, { squawk: '1000', adsb: 'minfuel' })],
  ]);
  assert.deepEqual(types(out), ['emergency-end']);
});

test('an ADS-B-only emergency tracks with source ads-b', () => {
  const { poll } = setup();
  const out = pollSeries(poll, T0, 30 * SEC, [
    (at) => [row(at, { squawk: null, adsb: 'downed' })],
    (at) => [row(at, { squawk: null, adsb: 'downed' })],
  ]);
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].kind, 'downed');
  assert.equal(out[0].squawk, null);
  assert.equal(out[0].source, 'ads-b');
});

test('an emergency flag without a kind falls back to the squawk', () => {
  const { poll, tracker } = setup();
  const odd = (at, squawk) =>
    row(at, { squawk, emergency: true, emergencyKind: null });
  pollSeries(poll, T0, 30 * SEC, [
    (at) => [odd(at, '7500')],
    (at) => [odd(at, null)],
    (at) => [odd(at, null)],
  ]);
  // The unreadable polls neither confirm nor clear.
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CANDIDATE);
  assert.equal(tracker.active()[0].kind, 'unlawful');
});

test('on-ground and unlawful-interference caveats', () => {
  const ground = confirmed({}, { onGround: true });
  assert.deepEqual(ground.start.caveats, ['on-ground']);
  assert.equal(ground.start.onGround, true);
  const unlawful = confirmed({}, { squawk: '7500' });
  assert.equal(unlawful.start.kind, 'unlawful');
  assert.deepEqual(unlawful.start.caveats, ['code-may-be-in-error']);
  const both = confirmed({}, { squawk: '7500', onGround: true });
  assert.deepEqual(both.start.caveats, ['on-ground', 'code-may-be-in-error']);
});

test('capacity eviction removes ended and candidate tracks first', () => {
  const { tracker, poll } = setup({ capacity: 3 });
  const hex = (n) => `a0000${n}`;
  // Two confirmed emergencies.
  for (const at of [T0, T0 + 30 * SEC]) {
    poll('flights', at, [
      row(at, { icao24: hex(1) }),
      row(at, { icao24: hex(2) }),
    ]);
  }
  assert.equal(tracker.diagnostics().confirmed, 2);
  // A third aircraft becomes a candidate (capacity reached).
  poll('flights', T0 + 40 * SEC, [
    row(T0 + 40 * SEC, { icao24: hex(1) }),
    row(T0 + 40 * SEC, { icao24: hex(2) }),
    row(T0 + 40 * SEC, { icao24: hex(3) }),
  ]);
  // A fourth evicts the candidate, not a confirmed track, even though the
  // confirmed tracks were used less recently.
  poll('military', T0 + 41 * SEC, [row(T0 + 41 * SEC, { icao24: hex(4) })]);
  let keys = tracker
    .active()
    .map((item) => item.key)
    .sort();
  assert.deepEqual(keys, [hex(1), hex(2), hex(4)]);
  assert.equal(tracker.diagnostics().evicted, 1);
  // With only confirmed tracks and one candidate, the candidate goes again.
  poll('military', T0 + 42 * SEC, [row(T0 + 42 * SEC, { icao24: hex(5) })]);
  keys = tracker
    .active()
    .map((item) => item.key)
    .sort();
  assert.deepEqual(keys, [hex(1), hex(2), hex(5)]);
  assert.equal(tracker.diagnostics().retained, 3);
  assert.equal(tracker.diagnostics().evicted, 2);
});

test('capacity eviction falls back to the least recently used track', () => {
  const { tracker, poll } = setup({ capacity: 2 });
  for (const at of [T0, T0 + 30 * SEC]) {
    poll('flights', at, [
      row(at, { icao24: 'b00001' }),
      row(at, { icao24: 'b00002' }),
    ]);
  }
  // b00002 is used more recently than b00001.
  poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { icao24: 'b00002' })]);
  poll('military', T0 + 41 * SEC, [row(T0 + 41 * SEC, { icao24: 'b00003' })]);
  const keys = tracker
    .active()
    .map((item) => item.key)
    .sort();
  assert.deepEqual(keys, ['b00002', 'b00003']);
});

test('an unknown track is forgotten silently after forgetUnknownMs', () => {
  const { tracker, poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [], { stats: { stale: true } });
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  assert.deepEqual(
    poll('flights', T0 + 30 * SEC + 59 * MIN, [], { stats: { stale: true } }),
    [],
  );
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.UNKNOWN);
  assert.deepEqual(
    poll('flights', T0 + 30 * SEC + 61 * MIN, [], { stats: { stale: true } }),
    [],
  );
  assert.deepEqual(tracker.active(), []);
  assert.equal(tracker.diagnostics().forgotten, 1);
});

test('policy overrides apply and invalid values fall back', () => {
  const strict = setup({ confirmPolls: 3, minSpanMs: 0 });
  const out = pollSeries(strict.poll, T0, 5 * SEC, [
    (at) => [row(at)],
    (at) => [row(at)],
    (at) => [row(at)],
  ]);
  assert.deepEqual(types(out), ['emergency-start']);
  assert.equal(out[0].lastFixAtMs, T0 + 10 * SEC);
  const fallback = setup({ confirmPolls: 0, minSpanMs: -1, capacity: 'x' });
  const none = pollSeries(fallback.poll, T0, 10 * SEC, [
    (at) => [row(at)],
    (at) => [row(at)],
  ]);
  assert.deepEqual(none, []);
});

test('frames from other layers and malformed frames are ignored', () => {
  const { tracker } = setup();
  assert.deepEqual(tracker.observe(null), []);
  assert.deepEqual(tracker.observe({}), []);
  assert.deepEqual(tracker.observe({ layerId: 'ais-live-vessels' }), []);
  assert.deepEqual(
    tracker.observe({
      layerId: 'flights',
      answer: { state: 'counted' },
      assets: [null, 7, { kind: 'vessel', key: 'x', emergency: true }],
    }),
    [],
  );
  assert.deepEqual(
    tracker.observe(
      frame({ layerId: 'earthquakes', epochMs: T0, rows: [row(T0)] }),
    ),
    [],
  );
  assert.deepEqual(tracker.active(), []);
});

test('reset forgets tracks, epochs and counters', () => {
  const { tracker, poll } = confirmed();
  poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC, { icao24: 'c00001' })]);
  tracker.reset();
  assert.deepEqual(tracker.active(), []);
  assert.deepEqual(tracker.diagnostics(), {
    tracked: 0,
    transientIgnored: 0,
    candidates: 0,
    confirmed: 0,
    retained: 0,
    evicted: 0,
    forgotten: 0,
    untimedIgnored: 0,
  });
  // The same epoch is new again after a reset, and the code restarts as a
  // candidate rather than continuing.
  assert.deepEqual(poll('flights', T0 + 40 * SEC, [row(T0 + 40 * SEC)]), []);
  assert.equal(phaseOf(tracker), EMERGENCY_PHASE.CANDIDATE);
});

test('active lists newest first and carries no owner fields', () => {
  const { tracker, poll } = setup();
  poll('flights', T0, [
    row(T0, {
      icao24: 'd00001',
      operator: 'Example Air',
      registration: 'N12345',
      originCountry: 'Nowhere',
    }),
  ]);
  poll('flights', T0 + 10 * SEC, [
    row(T0 + 10 * SEC, { icao24: 'd00001' }),
    row(T0 + 10 * SEC, { icao24: 'd00002' }),
  ]);
  const list = tracker.active();
  assert.deepEqual(
    list.map((item) => item.key),
    ['d00002', 'd00001'],
  );
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ACTIVE_KEYS);
    for (const value of Object.values(item)) {
      assert.notEqual(value, undefined);
      assert.ok(typeof value !== 'number' || Number.isFinite(value));
    }
  }
  assert.ok(!JSON.stringify(list).includes('Example Air'));
  assert.ok(!JSON.stringify(list).includes('N12345'));
});

test('transitions are JSON-safe across a full lifecycle', () => {
  const { poll } = setup();
  const out = pollSeries(poll, T0, 30 * SEC, [
    (at) => [row(at)],
    (at) => [row(at)],
    (at) => [row(at, { squawk: '7600' })],
    (at) => [row(at, { squawk: '7600' })],
    (at) => [row(at, { squawk: '2000' })],
    (at) => [row(at, { squawk: '2000' })],
  ]);
  assert.deepEqual(types(out), [
    'emergency-start',
    'emergency-change',
    'emergency-end',
  ]);
  for (const item of out) {
    assert.deepEqual(Object.keys(item).sort(), TRANSITION_KEYS);
    assert.deepEqual(JSON.parse(JSON.stringify(item)), item);
    for (const value of Object.values(item)) assert.notEqual(value, undefined);
  }
  assert.equal(out[2].kind, 'nordo');
  assert.equal(out[2].squawk, '7600');
  assert.equal(out[2].durationMs, 90 * SEC);
});
