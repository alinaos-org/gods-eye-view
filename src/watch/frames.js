/**
 * Feed-honest observation frames for Watch.
 *
 * A frame is one layer's answer at one moment: whether the feed can answer
 * at all (classified from its stats before any row is read), the ground it
 * covers, and the assets it reported. Zone answers combine the latest frame
 * of every layer of a kind with the zone geometry, so a zone never reads a
 * count the feeds cannot back.
 *
 * Answer states, best first:
 * - counted: the feed answered completely for its coverage; absence is
 *   evidence.
 * - floor: the feed answered, but the count is a lower bound (truncated or
 *   partial snapshot, partial or unknown coverage, a missing secondary feed).
 * - held: the feed had data but is stale or degraded; nothing moves.
 * - unknown: the feed cannot answer (unavailable, loading, never answered,
 *   key required, outside the loaded area).
 * - off: the layer is disabled.
 *
 * Only counted and floor answers carry assets. Every answer is
 * `{state, reason, asOfMs}` with a code reason (null for a plain counted
 * answer) and a data time (null when unknown).
 *
 * Pure module: no platform globals, timers, storage or clocks. Times come in
 * through the stats, the rows and `nowMs`.
 */
import { bboxMayContain, coverageOfZone, signedDistanceM } from './geometry.js';

/** Layers Watch reads, and the asset kind each one reports. */
export const WATCH_SOURCES = Object.freeze({
  flights: Object.freeze({ kind: 'aircraft' }),
  military: Object.freeze({ kind: 'aircraft' }),
  'ais-live-vessels': Object.freeze({ kind: 'vessel' }),
  'local-firms': Object.freeze({ kind: 'fire' }),
  earthquakes: Object.freeze({ kind: 'quake' }),
});

/** The layers that report each asset kind, primary first. */
export const KIND_LAYERS = Object.freeze({
  aircraft: Object.freeze(['flights', 'military']),
  vessel: Object.freeze(['ais-live-vessels']),
  fire: Object.freeze(['local-firms']),
  quake: Object.freeze(['earthquakes']),
});

/** Answer states, best first. */
export const ANSWER = Object.freeze({
  COUNTED: 'counted',
  FLOOR: 'floor',
  HELD: 'held',
  UNKNOWN: 'unknown',
  OFF: 'off',
});

/** Most rows one frame reads; `readRows` is asked for one more. */
export const RECORD_CAP = 250_000;

/**
 * How far past its frame epoch a vessel position time may be before the fix
 * is rejected as a future (bad clock) report.
 */
export const VESSEL_FUTURE_FIX_MS = 120_000;

/**
 * Layers whose records always cover the whole world (military is adsb.lol
 * /mil, FIRMS is "world/2", quakes are USGS all_day).
 */
export const GLOBAL_COVERAGE_LAYERS = Object.freeze([
  'military',
  'local-firms',
  'earthquakes',
]);

/** AIS transport statuses in which fresh vessel data is flowing. */
export const HEALTHY_TRANSPORT_STATUSES = Object.freeze(['live', 'open']);

/** Prefix of the held reason for an unhealthy vessel transport. */
export const TRANSPORT_REASON_PREFIX = 'transport-';

/**
 * Every fixed reason code an answer can carry. A vessel feed can also give
 * `transport-<status>` (see {@link TRANSPORT_REASON_PREFIX}).
 */
export const ANSWER_REASONS = Object.freeze([
  'feed-off',
  'key-required',
  'feed-unavailable',
  'feed-loading',
  'feed-stale',
  'feed-degraded',
  'never-answered',
  'cannot-answer',
  'truncated',
  'partial-snapshot',
  'regional-fallback',
  'outside-loaded-area',
  'coverage-unknown',
  'partial-coverage',
  'secondary-feed-only',
  'secondary-feed-stale',
]);

/**
 * @typedef {'counted'|'floor'|'held'|'unknown'|'off'} AnswerState
 */

/**
 * @typedef {{state: AnswerState, reason: string|null, asOfMs: number|null}}
 *   Answer
 */

/**
 * @typedef {{kind: 'global'}
 *   | {kind: 'circle', lat: number, lon: number, radiusKm: number}
 *   | {kind: 'unknown'}} Coverage
 */

/**
 * @typedef {{key: string, kind: 'aircraft', id: string, label: string|null,
 *   callsign: string|null, lat: number, lon: number, altM: number|null,
 *   speedMps: number|null, headingDeg: number|null, vRateMps: number|null,
 *   onGround: boolean|null, military: boolean, aircraftClass: string|null,
 *   typeCode: string|null,
 *   squawk: string|null, emergency: boolean, emergencyKind: string|null,
 *   emergencySource: string|null, fixAtMs: number|null,
 *   contactAtMs: number|null, layerId: string}} AircraftAsset
 */

