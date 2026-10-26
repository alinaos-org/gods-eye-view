// src/watch/eventLog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EVENT_LOG_POLICY,
  SEVERITY_RANK,
  createWatchEventLog,
} from './eventLog.js';

const T0 = 1_760_000_000_000;
const SEC = 1_000;
const MIN = 60_000;

const ROW_KEYS = [
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
  'repeat',
  'firstAtMs',
  'read',
].sort();

// ---------------------------------------------------------------- helpers

let seq = 0;

function ev(overrides = {}) {
  seq += 1;
  const type = overrides.type ?? 'zone-enter';
  const zoneId = overrides.zoneId === undefined ? 'z1' : overrides.zoneId;
  const assetKey =
    overrides.assetKey === undefined ? `aircraft:a${seq}` : overrides.assetKey;
  return {
    id: `e-${seq}`,
    seq,
    type,
    severity: 'notice',
    atMs: T0,
    dataAtMs: T0 - 5 * SEC,
    zoneId,
    assetKey,
    kind: 'aircraft',
    assetId: 'abc123',
    assetLabel: 'BAW12',
    layerId: 'flights',
    position: { lat: 51.47, lon: -0.45 },
    params: { sinceMs: T0 - MIN, reentry: false },
    caveats: [],
    watchlisted: false,
    dedupeKey: `${type}|${zoneId}|${assetKey}`,
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function fillZone(log, zoneId, count, atMs = T0) {
  const events = [];
  for (let i = 0; i < count; i += 1) events.push(ev({ zoneId, atMs }));
  return log.add(events, { nowMs: atMs });
}

// -------------------------------------------------------------- constants

test('policy and severity constants match the plan and are frozen', () => {
  assert.deepEqual(EVENT_LOG_POLICY, {
    capacity: 500,
    dedupeMs: 300_000,
    zoneWindowMs: 600_000,
    zoneMax: 30,
  });
  assert.deepEqual(SEVERITY_RANK, { info: 0, notice: 1, alert: 2 });
  assert.ok(Object.isFrozen(EVENT_LOG_POLICY));
  assert.ok(Object.isFrozen(SEVERITY_RANK));
});

test('the log exposes exactly the contract methods', () => {
  const log = createWatchEventLog();
  assert.deepEqual(Object.keys(log).sort(), [
    'add',
    'clear',
    'list',
    'markRead',
    'size',
    'suppressedCount',
    'unreadCount',
  ]);
  assert.equal(log.size(), 0);
  assert.equal(log.unreadCount(), 0);
  assert.equal(log.suppressedCount(), 0);
  assert.deepEqual(log.list(), []);
});

// --------------------------------------------------------------- new rows

test('a new event becomes a JSON-safe row with log bookkeeping', () => {
  const log = createWatchEventLog();
  const event = deepFreeze(ev({ caveats: ['lower-bound'] }));
  const result = log.add([event], { nowMs: T0 });
  assert.deepEqual(result, {
    accepted: 1,
    merged: 0,
    suppressed: 0,
    rejected: 0,
    evicted: 0,
  });
  const [row] = log.list();
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
  assert.equal(row.id, event.id);
  assert.equal(row.type, 'zone-enter');
  assert.equal(row.severity, 'notice');
  assert.equal(row.atMs, T0);
  assert.equal(row.firstAtMs, T0);
  assert.equal(row.repeat, 1);
  assert.equal(row.read, false);
  assert.deepEqual(row.position, { lat: 51.47, lon: -0.45 });
  assert.deepEqual(row.params, event.params);
  assert.deepEqual(row.caveats, ['lower-bound']);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
});

test('missing and invalid optional fields become null, never undefined', () => {
  const log = createWatchEventLog();
  log.add(
    [
      {
        type: 'feed-paused',
        atMs: T0,
        severity: 'bogus',
        dataAtMs: Number.NaN,
        position: { lat: Number.NaN, lon: 2 },
        params: { reason: 'stale', sinceMs: Infinity, nested: [1, NaN] },
        caveats: ['partial-coverage', 7, ''],
      },
    ],
    { nowMs: T0 },
  );
  const [row] = log.list();
  assert.equal(row.severity, 'info');
  assert.equal(row.seq, null);
  assert.equal(row.dataAtMs, null);
  assert.equal(row.zoneId, null);
  assert.equal(row.assetKey, null);
  assert.equal(row.kind, null);
  assert.equal(row.assetId, null);
  assert.equal(row.assetLabel, null);
  assert.equal(row.layerId, null);
  assert.equal(row.position, null);
  assert.equal(row.dedupeKey, null);
  assert.equal(row.watchlisted, false);
  assert.deepEqual(row.params, {
    reason: 'stale',
    sinceMs: null,
    nested: [1, null],
  });
  assert.deepEqual(row.caveats, ['partial-coverage']);
  for (const key of ROW_KEYS) assert.notEqual(row[key], undefined, key);
  assert.match(row.id, /^log-\d+$/);
});

test('rows keep only the event contract fields (no owner or person data)', () => {
  const log = createWatchEventLog();
  log.add([ev({ owner: 'someone', registrant: 'x', operatorName: 'y' })], {
    nowMs: T0,
  });
  const [row] = log.list();
  assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
  assert.doesNotMatch(JSON.stringify(row), /someone|owner|registrant/);
});

test('malformed events are rejected and counted, never stored', () => {
  const log = createWatchEventLog();
  const result = log.add(
    [
      null,
      42,
      'zone-enter',
      {},
      { type: '', atMs: T0 },
      { type: 'zone-enter' },
      { type: 'zone-enter', atMs: Number.NaN },
      { type: 7, atMs: T0 },
    ],
    { nowMs: T0 },
  );
  assert.equal(result.rejected, 8);
  assert.equal(result.accepted, 0);
  assert.equal(log.size(), 0);
  assert.deepEqual(log.add(undefined), {
    accepted: 0,
    merged: 0,
    suppressed: 0,
    rejected: 0,
    evicted: 0,
  });
});

test('a single event object is accepted without an array', () => {
  const log = createWatchEventLog();
  assert.equal(log.add(ev(), { nowMs: T0 }).accepted, 1);
  assert.equal(log.size(), 1);
});

test('inputs are never mutated and reads return copies', () => {
  const log = createWatchEventLog();
  const event = deepFreeze(ev({ params: { labels: ['A'], count: 1 } }));
  log.add([event], { nowMs: T0 });
  const [row] = log.list();
  row.params.labels.push('B');
  row.position.lat = 0;
  row.caveats.push('x');
  row.read = true;
  const [again] = log.list();
  assert.deepEqual(again.params, { labels: ['A'], count: 1 });
  assert.equal(again.position.lat, 51.47);
  assert.deepEqual(again.caveats, []);
  assert.equal(again.read, false);
});

test('a duplicate event id gets a distinct row id', () => {
  const log = createWatchEventLog();
  log.add([ev({ id: 'e-1' }), ev({ id: 'e-1' })], { nowMs: T0 });
  const ids = log.list().map((row) => row.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.includes('e-1'));
  const other = ids.find((id) => id !== 'e-1');
  assert.equal(log.markRead(other), 1);
  const rows = log.list();
  assert.equal(rows.find((r) => r.id === 'e-1').read, false);
  assert.equal(rows.find((r) => r.id === other).read, true);
});

// ------------------------------------------------------------------ dedupe

test('the same dedupeKey within 5 minutes merges into the existing row', () => {
  const log = createWatchEventLog();
  const first = ev({ assetKey: 'aircraft:abc123' });
  log.add([first], { nowMs: T0 });
  assert.equal(log.markRead(first.id), 1);
  assert.equal(log.unreadCount(), 0);

  const second = ev({
    assetKey: 'aircraft:abc123',
    atMs: T0 + 4 * MIN,
    dataAtMs: T0 + 4 * MIN - SEC,
    params: { sinceMs: T0 + 3 * MIN, reentry: true },
    caveats: ['lower-bound'],
    position: { lat: 51.5, lon: -0.4 },
    assetLabel: 'BAW12X',
  });
  const result = log.add([second], { nowMs: T0 + 4 * MIN });
  assert.equal(result.merged, 1);
  assert.equal(result.accepted, 0);
  assert.equal(log.size(), 1);

  const [row] = log.list();
  assert.equal(row.id, first.id);
  assert.equal(row.repeat, 2);
  assert.equal(row.firstAtMs, T0);
  assert.equal(row.atMs, T0 + 4 * MIN);
  assert.equal(row.dataAtMs, T0 + 4 * MIN - SEC);
  assert.equal(row.seq, second.seq);
  assert.deepEqual(row.params, { sinceMs: T0 + 3 * MIN, reentry: true });
  assert.deepEqual(row.caveats, ['lower-bound']);
  assert.deepEqual(row.position, { lat: 51.5, lon: -0.4 });
  assert.equal(row.assetLabel, 'BAW12X');
  assert.equal(row.read, false, 'a merge makes the row unread again');
  assert.equal(log.unreadCount(), 1);
});

test('a merge keeps the last position and label when the new event has none', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'k' })], { nowMs: T0 });
  log.add([ev({ assetKey: 'k', position: null, assetLabel: null })], {
    nowMs: T0 + MIN,
  });
  const [row] = log.list();
  assert.equal(row.repeat, 2);
  assert.deepEqual(row.position, { lat: 51.47, lon: -0.45 });
  assert.equal(row.assetLabel, 'BAW12');
});

