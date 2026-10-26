/**
 * Place briefs for Watch: a short, feed-honest summary of one zone.
 *
 * A brief combines, for one zone, the latest observation frames (frames.js
 * shape), the zone's view (engine WatchView zone entry), the watched assets
 * inside it, its recent events and its occupancy series. It never reads a
 * feed itself and never states more than the answers allow.
 *
 * Rules:
 * - The zone view's `perKind` answers are the authority for every kind
 *   section (state, reason, data time). Without a view answer a section can
 *   only be off (every frame of its kind off), unknown 'never-answered' (no
 *   frame) or unknown 'cannot-answer'.
 * - Counts and highlights come from the in-zone assets of the answering
 *   frames, with the zone's filters (aircraft `militaryOnly`, fire
 *   `minFrpMw`, quake `minMagnitude` and `bufferKm`). A section whose answer
 *   is not counted never reports 0: held, unknown and off report no count,
 *   and a floor reports a count only when it is positive.
 * - Aircraft highlights: emergencies first, then airborne before on-ground,
 *   then lowest altitude. Vessels: type buckets from `normalizeVesselType`
 *   and up to three named vessels. A slow vessel is stated as its speed and
 *   never as anchored or moored. Fires: count, strongest FRP, newest
 *   acquisition and the top three by FRP. Quakes: count, strongest
 *   magnitude and the three most recent.
 * - Highlight facts only use {@link BRIEF_FACT_KEYS} and event parameters
 *   only {@link BRIEF_EVENT_PARAM_KEYS}, so owner, operator, registrant and
 *   position fields never reach a brief.
 * - Ties are broken by asset key, so a brief is deterministic for fixed
 *   inputs and `nowMs`.
 *
 * Pure module: no platform globals, timers, storage, clocks or randomness.
 * Outputs are JSON-safe with null for missing values.
 */
import { normalizeVesselType } from '../data/vesselTypes.js';
import { bboxMayContain, compileZone, signedDistanceM } from './geometry.js';

/**
 * How many items each brief section lists.
 *
 * - `aircraftHighlights`: aircraft highlights.
 * - `vesselNames`: named vessel highlights.
 * - `vesselTypeBuckets`: vessel type buckets, the last one folding the rest.
 * - `fireHighlights` / `quakeHighlights`: fire and quake highlights.
 * - `activity`: recent events.
 */
export const BRIEF_LIMITS = Object.freeze({
  aircraftHighlights: 5,
  vesselNames: 3,
  vesselTypeBuckets: 4,
  fireHighlights: 3,
  quakeHighlights: 3,
  activity: 10,
});

/** The only keys a highlight's `facts` may carry. */
export const BRIEF_FACT_KEYS = Object.freeze([
  'altitudeM',
  'speedMps',
  'speedKts',
  'aircraftClass',
  'military',
  'emergencyKind',
  'squawk',
  'shipType',
  'frpMw',
  'acqMs',
  'magnitude',
  'depthKm',
  'timeMs',
  'place',
  'enteredAtMs',
  'lowerBound',
]);

/** Section ids, in the order a brief lists them. */
export const BRIEF_SECTION_IDS = Object.freeze([
  'aircraft',
  'vessels',
  'fires',
  'quakes',
  'watched',
  'occupancy',
  'activity',
]);

/**
 * Limits for the sections {@link BRIEF_LIMITS} does not name: watched assets
 * inside the zone and the longest-present occupants.
 */
export const BRIEF_EXTRA_LIMITS = Object.freeze({
  watchedHighlights: 10,
  occupantHighlights: 3,
});

/**
 * Vessel bucket keys that are not ship-type families: vessels reporting no
 * usable type, and the folded remainder past the bucket limit.
 */
export const BRIEF_BUCKET_KEYS = Object.freeze({
  untyped: 'untyped',
  rest: 'rest',
});

/**
 * Codes of the lines {@link placeBriefLines} returns, one template each in
 * the wording module.
 */
export const BRIEF_LINE_CODES = Object.freeze({
  HEADER: 'brief-header',
  AIRCRAFT: 'brief-aircraft',
  AIRCRAFT_ITEM: 'brief-aircraft-item',
  VESSELS: 'brief-vessels',
  VESSEL_TYPE: 'brief-vessel-type',
  VESSEL_ITEM: 'brief-vessel-item',
  FIRES: 'brief-fires',
  FIRE_ITEM: 'brief-fire-item',
  QUAKES: 'brief-quakes',
  QUAKE_ITEM: 'brief-quake-item',
  WATCHED: 'brief-watched',
  WATCHED_ITEM: 'brief-watched-item',
  OCCUPANCY: 'brief-occupancy',
  OCCUPANCY_SERIES: 'brief-occupancy-series',
  OCCUPANCY_GAP: 'brief-occupancy-gap',
  OCCUPANT: 'brief-occupant',
  ACTIVITY: 'brief-activity',
  ACTIVITY_EVENT: 'brief-activity-event',
});

/**
 * The event parameters an activity entry may carry: every parameter of the
 * Watch event catalogue, and nothing else, so no other field of an event
 * reaches a brief. Values are numbers, codes, feed strings, booleans, null
 * or short arrays of those.
 */