/**
 * @typedef {{key: string, kind: 'vessel', id: string, label: string|null,
 *   lat: number, lon: number, speedKts: number|null, courseDeg: number|null,
 *   shipType: string|null, fixAtMs: number|null, layerId: string}}
 *   VesselAsset
 */

/**
 * @typedef {{key: string, kind: 'fire', lat: number, lon: number,
 *   frpMw: number|null, confidence: number|null, acqMs: number|null,
 *   satellite: string|null}} FireAsset
 */

/**
 * @typedef {{key: string, kind: 'quake', id: string, lat: number,
 *   lon: number, magnitude: number|null, depthKm: number|null,
 *   timeMs: number|null, place: string|null}} QuakeAsset
 */

/** @typedef {AircraftAsset|VesselAsset|FireAsset|QuakeAsset} Asset */

/**
 * One layer's observation. `epochMs` is the data time of the layer's
 * snapshot (`stats.lastUpdate`), null when off or never answered; `newEpoch`
 * is true when it differs from the previous frame's epoch. `complete` is true
 * only for a counted answer, the only one under which absence is evidence.
 * `rejected` counts rows dropped as unusable or duplicate.
 *
 * @typedef {{layerId: string|null, kind: string|null, nowMs: number|null,
 *   epochMs: number|null, newEpoch: boolean, answer: Answer,
 *   coverage: Coverage, complete: boolean, assets: Asset[],
 *   keys: Set<string>, rejected: number}} ObservationFrame
 */

/**
 * A zone's answer for one kind. `coverage` is how much of the zone the
 * deciding layer's coverage reaches; `count` is the number of distinct
 * assets inside the zone (after its filters) across the answering layers,
 * null when the answer is not counted or floor or counting was skipped.
 *
 * @typedef {{state: AnswerState, reason: string|null, asOfMs: number|null,
 *   coverage: 'full'|'partial'|'none'|'unknown', count: number|null}}
 *   ZoneAnswer
 */

