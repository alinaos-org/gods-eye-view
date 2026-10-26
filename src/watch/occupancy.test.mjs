// src/watch/occupancy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  OCCUPANCY_SERIES_DEFAULTS,
  createOccupancySeries,
} from './occupancy.js';

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
// A minute-aligned base time.
const T0 = 29_333_340 * MIN;

// ---------------------------------------------------------------- basics

test('defaults match the plan and are frozen', () => {
  assert.deepEqual(OCCUPANCY_SERIES_DEFAULTS, { stepMs: 60_000, samples: 360 });
  assert.ok(Object.isFrozen(OCCUPANCY_SERIES_DEFAULTS));
  assert.equal(T0 % MIN, 0);
});

test('the series exposes record, summary, values and clear', () => {
  const series = createOccupancySeries();
  assert.deepEqual(Object.keys(series).sort(), [
    'clear',
    'record',
    'summary',
    'values',
  ]);
});

test('an empty series has no summary and no values', () => {
  const series = createOccupancySeries();
  assert.equal(series.summary(T0), null);
  assert.equal(series.summary(), null);
  assert.deepEqual(series.values(), {
    startMs: null,
    stepMs: MIN,
    values: [],
    floor: [],
  });
  assert.deepEqual(series.values(T0).values, []);
});

test('counted samples fill consecutive buckets and summarise', () => {
  const series = createOccupancySeries();
  const counts = [4, 9, 2, 7, 5];
  counts.forEach((count, i) => {
    assert.equal(series.record(T0 + i * MIN + 10 * SEC, count), true);
  });
  assert.deepEqual(series.values(), {
    startMs: T0,
    stepMs: MIN,
    values: counts,
    floor: [false, false, false, false, false],
  });
  assert.deepEqual(series.summary(T0 + 4 * MIN + 30 * SEC), {
    sinceMs: T0 + 10 * SEC,
    min: 2,
    median: 5,
    max: 9,
    samples: 5,
    floorSamples: 0,
  });
});

test('the median of an even number of samples is the mean of the middle two', () => {
  const series = createOccupancySeries();
  [1, 10, 3, 4].forEach((count, i) => series.record(T0 + i * MIN, count));
  const summary = series.summary(T0 + 3 * MIN);
  assert.equal(summary.median, 3.5);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 10);
});

test('zero is a real counted value, distinct from a gap', () => {
  const series = createOccupancySeries();
  series.record(T0, 0);
  series.record(T0 + MIN, null);
  series.record(T0 + 2 * MIN, 0);
  assert.deepEqual(series.values().values, [0, null, 0]);
  const summary = series.summary(T0 + 2 * MIN);
  assert.equal(summary.samples, 2);
  assert.equal(summary.median, 0);
});

// ----------------------------------------------------------------- buckets

test('a bucket holds the last counted value', () => {
  const series = createOccupancySeries();
  series.record(T0 + 5 * SEC, 3);
  series.record(T0 + 30 * SEC, 8);
  assert.deepEqual(series.values().values, [8]);
  // An earlier sample time in the same bucket does not overwrite it.
  assert.equal(series.record(T0 + 10 * SEC, 1), false);
  assert.deepEqual(series.values().values, [8]);
  // Equal times: the later call wins.
  series.record(T0 + 30 * SEC, 6);
  assert.deepEqual(series.values().values, [6]);
});

test('a null record never erases a counted value in its bucket', () => {
  const series = createOccupancySeries();
  series.record(T0 + 5 * SEC, 3);
  assert.equal(series.record(T0 + 50 * SEC, null), false);
  assert.deepEqual(series.values().values, [3]);
  assert.equal(series.summary(T0 + 50 * SEC).samples, 1);
});

test('a later floor sample replaces the counted value and its flag', () => {
  const series = createOccupancySeries();
  series.record(T0 + 5 * SEC, 12);
  series.record(T0 + 40 * SEC, 5, { floor: true });
  assert.deepEqual(series.values(), {
    startMs: T0,
    stepMs: MIN,
    values: [5],
    floor: [true],
  });
  series.record(T0 + 50 * SEC, 11, { floor: false });
  assert.deepEqual(series.values().floor, [false]);
});

test('buckets roll over on step boundaries', () => {
  const series = createOccupancySeries();
  series.record(T0 + 59_999, 1);
  series.record(T0 + MIN, 2);
  series.record(T0 + MIN + 59_999, 3);
  series.record(T0 + 2 * MIN, 4);
  assert.deepEqual(series.values(), {
    startMs: T0,
    stepMs: MIN,
    values: [1, 3, 4],
    floor: [false, false, false],
  });
});

test('gaps stay null: skipped buckets and null records are never 0', () => {
  const series = createOccupancySeries();
  series.record(T0, 5);
  series.record(T0 + 2 * MIN, null);
  series.record(T0 + 5 * MIN, 7);
  const out = series.values();
  assert.deepEqual(out.values, [5, null, null, null, null, 7]);
  assert.deepEqual(out.floor, [false, false, false, false, false, false]);
  assert.ok(!out.values.includes(0));
  assert.equal(series.summary(T0 + 5 * MIN).samples, 2);
  assert.equal(series.summary(T0 + 5 * MIN).min, 5);
});

