/**
 * New fires and quakes in watch zones.
 *
 * One hazard watch keeps, per zone and hazard kind, the content keys it has
 * already seen inside the zone, and reports only keys that are new since its
 * silent baseline. It reads assets and answers as plain data shaped like the
 * frames module's output (fire assets keyed by content, so renumbered FIRE-#
 * ids never look new; quake assets keyed by their USGS id).
 *
 * Rules:
 * - Baseline: the first counted or floor evaluation after creation,
 *   `reset`, `dropZone`, or a change of the zone's geometry or filters
 *   (fire `minFrpMw`, quake `minMagnitude` and `bufferKm`) is silent. It
 *   remembers every key inside the zone. `alertMagnitude` only sets severity
 *   and never re-baselines.
 * - Seen keys are every key geometrically inside the zone (quakes: signed
 *   distance ≤ `bufferKm` × 1000), whatever its FRP or magnitude, so a
 *   magnitude revision of a known quake is silent.
 * - Fires: new keys inside the zone with FRP ≥ `minFrpMw` give one
 *   `fires-new` per zone per FIRMS epoch (the answer's `asOfMs`), with the
 *   count, the strongest FRP, the first and last acquisition times and the
 *   strongest detection's position. It is an alert when the strongest FRP is
 *   at least `fireAlertFrpMw`.
 * - Quakes: each new id inside the buffer with magnitude ≥ `minMagnitude`
 *   gives one `quake-new`. `reportedAfterBaseline` is true when the origin
 *   time is before the baseline's data time (a late report). It is an alert
 *   when the magnitude is at least the zone's `alertMagnitude` (default 5).
 * - Same epoch: an evaluation whose `asOfMs` equals the last processed epoch
 *   only refreshes the view; it neither reports nor remembers new keys.
 * - Gaps: when the feed was observed not answering (held, unknown or off)
 *   for longer than `gapSummaryMs`, the first new epoch after recovery gives
 *   one `hazard-gap-summary` counting the new items instead of individual
 *   events. Alert-level items (quakes at or above `alertMagnitude`, fires at
 *   or above `fireAlertFrpMw`) are still reported on their own, with caveat
 *   'unobserved-interval', so a summary never hides an alert. A gap with
 *   nothing new reports nothing.
 * - Forgetting: a key is forgotten `seenTtlMs` (26 h) after it was last
 *   reported inside the zone. Both feeds serve a trailing 24 h window, so a
 *   key still in the feed is never forgotten and never announced twice.
 * - Cap: at most `seenCapPerZone` keys per zone and kind, first in, first
 *   out (new keys are remembered oldest data time first). An evicted key's
 *   data time raises a watermark: an unseen key at or before the watermark
 *   is treated as seen, so an evicted key that is still in the feed is not
 *   announced again. The watermark lapses `seenTtlMs` after it last
 *   suppressed or evicted a key.
 * - Floor answers report as usual; their count-bearing transitions
 *   (`fires-new`, `hazard-gap-summary`) carry caveat 'lower-bound'. Views of
 *   answers that are not counted or floor never report a count.
 *
 * Pure module: no platform globals, timers, storage, clocks or randomness.
 * Every time comes in as `nowMs` or as asset and answer times, and outputs
 * are JSON-safe with null for missing values.
 */
import { bboxMayContain, signedDistanceM } from './geometry.js';

/**
 * Hazard watch limits.
 *
 * - `seenCapPerZone`: most remembered keys per zone and hazard kind.
 * - `seenTtlMs`: a key is forgotten this long after it was last reported
 *   inside the zone (26 h, past the feeds' 24 h windows).
 * - `gapSummaryMs`: an observed non-answering stretch longer than this turns
 *   the recovery into one summary.
 * - `fireAlertFrpMw`: a `fires-new` whose strongest FRP reaches this is an
 *   alert.
 *
 * @type {Readonly<{seenCapPerZone: number, seenTtlMs: number,
 *   gapSummaryMs: number, fireAlertFrpMw: number}>}
 */