test('the same dedupeKey after 5 minutes starts a new row', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'k' })], { nowMs: T0 });
  const atEdge = log.add([ev({ assetKey: 'k', atMs: T0 + 5 * MIN })], {
    nowMs: T0 + 5 * MIN,
  });
  assert.equal(atEdge.merged, 1, 'exactly 5 minutes still merges');
  const after = log.add([ev({ assetKey: 'k', atMs: T0 + 10 * MIN + 1 })], {
    nowMs: T0 + 10 * MIN + 1,
  });
  assert.equal(after.accepted, 1);
  assert.equal(after.merged, 0);
  assert.equal(log.size(), 2);
  const [newest, oldest] = log.list();
  assert.equal(newest.repeat, 1);
  assert.equal(newest.firstAtMs, T0 + 10 * MIN + 1);
  assert.equal(oldest.repeat, 2);

  // Later repeats merge into the newest row for that key.
  const again = log.add([ev({ assetKey: 'k', atMs: T0 + 11 * MIN })], {
    nowMs: T0 + 11 * MIN,
  });
  assert.equal(again.merged, 1);
  assert.equal(log.list()[0].repeat, 2);
  assert.equal(log.list()[1].repeat, 2);
});

test('the dedupe window slides with each merge', () => {
  const log = createWatchEventLog();
  for (let i = 0; i < 5; i += 1) {
    const atMs = T0 + i * 4 * MIN;
    log.add([ev({ assetKey: 'k', atMs })], { nowMs: atMs });
  }
  assert.equal(log.size(), 1);
  assert.equal(log.list()[0].repeat, 5);
  assert.equal(log.list()[0].firstAtMs, T0);
  assert.equal(log.list()[0].atMs, T0 + 16 * MIN);
});

