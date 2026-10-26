/**
 * Occupancy series for one zone and one asset kind: a fixed ring of time
 * buckets holding the zone's counted occupancy, for the place brief, busy
 * mode and card text.
 *
 * Portable and pure: no imports, no clock, no randomness. Every time comes in
 * as an argument.
 *
 * Rules:
 * - Buckets are `stepMs` wide and aligned to multiples of `stepMs`; the ring
 *   keeps the latest `samples` buckets (6 hours of minutes by default).
 * - A bucket holds the last counted value recorded into it (by sample time;
 *   at equal times, the later call wins), with its floor flag.
 * - `null` means no counted sample: a gap, never 0. Recording `null` (a feed
 *   that cannot answer) advances time but never erases a counted value.
 * - Moving to a later bucket clears every bucket skipped on the way, so
 *   unrecorded time reads as a gap. Samples older than the ring, and times
 *   that are not finite or lie outside the Date range, are ignored.
 * - `values` starts at the earliest bucket recorded (never before the series
 *   began), so leading time before the first record is not shown as a gap.
 * - `summary` uses non-floor samples only and reports floor samples as a
 *   count; it is null when the window holds no non-floor sample.
 */

/**
 * Default bucket width and ring length (360 one-minute buckets = 6 hours).
 * @type {Readonly<{stepMs: number, samples: number}>}
 */
export const OCCUPANCY_SERIES_DEFAULTS = Object.freeze({
  stepMs: 60_000,
  samples: 360,
});

/** Upper bound on the ring length, to keep memory bounded. */
const MAX_SAMPLES = 100_000;

/** Largest valid time value (ms), as for a JavaScript Date. */
const MAX_TIME_MS = 8.64e15;

/**
 * @typedef {Object} OccupancySummary
 * @property {number} sinceMs Sample time of the earliest non-floor sample in
 *   the summarised range.
 * @property {number} min
 * @property {number} median Middle value; the mean of the two middle values
 *   for an even number of samples.
 * @property {number} max
 * @property {number} samples Non-floor buckets in the summarised range.
 * @property {number} floorSamples Floor (lower-bound) buckets in the
 *   summarised range.
 */

/**
 * @typedef {Object} OccupancyValues
 * @property {number|null} startMs Start of the first bucket, or null for an
 *   empty series.
 * @property {number} stepMs
 * @property {(number|null)[]} values Oldest first; null is a gap.
 * @property {boolean[]} floor True where the value is a lower bound.
 */

/**
 * @typedef {Object} OccupancySeries
 * @property {(atMs: number, count: number|null,
 *   options?: {floor?: boolean}) => boolean} record Returns true when a
 *   counted value was stored.
 * @property {(nowMs?: number) => OccupancySummary|null} summary
 * @property {(nowMs?: number) => OccupancyValues} values With `nowMs` past the
 *   latest bucket, trailing gaps up to `nowMs` are included.
 * @property {() => void} clear
 */

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A usable time: finite and within the Date range, so buckets stay exact. */
function timeOrNull(value) {
  const n = finiteOrNull(value);
  return n !== null && Math.abs(n) <= MAX_TIME_MS ? n : null;
}

function positiveInt(value, fallback, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n >= 1 ? Math.min(n, max) : fallback;
}

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Create an occupancy series.
 * @param {{stepMs?: number, samples?: number}} [options] Bucket width in ms
 *   and ring length; invalid values keep `OCCUPANCY_SERIES_DEFAULTS`.
 * @returns {OccupancySeries}
 */
export function createOccupancySeries(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const stepMs = positiveInt(
    opts.stepMs,
    OCCUPANCY_SERIES_DEFAULTS.stepMs,
    Number.MAX_SAFE_INTEGER,
  );
  const samples = positiveInt(
    opts.samples,
    OCCUPANCY_SERIES_DEFAULTS.samples,
    MAX_SAMPLES,
  );
  const counts = new Array(samples).fill(null);
  const floors = new Array(samples).fill(false);
  const sampleAt = new Array(samples).fill(null);
  /** Latest bucket number reached, or null before the first record. */
  let head = null;
  /** Earliest bucket number reached since creation or `clear`. */
  let first = null;

  function slotOf(bucket) {
    return ((bucket % samples) + samples) % samples;
  }

  function clearSlot(bucket) {
    const slot = slotOf(bucket);
    counts[slot] = null;
    floors[slot] = false;
    sampleAt[slot] = null;
  }

  function advanceTo(bucket) {
    if (head === null) {
      head = bucket;
      first = bucket;
      return;
    }
    if (bucket < first) first = bucket;
    if (bucket <= head) return;
    if (bucket - head >= samples) {
      counts.fill(null);
      floors.fill(false);
      sampleAt.fill(null);
    } else {
      for (let b = head + 1; b <= bucket; b += 1) clearSlot(b);
    }
    head = bucket;
  }

  function record(atMs, count, recordOptions = {}) {
    const at = timeOrNull(atMs);
    if (at === null) return false;
    const bucket = Math.floor(at / stepMs);
    if (head !== null && bucket <= head - samples) return false;
    advanceTo(bucket);
    const value = finiteOrNull(count);
    if (value === null || value < 0) return false;
    const slot = slotOf(bucket);
    if (sampleAt[slot] !== null && at < sampleAt[slot]) return false;
    counts[slot] = value;
    floors[slot] = recordOptions?.floor === true;
    sampleAt[slot] = at;
    return true;
  }

  /** Inclusive bucket range to report, or null when there is nothing. */
  function windowFor(nowMs) {
    if (head === null) return null;
    const now = timeOrNull(nowMs);
    const nowBucket = now === null ? head : Math.floor(now / stepMs);
    const end = Math.max(head, nowBucket);
    const start = Math.max(first, end - samples + 1);
    return { start, end };
  }

  function summary(nowMs) {
    const range = windowFor(nowMs);
    if (range === null) return null;
    const kept = [];
    let floorSamples = 0;
    let sinceMs = null;
    for (let b = range.start; b <= Math.min(range.end, head); b += 1) {
      const slot = slotOf(b);
      if (counts[slot] === null) continue;
      if (floors[slot]) {
        floorSamples += 1;
        continue;
      }
      kept.push(counts[slot]);
      if (sinceMs === null || sampleAt[slot] < sinceMs)
        sinceMs = sampleAt[slot];
    }
    if (kept.length === 0) return null;
    kept.sort((a, b) => a - b);
    return {
      sinceMs,
      min: kept[0],
      median: median(kept),
      max: kept[kept.length - 1],
      samples: kept.length,
      floorSamples,
    };
  }

  function values(nowMs) {
    const range = windowFor(nowMs);
    if (range === null) return { startMs: null, stepMs, values: [], floor: [] };
    const outValues = [];
    const outFloor = [];
    for (let b = range.start; b <= range.end; b += 1) {
      if (b > head) {
        outValues.push(null);
        outFloor.push(false);
        continue;
      }
      const slot = slotOf(b);
      outValues.push(counts[slot]);
      outFloor.push(counts[slot] !== null && floors[slot]);
    }
    return {
      startMs: range.start * stepMs,
      stepMs,
      values: outValues,
      floor: outFloor,
    };
  }

  function clear() {
    counts.fill(null);
    floors.fill(false);
    sampleAt.fill(null);
    head = null;
    first = null;
  }

  return { record, summary, values, clear };
}