export const BRIEF_EVENT_PARAM_KEYS = Object.freeze([
  'sinceMs',
  'reentry',
  'exitAtMs',
  'enteredAtMs',
  'dwellMs',
  'dwellLowerBound',
  'fromMs',
  'toMs',
  'lastFixAtMs',
  'lastAltM',
  'lastOnGround',
  'descending',
  'count',
  'labels',
  'assetKeys',
  'entered',
  'exited',
  'noLongerReported',
  'median',
  'gapMs',
  'before',
  'after',
  'reason',
  'pausedMs',
  'maxFrpMw',
  'firstAcqMs',
  'lastAcqMs',
  'magnitude',
  'depthKm',
  'timeMs',
  'place',
  'usgsId',
  'reportedAfterBaseline',
  'outsideByKm',
  'hazard',
  'kind',
  'fromKind',
  'squawk',
  'source',
  'durationMs',
  'layerId',
  'lastSeenAtMs',
  'absentMs',
  'coveredShare',
]);

/**
 * @typedef {'counted'|'floor'|'held'|'unknown'|'off'} BriefAnswerState
 */

/**
 * One listed item. `label` is the asset's display identifier (callsign,
 * registration or ICAO24; vessel name; USGS id; a watch entry's label or
 * value), null for fires. `facts` holds only {@link BRIEF_FACT_KEYS}, null
 * where unknown. Watched highlights also carry `presence`, the watch
 * presence state.
 *
 * @typedef {{label: string|null, kind: string, facts: Object<string, *>,
 *   presence?: string|null}} BriefHighlight
 */

/**
 * One brief section. `answer` is the answer state and `reason` its code;
 * `count` is null unless the answer allows it (never 0 unless counted);
 * `floor` is true when the answer or count is a lower bound.
 *
 * Section extras: vessels `buckets` ([{key, count}], most first); fires
 * `maxFrpMw` and `newestAcqMs`; quakes `maxMagnitude` and `newestTimeMs`;
 * occupancy `series` ({aircraft?, vessel?: OccupancySummary|null}, count
 * always null); activity `events` (WatchEvent copies, newest first, with
 * no position and only {@link BRIEF_EVENT_PARAM_KEYS} params; highlights
 * always empty).
 *
 * @typedef {{id: string, answer: BriefAnswerState, reason: string|null,
 *   asOfMs: number|null, count: number|null, floor: boolean,
 *   highlights: BriefHighlight[], buckets?: Array<{key: string,
 *   count: number}>, maxFrpMw?: number|null, newestAcqMs?: number|null,
 *   maxMagnitude?: number|null, newestTimeMs?: number|null,
 *   series?: Object<string, object|null>, events?: object[]}} BriefSection
 */

/**
 * @typedef {{zoneId: string|null, name: string|null,
 *   generatedAtMs: number|null, sections: BriefSection[]}} PlaceBrief
 */

/** @typedef {{code: string, values: Object<string, *>}} BriefLine */

const COUNTED = 'counted';
const FLOOR = 'floor';
const HELD = 'held';
const UNKNOWN = 'unknown';
const OFF = 'off';
const ANSWER_STATES = Object.freeze([COUNTED, FLOOR, HELD, UNKNOWN, OFF]);
const NON_ANSWERING_RANK = Object.freeze({ held: 0, unknown: 1, off: 2 });

/** Zone kinds in canonical order, and the brief section of each. */
const ZONE_KINDS = Object.freeze(['aircraft', 'vessel', 'fire', 'quake']);
const PRESENCE_KINDS = Object.freeze(['aircraft', 'vessel']);
const SECTION_OF_KIND = Object.freeze({
  aircraft: 'aircraft',
  vessel: 'vessels',
  fire: 'fires',
  quake: 'quakes',
});

/** The asset kind each Watch layer reports (mirrors frames.js). */
const LAYER_KINDS = Object.freeze({
  flights: 'aircraft',
  military: 'aircraft',
  'ais-live-vessels': 'vessel',
  'local-firms': 'fire',
  earthquakes: 'quake',
});

const FACT_KEY_SET = new Set(BRIEF_FACT_KEYS);
const EVENT_PARAM_KEY_SET = new Set(BRIEF_EVENT_PARAM_KEYS);
const MAX_PARAM_ITEMS = 10;
const MAX_CAVEATS = 16;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch milliseconds, or null unless finite and > 0. */
function timeOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
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

/** A non-negative whole count, or null. */
function countOrNull(value) {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

/** A JSON scalar for a fact: finite number, string, boolean or null. */
function factValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return null;
}