test('same-key events in one batch merge; events without a key never do', () => {
  const log = createWatchEventLog();
  const result = log.add(
    [
      ev({ assetKey: 'k' }),
      ev({ assetKey: 'k' }),
      ev({ dedupeKey: null }),
      ev({ dedupeKey: null }),
      ev({ dedupeKey: '' }),
    ],
    { nowMs: T0 },
  );
  assert.equal(result.accepted, 4);
  assert.equal(result.merged, 1);
  assert.equal(log.size(), 4);
});

test('a merge keeps the higher severity and latches watchlisted', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'k', severity: 'notice' })], { nowMs: T0 });
  log.add([ev({ assetKey: 'k', severity: 'alert', watchlisted: true })], {
    nowMs: T0 + MIN,
  });
  log.add([ev({ assetKey: 'k', severity: 'info', watchlisted: false })], {
    nowMs: T0 + 2 * MIN,
  });
  const [row] = log.list();
  assert.equal(row.repeat, 3);
  assert.equal(row.severity, 'alert');
  assert.equal(row.watchlisted, true);
});

test('a merged row moves to the top of the list', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'a' })], { nowMs: T0 });
  log.add([ev({ assetKey: 'b' })], { nowMs: T0 + SEC });
  assert.equal(log.list()[0].assetKey, 'b');
  log.add([ev({ assetKey: 'a' })], { nowMs: T0 + 2 * SEC });
  assert.deepEqual(
    log.list().map((r) => r.assetKey),
    ['a', 'b'],
  );
});

test('without nowMs each event time is the clock', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'k', atMs: T0 })]);
  assert.equal(log.add([ev({ assetKey: 'k', atMs: T0 + 4 * MIN })]).merged, 1);
  assert.equal(
    log.add([ev({ assetKey: 'k', atMs: T0 + 10 * MIN })]).accepted,
    1,
  );
});