const ANSWER_STATES = Object.freeze(Object.values(ANSWER));
const ANSWERING_STATES = Object.freeze([ANSWER.COUNTED, ANSWER.FLOOR]);
/** Stats statuses that read UNAVAILABLE (mirrors src/data/feedState.js). */
const UNAVAILABLE_STATUSES = Object.freeze([
  'unavailable',
  'offline',
  'down',
  'error',
]);
/** Printable ASCII without spaces: ICAO24, MMSI and USGS ids. */
const IDENT_PATTERN = /^[!-~]{1,32}$/;
/** The earthquake layer's index-based id when USGS gave none. */
const QUAKE_FALLBACK_ID = /^quake-\d+$/i;
const MAX_TRANSPORT_CODE_CHARS = 32;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch milliseconds (a number or a Date), or null unless finite and > 0. */
function timeOrNull(value) {
  const ms = value instanceof Date ? value.getTime() : value;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

function textOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function boolOrNull(value) {
  return value === true || value === false ? value : null;
}

function identOrNull(value) {
  const text = textOrNull(value);
  return text && IDENT_PATTERN.test(text) ? text : null;
}

function makeAnswer(state, reason, asOfMs) {
  return { state, reason, asOfMs };
}

/** A validated copy of an answer; anything malformed cannot answer. */
function copyAnswer(answer) {
  if (!isRecord(answer) || !ANSWER_STATES.includes(answer.state)) {
    return makeAnswer(ANSWER.UNKNOWN, 'cannot-answer', null);
  }
  return makeAnswer(
    answer.state,
    typeof answer.reason === 'string' && answer.reason ? answer.reason : null,
    timeOrNull(answer.asOfMs),
  );
}

function answerStateOf(value) {
  if (typeof value === 'string') return value;
  return isRecord(value) && typeof value.state === 'string'
    ? value.state
    : null;
}

function validPosition(lat, lon) {
  return (
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function sourceKind(layerId) {
  return typeof layerId === 'string' && Object.hasOwn(WATCH_SOURCES, layerId)
    ? WATCH_SOURCES[layerId].kind
    : null;
}

function isCompiledZone(compiled) {
  return (
    isRecord(compiled) &&
    (compiled.shape === 'circle' || compiled.shape === 'polygon') &&
    isRecord(compiled.bbox)
  );
}

/** Code for an unhealthy vessel transport, or null when healthy or unset. */
function transportCode(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text || HEALTHY_TRANSPORT_STATUSES.includes(text)) return null;
  const code = text
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TRANSPORT_CODE_CHARS)
    .replace(/-+$/, '');
  return code || 'unknown';
}

/** Four-decimal coordinate text, without a "-0.0000". */
function fixed4(value) {
  const text = value.toFixed(4);
  return text === '-0.0000' ? '0.0000' : text;
}

/**
 * Whether an answer state (or an answer carrying one) answers: counted or
 * floor.
 *
 * @param {AnswerState|{state: AnswerState}|null|undefined} answer
 * @returns {boolean}
 */
export function isAnswering(answer) {
  return ANSWERING_STATES.includes(answerStateOf(answer));
}

/**
 * Classifies a layer's feed before any rows are read. Rules apply in order
 * and the first match wins:
 *
 * 1. Not enabled (or feedState 'off') → off, 'feed-off'.
 * 2. A fire feed with `stats.keyRequired` → unknown, 'key-required'.
 * 3. feedState 'unavailable' (or a stats status of unavailable, offline,
 *    down or error) → unknown, 'feed-unavailable'.
 * 4. Loading (feedState 'loading' or `stats.loading`) without a
 *    `lastUpdate` > 0 → unknown, 'feed-loading'. Loading with prior data is
 *    evaluated as not loading.
 * 5. `stats.stale` or feedState 'stale' → held, 'feed-stale'; an `error`,
 *    `lastError` or `managerRefreshError`, `degraded`, `unavailable: true`,
 *    `available: false` or feedState 'degraded' → held, 'feed-degraded'.
 *    Raw stats are tested here, before any trust in 'fallback', because
 *    `layerFeedState` reads a stale fallback feed as FALLBACK.
 * 6. A vessel feed whose `transportStatus` is set and not live or open →
 *    held, `transport-<status>`.
 * 7. No `lastUpdate` > 0 → unknown, 'never-answered'.
 * 8. Otherwise counted, reason null.
 *
 * `asOfMs` is `stats.lastUpdate` when it is a time > 0, else null; always
 * null when off.
 *
 * @param {{enabled?: boolean, feedState?: string|null, stats?: object|null,
 *   kind?: string|null}} [input] feedState is `layerSnapshot(row).feedState`
 *   (one of nominal, loading, degraded, stale, partial, fallback,
 *   unavailable or off); stats is the raw `getAll()` row stats.
 * @returns {Answer}
 */
export function classifyFeed({ enabled, feedState, stats, kind } = {}) {
  const s = isRecord(stats) ? stats : {};
  const state = typeof feedState === 'string' ? feedState : null;
  if (!enabled || state === ANSWER.OFF) {
    return makeAnswer(ANSWER.OFF, 'feed-off', null);
  }
  const asOfMs = timeOrNull(s.lastUpdate);
  if (kind === 'fire' && s.keyRequired) {
    return makeAnswer(ANSWER.UNKNOWN, 'key-required', asOfMs);
  }
  const rawStatus =
    typeof s.status === 'string' ? s.status.trim().toLowerCase() : '';
  if (state === 'unavailable' || UNAVAILABLE_STATUSES.includes(rawStatus)) {
    return makeAnswer(ANSWER.UNKNOWN, 'feed-unavailable', asOfMs);
  }
  if ((state === 'loading' || s.loading) && asOfMs === null) {
    return makeAnswer(ANSWER.UNKNOWN, 'feed-loading', null);
  }
  if (s.stale || state === 'stale' || rawStatus === 'stale') {
    return makeAnswer(ANSWER.HELD, 'feed-stale', asOfMs);
  }
  if (
    s.error ||
    s.lastError ||
    s.managerRefreshError ||
    s.degraded ||
    s.unavailable === true ||
    s.available === false ||
    state === 'degraded'
  ) {
    return makeAnswer(ANSWER.HELD, 'feed-degraded', asOfMs);
  }
  if (kind === 'vessel') {
    const transport = transportCode(s.transportStatus);
    if (transport) {
      return makeAnswer(
        ANSWER.HELD,
        `${TRANSPORT_REASON_PREFIX}${transport}`,
        asOfMs,
      );
    }
  }
  if (asOfMs === null) {
    return makeAnswer(ANSWER.UNKNOWN, 'never-answered', null);
  }
  return makeAnswer(ANSWER.COUNTED, null, asOfMs);
}

/**
 * Refines a counted or floor answer once the rows are read. The first
 * matching rule wins:
 *
 * - No rows while `statsCount` > 0 → unknown, 'cannot-answer' (the layer
 *   holds records it would not hand over, so "none" would be a guess).
 * - `truncated` → floor, 'truncated'.
 * - feedState 'partial' or `partial` → floor, 'partial-snapshot'.
 * - feedState 'fallback' keeps a plain counted state and sets reason
 *   'regional-fallback'.
 *
 * Held, unknown and off answers are returned unchanged. The input is never
 * mutated.
 *
 * @param {Answer} answer
 * @param {{rowCount?: number, truncated?: boolean, statsCount?: number|null,
 *   feedState?: string|null, partial?: boolean}} [facts] A missing rowCount
 *   is no rows; a missing statsCount is 0.
 * @returns {Answer}
 */
export function refineAnswer(
  answer,
  { rowCount, truncated, statsCount, feedState, partial } = {},
) {
  const base = copyAnswer(answer);
  if (!ANSWERING_STATES.includes(base.state)) return base;
  const rows = finiteOrNull(rowCount) ?? 0;
  const count = finiteOrNull(statsCount) ?? 0;
  if (rows <= 0 && count > 0) {
    return makeAnswer(ANSWER.UNKNOWN, 'cannot-answer', base.asOfMs);
  }
  if (truncated === true) {
    return makeAnswer(ANSWER.FLOOR, 'truncated', base.asOfMs);
  }
  if (feedState === 'partial' || partial === true) {
    return makeAnswer(ANSWER.FLOOR, 'partial-snapshot', base.asOfMs);
  }
  if (
    feedState === 'fallback' &&
    base.state === ANSWER.COUNTED &&
    base.reason === null
  ) {
    return makeAnswer(ANSWER.COUNTED, 'regional-fallback', base.asOfMs);
  }
  return base;
}

/**
 * Normalises a layer's `getCoverageArea()` result. Military, local-firms and
 * earthquakes are always global whatever they report; anything malformed
 * (missing, an unknown kind, a non-finite or out-of-range centre, a radius
 * that is not > 0) is `{kind: 'unknown'}`.
 *
 * @param {string} layerId
 * @param {unknown} raw
 * @returns {Coverage} A fresh plain object.
 */
export function normalizeCoverage(layerId, raw) {
  if (GLOBAL_COVERAGE_LAYERS.includes(layerId)) return { kind: 'global' };
  if (!isRecord(raw)) return { kind: 'unknown' };
  if (raw.kind === 'global') return { kind: 'global' };
  if (raw.kind === 'circle') {
    const lat = finiteOrNull(raw.lat);
    const lon = finiteOrNull(raw.lon);
    const radiusKm = finiteOrNull(raw.radiusKm);
    if (
      lat !== null &&
      lon !== null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      radiusKm !== null &&
      radiusKm > 0
    ) {
      return { kind: 'circle', lat, lon, radiusKm };
    }
  }
  return { kind: 'unknown' };
}

/**
 * Stable identity of an asset within its kind.
 *
 * - aircraft: the ICAO24 (a string), trimmed and lowercased.
 * - vessel: the MMSI (a string or number), trimmed.
 * - fire: a fire record or asset (`{lat, lon, acqTime|acqMs, satellite}`);
 *   the key is `fire:<lat 4dp>:<lon 4dp>:<acqTime|0>:<SATELLITE>`, so it
 *   survives the FIRE-##### ids renumbering on every fetch.
 * - quake: the USGS event id; the layer's QUAKE-#### fallback ids are not
 *   keyable.
 *
 * Identifiers must be 1-32 printable ASCII characters without spaces.
 *
 * @param {'aircraft'|'vessel'|'fire'|'quake'} kind
 * @param {string|number|object} id
 * @returns {string|null} null when the asset is not keyable.
 */
export function assetKey(kind, id) {
  if (kind === 'aircraft') {
    const ident = identOrNull(id);
    return ident ? ident.toLowerCase() : null;
  }
  if (kind === 'vessel') return identOrNull(id);
  if (kind === 'quake') {
    const ident = identOrNull(id);
    return ident && !QUAKE_FALLBACK_ID.test(ident) ? ident : null;
  }
  if (kind === 'fire') {
    if (!isRecord(id)) return null;
    const lat = finiteOrNull(id.lat);
    const lon = finiteOrNull(id.lon);
    if (lat === null || lon === null) return null;
    const acqMs = timeOrNull(id.acqTime ?? id.acqMs);
    const satellite = (textOrNull(id.satellite) || '')
      .toUpperCase()
      .replace(/[\s:]+/g, '-');
    return `fire:${fixed4(lat)}:${fixed4(lon)}:${acqMs ?? 0}:${satellite}`;
  }
  return null;
}

/**
 * Turns one analyst record into an asset, or null when it is unusable: an
 * unknown layer, no key, a non-finite position, |lat| > 90, |lon| > 180,
 * exactly (0, 0), or a vessel position time more than
 * {@link VESSEL_FUTURE_FIX_MS} after `epochMs`.
 *
 * Aircraft take `fixAtMs` from `receivedAtMs` (this browser's receipt of the
 * poll row, so a record carried through a missed poll keeps its old time)
 * and `contactAtMs` from `lastContactAtMs`; vessels take `fixAtMs` from
 * `positionAtMs`. Records from the military layer are military. Only asset
 * identifiers travel: no operator, origin country or other owner fields.
 *
 * @param {string} layerId One of {@link WATCH_SOURCES}.
 * @param {object} row An analyst record from `getAnalystRecords()`.
 * @param {{epochMs?: number|null}} [options]
 * @returns {Asset|null}
 */
export function toAsset(layerId, row, { epochMs = null } = {}) {
  const kind = sourceKind(layerId);
  if (!kind || !isRecord(row)) return null;
  const lat = finiteOrNull(row.lat);
  const lon = finiteOrNull(row.lon);
  if (!validPosition(lat, lon)) return null;
  if (kind === 'aircraft') {
    const key = assetKey('aircraft', row.icao24);
    if (!key) return null;
    return {
      key,
      kind,
      id: key,
      label: textOrNull(row.id),
      callsign: textOrNull(row.callsign),
      lat,
      lon,
      altM: finiteOrNull(row.altitudeM),
      speedMps: finiteOrNull(row.speedMps),
      headingDeg: finiteOrNull(row.heading),
      vRateMps: finiteOrNull(row.verticalRateMps),
      onGround: boolOrNull(row.onGround),
      military: row.military === true || layerId === 'military',
      aircraftClass: textOrNull(row.aircraftClass),
      typeCode: textOrNull(row.typeCode),
      squawk: textOrNull(row.squawk),
      emergency: row.emergency === true,
      emergencyKind: textOrNull(row.emergencyKind),
      emergencySource: textOrNull(row.emergencySource),
      fixAtMs: timeOrNull(row.receivedAtMs),
      contactAtMs: timeOrNull(row.lastContactAtMs),
      layerId,
    };
  }
  if (kind === 'vessel') {
    const key = assetKey('vessel', row.mmsi);
    if (!key) return null;
    const fixAtMs = timeOrNull(row.positionAtMs);
    const epoch = timeOrNull(epochMs);
    if (
      fixAtMs !== null &&
      epoch !== null &&
      fixAtMs > epoch + VESSEL_FUTURE_FIX_MS
    ) {
      return null;
    }
    return {
      key,
      kind,
      id: key,
      label: textOrNull(row.id),
      lat,
      lon,
      speedKts: finiteOrNull(row.speedKts),
      courseDeg: finiteOrNull(row.courseDeg),
      shipType: textOrNull(row.shipType),
      fixAtMs,
      layerId,
    };
  }
  if (kind === 'fire') {
    const key = assetKey('fire', row);
    if (!key) return null;
    return {
      key,
      kind,
      lat,
      lon,
      frpMw: finiteOrNull(row.frp),
      confidence: finiteOrNull(row.confidence),
      acqMs: timeOrNull(row.acqTime),
      satellite: textOrNull(row.satellite),
    };
  }
  const key = assetKey('quake', row.id);
  if (!key) return null;
  return {
    key,
    kind,
    id: key,
    lat,
    lon,
    magnitude: finiteOrNull(row.magnitude),
    depthKm: finiteOrNull(row.depthKm),
    timeMs: timeOrNull(row.timeMs),
    place: textOrNull(row.place),
  };
}

/** Fix time of an asset (`fixAtMs`) or a presence fix (`atMs`). */
function fixTimeOf(fix) {
  return timeOrNull(fix.fixAtMs) ?? timeOrNull(fix.atMs);
}

/**
 * Whether `fix` is a new observation after `prev`. With no previous fix it
 * is fresh. Otherwise both fix times (`fixAtMs`, or a presence fix's `atMs`)
 * must be known and `fix` must be later; and when both carry a contact time
 * (aircraft `contactAtMs`) it must have advanced too, so a cached snapshot
 * re-received with a new receipt time is not fresh. A record carried through
 * a missed poll keeps its fix time and is never fresh.
 *
 * @param {object|null|undefined} prev
 * @param {object|null|undefined} fix
 * @returns {boolean}
 */
export function isFreshFix(prev, fix) {
  if (!isRecord(fix)) return false;
  if (!isRecord(prev)) return true;
  const prevAtMs = fixTimeOf(prev);
  const atMs = fixTimeOf(fix);
  if (prevAtMs === null || atMs === null || !(atMs > prevAtMs)) return false;
  const prevContactMs = timeOrNull(prev.contactAtMs);
  const contactMs = timeOrNull(fix.contactAtMs);
  if (prevContactMs !== null && contactMs !== null) {
    return contactMs > prevContactMs;
  }
  return true;
}

/**
 * Builds one layer's observation frame.
 *
 * The feed is classified from `snapshot.feedState` and the raw `stats`
 * (falling back to the snapshot's `lastUpdate` and `count`) before anything
 * is read. `readRows(RECORD_CAP + 1)` is called at most once, and only when
 * that answer is counted; a missing or throwing `readRows` cannot answer.
 * The rows then refine the answer ({@link refineAnswer}): more than
 * {@link RECORD_CAP} rows is a truncated floor and only the first
 * RECORD_CAP are used. Assets are empty for held, unknown and off answers;
 * otherwise they are the usable rows ({@link toAsset}), first one per key.
 *
 * @param {{layerId: string, nowMs?: number, enabled?: boolean,
 *   snapshot?: {enabled?: boolean, feedState?: string, count?: number,
 *     lastUpdate?: number|null}|null,
 *   stats?: object|null, coverage?: unknown,
 *   readRows?: (cap: number) => Array<object>,
 *   previousEpochMs?: number|null}} input `snapshot` is
 *   `layerSnapshot(row)`, `stats` is `row.stats` and `coverage` is the
 *   module's `getCoverageArea?.()`. `enabled` defaults to
 *   `snapshot.enabled`.
 * @returns {ObservationFrame}
 */
export function buildFrame({
  layerId,
  nowMs,
  enabled,
  snapshot,
  stats,
  coverage,
  readRows,
  previousEpochMs = null,
} = {}) {
  const id = typeof layerId === 'string' ? layerId : null;
  const kind = sourceKind(id);
  const snap = isRecord(snapshot) ? snapshot : {};
  const effectiveStats = { ...(isRecord(stats) ? stats : {}) };
  if (
    timeOrNull(effectiveStats.lastUpdate) === null &&
    timeOrNull(snap.lastUpdate) !== null
  ) {
    effectiveStats.lastUpdate = snap.lastUpdate;
  }
  if (
    finiteOrNull(effectiveStats.count) === null &&
    finiteOrNull(snap.count) !== null
  ) {
    effectiveStats.count = snap.count;
  }
  const isEnabled = Boolean(enabled ?? snap.enabled);
  const feedState = typeof snap.feedState === 'string' ? snap.feedState : null;
  let answer = classifyFeed({
    enabled: isEnabled,
    feedState,
    stats: effectiveStats,
    kind,
  });
  if (!kind && answer.state !== ANSWER.OFF) {
    answer = makeAnswer(ANSWER.UNKNOWN, 'cannot-answer', answer.asOfMs);
  }
  const epochMs =
    answer.state === ANSWER.OFF ? null : timeOrNull(effectiveStats.lastUpdate);
  const newEpoch = epochMs !== null && epochMs !== timeOrNull(previousEpochMs);
  const assets = [];
  const keys = new Set();
  let rejected = 0;
  if (answer.state === ANSWER.COUNTED) {
    let rows = null;
    let readable = typeof readRows === 'function';
    if (readable) {
      try {
        rows = readRows(RECORD_CAP + 1);
      } catch {
        readable = false;
      }
    }
    if (!readable) {
      answer = makeAnswer(ANSWER.UNKNOWN, 'cannot-answer', answer.asOfMs);
    } else {
      const list = Array.isArray(rows) ? rows : [];
      answer = refineAnswer(answer, {
        rowCount: list.length,
        truncated: list.length > RECORD_CAP,
        statsCount: finiteOrNull(effectiveStats.count),
        feedState,
        partial: effectiveStats.partial === true,
      });
      if (ANSWERING_STATES.includes(answer.state)) {
        const limit = Math.min(list.length, RECORD_CAP);
        for (let i = 0; i < limit; i += 1) {
          const asset = toAsset(id, list[i], { epochMs });
          if (!asset || keys.has(asset.key)) {
            rejected += 1;
            continue;
          }
          keys.add(asset.key);
          assets.push(asset);
        }
      }
    }
  }
  return {
    layerId: id,
    kind,
    nowMs: finiteOrNull(nowMs),
    epochMs,
    newEpoch,
    answer,
    coverage: normalizeCoverage(id, coverage),
    complete: answer.state === ANSWER.COUNTED,
    assets,
    keys,
    rejected,
  };
}

/** Whether the zone's own filters accept an asset of its kind. */
function zoneFiltersAccept(kind, zone, asset) {
  if (kind === 'aircraft') {
    return zone?.aircraft?.militaryOnly === true
      ? asset.military === true
      : true;
  }
  if (kind === 'fire') {
    const minFrpMw = finiteOrNull(zone?.fire?.minFrpMw);
    if (minFrpMw === null || minFrpMw <= 0) return true;
    const frpMw = finiteOrNull(asset.frpMw);
    return frpMw !== null && frpMw >= minFrpMw;
  }
  if (kind === 'quake') {
    const minMagnitude = finiteOrNull(zone?.quake?.minMagnitude);
    if (minMagnitude === null) return true;
    const magnitude = finiteOrNull(asset.magnitude);
    return magnitude !== null && magnitude >= minMagnitude;
  }
  return true;
}

/** Quake search buffer in metres (0 for other kinds or a bad value). */
function zoneBufferM(kind, zone) {
  if (kind !== 'quake') return 0;
  const bufferKm = finiteOrNull(zone?.quake?.bufferKm);
  return bufferKm !== null && bufferKm > 0 ? bufferKm * 1000 : 0;
}

/**
 * Whether an asset counts for a zone: same kind, a valid position, accepted
 * by the zone's filters (aircraft `militaryOnly`, fire `minFrpMw`, quake
 * `minMagnitude`) and geometrically inside the zone (signed distance ≤ 0,
 * or ≤ the quake `bufferKm`).
 *
 * @param {string} kind
 * @param {object|null} zone The stored zone (for its filters).
 * @param {import('./geometry.js').CompiledZone} compiled
 * @param {Asset} asset
 * @returns {boolean}
 */
export function assetInZone(kind, zone, compiled, asset) {
  if (!isRecord(asset) || asset.kind !== kind || !isCompiledZone(compiled)) {
    return false;
  }
  const lat = finiteOrNull(asset.lat);
  const lon = finiteOrNull(asset.lon);
  if (!validPosition(lat, lon) || !zoneFiltersAccept(kind, zone, asset)) {
    return false;
  }
  const padM = zoneBufferM(kind, zone);
  if (!bboxMayContain(compiled, lat, lon, padM)) return false;
  return signedDistanceM(compiled, lat, lon) <= padM;
}

/** Lookup by layer id over a Map, an array (last wins) or a plain object. */
function frameLookup(frames) {
  if (frames instanceof Map) return (layerId) => frames.get(layerId) ?? null;
  if (Array.isArray(frames)) {
    return (layerId) => {
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        if (frames[i]?.layerId === layerId) return frames[i];
      }
      return null;
    };
  }
  if (isRecord(frames)) {
    return (layerId) =>
      Object.hasOwn(frames, layerId) ? (frames[layerId] ?? null) : null;
  }
  return () => null;
}