/** Code-unit string order, so sorting never depends on the locale. */
function compareText(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Ascending numbers with nulls last. */
function compareAsc(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Descending numbers with nulls last. */
function compareDesc(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
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

function isAnsweringState(state) {
  return state === COUNTED || state === FLOOR;
}

function answerStateOf(answer) {
  if (typeof answer === 'string') return answer;
  return isRecord(answer) && typeof answer.state === 'string'
    ? answer.state
    : null;
}

function isCompiledZone(compiled) {
  return (
    isRecord(compiled) &&
    (compiled.shape === 'circle' || compiled.shape === 'polygon') &&
    isRecord(compiled.bbox)
  );
}

/** Only whitelisted keys, each as a JSON scalar. */
function pickFacts(source) {
  const facts = {};
  for (const key of Object.keys(source)) {
    if (FACT_KEY_SET.has(key)) facts[key] = factValue(source[key]);
  }
  return facts;
}

/** The latest frame per layer, ordered by layer id. */
function frameList(frames) {
  const byLayer = new Map();
  const add = (layerId, frame) => {
    if (!isRecord(frame)) return;
    const id = textOrNull(frame.layerId) ?? textOrNull(layerId);
    if (id) byLayer.set(id, { ...frame, layerId: id });
  };
  if (frames instanceof Map) {
    for (const [layerId, frame] of frames) add(layerId, frame);
  } else if (Array.isArray(frames)) {
    for (const frame of frames) add(null, frame);
  } else if (isRecord(frames)) {
    for (const layerId of Object.keys(frames)) add(layerId, frames[layerId]);
  }
  return [...byLayer.keys()]
    .sort(compareText)
    .map((layerId) => byLayer.get(layerId));
}

function frameKind(frame) {
  if (Object.hasOwn(LAYER_KINDS, frame.layerId)) {
    return LAYER_KINDS[frame.layerId];
  }
  return typeof frame.kind === 'string' ? frame.kind : null;
}

/** Whether the zone's own filters accept an asset (mirrors frames.js). */
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

function assetInZone(kind, zone, compiled, asset) {
  const lat = finiteOrNull(asset.lat);
  const lon = finiteOrNull(asset.lon);
  if (!validPosition(lat, lon) || !zoneFiltersAccept(kind, zone, asset)) {
    return false;
  }
  const padM = zoneBufferM(kind, zone);
  if (!bboxMayContain(compiled, lat, lon, padM)) return false;
  return signedDistanceM(compiled, lat, lon) <= padM;
}

/**
 * Distinct in-zone assets of one kind across answering frames, one per key:
 * the copy with the latest fix (the first by layer id on a tie), military
 * when any accepted copy is.
 */
function collectZoneAssets(kind, zone, compiled, frames) {
  const byKey = new Map();
  for (const frame of frames) {
    const assets = Array.isArray(frame.assets) ? frame.assets : [];
    for (const asset of assets) {
      if (!isRecord(asset) || asset.kind !== kind) continue;
      const key = textOrNull(asset.key);
      if (!key || !assetInZone(kind, zone, compiled, asset)) continue;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { key, asset, military: asset.military === true });
        continue;
      }
      prev.military = prev.military || asset.military === true;
      const atMs = timeOrNull(asset.fixAtMs);
      const prevAtMs = timeOrNull(prev.asset.fixAtMs);
      if (atMs !== null && (prevAtMs === null || atMs > prevAtMs)) {
        prev.asset = asset;
      }
    }
  }
  return [...byKey.values()].sort((a, b) => compareText(a.key, b.key));
}

/** The view's answer for a kind, or null when the view has none. */
function viewAnswer(zoneView, kind) {
  const perKind = isRecord(zoneView?.perKind) ? zoneView.perKind : null;
  const entry =
    perKind && Object.hasOwn(perKind, kind) && isRecord(perKind[kind])
      ? perKind[kind]
      : null;
  if (!entry) return null;
  let state = entry.answer;
  let reason = entry.reason;
  let asOfMs = entry.asOfMs;
  if (isRecord(state)) {
    reason = state.reason ?? reason;
    asOfMs = state.asOfMs ?? asOfMs;
    state = state.state;
  }
  if (!ANSWER_STATES.includes(state)) {
    return {
      state: UNKNOWN,
      reason: 'cannot-answer',
      asOfMs: null,
      count: null,
    };
  }
  return {
    state,
    reason: textOrNull(reason),
    asOfMs: timeOrNull(asOfMs),
    count: countOrNull(entry.count),
  };
}

/** A conservative answer from the frames alone (never counted or floor). */
function fallbackAnswer(kindFrames) {
  if (!kindFrames.length) {
    return {
      state: UNKNOWN,
      reason: 'never-answered',
      asOfMs: null,
      count: null,
    };
  }
  if (kindFrames.every((frame) => answerStateOf(frame.answer) === OFF)) {
    return { state: OFF, reason: 'feed-off', asOfMs: null, count: null };
  }
  return { state: UNKNOWN, reason: 'cannot-answer', asOfMs: null, count: null };
}

/** Kind sections: no count unless counted, and never a floor of 0. */
function kindCount(state, count) {
  const n = countOrNull(count);
  if (n === null) return null;
  if (state === COUNTED) return n;
  return state === FLOOR && n > 0 ? n : null;
}

/** Combined sections: a positive count is always at least that many. */
function combinedCount(state, count) {
  const n = countOrNull(count);
  if (n === null) return null;
  return state === COUNTED || n > 0 ? n : null;
}

function baseSection(id, answer, count) {
  return {
    id,
    answer: answer.state,
    reason: answer.reason,
    asOfMs: answer.asOfMs,
    count,
    floor:
      answer.state === FLOOR || (count !== null && answer.state !== COUNTED),
    highlights: [],
  };
}

function occupantFacts(occupants, key) {
  const occupant = occupants.get(key);
  return {
    enteredAtMs: occupant ? timeOrNull(occupant.enteredAtMs) : null,
    lowerBound: occupant ? boolOrNull(occupant.lowerBound) : null,
  };
}

function aircraftLabel(asset) {
  return (
    textOrNull(asset.label) ??
    textOrNull(asset.callsign) ??
    textOrNull(asset.id)
  );
}

function aircraftFacts(item, occupants) {
  const { asset } = item;
  return pickFacts({
    altitudeM: finiteOrNull(asset.altM),
    speedMps: finiteOrNull(asset.speedMps),
    aircraftClass: textOrNull(asset.aircraftClass),
    military: item.military,
    emergencyKind: textOrNull(asset.emergencyKind),
    squawk: textOrNull(asset.squawk),
    ...occupantFacts(occupants, item.key),
  });
}

/** Family name for a ship type, uppercase, or null when none. */
function vesselFamily(shipType) {
  const text = textOrNull(shipType);
  if (!text) return null;
  return textOrNull(normalizeVesselType(text).toUpperCase());
}

function vesselFacts(item, occupants) {
  const { asset } = item;
  return pickFacts({
    speedKts: finiteOrNull(asset.speedKts),
    shipType: vesselFamily(asset.shipType),
    ...occupantFacts(occupants, item.key),
  });
}

/** A vessel's name: its label, when that is not just its MMSI. */
function vesselName(asset) {
  const label = textOrNull(asset.label);
  if (!label) return null;
  return label === textOrNull(asset.id) || label === textOrNull(asset.key)
    ? null
    : label;
}

function compareAircraft(a, b) {
  const emergency =
    Number(b.asset.emergency === true) - Number(a.asset.emergency === true);
  if (emergency) return emergency;
  const ground =
    Number(a.asset.onGround === true) - Number(b.asset.onGround === true);
  if (ground) return ground;
  const altitude = compareAsc(
    finiteOrNull(a.asset.altM),
    finiteOrNull(b.asset.altM),
  );
  return altitude || compareText(a.key, b.key);
}

function aircraftSection(section, items, occupants) {
  section.highlights = [...items]
    .sort(compareAircraft)
    .slice(0, BRIEF_LIMITS.aircraftHighlights)
    .map((item) => ({
      label: aircraftLabel(item.asset),
      kind: 'aircraft',
      facts: aircraftFacts(item, occupants),
    }));
  return section;
}

function vesselBuckets(items) {
  const counts = new Map();
  for (const { asset } of items) {
    const key = vesselFamily(asset.shipType) ?? BRIEF_BUCKET_KEYS.untyped;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || compareText(a.key, b.key));
  const limit = BRIEF_LIMITS.vesselTypeBuckets;
  if (sorted.length <= limit) return sorted;
  const kept = sorted.slice(0, limit - 1);
  let rest = 0;
  for (const bucket of sorted.slice(limit - 1)) rest += bucket.count;
  kept.push({ key: BRIEF_BUCKET_KEYS.rest, count: rest });
  return kept;
}

function vesselSection(section, items, occupants) {
  section.buckets = vesselBuckets(items);
  const named = items
    .map((item) => ({
      item,
      name: vesselName(item.asset),
      enteredAtMs: occupantFacts(occupants, item.key).enteredAtMs,
      fixAtMs: timeOrNull(item.asset.fixAtMs),
    }))
    .filter((entry) => entry.name !== null);
  named.sort(
    (a, b) =>
      compareAsc(a.enteredAtMs, b.enteredAtMs) ||
      compareDesc(a.fixAtMs, b.fixAtMs) ||
      compareText(a.name, b.name) ||
      compareText(a.item.key, b.item.key),
  );
  section.highlights = named
    .slice(0, BRIEF_LIMITS.vesselNames)
    .map((entry) => ({
      label: entry.name,
      kind: 'vessel',
      facts: vesselFacts(entry.item, occupants),
    }));
  return section;
}

function maxOf(items, read) {
  let best = null;
  for (const item of items) {
    const value = read(item);
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

function fireSection(section, items) {
  section.maxFrpMw = maxOf(items, (item) => finiteOrNull(item.asset.frpMw));
  section.newestAcqMs = maxOf(items, (item) => timeOrNull(item.asset.acqMs));
  section.highlights = [...items]
    .sort(
      (a, b) =>
        compareDesc(finiteOrNull(a.asset.frpMw), finiteOrNull(b.asset.frpMw)) ||
        compareDesc(timeOrNull(a.asset.acqMs), timeOrNull(b.asset.acqMs)) ||
        compareText(a.key, b.key),
    )
    .slice(0, BRIEF_LIMITS.fireHighlights)
    .map((item) => ({
      label: null,
      kind: 'fire',
      facts: pickFacts({
        frpMw: finiteOrNull(item.asset.frpMw),
        acqMs: timeOrNull(item.asset.acqMs),
      }),
    }));
  return section;
}

function quakeSection(section, items) {
  section.maxMagnitude = maxOf(items, (item) =>
    finiteOrNull(item.asset.magnitude),
  );
  section.newestTimeMs = maxOf(items, (item) => timeOrNull(item.asset.timeMs));
  section.highlights = [...items]
    .sort(
      (a, b) =>
        compareDesc(timeOrNull(a.asset.timeMs), timeOrNull(b.asset.timeMs)) ||
        compareDesc(
          finiteOrNull(a.asset.magnitude),
          finiteOrNull(b.asset.magnitude),
        ) ||
        compareText(a.key, b.key),
    )
    .slice(0, BRIEF_LIMITS.quakeHighlights)
    .map((item) => ({
      label: textOrNull(item.asset.id) ?? item.key,
      kind: 'quake',
      facts: pickFacts({
        magnitude: finiteOrNull(item.asset.magnitude),
        depthKm: finiteOrNull(item.asset.depthKm),
        timeMs: timeOrNull(item.asset.timeMs),
        place: textOrNull(item.asset.place),
      }),
    }));
  return section;
}

function emptyExtras(kind, section) {
  if (kind === 'vessel') section.buckets = [];
  if (kind === 'fire') {
    section.maxFrpMw = null;
    section.newestAcqMs = null;
  }
  if (kind === 'quake') {
    section.maxMagnitude = null;
    section.newestTimeMs = null;
  }
  return section;
}

/** One kind section, plus its in-zone assets for the watched section. */
function buildKindSection(kind, ctx) {
  const kindFrames = ctx.frames.filter((frame) => frameKind(frame) === kind);
  const answer = viewAnswer(ctx.zoneView, kind) ?? fallbackAnswer(kindFrames);
  const answeringFrames = kindFrames.filter((frame) =>
    isAnsweringState(answerStateOf(frame.answer)),
  );
  const known =
    isAnsweringState(answer.state) &&
    ctx.compiled !== null &&
    answeringFrames.length > 0;
  const items = known
    ? collectZoneAssets(kind, ctx.zone, ctx.compiled, answeringFrames)
    : [];
  let rawCount = null;
  if (known) rawCount = items.length;
  else if (isAnsweringState(answer.state)) rawCount = answer.count;
  const section = emptyExtras(
    kind,
    baseSection(
      SECTION_OF_KIND[kind],
      answer,
      kindCount(answer.state, rawCount),
    ),
  );
  if (!known) return { section, items };
  if (kind === 'aircraft') aircraftSection(section, items, ctx.occupants);
  else if (kind === 'vessel') vesselSection(section, items, ctx.occupants);
  else if (kind === 'fire') fireSection(section, items);
  else quakeSection(section, items);
  return { section, items };
}

function oldestAsOf(sections) {
  let oldest = null;
  for (const section of sections) {
    const asOfMs = timeOrNull(section.asOfMs);
    if (asOfMs !== null && (oldest === null || asOfMs < oldest)) {
      oldest = asOfMs;
    }
  }
  return oldest;
}

/**
 * One answer for several kind sections: counted when all are counted;
 * floor (with the first shortfall's reason) when some answer; otherwise the
 * most informative non-answer (held, then unknown, then off).
 */
function combineAnswers(sections) {
  if (!sections.length) {
    return { state: UNKNOWN, reason: 'cannot-answer', asOfMs: null };
  }
  const answering = sections.filter((section) =>
    isAnsweringState(section.answer),
  );
  if (answering.length) {
    const short = sections.find((section) => section.answer !== COUNTED);
    return short
      ? { state: FLOOR, reason: short.reason, asOfMs: oldestAsOf(answering) }
      : { state: COUNTED, reason: null, asOfMs: oldestAsOf(answering) };
  }
  let best = sections[0];
  for (const section of sections) {
    const rank = NON_ANSWERING_RANK[section.answer] ?? 1;
    const bestRank = NON_ANSWERING_RANK[best.answer] ?? 1;
    if (rank < bestRank) best = section;
  }
  return { state: best.answer, reason: best.reason, asOfMs: best.asOfMs };
}

/** Normalised callsign for matching (uppercase, no spaces). */
function callsignOf(value) {
  const text = textOrNull(value);
  return text ? text.toUpperCase().replace(/\s+/g, '') : null;
}

/** The in-zone asset a watch entry refers to, if it is listed. */
function watchedItem(entry, itemsByKind) {
  const items = itemsByKind.get(entry.kind) ?? [];
  const value = textOrNull(entry.value);
  if (!value) return null;
  if (entry.match === 'callsign') {
    const wanted = callsignOf(value);
    return (
      items.find((item) => callsignOf(item.asset.callsign) === wanted) ?? null
    );
  }
  const key = entry.kind === 'aircraft' ? value.toLowerCase() : value;
  return items.find((item) => item.key === key) ?? null;
}

function watchedFacts(entry, item, occupants) {
  const facts =
    entry.kind === 'aircraft'
      ? item
        ? aircraftFacts(item, occupants)
        : pickFacts({
            altitudeM: finiteOrNull(entry.fix?.altM),
            speedMps: null,
            aircraftClass: null,
            military: null,
            emergencyKind: null,
            squawk: null,
            enteredAtMs: null,
            lowerBound: null,
          })
      : item
        ? vesselFacts(item, occupants)
        : pickFacts({
            speedKts: null,
            shipType: null,
            enteredAtMs: null,
            lowerBound: null,
          });
  if (timeOrNull(entry.enteredAtMs) !== null) {
    facts.enteredAtMs = timeOrNull(entry.enteredAtMs);
  }
  if (boolOrNull(entry.lowerBound) !== null) {
    facts.lowerBound = boolOrNull(entry.lowerBound);
  }
  return facts;
}

function buildWatchedSection(ctx, presenceSections, itemsByKind) {
  const kinds = presenceSections.map((section) =>
    section.id === 'aircraft' ? 'aircraft' : 'vessel',
  );
  const entries = ctx.watchInside.filter(
    (entry) =>
      isRecord(entry) &&
      kinds.includes(entry.kind) &&
      (!Array.isArray(entry.zoneIds) ||
        ctx.zoneId === null ||
        entry.zoneIds.includes(ctx.zoneId)),
  );
  const answer = combineAnswers(presenceSections);
  const section = baseSection(
    'watched',
    answer,
    combinedCount(answer.state, entries.length),
  );
  section.highlights = entries
    .map((entry) => ({
      entry,
      label: textOrNull(entry.label) ?? textOrNull(entry.value),
    }))
    .sort(
      (a, b) =>
        ZONE_KINDS.indexOf(a.entry.kind) - ZONE_KINDS.indexOf(b.entry.kind) ||
        compareText(a.label, b.label) ||
        compareText(textOrNull(a.entry.entryId), textOrNull(b.entry.entryId)),
    )
    .slice(0, BRIEF_EXTRA_LIMITS.watchedHighlights)
    .map(({ entry, label }) => ({
      label,
      kind: entry.kind,
      presence: textOrNull(entry.presence?.state),
      facts: watchedFacts(
        entry,
        watchedItem(entry, itemsByKind),
        ctx.occupants,
      ),
    }));
  return section;
}

/** A W9 summary, a W9 values() result or a series object, as a summary. */
function readSummary(value, nowMs) {
  let source = value;
  if (isRecord(source) && typeof source.summary === 'function') {
    try {
      source = source.summary(nowMs ?? undefined);
    } catch {
      return null;
    }
  }
  if (!isRecord(source)) return null;
  if (Array.isArray(source.values)) return summaryFromValues(source);
  const min = finiteOrNull(source.min);
  const median = finiteOrNull(source.median);
  const max = finiteOrNull(source.max);
  const samples = countOrNull(source.samples);
  if (min === null || median === null || max === null || !samples) return null;
  return {
    sinceMs: timeOrNull(source.sinceMs),
    min,
    median,
    max,
    samples,
    floorSamples: countOrNull(source.floorSamples) ?? 0,
  };
}

function summaryFromValues(source) {
  const startMs = finiteOrNull(source.startMs);
  const stepMs = finiteOrNull(source.stepMs);
  const floors = Array.isArray(source.floor) ? source.floor : [];
  const kept = [];
  let floorSamples = 0;
  let sinceMs = null;
  source.values.forEach((raw, index) => {
    const value = finiteOrNull(raw);
    if (value === null || value < 0) return;
    if (floors[index] === true) {
      floorSamples += 1;
      return;
    }
    kept.push(value);
    if (sinceMs === null && startMs !== null && stepMs !== null) {
      sinceMs = timeOrNull(startMs + index * stepMs);
    }
  });
  if (!kept.length) return null;
  kept.sort((a, b) => a - b);
  const mid = Math.floor(kept.length / 2);
  return {
    sinceMs,
    min: kept[0],
    median: kept.length % 2 === 1 ? kept[mid] : (kept[mid - 1] + kept[mid]) / 2,
    max: kept[kept.length - 1],
    samples: kept.length,
    floorSamples,
  };
}

function buildOccupancySection(ctx, kinds) {
  const series = {};
  for (const kind of kinds) {
    const given =
      isRecord(ctx.series) && Object.hasOwn(ctx.series, kind)
        ? ctx.series[kind]
        : undefined;
    const fromView = isRecord(ctx.zoneView?.series)
      ? ctx.zoneView.series[kind]
      : undefined;
    series[kind] =
      readSummary(given, ctx.nowMs) ?? readSummary(fromView, ctx.nowMs);
  }
  const known = kinds.filter((kind) => series[kind] !== null).length;
  let answer;
  if (known === kinds.length) answer = { state: COUNTED, reason: null };
  else if (known > 0) answer = { state: FLOOR, reason: 'never-answered' };
  else answer = { state: UNKNOWN, reason: 'never-answered' };
  const section = baseSection('occupancy', { ...answer, asOfMs: null }, null);
  section.series = series;
  const occupants = Array.isArray(ctx.zoneView?.occupants)
    ? ctx.zoneView.occupants
    : [];
  section.highlights = occupants
    .filter((occupant) => isRecord(occupant) && kinds.includes(occupant.kind))
    .map((occupant) => ({
      key: textOrNull(occupant.assetKey),
      kind: occupant.kind,
      label: textOrNull(occupant.label),
      enteredAtMs: timeOrNull(occupant.enteredAtMs),
      lowerBound: boolOrNull(occupant.lowerBound),
    }))
    .sort(
      (a, b) =>
        compareAsc(a.enteredAtMs, b.enteredAtMs) || compareText(a.key, b.key),
    )
    .slice(0, BRIEF_EXTRA_LIMITS.occupantHighlights)
    .map((occupant) => ({
      label: occupant.label,
      kind: occupant.kind,
      facts: pickFacts({
        enteredAtMs: occupant.enteredAtMs,
        lowerBound: occupant.lowerBound,
      }),
    }));
  return section;
}

/** An event parameter value: a JSON scalar or a short array of them. */
function paramValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_PARAM_ITEMS).map(factValue);
  }
  return factValue(value);
}