export const HAZARD_POLICY = Object.freeze({
  seenCapPerZone: 5_000,
  seenTtlMs: 93_600_000,
  gapSummaryMs: 1_800_000,
  fireAlertFrpMw: 100,
});

/** Hazard kinds a hazard watch evaluates. */
export const HAZARD_KINDS = Object.freeze(['fire', 'quake']);

/** Transition types a hazard watch reports. */
export const HAZARD_TRANSITION = Object.freeze({
  FIRES_NEW: 'fires-new',
  QUAKE_NEW: 'quake-new',
  GAP_SUMMARY: 'hazard-gap-summary',
});

/** Caveat codes a hazard transition can carry. */
export const HAZARD_CAVEATS = Object.freeze([
  'lower-bound',
  'unobserved-interval',
]);

/**
 * Alert magnitude for a quake zone that does not set a valid one (the zone
 * document default).
 */
export const DEFAULT_ALERT_MAGNITUDE = 5;

/** Layer that reports each hazard kind. */
const HAZARD_LAYER = Object.freeze({
  fire: 'local-firms',
  quake: 'earthquakes',
});

const ANSWER_STATES = Object.freeze([
  'counted',
  'floor',
  'held',
  'unknown',
  'off',
]);
const ANSWERING_STATES = Object.freeze(['counted', 'floor']);

const SEVERITY = Object.freeze({
  INFO: 'info',
  NOTICE: 'notice',
  ALERT: 'alert',
});

const CAVEAT = Object.freeze({
  LOWER_BOUND: 'lower-bound',
  UNOBSERVED_INTERVAL: 'unobserved-interval',
});

/** Largest valid time value (ms), as for a JavaScript Date. */
const MAX_TIME_MS = 8.64e15;

/** Upper bound on `seenCapPerZone`, to keep memory bounded. */
const MAX_SEEN_CAP = 1_000_000;

/**
 * @typedef {'counted'|'floor'|'held'|'unknown'|'off'} AnswerState
 */

/**
 * @typedef {{state: AnswerState, reason?: string|null,
 *   asOfMs?: number|null}} HazardAnswer A feed or zone answer (for example
 *   the frames module's `zoneAnswer` result).
 */

/**
 * @typedef {Object} HazardTransition
 * @property {'fires-new'|'quake-new'|'hazard-gap-summary'} type
 * @property {'info'|'notice'|'alert'} severity
 * @property {string} zoneId
 * @property {'fire'|'quake'} kind
 * @property {string} layerId 'local-firms' or 'earthquakes'.
 * @property {number} atMs The evaluation time (`nowMs`).
 * @property {number|null} dataAtMs The answer's data time (`asOfMs`).
 * @property {string|null} assetKey The quake key, or the strongest new
 *   fire's key; null for a summary.
 * @property {string|null} assetId The USGS id for a quake; otherwise null.
 * @property {null} assetLabel Always null; hazards carry no labels.
 * @property {{lat: number, lon: number}|null} position The quake, or the
 *   strongest new fire; null for a summary.
 * @property {Object} params
 *   - fires-new: `{count, maxFrpMw, firstAcqMs, lastAcqMs}`;
 *   - quake-new: `{magnitude, depthKm, timeMs, place, usgsId,
 *     reportedAfterBaseline, outsideByKm}`;
 *   - hazard-gap-summary: `{hazard, count, gapMs}`.
 * @property {string[]} caveats Codes from {@link HAZARD_CAVEATS}.
 */

/**
 * @typedef {Object} HazardView
 * @property {number|null} count In-zone items passing the zone's filters;
 *   null unless the answer is counted or floor.
 * @property {boolean} floor True when the count is a lower bound.
 * @property {number|null} [maxFrpMw] Fires: strongest FRP among them.
 * @property {number|null} [maxMagnitude] Quakes: largest magnitude.
 * @property {number|null} newestAtMs Latest acquisition (fires) or origin
 *   (quakes) time among them.
 * @property {number|null} asOfMs The answer's data time.
 * @property {AnswerState} state
 * @property {string|null} reason
 */