test('nowMs, when given, is the clock for the dedupe window', () => {
  const log = createWatchEventLog();
  log.add([ev({ assetKey: 'k', atMs: T0 })], { nowMs: T0 });
  // Event time says 1 minute, but the log clock says 6 minutes.
  const late = log.add([ev({ assetKey: 'k', atMs: T0 + MIN })], {
    nowMs: T0 + 6 * MIN,
  });
  assert.equal(late.accepted, 1);
  assert.equal(late.merged, 0);
});

// ---------------------------------------------------------------- rate cap

test('the 31st row for one zone in 10 minutes is suppressed', () => {
  const log = createWatchEventLog();
  const first = fillZone(log, 'z1', 30);
  assert.equal(first.accepted, 30);
  assert.equal(first.suppressed, 0);
  const extra = log.add([ev({ zoneId: 'z1' })], { nowMs: T0 + MIN });
  assert.equal(extra.suppressed, 1);
  assert.equal(extra.accepted, 0);
  assert.equal(log.size(), 30);
  assert.equal(log.suppressedCount('z1'), 1);
  assert.equal(log.suppressedCount('z2'), 0);
  assert.equal(log.suppressedCount(), 1);
});

test('alerts and watchlisted events pass the cap', () => {
  const log = createWatchEventLog();
  fillZone(log, 'z1', 30);
  const result = log.add(
    [
      ev({ zoneId: 'z1', severity: 'alert' }),
      ev({ zoneId: 'z1', severity: 'notice', watchlisted: true }),
      ev({ zoneId: 'z1', severity: 'info' }),
    ],
    { nowMs: T0 + MIN },
  );
  assert.equal(result.accepted, 2);
  assert.equal(result.suppressed, 1);
  assert.equal(log.size(), 32);
  assert.equal(log.list({ minSeverity: 'alert' }).length, 1);
});

test('exempt rows do not use up the zone cap', () => {
  const log = createWatchEventLog();
  const alerts = [];
  for (let i = 0; i < 10; i += 1) {
    alerts.push(ev({ zoneId: 'z1', severity: 'alert' }));
  }
  log.add(alerts, { nowMs: T0 });
  assert.equal(fillZone(log, 'z1', 30).accepted, 30);
  assert.equal(log.size(), 40);
});

test('alerts are exempt from the cap but not from dedupe', () => {
  const log = createWatchEventLog();
  fillZone(log, 'z1', 30);
  const alert = ev({ zoneId: 'z1', severity: 'alert', assetKey: 'k' });
  log.add([alert], { nowMs: T0 });
  const repeat = log.add(
    [ev({ zoneId: 'z1', severity: 'alert', assetKey: 'k' })],
    { nowMs: T0 + MIN },
  );
  assert.equal(repeat.merged, 1);
  assert.equal(repeat.accepted, 0);
  assert.equal(log.size(), 31);
});

test('merges are allowed while a zone is capped', () => {
  const log = createWatchEventLog();
  const events = [];
  for (let i = 0; i < 30; i += 1) {
    events.push(ev({ zoneId: 'z1', assetKey: `k${i}` }));
  }
  log.add(events, { nowMs: T0 });
  const result = log.add(
    [
      ev({ zoneId: 'z1', assetKey: 'k3' }),
      ev({ zoneId: 'z1', assetKey: 'new' }),
    ],
    { nowMs: T0 + MIN },
  );
  assert.equal(result.merged, 1);
  assert.equal(result.suppressed, 1);
  assert.equal(log.suppressedCount('z1'), 1);
});

test('the cap is per zone and does not apply to zoneless events', () => {
  const log = createWatchEventLog();
  fillZone(log, 'z1', 30);
  assert.equal(fillZone(log, 'z2', 30).accepted, 30);
  assert.equal(fillZone(log, null, 40).accepted, 40);
  assert.equal(log.size(), 100);
  assert.equal(log.suppressedCount(), 0);
});

test('the zone window rolls: rows are accepted again after 10 minutes', () => {
  const log = createWatchEventLog();
  fillZone(log, 'z1', 20, T0);
  fillZone(log, 'z1', 10, T0 + 5 * MIN);
  assert.equal(
    log.add([ev({ zoneId: 'z1' })], { nowMs: T0 + 9 * MIN }).suppressed,
    1,
  );
  // The first 20 have aged out; the 10 from minute 5 still count.
  const rolled = fillZone(log, 'z1', 21, T0 + 10 * MIN);
  assert.equal(rolled.accepted, 20);
  assert.equal(rolled.suppressed, 1);
  assert.equal(log.suppressedCount('z1'), 2);
});