/** Catalogue parameters only, in key order, with JSON-safe values. */
function briefParams(params) {
  const out = {};
  if (!isRecord(params)) return out;
  for (const key of Object.keys(params).sort(compareText)) {
    if (EVENT_PARAM_KEY_SET.has(key)) out[key] = paramValue(params[key]);
  }
  return out;
}

/** A position-free, JSON-safe copy of a WatchEvent or log row. */
function briefEvent(event) {
  const params = briefParams(event.params);
  const caveats = Array.isArray(event.caveats)
    ? event.caveats
        .map(textOrNull)
        .filter((code) => code !== null)
        .slice(0, MAX_CAVEATS)
    : [];
  const repeat = countOrNull(event.repeat);
  return {
    id: textOrNull(event.id),
    seq: finiteOrNull(event.seq),
    type: textOrNull(event.type),
    severity: textOrNull(event.severity),
    atMs: timeOrNull(event.atMs),
    dataAtMs: timeOrNull(event.dataAtMs),
    zoneId: textOrNull(event.zoneId),
    kind: textOrNull(event.kind),
    assetKey: textOrNull(event.assetKey),
    assetId: textOrNull(event.assetId),
    assetLabel: textOrNull(event.assetLabel),
    layerId: textOrNull(event.layerId),
    params,
    caveats,
    watchlisted: event.watchlisted === true,
    repeat: repeat !== null && repeat >= 1 ? repeat : null,
  };
}