/**
 * One layer's answer for a zone: its feed answer, then the coverage
 * mapping ('none' → unknown, 'outside-loaded-area'; 'unknown' → floor,
 * 'coverage-unknown'; 'partial' → floor, 'partial-coverage').
 */
function layerZoneAnswer(frame, compiled, missing) {
  if (!isRecord(frame)) {
    return { ...missing, coverage: 'unknown', frame: null, feedState: null };
  }
  const feed = copyAnswer(frame.answer);
  const coverage = coverageOfZone(frame.coverage, compiled);
  const result = { ...feed, coverage, frame, feedState: feed.state };
  if (!ANSWERING_STATES.includes(feed.state)) return result;
  if (coverage === 'none') {
    return {
      ...result,
      state: ANSWER.UNKNOWN,
      reason: 'outside-loaded-area',
    };
  }
  if (feed.state === ANSWER.COUNTED && coverage === 'unknown') {
    return { ...result, state: ANSWER.FLOOR, reason: 'coverage-unknown' };
  }
  if (feed.state === ANSWER.COUNTED && coverage === 'partial') {
    return { ...result, state: ANSWER.FLOOR, reason: 'partial-coverage' };
  }
  return result;
}

const MISSING_PRIMARY = Object.freeze(
  makeAnswer(ANSWER.UNKNOWN, 'never-answered', null),
);
const MISSING_SECONDARY = Object.freeze(
  makeAnswer(ANSWER.OFF, 'feed-off', null),
);