/**
 * @typedef {Object} HazardWatch
 * @property {(input: {zone?: object|null,
 *   compiled: import('./geometry.js').CompiledZone,
 *   kind: 'fire'|'quake', assets?: object[], answer?: HazardAnswer,
 *   nowMs: number}) => HazardTransition[]} update
 * @property {(zoneId: string, kind: 'fire'|'quake') => HazardView|null} view
 *   null for a kind that is not a hazard kind.
 * @property {(zoneId: string) => boolean} dropZone True when state was held
 *   for the zone.
 * @property {() => void} reset
 * @property {() => {tracked: number, seen: number, evicted: number,
 *   suppressed: number}} diagnostics
 */

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeOrNull(value) {
  const n = finiteOrNull(value);
  return n !== null && Math.abs(n) <= MAX_TIME_MS ? n : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveInt(value, fallback, max) {
  const n = finiteOrNull(value);
  if (n === null) return fallback;
  const whole = Math.floor(n);
  return whole >= 1 ? Math.min(whole, max) : fallback;
}

function positiveNumber(value, fallback) {
  const n = finiteOrNull(value);
  return n !== null && n > 0 ? n : fallback;
}

function nonNegativeNumber(value, fallback) {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? n : fallback;
}

function resolvePolicy(policy) {
  const p = isRecord(policy) ? policy : {};
  return Object.freeze({
    seenCapPerZone: positiveInt(
      p.seenCapPerZone,
      HAZARD_POLICY.seenCapPerZone,
      MAX_SEEN_CAP,
    ),
    seenTtlMs: positiveNumber(p.seenTtlMs, HAZARD_POLICY.seenTtlMs),
    gapSummaryMs: nonNegativeNumber(p.gapSummaryMs, HAZARD_POLICY.gapSummaryMs),
    fireAlertFrpMw: nonNegativeNumber(
      p.fireAlertFrpMw,
      HAZARD_POLICY.fireAlertFrpMw,
    ),
  });
}

function isHazardKind(kind) {
  return typeof kind === 'string' && HAZARD_KINDS.includes(kind);
}

function isCompiledZone(compiled) {
  return (
    isRecord(compiled) &&
    (compiled.shape === 'circle' || compiled.shape === 'polygon') &&
    isRecord(compiled.bbox)
  );
}

function validPosition(lat, lon) {
  return (
    lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

/** The answer's state, reason and data time, with unusable input unknown. */
function readAnswer(answer) {
  const raw = typeof answer === 'string' ? { state: answer } : answer;
  if (!isRecord(raw) || !ANSWER_STATES.includes(raw.state)) {
    return {
      state: 'unknown',
      reason: isRecord(raw)
        ? (textOrNull(raw.reason) ?? 'cannot-answer')
        : 'cannot-answer',
      asOfMs: isRecord(raw) ? timeOrNull(raw.asOfMs) : null,
    };
  }
  return {
    state: raw.state,
    reason: textOrNull(raw.reason),
    asOfMs: timeOrNull(raw.asOfMs),
  };
}

/** The zone's filters for a kind, read leniently. */
function zoneFilters(kind, zone) {
  if (kind === 'fire') {
    const minFrpMw = finiteOrNull(zone?.fire?.minFrpMw);
    return {
      minFrpMw: minFrpMw !== null && minFrpMw > 0 ? minFrpMw : null,
      minMagnitude: null,
      alertMagnitude: null,
      bufferM: 0,
    };
  }
  const bufferKm = finiteOrNull(zone?.quake?.bufferKm);
  return {
    minFrpMw: null,
    minMagnitude: finiteOrNull(zone?.quake?.minMagnitude),
    alertMagnitude:
      finiteOrNull(zone?.quake?.alertMagnitude) ?? DEFAULT_ALERT_MAGNITUDE,
    bufferM: bufferKm !== null && bufferKm > 0 ? bufferKm * 1000 : 0,
  };
}

/** The filter part of a record signature (alertMagnitude excluded). */
function filterSignature(kind, filters) {
  return kind === 'fire'
    ? `fire|${filters.minFrpMw}`
    : `quake|${filters.minMagnitude}|${filters.bufferM}`;
}

function geometrySignature(compiled) {
  const parts = [
    compiled.shape,
    compiled.center?.lat,
    compiled.center?.lon,
    compiled.radiusM,
  ];
  if (compiled.xy && typeof compiled.xy.length === 'number') {
    parts.push(Array.prototype.join.call(compiled.xy, ','));
  }
  return parts.join('|');
}

/** Whether the zone's filters accept an in-zone item. */
function filtersAccept(kind, filters, item) {
  if (kind === 'fire') {
    return filters.minFrpMw === null
      ? true
      : item.frpMw !== null && item.frpMw >= filters.minFrpMw;
  }
  return filters.minMagnitude === null
    ? true
    : item.magnitude !== null && item.magnitude >= filters.minMagnitude;
}

/**
 * The in-zone items of a kind, first one per key: every asset whose signed
 * distance is ≤ the quake buffer (0 for fires).
 */
function scanAssets(kind, assets, compiled, filters) {
  const padM = kind === 'quake' ? filters.bufferM : 0;
  const items = new Map();
  if (!Array.isArray(assets)) return items;
  for (const asset of assets) {
    if (!isRecord(asset) || asset.kind !== kind) continue;
    const key = textOrNull(asset.key);
    if (key === null || items.has(key)) continue;
    const lat = finiteOrNull(asset.lat);
    const lon = finiteOrNull(asset.lon);
    if (!validPosition(lat, lon)) continue;
    if (!bboxMayContain(compiled, lat, lon, padM)) continue;
    const distanceM = signedDistanceM(compiled, lat, lon);
    if (!(distanceM <= padM)) continue;
    const item =
      kind === 'fire'
        ? {
            key,
            lat,
            lon,
            distanceM,
            timeMs: timeOrNull(asset.acqMs),
            frpMw: finiteOrNull(asset.frpMw),
          }
        : {
            key,
            lat,
            lon,
            distanceM,
            timeMs: timeOrNull(asset.timeMs),
            magnitude: finiteOrNull(asset.magnitude),
            depthKm: finiteOrNull(asset.depthKm),
            place: textOrNull(asset.place),
            usgsId: textOrNull(asset.id) ?? key,
          };
    item.qualifies = filtersAccept(kind, filters, item);
    items.set(key, item);
  }
  return items;
}

function maxOrNull(current, value) {
  if (value === null) return current;
  return current === null || value > current ? value : current;
}

function minOrNull(current, value) {
  if (value === null) return current;
  return current === null || value < current ? value : current;
}

function emptyView(kind, answer) {
  const view = { count: null, floor: false };
  if (kind === 'fire') view.maxFrpMw = null;
  else view.maxMagnitude = null;
  view.newestAtMs = null;
  view.asOfMs = answer.asOfMs;
  view.state = answer.state;
  view.reason = answer.reason;
  return view;
}

function answeringView(kind, items, answer) {
  const view = emptyView(kind, answer);
  let count = 0;
  let max = null;
  let newest = null;
  for (const item of items.values()) {
    if (!item.qualifies) continue;
    count += 1;
    max = maxOrNull(max, kind === 'fire' ? item.frpMw : item.magnitude);
    newest = maxOrNull(newest, item.timeMs);
  }
  view.count = count;
  view.floor = answer.state === 'floor';
  if (kind === 'fire') view.maxFrpMw = max;
  else view.maxMagnitude = max;
  view.newestAtMs = newest;
  return view;
}

const NEVER_ANSWERED = Object.freeze({
  state: 'unknown',
  reason: 'never-answered',
  asOfMs: null,
});

/** Older data time first, then key, so the cap evicts the oldest first. */
function byTimeThenKey(a, b) {
  const at = a.timeMs ?? Number.NEGATIVE_INFINITY;
  const bt = b.timeMs ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Strongest FRP first (known before unknown), then later, then key. */
function strongerFire(a, b) {
  if (a.frpMw !== b.frpMw) {
    if (a.frpMw === null) return b;
    if (b.frpMw === null) return a;
    return a.frpMw > b.frpMw ? a : b;
  }
  const at = a.timeMs ?? Number.NEGATIVE_INFINITY;
  const bt = b.timeMs ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at > bt ? a : b;
  return a.key <= b.key ? a : b;
}

function createRecord(kind, signature) {
  return {
    signature,
    baselined: false,
    baselineAtMs: null,
    /** key → {lastSeenAtMs, timeMs}, in insertion (first-in) order. */
    seen: new Map(),
    watermarkMs: null,
    watermarkAtMs: null,
    lastEpochMs: null,
    unansweredSinceMs: null,
    pendingGapMs: null,
    view: emptyView(kind, NEVER_ANSWERED),
  };
}

function copyView(view) {
  return { ...view };
}

/**
 * Create a hazard watch for new fires and quakes in watch zones.
 *
 * @param {Partial<typeof HAZARD_POLICY>} [policy] Overrides for
 *   {@link HAZARD_POLICY}; invalid or missing values keep the defaults.
 * @returns {HazardWatch}
 */
export function createHazardWatch(policy) {
  const limits = resolvePolicy(policy);
  /** zoneId → Map(kind → record). */
  let zones = new Map();
  /** compiled zone → geometry signature. */
  let signatures = new WeakMap();
  let evicted = 0;
  let suppressed = 0;

  function signatureOf(compiled, kind, filters) {
    let geometry = signatures.get(compiled);
    if (geometry === undefined) {
      geometry = geometrySignature(compiled);
      signatures.set(compiled, geometry);
    }
    return `${geometry}#${filterSignature(kind, filters)}`;
  }

  function recordFor(zoneId, kind, signature) {
    let byKind = zones.get(zoneId);
    if (!byKind) {
      byKind = new Map();
      zones.set(zoneId, byKind);
    }
    let record = byKind.get(kind);
    if (!record || record.signature !== signature) {
      record = createRecord(kind, signature);
      byKind.set(kind, record);
    }
    return record;
  }

  function raiseWatermark(record, timeMs, nowMs) {
    const t = timeMs ?? Number.NEGATIVE_INFINITY;
    record.watermarkMs =
      record.watermarkMs === null ? t : Math.max(record.watermarkMs, t);
    record.watermarkAtMs = nowMs;
  }

  function isBelowWatermark(record, timeMs) {
    return (
      record.watermarkMs !== null &&
      (timeMs ?? Number.NEGATIVE_INFINITY) <= record.watermarkMs
    );
  }

  function forgetExpired(record, nowMs) {
    for (const [key, entry] of record.seen) {
      if (nowMs - entry.lastSeenAtMs > limits.seenTtlMs)
        record.seen.delete(key);
    }
    if (
      record.watermarkAtMs !== null &&
      nowMs - record.watermarkAtMs > limits.seenTtlMs
    ) {
      record.watermarkMs = null;
      record.watermarkAtMs = null;
    }
  }

  function remember(record, item, nowMs) {
    record.seen.set(item.key, { lastSeenAtMs: nowMs, timeMs: item.timeMs });
    while (record.seen.size > limits.seenCapPerZone) {
      let oldestKey = null;
      let oldest = null;
      for (const [key, entry] of record.seen) {
        oldestKey = key;
        oldest = entry;
        break;
      }
      record.seen.delete(oldestKey);
      raiseWatermark(record, oldest.timeMs, nowMs);
      evicted += 1;
    }
  }

  /** Refreshes known keys and returns the unseen ones, oldest first. */
  function sortOut(record, items, nowMs) {
    const fresh = [];
    for (const item of items.values()) {
      const entry = record.seen.get(item.key);
      if (entry) {
        entry.lastSeenAtMs = nowMs;
      } else if (isBelowWatermark(record, item.timeMs)) {
        record.watermarkAtMs = nowMs;
        suppressed += 1;
      } else {
        fresh.push(item);
      }
    }
    fresh.sort(byTimeThenKey);
    return fresh;
  }

  function baseTransition(type, severity, ctx) {
    return {
      type,
      severity,
      zoneId: ctx.zoneId,
      kind: ctx.kind,
      layerId: HAZARD_LAYER[ctx.kind],
      atMs: ctx.nowMs,
      dataAtMs: ctx.answer.asOfMs,
      assetKey: null,
      assetId: null,
      assetLabel: null,
      position: null,
      params: {},
      caveats: [],
    };
  }

  function firesNew(fires, ctx, caveats) {
    let strongest = fires[0];
    let maxFrpMw = null;
    let firstAcqMs = null;
    let lastAcqMs = null;
    for (const fire of fires) {
      strongest = strongerFire(strongest, fire);
      maxFrpMw = maxOrNull(maxFrpMw, fire.frpMw);
      firstAcqMs = minOrNull(firstAcqMs, fire.timeMs);
      lastAcqMs = maxOrNull(lastAcqMs, fire.timeMs);
    }
    const alert = maxFrpMw !== null && maxFrpMw >= limits.fireAlertFrpMw;
    const transition = baseTransition(
      HAZARD_TRANSITION.FIRES_NEW,
      alert ? SEVERITY.ALERT : SEVERITY.NOTICE,
      ctx,
    );
    transition.assetKey = strongest.key;
    transition.position = { lat: strongest.lat, lon: strongest.lon };
    transition.params = {
      count: fires.length,
      maxFrpMw,
      firstAcqMs,
      lastAcqMs,
    };
    transition.caveats = caveats;
    return transition;
  }

  function quakeNew(quake, ctx, record, caveats) {
    const alert =
      quake.magnitude !== null && quake.magnitude >= ctx.filters.alertMagnitude;
    const transition = baseTransition(
      HAZARD_TRANSITION.QUAKE_NEW,
      alert ? SEVERITY.ALERT : SEVERITY.NOTICE,
      ctx,
    );
    transition.assetKey = quake.key;
    transition.assetId = quake.usgsId;
    transition.position = { lat: quake.lat, lon: quake.lon };
    transition.params = {
      magnitude: quake.magnitude,
      depthKm: quake.depthKm,
      timeMs: quake.timeMs,
      place: quake.place,
      usgsId: quake.usgsId,
      reportedAfterBaseline:
        quake.timeMs !== null && record.baselineAtMs !== null
          ? quake.timeMs < record.baselineAtMs
          : null,
      outsideByKm:
        quake.distanceM > 0 ? Math.round(quake.distanceM / 100) / 10 : 0,
    };
    transition.caveats = caveats;
    return transition;
  }

  function gapSummary(count, gapMs, ctx) {
    const transition = baseTransition(
      HAZARD_TRANSITION.GAP_SUMMARY,
      SEVERITY.INFO,
      ctx,
    );
    transition.params = { hazard: ctx.kind, count, gapMs };
    transition.caveats = ctx.floor ? [CAVEAT.LOWER_BOUND] : [];
    return transition;
  }

  function isAlertLevel(item, ctx) {
    if (ctx.kind === 'fire') {
      return item.frpMw !== null && item.frpMw >= limits.fireAlertFrpMw;
    }
    return (
      item.magnitude !== null && item.magnitude >= ctx.filters.alertMagnitude
    );
  }

  function transitionsFor(news, ctx, record, gapMs) {
    const out = [];
    if (!news.length) return out;
    const countCaveats = ctx.floor ? [CAVEAT.LOWER_BOUND] : [];
    if (gapMs === null) {
      if (ctx.kind === 'fire') out.push(firesNew(news, ctx, countCaveats));
      else for (const quake of news) out.push(quakeNew(quake, ctx, record, []));
      return out;
    }
    const alerts = news.filter((item) => isAlertLevel(item, ctx));
    const rest = news.length - alerts.length;
    if (alerts.length) {
      if (ctx.kind === 'fire') {
        out.push(
          firesNew(alerts, ctx, [...countCaveats, CAVEAT.UNOBSERVED_INTERVAL]),
        );
      } else {
        for (const quake of alerts) {
          out.push(quakeNew(quake, ctx, record, [CAVEAT.UNOBSERVED_INTERVAL]));
        }
      }
    }
    if (rest > 0) out.push(gapSummary(rest, gapMs, ctx));
    return out;
  }

  function update(input) {
    const {
      zone = null,
      compiled,
      kind,
      assets,
      answer,
      nowMs,
    } = isRecord(input) ? input : {};
    if (!isHazardKind(kind) || !isCompiledZone(compiled)) return [];
    const now = timeOrNull(nowMs);
    if (now === null) return [];
    const zoneId = textOrNull(zone?.id) ?? textOrNull(compiled.id);
    if (zoneId === null) return [];
    const filters = zoneFilters(kind, zone);
    const record = recordFor(
      zoneId,
      kind,
      signatureOf(compiled, kind, filters),
    );
    forgetExpired(record, now);
    const read = readAnswer(answer);
    if (!ANSWERING_STATES.includes(read.state)) {
      record.view = emptyView(kind, read);
      if (record.baselined && record.unansweredSinceMs === null) {
        record.unansweredSinceMs = now;
      }
      return [];
    }
    const items = scanAssets(kind, assets, compiled, filters);
    record.view = answeringView(kind, items, read);
    if (!record.baselined) {
      for (const item of sortOut(record, items, now)) {
        remember(record, item, now);
      }
      record.baselined = true;
      record.baselineAtMs = read.asOfMs ?? now;
      record.lastEpochMs = read.asOfMs;
      return [];
    }
    if (record.unansweredSinceMs !== null) {
      record.pendingGapMs =
        (record.pendingGapMs ?? 0) +
        Math.max(0, now - record.unansweredSinceMs);
      record.unansweredSinceMs = null;
    }
    if (read.asOfMs !== null && read.asOfMs === record.lastEpochMs) {
      for (const item of items.values()) {
        const entry = record.seen.get(item.key);
        if (entry) entry.lastSeenAtMs = now;
      }
      return [];
    }
    const gapMs =
      record.pendingGapMs !== null && record.pendingGapMs > limits.gapSummaryMs
        ? record.pendingGapMs
        : null;
    record.pendingGapMs = null;
    record.lastEpochMs = read.asOfMs;
    const fresh = sortOut(record, items, now);
    for (const item of fresh) remember(record, item, now);
    const news = fresh.filter((item) => item.qualifies);
    return transitionsFor(
      news,
      {
        zoneId,
        kind,
        nowMs: now,
        answer: read,
        filters,
        floor: read.state === 'floor',
      },
      record,
      gapMs,
    );
  }

  function view(zoneId, kind) {
    if (!isHazardKind(kind)) return null;
    const record =
      typeof zoneId === 'string' ? zones.get(zoneId)?.get(kind) : undefined;
    return copyView(record ? record.view : emptyView(kind, NEVER_ANSWERED));
  }

  function dropZone(zoneId) {
    return typeof zoneId === 'string' ? zones.delete(zoneId) : false;
  }

  function reset() {
    zones = new Map();
    signatures = new WeakMap();
    evicted = 0;
    suppressed = 0;
  }

  function diagnostics() {
    let tracked = 0;
    let seen = 0;
    for (const byKind of zones.values()) {
      for (const record of byKind.values()) {
        tracked += 1;
        seen += record.seen.size;
      }
    }
    return { tracked, seen, evicted, suppressed };
  }

  return { update, view, dropZone, reset, diagnostics };
}