function buildActivitySection(ctx, kindSections) {
  const events = ctx.recentEvents
    .filter(
      (event) =>
        isRecord(event) &&
        ctx.zoneId !== null &&
        textOrNull(event.zoneId) === ctx.zoneId,
    )
    .map(briefEvent)
    .sort(
      (a, b) =>
        compareDesc(a.atMs, b.atMs) ||
        compareDesc(a.seq, b.seq) ||
        compareText(a.id, b.id),
    );
  const answer = combineAnswers(kindSections);
  const section = baseSection(
    'activity',
    answer,
    combinedCount(answer.state, events.length),
  );
  section.events = events.slice(0, BRIEF_LIMITS.activity);
  return section;
}

function zoneKinds(zone, zoneView) {
  const raw = Array.isArray(zone?.kinds)
    ? zone.kinds
    : Array.isArray(zoneView?.kinds)
      ? zoneView.kinds
      : [];
  return ZONE_KINDS.filter((kind) => raw.includes(kind));
}

/**
 * Builds the place brief for one zone.
 *
 * Sections, in {@link BRIEF_SECTION_IDS} order: one per kind the zone
 * watches ('aircraft', 'vessels', 'fires', 'quakes'); 'watched' when the
 * zone watches aircraft or vessels and `watchInside` is an array; 'occupancy'
 * when it watches aircraft or vessels; and 'activity' always.
 *
 * - Kind sections take their answer from `zoneView.perKind[kind]` and their
 *   count and highlights from the in-zone assets of the answering `frames`
 *   (the view's count when no answering frame of the kind is given).
 * - 'watched' lists the watch entries inside the zone (WatchView watchlist
 *   rows; rows whose `zoneIds` omit the zone are dropped) under the combined
 *   aircraft and vessel answer.
 * - 'occupancy' reads each kind's summary from `series[kind]` (a W9 summary,
 *   a W9 `values()` result or a series object) or `zoneView.series[kind]`,
 *   and lists the view's longest-present occupants.
 * - 'activity' lists the zone's newest events from `recentEvents` (events
 *   or log rows with this `zoneId`) under the combined answer of every kind.
 *
 * @param {{zone?: object|null,
 *   compiled?: import('./geometry.js').CompiledZone|null,
 *   frames?: Map<string, object>|object[]|Object<string, object>|null,
 *   zoneView?: object|null, watchInside?: object[]|null,
 *   recentEvents?: object[]|null, series?: Object<string, *>|null,
 *   nowMs?: number|null}} input `zone` is the stored zone (id, name, kinds
 *   and filters); `compiled` defaults to `compileZone(zone)`; `frames` holds
 *   the latest ObservationFrame per layer.
 * @returns {PlaceBrief}
 */