test('a series that starts with null records reads as gaps', () => {
  const series = createOccupancySeries();
  series.record(T0, null);
  series.record(T0 + MIN, null);
  assert.deepEqual(series.values(), {
    startMs: T0,
    stepMs: MIN,
    values: [null, null],
    floor: [false, false],
  });
  assert.equal(series.summary(T0 + MIN), null);
});

test('invalid counts are gaps and invalid times change nothing', () => {
  const series = createOccupancySeries();
  series.record(T0, 4);
  for (const bad of [-1, Number.NaN, Infinity, '7', undefined, {}]) {
    assert.equal(series.record(T0 + MIN, bad), false);
  }
  for (const badTime of [Number.NaN, Infinity, '1', null, 1e300]) {
    assert.equal(series.record(badTime, 9), false);
  }
  assert.deepEqual(series.values().values, [4, null]);
});

// -------------------------------------------------------------------- wrap

test('the ring wraps after 6 hours of one-minute buckets', () => {
  const series = createOccupancySeries();
  for (let i = 0; i <= 360; i += 1) series.record(T0 + i * MIN, i);
  const out = series.values();
  assert.equal(out.values.length, 360);
  assert.equal(out.floor.length, 360);
  assert.equal(out.startMs, T0 + MIN);
  assert.equal(out.values[0], 1);
  assert.equal(out.values.at(-1), 360);
  const summary = series.summary(T0 + 360 * MIN);
  assert.equal(summary.samples, 360);
  assert.equal(summary.min, 1, 'the sample from 6 hours ago rolled off');
  assert.equal(summary.max, 360);
  assert.equal(summary.sinceMs, T0 + MIN);
  // A sample older than the ring is ignored.
  assert.equal(series.record(T0, 99), false);
  assert.equal(series.values().values[0], 1);
});

test('wrapping keeps old slots from leaking into new buckets', () => {
  const series = createOccupancySeries({ samples: 4 });
  series.record(T0, 1);
  series.record(T0 + MIN, 2);
  series.record(T0 + 2 * MIN, 3);
  series.record(T0 + 3 * MIN, 4);
  // Bucket 5 reuses slot 1 and skips bucket 4 (slot 0).
  series.record(T0 + 5 * MIN, 6);
  assert.deepEqual(series.values(), {
    startMs: T0 + 2 * MIN,
    stepMs: MIN,
    values: [3, 4, null, 6],
    floor: [false, false, false, false],
  });
});

test('a jump longer than the ring clears every bucket', () => {
  const series = createOccupancySeries();
  series.record(T0, 3, { floor: true });
  series.record(T0 + MIN, 4);
  series.record(T0 + 400 * MIN, 9);
  const out = series.values();
  assert.equal(out.values.length, 360);
  assert.equal(out.startMs, T0 + 41 * MIN);
  assert.equal(out.values.filter((v) => v !== null).length, 1);
  assert.equal(out.values.at(-1), 9);
  assert.equal(out.floor.filter(Boolean).length, 0);
  assert.deepEqual(series.summary(T0 + 400 * MIN), {
    sinceMs: T0 + 400 * MIN,
    min: 9,
    median: 9,
    max: 9,
    samples: 1,
    floorSamples: 0,
  });
});

test('an out-of-order sample inside the ring is stored', () => {
  const series = createOccupancySeries();
  series.record(T0 + 5 * MIN, 5);
  assert.equal(series.record(T0 + 3 * MIN, 3), true);
  assert.deepEqual(series.values(), {
    startMs: T0 + 3 * MIN,
    stepMs: MIN,
    values: [3, null, 5],
    floor: [false, false, false],
  });
});

// ------------------------------------------------------------ floor samples

test('floor samples are excluded from the summary and counted apart', () => {
  const series = createOccupancySeries();
  series.record(T0, 10);
  series.record(T0 + MIN, 50, { floor: true });
  series.record(T0 + 2 * MIN, 20);
  series.record(T0 + 3 * MIN, 1, { floor: true });
  series.record(T0 + 4 * MIN, null);
  assert.deepEqual(series.values(), {
    startMs: T0,
    stepMs: MIN,
    values: [10, 50, 20, 1, null],
    floor: [false, true, false, true, false],
  });
  assert.deepEqual(series.summary(T0 + 4 * MIN), {
    sinceMs: T0,
    min: 10,
    median: 15,
    max: 20,
    samples: 2,
    floorSamples: 2,
  });
});

test('a series of floor samples only has no summary', () => {
  const series = createOccupancySeries();
  series.record(T0, 4, { floor: true });
  series.record(T0 + MIN, 6, { floor: true });
  assert.equal(series.summary(T0 + MIN), null);
  assert.deepEqual(series.values().floor, [true, true]);
});