// ------------------------------------------------------------ read state

test('unreadCount counts unread notice and alert rows only', () => {
  const log = createWatchEventLog();
  const info = ev({ severity: 'info' });
  const notice = ev({ severity: 'notice' });
  const alert = ev({ severity: 'alert' });
  log.add([info, notice, alert], { nowMs: T0 });
  assert.equal(log.size(), 3);
  assert.equal(log.unreadCount(), 2);
  assert.equal(log.markRead(info.id), 1);
  assert.equal(log.unreadCount(), 2);
  assert.equal(log.markRead(notice.id), 1);
  assert.equal(log.unreadCount(), 1);
  assert.equal(log.markRead(notice.id), 0, 'already read');
  assert.equal(log.markRead('missing'), 0);
  assert.equal(log.markRead(undefined), 0);
  assert.equal(log.unreadCount(), 1);
});

test("markRead('all') marks every row read", () => {
  const log = createWatchEventLog();
  log.add([ev({ severity: 'info' }), ev(), ev({ severity: 'alert' })], {
    nowMs: T0,
  });
  assert.equal(log.markRead('all'), 3);
  assert.equal(log.unreadCount(), 0);
  assert.ok(log.list().every((row) => row.read));
  assert.equal(log.markRead('all'), 0);
  log.add([ev()], { nowMs: T0 + SEC });
  assert.equal(log.unreadCount(), 1);
});

// ---------------------------------------------------------------- eviction

test('the oldest rows are evicted first past capacity', () => {
  const log = createWatchEventLog({ capacity: 3 });
  const events = [];
  for (let i = 0; i < 5; i += 1) {
    events.push(ev({ assetKey: `k${i}`, atMs: T0 + i * SEC }));
  }
  const result = log.add(events, { nowMs: T0 });
  assert.equal(result.accepted, 5);
  assert.equal(result.evicted, 2);
  assert.equal(log.size(), 3);
  assert.deepEqual(
    log.list().map((r) => r.assetKey),
    ['k4', 'k3', 'k2'],
  );
  // An evicted row's key starts a new row instead of merging.
  const again = log.add([ev({ assetKey: 'k0' })], { nowMs: T0 + SEC });
  assert.equal(again.accepted, 1);
  assert.equal(again.evicted, 1);
  assert.deepEqual(
    log.list().map((r) => r.assetKey),
    ['k0', 'k4', 'k3'],
  );
});

test('a recently merged row survives eviction over older rows', () => {
  const log = createWatchEventLog({ capacity: 2 });
  log.add([ev({ assetKey: 'a' }), ev({ assetKey: 'b' })], { nowMs: T0 });
  log.add([ev({ assetKey: 'a' })], { nowMs: T0 + SEC });
  log.add([ev({ assetKey: 'c' })], { nowMs: T0 + 2 * SEC });
  assert.deepEqual(
    log.list().map((r) => r.assetKey),
    ['c', 'a'],
  );
  assert.equal(log.unreadCount(), 2);
});

test('the default capacity holds 500 rows', () => {
  const log = createWatchEventLog();
  const events = [];
  for (let i = 0; i < 520; i += 1) {
    events.push(ev({ zoneId: null, assetKey: `k${i}` }));
  }
  const result = log.add(events, { nowMs: T0 });
  assert.equal(result.evicted, 20);
  assert.equal(log.size(), 500);
  assert.equal(log.list({ limit: Infinity }).at(-1).assetKey, 'k20');
});

// ------------------------------------------------------------------- clear

test('clear empties rows, unread, suppressed counts and windows', () => {
  const log = createWatchEventLog();
  fillZone(log, 'z1', 31);
  log.add([ev({ zoneId: null, assetKey: 'k' })], { nowMs: T0 });
  assert.equal(log.suppressedCount('z1'), 1);
  log.clear();
  assert.equal(log.size(), 0);
  assert.equal(log.unreadCount(), 0);
  assert.equal(log.suppressedCount(), 0);
  assert.equal(log.suppressedCount('z1'), 0);
  assert.deepEqual(log.list(), []);
  const after = log.add([ev({ zoneId: null, assetKey: 'k' })], {
    nowMs: T0 + SEC,
  });
  assert.equal(after.accepted, 1, 'a cleared row is never merged into');
  assert.equal(log.list()[0].repeat, 1);
  assert.equal(fillZone(log, 'z1', 30, T0 + SEC).accepted, 30);
});