export function buildPlaceBrief({
  zone = null,
  compiled = null,
  frames = null,
  zoneView = null,
  watchInside = null,
  recentEvents = null,
  series = null,
  nowMs = null,
} = {}) {
  const zoneRecord = isRecord(zone) ? zone : null;
  const view = isRecord(zoneView) ? zoneView : null;
  let compiledZone = isCompiledZone(compiled) ? compiled : null;
  if (!compiledZone && zoneRecord) compiledZone = compileZone(zoneRecord);
  const zoneId =
    textOrNull(zoneRecord?.id) ??
    textOrNull(view?.id) ??
    textOrNull(compiledZone?.id);
  const occupants = new Map();
  for (const occupant of Array.isArray(view?.occupants) ? view.occupants : []) {
    const key = isRecord(occupant) ? textOrNull(occupant.assetKey) : null;
    if (key && !occupants.has(key)) occupants.set(key, occupant);
  }
  const ctx = {
    zone: zoneRecord,
    zoneId,
    compiled: compiledZone,
    frames: frameList(frames),
    zoneView: view,
    watchInside: Array.isArray(watchInside) ? watchInside : [],
    recentEvents: Array.isArray(recentEvents) ? recentEvents : [],
    series: isRecord(series) ? series : null,
    nowMs: finiteOrNull(nowMs),
    occupants,
  };
  const kinds = zoneKinds(zoneRecord, view);
  const kindSections = [];
  const itemsByKind = new Map();
  for (const kind of kinds) {
    const { section, items } = buildKindSection(kind, ctx);
    kindSections.push(section);
    itemsByKind.set(kind, items);
  }
  const presenceKinds = kinds.filter((kind) => PRESENCE_KINDS.includes(kind));
  const presenceSections = kindSections.filter(
    (section) => section.id === 'aircraft' || section.id === 'vessels',
  );
  const sections = [...kindSections];
  if (presenceKinds.length && Array.isArray(watchInside)) {
    sections.push(buildWatchedSection(ctx, presenceSections, itemsByKind));
  }
  if (presenceKinds.length) {
    sections.push(buildOccupancySection(ctx, presenceKinds));
  }
  sections.push(buildActivitySection(ctx, kindSections));
  return {
    zoneId,
    name: textOrNull(zoneRecord?.name) ?? textOrNull(view?.name),
    generatedAtMs: timeOrNull(nowMs),
    sections,
  };
}