function zoneResult(state, reason, asOfMs, coverage, count) {
  return { state, reason, asOfMs, coverage, count };
}

/** Oldest known data time across answering layers. */
function oldestAsOf(layers) {
  let oldest = null;
  for (const layer of layers) {
    if (layer.asOfMs !== null && (oldest === null || layer.asOfMs < oldest)) {
      oldest = layer.asOfMs;
    }
  }
  return oldest;
}

/** Distinct keys of in-zone assets across the given frames. */
function unionCount(kind, zone, compiled, frames) {
  const seen = new Set();
  for (const frame of frames) {
    const assets = Array.isArray(frame?.assets) ? frame.assets : [];
    for (const asset of assets) {
      const key = asset?.key;
      if (typeof key !== 'string' || seen.has(key)) continue;
      if (assetInZone(kind, zone, compiled, asset)) seen.add(key);
    }
  }
  return seen.size;
}

/**
 * A zone's answer for one kind, from the latest frame of each layer of that
 * kind. Each layer's feed answer is first mapped through the zone coverage:
 * 'none' → unknown, 'outside-loaded-area'; 'unknown' → floor,
 * 'coverage-unknown'; 'partial' → floor, 'partial-coverage'. A missing
 * primary frame is unknown, 'never-answered'.
 *
 * Aircraft: the primary layer is military when the zone is `militaryOnly`,
 * otherwise flights; the other is secondary (a missing secondary frame is
 * off).
 * - Primary off and secondary answering → floor, 'secondary-feed-only'.
 * - Primary held, unknown (or off with no answering secondary) → that
 *   state.
 * - Primary answering and the secondary feed enabled but held or unknown →
 *   counted is downgraded to floor, 'secondary-feed-stale'.
 *
 * `count` is the union of distinct keys inside the zone across the
 * answering layers, after the zone's filters ({@link assetInZone}); null
 * when not answering or when `countAssets` is false. `asOfMs` is the oldest
 * data time of the answering layers.
 *
 * @param {{kind: 'aircraft'|'vessel'|'fire'|'quake', zone?: object|null,
 *   compiled: import('./geometry.js').CompiledZone,
 *   frames: Map<string, ObservationFrame>|ObservationFrame[]
 *     |Record<string, ObservationFrame>, countAssets?: boolean}} input
 * @returns {ZoneAnswer}
 */