// -------------------------------------------------------------------- list

test('list filters by minimum severity and zone, newest first', () => {
  const log = createWatchEventLog();
  log.add(
    [
      ev({ zoneId: 'z1', severity: 'info', assetKey: 'a' }),
      ev({ zoneId: 'z2', severity: 'notice', assetKey: 'b' }),
      ev({ zoneId: 'z1', severity: 'alert', assetKey: 'c' }),
      ev({ zoneId: null, severity: 'notice', assetKey: 'd' }),
    ],
    { nowMs: T0 },
  );
  const keys = (rows) => rows.map((r) => r.assetKey);
  assert.deepEqual(keys(log.list()), ['d', 'c', 'b', 'a']);
  assert.deepEqual(keys(log.list({ minSeverity: 'info' })), [
    'd',
    'c',
    'b',
    'a',
  ]);
  assert.deepEqual(keys(log.list({ minSeverity: 'notice' })), ['d', 'c', 'b']);
  assert.deepEqual(keys(log.list({ minSeverity: 'alert' })), ['c']);
  assert.deepEqual(keys(log.list({ minSeverity: 'nonsense' })), [
    'd',
    'c',
    'b',
    'a',
  ]);
  assert.deepEqual(keys(log.list({ zoneId: 'z1' })), ['c', 'a']);
  assert.deepEqual(keys(log.list({ zoneId: 'z1', minSeverity: 'notice' })), [
    'c',
  ]);
  assert.deepEqual(keys(log.list({ zoneId: 'nope' })), []);
});

test('list limits default to 50 and accept 0 and Infinity', () => {
  const log = createWatchEventLog();
  fillZone(log, null, 60);
  assert.equal(log.list().length, 50);
  assert.equal(log.list({ limit: 5 }).length, 5);
  assert.equal(log.list({ limit: 2.9 }).length, 2);
  assert.equal(log.list({ limit: 0 }).length, 0);
  assert.equal(log.list({ limit: -3 }).length, 0);
  assert.equal(log.list({ limit: Number.NaN }).length, 50);
  assert.equal(log.list({ limit: Infinity }).length, 60);
});

// ------------------------------------------------------------------ policy

test('policy overrides apply and invalid values keep the defaults', () => {
  const log = createWatchEventLog({ dedupeMs: MIN, zoneMax: 2 });
  log.add([ev({ assetKey: 'k' })], { nowMs: T0 });
  assert.equal(
    log.add([ev({ assetKey: 'k' })], { nowMs: T0 + 2 * MIN }).accepted,
    1,
  );
  assert.equal(log.add([ev()], { nowMs: T0 + 2 * MIN }).suppressed, 1);

  const fallback = createWatchEventLog({
    capacity: -1,
    dedupeMs: 'x',
    zoneWindowMs: Number.NaN,
    zoneMax: null,
  });
  assert.equal(fillZone(fallback, 'z1', 31).suppressed, 1);
  fallback.add([ev({ zoneId: null, assetKey: 'k' })], { nowMs: T0 });
  assert.equal(
    fallback.add([ev({ zoneId: null, assetKey: 'k' })], {
      nowMs: T0 + 4 * MIN,
    }).merged,
    1,
  );
  assert.equal(createWatchEventLog(null).size(), 0);
  assert.equal(createWatchEventLog('nope').size(), 0);
});

test('zoneMax 0 suppresses every capped event but not alerts', () => {
  const log = createWatchEventLog({ zoneMax: 0 });
  const result = log.add([ev(), ev({ severity: 'alert' })], { nowMs: T0 });
  assert.equal(result.suppressed, 1);
  assert.equal(result.accepted, 1);
});

// ------------------------------------------------------------- portability

test('the module is portable: no imports, clocks, randomness or globals', () => {
  const source = readFileSync(
    new URL('./eventLog.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  for (const banned of [
    'Date.now',
    'new Date',
    'Math.random',
    'setTimeout',
    'setInterval',
    'localStorage',
    'sessionStorage',
    'window.',
    'document.',
    'globalThis',
    'Cesium',
  ]) {
    assert.ok(!source.includes(banned), `eventLog.js mentions ${banned}`);
  }
  assert.doesNotMatch(source, /\b(label|title|status|hint)\s*:\s*['"`]/);
  assert.doesNotMatch(source, /owner|registrant/i);
});