function sectionValues(section) {
  return {
    answer: ANSWER_STATES.includes(section.answer) ? section.answer : UNKNOWN,
    reason: textOrNull(section.reason),
    count: countOrNull(section.count),
    floor: section.floor === true,
    asOfMs: timeOrNull(section.asOfMs),
  };
}

function highlightValues(highlight, extra = {}) {
  const facts = isRecord(highlight.facts) ? pickFacts(highlight.facts) : {};
  return { label: textOrNull(highlight.label), ...extra, ...facts };
}

function highlightsOf(section) {
  return Array.isArray(section.highlights)
    ? section.highlights.filter(isRecord)
    : [];
}

function pushHighlights(lines, code, section, extra) {
  for (const highlight of highlightsOf(section)) {
    lines.push({
      code,
      values: highlightValues(highlight, extra ? extra(highlight) : {}),
    });
  }
}

const SUMMARY_KEYS = Object.freeze([
  'sinceMs',
  'min',
  'median',
  'max',
  'samples',
  'floorSamples',
]);

function occupancyLines(lines, section) {
  lines.push({
    code: BRIEF_LINE_CODES.OCCUPANCY,
    values: sectionValues(section),
  });
  const series = isRecord(section.series) ? section.series : {};
  for (const kind of PRESENCE_KINDS) {
    if (!Object.hasOwn(series, kind)) continue;
    const summary = series[kind];
    if (!isRecord(summary)) {
      lines.push({ code: BRIEF_LINE_CODES.OCCUPANCY_GAP, values: { kind } });
      continue;
    }
    const values = { kind };
    for (const key of SUMMARY_KEYS) values[key] = finiteOrNull(summary[key]);
    lines.push({ code: BRIEF_LINE_CODES.OCCUPANCY_SERIES, values });
  }
  pushHighlights(lines, BRIEF_LINE_CODES.OCCUPANT, section, (highlight) => ({
    kind: textOrNull(highlight.kind),
  }));
}