test('sinceMs is the earliest non-floor sample, not an earlier floor one', () => {
  const series = createOccupancySeries();
  series.record(T0 + 5 * SEC, 4, { floor: true });
  series.record(T0 + MIN + 7 * SEC, 6);
  assert.equal(series.summary(T0 + MIN).sinceMs, T0 + MIN + 7 * SEC);
});

// ----------------------------------------------------------- nowMs window

test('summary(nowMs) drops samples that fell out of the window', () => {
  const series = createOccupancySeries({ samples: 10 });
  for (let i = 0; i < 5; i += 1) series.record(T0 + i * MIN, 100 + i);
  // Window at minute 12 covers minutes 3..12: only samples 3 and 4 remain.
  assert.deepEqual(series.summary(T0 + 12 * MIN), {
    sinceMs: T0 + 3 * MIN,
    min: 103,
    median: 103.5,
    max: 104,
    samples: 2,
    floorSamples: 0,
  });
  // Past the whole ring, nothing is left.
  assert.equal(series.summary(T0 + 14 * MIN), null);
  // Without nowMs, the window ends at the latest bucket.
  assert.equal(series.summary().samples, 5);
});

test('summary(nowMs) before the latest bucket keeps the latest window', () => {
  const series = createOccupancySeries();
  series.record(T0, 1);
  series.record(T0 + 2 * MIN, 3);
  assert.equal(series.summary(T0).samples, 2);
  assert.equal(series.summary(Number.NaN).samples, 2);
});

test('values(nowMs) adds trailing gaps up to nowMs without changing state', () => {
  const series = createOccupancySeries({ samples: 6 });
  series.record(T0, 2);
  series.record(T0 + MIN, 3);
  assert.deepEqual(series.values(T0 + 3 * MIN + 30 * SEC), {
    startMs: T0,
    stepMs: MIN,
    values: [2, 3, null, null],
    floor: [false, false, false, false],
  });
  assert.deepEqual(series.values(T0 + 7 * MIN), {
    startMs: T0 + 2 * MIN,
    stepMs: MIN,
    values: [null, null, null, null, null, null],
    floor: [false, false, false, false, false, false],
  });
  assert.deepEqual(series.values().values, [2, 3]);
  assert.deepEqual(series.values(T0).values, [2, 3]);
});

// ---------------------------------------------------------------- options

test('custom step and ring length are honoured', () => {
  const series = createOccupancySeries({ stepMs: 5 * MIN, samples: 3 });
  series.record(T0, 1);
  series.record(T0 + 4 * MIN, 2);
  series.record(T0 + 5 * MIN, 3);
  series.record(T0 + 15 * MIN, 4);
  assert.deepEqual(series.values(), {
    startMs: T0 + 5 * MIN,
    stepMs: 5 * MIN,
    values: [3, null, 4],
    floor: [false, false, false],
  });
});

test('invalid options fall back to the defaults', () => {
  for (const options of [
    undefined,
    null,
    'x',
    { stepMs: 0, samples: 0 },
    { stepMs: -5, samples: -1 },
    { stepMs: Number.NaN, samples: Infinity },
    { stepMs: '60000', samples: '360' },
  ]) {
    const series = createOccupancySeries(options);
    for (let i = 0; i <= 360; i += 1) series.record(T0 + i * MIN, i);
    const out = series.values();
    assert.equal(out.stepMs, MIN);
    assert.equal(out.values.length, 360);
  }
  const fractional = createOccupancySeries({ samples: 3.7 });
  for (let i = 0; i < 5; i += 1) fractional.record(T0 + i * MIN, i);
  assert.deepEqual(fractional.values().values, [2, 3, 4]);
});

test('clear empties the series', () => {
  const series = createOccupancySeries();
  series.record(T0, 3);
  series.record(T0 + MIN, 4);
  series.clear();
  assert.equal(series.summary(T0 + MIN), null);
  assert.deepEqual(series.values().values, []);
  // After a clear an earlier time is accepted again.
  assert.equal(series.record(T0 - HOUR * 10, 2), true);
  assert.deepEqual(series.values(), {
    startMs: T0 - HOUR * 10,
    stepMs: MIN,
    values: [2],
    floor: [false],
  });
});

test('outputs are JSON-safe', () => {
  const series = createOccupancySeries();
  series.record(T0, 2);
  series.record(T0 + 2 * MIN, 5, { floor: true });
  series.record(T0 + 3 * MIN, 4);
  const values = series.values(T0 + 5 * MIN);
  const summary = series.summary(T0 + 5 * MIN);
  assert.deepEqual(JSON.parse(JSON.stringify(values)), values);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
  for (const v of values.values) {
    assert.ok(v === null || Number.isFinite(v));
  }
});

// ------------------------------------------------------------- portability

test('the module is portable: no imports, clocks, randomness or globals', () => {
  const source = readFileSync(
    new URL('./occupancy.js', import.meta.url),
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
    assert.ok(!source.includes(banned), `occupancy.js mentions ${banned}`);
  }
  assert.doesNotMatch(source, /\b(label|title|status|hint)\s*:\s*['"`]/);
  assert.doesNotMatch(source, /owner|registrant/i);
});