export function zoneAnswer({
  kind,
  zone = null,
  compiled,
  frames,
  countAssets = true,
} = {}) {
  const layers =
    typeof kind === 'string' && Object.hasOwn(KIND_LAYERS, kind)
      ? KIND_LAYERS[kind]
      : null;
  if (!layers || !isCompiledZone(compiled)) {
    return zoneResult(ANSWER.UNKNOWN, 'cannot-answer', null, 'unknown', null);
  }
  const lookup = frameLookup(frames);
  let decided;
  let answering;
  if (kind === 'aircraft') {
    const primaryId =
      zone?.aircraft?.militaryOnly === true ? 'military' : 'flights';
    const secondaryId = primaryId === 'military' ? 'flights' : 'military';
    const primary = layerZoneAnswer(
      lookup(primaryId),
      compiled,
      MISSING_PRIMARY,
    );
    const secondary = layerZoneAnswer(
      lookup(secondaryId),
      compiled,
      MISSING_SECONDARY,
    );
    if (primary.state === ANSWER.OFF) {
      if (ANSWERING_STATES.includes(secondary.state)) {
        decided = {
          ...secondary,
          state: ANSWER.FLOOR,
          reason: 'secondary-feed-only',
        };
        answering = [secondary];
      } else {
        decided = primary;
        answering = [];
      }
    } else if (!ANSWERING_STATES.includes(primary.state)) {
      decided = primary;
      answering = [];
    } else {
      decided = primary;
      answering = [primary];
      if (ANSWERING_STATES.includes(secondary.state)) {
        answering.push(secondary);
      }
      const secondaryFeed = secondary.feedState;
      if (
        decided.state === ANSWER.COUNTED &&
        (secondaryFeed === ANSWER.HELD || secondaryFeed === ANSWER.UNKNOWN)
      ) {
        decided = {
          ...decided,
          state: ANSWER.FLOOR,
          reason: 'secondary-feed-stale',
        };
      }
    }
  } else {
    decided = layerZoneAnswer(lookup(layers[0]), compiled, MISSING_PRIMARY);
    answering = ANSWERING_STATES.includes(decided.state) ? [decided] : [];
  }
  if (!answering.length) {
    return zoneResult(
      decided.state,
      decided.reason,
      decided.asOfMs,
      decided.coverage,
      null,
    );
  }
  return zoneResult(
    decided.state,
    decided.reason,
    oldestAsOf(answering),
    decided.coverage,
    countAssets === false
      ? null
      : unionCount(
          kind,
          zone,
          compiled,
          answering.map((layer) => layer.frame),
        ),
  );
}