function activityLines(lines, section) {
  lines.push({
    code: BRIEF_LINE_CODES.ACTIVITY,
    values: sectionValues(section),
  });
  const events = Array.isArray(section.events) ? section.events : [];
  for (const event of events) {
    if (!isRecord(event)) continue;
    const safe = briefEvent(event);
    lines.push({
      code: BRIEF_LINE_CODES.ACTIVITY_EVENT,
      values: {
        type: safe.type,
        severity: safe.severity,
        atMs: safe.atMs,
        label: safe.assetLabel,
        kind: safe.kind,
        repeat: safe.repeat,
        watchlisted: safe.watchlisted,
        params: safe.params,
        caveats: safe.caveats,
      },
    });
  }
}

/**
 * Flattens a brief into wording-ready lines, each `{code, values}` with a
 * {@link BRIEF_LINE_CODES} code and JSON-safe values (numbers, codes, feed
 * strings, booleans and null). Labels and the zone name are values, never
 * text to translate.
 *
 * - 'brief-header' `{name, generatedAtMs}` first.
 * - Each section header carries `{answer, reason, count, floor, asOfMs}`;
 *   'brief-fires' adds `maxFrpMw` and `newestAcqMs`, 'brief-quakes' adds
 *   `maxMagnitude` and `newestTimeMs`.
 * - Item lines carry `label` and the highlight's facts; watched items add
 *   `kind` and `presence`, occupants add `kind`.
 * - 'brief-vessel-type' `{type, count}` per bucket (type may be a
 *   {@link BRIEF_BUCKET_KEYS} code).
 * - 'brief-occupancy-series' `{kind, sinceMs, min, median, max, samples,
 *   floorSamples}` per kind with a summary, 'brief-occupancy-gap' `{kind}`
 *   per kind without one.
 * - 'brief-activity-event' `{type, severity, atMs, label, kind, repeat,
 *   watchlisted, params, caveats}` per event, newest first.
 *
 * @param {PlaceBrief} brief
 * @returns {BriefLine[]} empty for anything that is not a brief.
 */
export function placeBriefLines(brief) {
  if (!isRecord(brief)) return [];
  const lines = [
    {
      code: BRIEF_LINE_CODES.HEADER,
      values: {
        name: textOrNull(brief.name),
        generatedAtMs: timeOrNull(brief.generatedAtMs),
      },
    },
  ];
  const sections = Array.isArray(brief.sections) ? brief.sections : [];
  for (const section of sections) {
    if (!isRecord(section)) continue;
    switch (section.id) {
      case 'aircraft':
        lines.push({
          code: BRIEF_LINE_CODES.AIRCRAFT,
          values: sectionValues(section),
        });
        pushHighlights(lines, BRIEF_LINE_CODES.AIRCRAFT_ITEM, section);
        break;
      case 'vessels':
        lines.push({
          code: BRIEF_LINE_CODES.VESSELS,
          values: sectionValues(section),
        });
        for (const bucket of Array.isArray(section.buckets)
          ? section.buckets
          : []) {
          if (!isRecord(bucket)) continue;
          lines.push({
            code: BRIEF_LINE_CODES.VESSEL_TYPE,
            values: {
              type: textOrNull(bucket.key),
              count: countOrNull(bucket.count),
            },
          });
        }
        pushHighlights(lines, BRIEF_LINE_CODES.VESSEL_ITEM, section);
        break;
      case 'fires':
        lines.push({
          code: BRIEF_LINE_CODES.FIRES,
          values: {
            ...sectionValues(section),
            maxFrpMw: finiteOrNull(section.maxFrpMw),
            newestAcqMs: timeOrNull(section.newestAcqMs),
          },
        });
        pushHighlights(lines, BRIEF_LINE_CODES.FIRE_ITEM, section);
        break;
      case 'quakes':
        lines.push({
          code: BRIEF_LINE_CODES.QUAKES,
          values: {
            ...sectionValues(section),
            maxMagnitude: finiteOrNull(section.maxMagnitude),
            newestTimeMs: timeOrNull(section.newestTimeMs),
          },
        });
        pushHighlights(lines, BRIEF_LINE_CODES.QUAKE_ITEM, section);
        break;
      case 'watched':
        lines.push({
          code: BRIEF_LINE_CODES.WATCHED,
          values: sectionValues(section),
        });
        pushHighlights(
          lines,
          BRIEF_LINE_CODES.WATCHED_ITEM,
          section,
          (highlight) => ({
            kind: textOrNull(highlight.kind),
            presence: textOrNull(highlight.presence),
          }),
        );
        break;
      case 'occupancy':
        occupancyLines(lines, section);
        break;
      case 'activity':
        activityLines(lines, section);
        break;
      default:
        break;
    }
  }
  return lines;
}
