/**
 * The Watch engine: one pure state machine that turns observation frames
 * (frames.js) into honest watch events and a JSON-safe view.
 *
 * It owns, for the current Watch document, the presence members of every
 * aircraft and vessel zone, the hazard watch for fire and quake zones, the
 * emergency tracker, the watched-asset debounce, the occupancy series and the
 * feed pause bookkeeping. The controller feeds it frames (`ingest`), a clock
 * (`tick`), satellite lookups (`setSatellites`) and documents (`setDocument`),
 * and renders `view(nowMs)`. Wording lives in the UI: the engine only emits
 * codes, numbers and feed strings.
 *
 * Honesty rules (see the plan, sections 2 and 3):
 * - Only counted or floor answers move members, and only fresh fixes move
 *   streaks. A held, unknown or off answer (or coverage that misses the zone)
 *   turns inside members unknown and never produces an exit, an exit window,
 *   a no-longer-reported or a not-reported event.
 * - Absence is evidence only in a counted, new-epoch frame from a layer that
 *   carried the member, when every other layer that carried it also answers
 *   counted for the zone and lacks it.
 * - An entry needs two fresh core-inside fixes and a report outside the zone
 *   in the layer's previous answering frame (or the other aircraft layer's
 *   latest); otherwise the asset is first-seen, with a lower-bound dwell.
 * - Zone events honour the zone's `notify` ('all' emits them; 'watchlisted'
 *   and 'none' keep only watched assets' events), and emergencies are
 *   reported for members of 'all' zones, watched aircraft, or everything
 *   when `prefs.allEmergencies` is on.
 * - A zone is baselined silently on its first answer, after a geometry or
 *   filter edit and after a gap longer than the kind's re-baseline gap; a
 *   gap baseline reports `zone-rechecked` when the count changed.
 * - Busy zones (median count over the busy window above `busyEnterMedian`,
 *   until it falls below `busyExitMedian`) turn presence events into counters,
 *   reported as `zone-traffic-summary` every `busySummaryMs`. More than
 *   `coalesceAbove` presence events of one type for one zone in one frame
 *   become one summary. Events of watched assets are escalated and bypass
 *   busy mode, coalescing and the zone's `notify` setting.
 *
 * Only asset identifiers travel (ICAO24, callsign, MMSI, NORAD id, USGS id
 * and the feed's display label).
 *
 * Pure module: no platform globals, timers, storage, clocks or randomness.
 * Every time comes in through the frames (`nowMs`, epochs and fix times) and
 * through `tick(nowMs)`, `setSatellites(rows, nowMs)` and `view(nowMs)`; an
 * optional injected `measureMs` clock only times ingests for diagnostics.
 */
import { buildPlaceBrief } from './brief.js';
import { ZONE_KINDS } from './document.js';
import { EMERGENCY_TRANSITION, createEmergencyTracker } from './emergency.js';
import {
  ANSWER,
  KIND_LAYERS,
  WATCH_SOURCES,
  isAnswering,
  isFreshFix,
  zoneAnswer,
} from './frames.js';
import {
  compileZone,
  coverageOfZone,
  marginM,
  outlineRing,
  signedDistanceM,
} from './geometry.js';
import { createHazardWatch } from './hazards.js';
import { createOccupancySeries } from './occupancy.js';
import {
  MEMBER_STATE,
  PRESENCE_POLICY,
  PRESENCE_TRANSITION,
  baselineMember,
  expireMember,
  initialMember,
  stepMember,
} from './presence.js';
import {
  WATCHLIST_POLICY,
  WATCH_LAYERS,
  WATCH_PRESENCE,
  compileWatchlist,
  createWatchTracker,
  matchAsset,
  resolveWatchPresence,
  watchClassKnown,
  watchEligibility,
} from './watchlist.js';

/**
 * Engine limits.
 *
 * - `maxMembersPerZone` / `maxMembersTotal`: presence members kept per zone
 *   (all kinds) and across every zone; past them a zone reads `capped`.
 * - `eventsPerIngest`: most events one call returns (lowest severity dropped
 *   first, counted in diagnostics).
 * - `coalesceAbove`: more than this many presence events of one type for one
 *   zone in one frame become one summary.
 * - `busyEnterMedian` / `busyExitMedian` / `busyWindowSamples`: busy mode
 *   hysteresis over the median of the latest counted samples.
 * - `busySummaryMs`: how often a busy zone reports its counters.
 * - `recheckMinGapMs`: shortest gap whose re-baseline reports
 *   `zone-rechecked`.
 * - `feedPauseEvals` / `feedPauseMs`: a needed layer that answered before
 *   reads paused after this many non-answering evaluations over this long.
 * - `bboxPadMargins`: candidate prefilter pad, in hysteresis margins.
 * - `alertHoldMs`: how long a zone reads `alert` after an alert event.
 * - `occupantsShown`: occupants listed per zone in the view.
 *
 * @type {Readonly<{maxMembersPerZone: number, maxMembersTotal: number,
 *   eventsPerIngest: number, coalesceAbove: number, busyEnterMedian: number,
 *   busyExitMedian: number, busyWindowSamples: number, busySummaryMs: number,
 *   recheckMinGapMs: number, feedPauseEvals: number, feedPauseMs: number,
 *   bboxPadMargins: number, alertHoldMs: number, occupantsShown: number}>}
 */
export const WATCH_ENGINE_LIMITS = Object.freeze({
  maxMembersPerZone: 400,
  maxMembersTotal: 10_000,
  eventsPerIngest: 100,
  coalesceAbove: 5,
  busyEnterMedian: 30,
  busyExitMedian: 20,
  busyWindowSamples: 10,
  busySummaryMs: 600_000,
  recheckMinGapMs: 300_000,
  feedPauseEvals: 2,
  feedPauseMs: 120_000,
  bboxPadMargins: 2,
  alertHoldMs: 600_000,
  occupantsShown: 3,
});

function catalogueEntry(severity, escalation, params) {
  return Object.freeze({ severity, escalation, params: Object.freeze(params) });
}

/**
 * The event catalogue shared with the wording module: every event type, its
 * base severity, its escalation rule (a code, or null) and the only params
 * keys it carries. Escalation codes: 'alert-if-watchlisted',
 * 'notice-if-watchlisted', 'alert-if-strong-fire' (max FRP at or above the
 * hazard alert FRP), 'alert-if-strong-quake' (magnitude at or above the
 * zone's `alertMagnitude`) and 'notice-if-on-ground'.
 *
 * @type {Readonly<Record<string, Readonly<{severity: 'info'|'notice'|'alert',
 *   escalation: string|null, params: ReadonlyArray<string>}>>>}
 */
export const WATCH_EVENT_CATALOGUE = Object.freeze({
  'zone-enter': catalogueEntry('notice', 'alert-if-watchlisted', [
    'sinceMs',
    'reentry',
  ]),
  'zone-exit': catalogueEntry('notice', 'alert-if-watchlisted', [
    'exitAtMs',
    'enteredAtMs',
    'dwellMs',
    'dwellLowerBound',
  ]),
  'zone-exit-window': catalogueEntry('info', 'alert-if-watchlisted', [
    'fromMs',
    'toMs',
  ]),
  'zone-no-longer-reported': catalogueEntry('info', 'notice-if-watchlisted', [
    'lastFixAtMs',
    'lastAltM',
    'lastOnGround',
    'descending',
  ]),
  'zone-enter-summary': catalogueEntry('info', null, [
    'count',
    'labels',
    'assetKeys',
  ]),
  'zone-exit-summary': catalogueEntry('info', null, [
    'count',
    'labels',
    'assetKeys',
  ]),
  'zone-traffic-summary': catalogueEntry('info', null, [
    'sinceMs',
    'entered',
    'exited',
    'noLongerReported',
    'median',
  ]),
  'zone-rechecked': catalogueEntry('info', null, [
    'gapMs',
    'before',
    'after',
    'beforeFloor',
    'afterFloor',
  ]),
  'feed-paused': catalogueEntry('notice', null, ['reason', 'sinceMs']),
  'feed-resumed': catalogueEntry('info', null, ['pausedMs']),
  'fires-new': catalogueEntry('notice', 'alert-if-strong-fire', [
    'count',
    'maxFrpMw',
    'firstAcqMs',
    'lastAcqMs',
  ]),
  'quake-new': catalogueEntry('notice', 'alert-if-strong-quake', [
    'magnitude',
    'depthKm',
    'timeMs',
    'place',
    'usgsId',
    'reportedAfterBaseline',
    'outsideByKm',
  ]),
  'hazard-gap-summary': catalogueEntry('info', null, [
    'hazard',
    'count',
    'gapMs',
  ]),
  'emergency-start': catalogueEntry('alert', 'notice-if-on-ground', [
    'kind',
    'squawk',
    'source',
    'sinceMs',
  ]),
  'emergency-change': catalogueEntry('notice', null, [
    'fromKind',
    'kind',
    'squawk',
    'source',
  ]),
  'emergency-end': catalogueEntry('info', null, [
    'kind',
    'squawk',
    'durationMs',
  ]),
  'emergency-unresolved': catalogueEntry('notice', null, [
    'kind',
    'squawk',
    'lastFixAtMs',
  ]),
  'watch-seen': catalogueEntry('info', null, ['layerId']),
  'watch-not-reported': catalogueEntry('notice', null, ['lastSeenAtMs']),
  'watch-reappeared': catalogueEntry('alert', null, [
    'absentMs',
    'coveredShare',
  ]),
});

/** Every caveat code a watch event can carry, in display order. */
export const WATCH_EVENT_CAVEATS = Object.freeze([
  'on-ground',
  'code-may-be-in-error',
  'unobserved-interval',
  'coverage-incomplete',
  'partial-coverage',
  'regional-fallback',
  'lower-bound',
]);

/**
 * A watch event, as the engine returns it.
 *
 * @typedef {{id: string, seq: number, type: string,
 *   severity: 'info'|'notice'|'alert', atMs: number, dataAtMs: number|null,
 *   zoneId: string|null, assetKey: string|null, kind: string|null,
 *   assetId: string|null, assetLabel: string|null, layerId: string|null,
 *   position: {lat: number, lon: number}|null, params: object,
 *   caveats: string[], watchlisted: boolean, dedupeKey: string}} WatchEvent
 */

/**
 * @typedef {{answer: string, reason: string|null, count: number|null,
 *   floor: boolean, asOfMs: number|null, busy: boolean}} ZoneKindView
 */

/**
 * @typedef {{id: string, name: string|null, shape: string, kinds: string[],
 *   notify: string, alert: boolean, labelAnchor: {lat: number, lon: number},
 *   outline: Array<[number, number]>, perKind: Object<string, ZoneKindView>,
 *   occupants: Array<{assetKey: string, label: string|null, kind: string,
 *     enteredAtMs: number|null, lowerBound: boolean}>,
 *   timed: boolean, capped: boolean,
 *   series: Object<string, object|null>}} ZoneView
 *   `timed` is true once presence tracking has baselined one of the zone's
 *   aircraft or vessel kinds (occupants and dwell times are being timed);
 *   `capped` is true when the member cap stopped tracking new members.
 */

/**
 * @typedef {{generatedAtMs: number|null, zones: ZoneView[],
 *   watchlist: object[], emergencies: object[],
 *   feeds: Object<string, {answer: string, reason: string|null,
 *     asOfMs: number|null, paused: boolean}>}} WatchView
 */

const { COUNTED, FLOOR, HELD, UNKNOWN, OFF } = ANSWER;
const ANSWER_STATES = Object.freeze([COUNTED, FLOOR, HELD, UNKNOWN, OFF]);
const PRESENCE_KINDS = Object.freeze(['aircraft', 'vessel']);
const HAZARD_KINDS = Object.freeze(['fire', 'quake']);
const SOURCE_LAYERS = Object.freeze(Object.keys(WATCH_SOURCES));
const SEVERITY_ORDER = Object.freeze({ info: 0, notice: 1, alert: 2 });
const INSIDE_STATES = Object.freeze([
  MEMBER_STATE.INSIDE,
  MEMBER_STATE.EXITING,
]);
const ENTER_GROUP = Object.freeze(['zone-enter']);
const EXIT_GROUP = Object.freeze(['zone-exit', 'zone-exit-window']);
const BUSY_COUNTER = Object.freeze({
  'zone-enter': 'entered',
  'zone-exit': 'exited',
  'zone-exit-window': 'exited',
  'zone-no-longer-reported': 'noLongerReported',
});
const ACTIVE_EMERGENCY_PHASES = Object.freeze(['active', 'clearing']);
const VIEW_EMERGENCY_PHASES = Object.freeze(['active', 'clearing', 'unknown']);
/**
 * A no-longer-reported event that cannot be reported (the zone or a source
 * layer does not answer counted) waits up to this many expiry times of its
 * kind before the member expires silently.
 */
const LOSS_DEFER_FACTOR = 2;
const AWAITING_PRESENCE = Object.freeze({
  state: WATCH_PRESENCE.CHECKING,
  reason: 'awaiting-frame',
  fix: null,
  layerId: null,
  matches: 0,
  asset: null,
  covered: false,
});
const MAX_LABELS = 3;
const MAX_ASSET_KEYS = 10;

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

function positionOf(value) {
  if (!isRecord(value)) return null;
  const lat = finiteOrNull(value.lat);
  const lon = finiteOrNull(value.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90) return null;
  if (Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A JSON-safe param value: a finite number, string, boolean or null, or a
 * list of those.
 */
function paramValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => paramValue(item))
      .filter((item) => item !== null && !Array.isArray(item));
  }
  return null;
}

/** Params of an event type: exactly the catalogue keys, null when missing. */
function pickParams(type, raw) {
  const entry = WATCH_EVENT_CATALOGUE[type];
  const source = isRecord(raw) ? raw : {};
  const params = {};
  for (const key of entry ? entry.params : []) {
    params[key] = paramValue(source[key]);
  }
  return params;
}

/** Caveats in catalogue order, each once, unknown codes dropped. */
function orderCaveats(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return WATCH_EVENT_CAVEATS.filter((code) => set.has(code));
}

/** A validated copy of a frame's answer. */
function answerOf(frame) {
  const answer = isRecord(frame?.answer) ? frame.answer : null;
  if (!answer || !ANSWER_STATES.includes(answer.state)) {
    return { state: UNKNOWN, reason: 'cannot-answer', asOfMs: null };
  }
  return {
    state: answer.state,
    reason: textOrNull(answer.reason),
    asOfMs: timeOrNull(answer.asOfMs),
  };
}

function sameAnswer(a, b) {
  return a.state === b.state && a.reason === b.reason;
}

/**
 * One layer's answer for one zone: the frame answer mapped through the
 * zone coverage exactly as frames.js `zoneAnswer` maps each layer.
 */
function layerAnswer(frame, compiled) {
  const answer = answerOf(frame);
  if (!isAnswering(answer)) return answer;
  const coverage = coverageOfZone(frame.coverage, compiled);
  if (coverage === 'none') {
    return { ...answer, state: UNKNOWN, reason: 'outside-loaded-area' };
  }
  if (answer.state === COUNTED && coverage === 'unknown') {
    return { ...answer, state: FLOOR, reason: 'coverage-unknown' };
  }
  if (answer.state === COUNTED && coverage === 'partial') {
    return { ...answer, state: FLOOR, reason: 'partial-coverage' };
  }
  return answer;
}

const DEG = Math.PI / 180;
/** Fewest metres in one degree of latitude, so degree pads are generous. */
const MIN_M_PER_DEG = 110_000;

/**
 * A conservative lat/lon box around a compiled zone, padded by `padM`: a
 * point within `padM` of the zone is always inside it. It is a cheap
 * numeric prefilter in front of `signedDistanceM`, which decides.
 */
function paddedBox(compiled, padM) {
  const { south, north, west, east, wraps } = compiled.bbox;
  const padLat = padM / MIN_M_PER_DEG + 1e-3;
  const s = south - padLat;
  const n = north + padLat;
  const width = wraps ? east + 360 - west : east - west;
  if (s <= -89 || n >= 89) {
    return { south: s, north: n, full: true, westU: 0, span: 360 };
  }
  const maxAbsLat = Math.max(Math.abs(s), Math.abs(n));
  const padLon = padM / (MIN_M_PER_DEG * Math.cos(maxAbsLat * DEG)) + 1e-3;
  const span = width + 2 * padLon;
  return {
    south: s,
    north: n,
    full: span >= 360,
    westU: west - padLon,
    span,
  };
}

/** Grid cells per asset above which a linear scan is cheaper. */
const GRID_SCAN_FACTOR = 4;

/** One-degree grid cell key, longitudes wrapped to [-180, 180). */
function gridKey(latCell, lonCell) {
  const lon = ((((lonCell + 180) % 360) + 360) % 360) - 180;
  return (latCell + 90) * 360 + (lon + 180);
}

function boxContains(box, lat, lon) {
  if (lat < box.south || lat > box.north) return false;
  if (box.full) return true;
  return (((lon - box.westU) % 360) + 360) % 360 <= box.span;
}

/** Quake search buffer of a zone in metres (0 for other kinds). */
function insideLimitM(kind, zone) {
  if (kind !== 'quake') return 0;
  const bufferKm = finiteOrNull(zone?.quake?.bufferKm);
  return bufferKm !== null && bufferKm > 0 ? bufferKm * 1000 : 0;
}

/**
 * Whether the zone's filters let an in-zone asset count, exactly as
 * frames.js `assetInZone` filters (aircraft `militaryOnly`, fire
 * `minFrpMw`, quake `minMagnitude`).
 */
function countFilterAccepts(kind, zone, asset) {
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

/** Whether the zone's own filters accept a presence asset. */
function acceptsAsset(kind, zone, asset) {
  if (!isRecord(asset) || asset.kind !== kind) return false;
  if (typeof asset.key !== 'string' || !asset.key) return false;
  if (positionOf(asset) === null) return false;
  if (kind === 'aircraft' && zone?.aircraft?.militaryOnly === true) {
    return asset.military === true;
  }
  return true;
}

function zoneKindsOf(zone) {
  const raw = Array.isArray(zone?.kinds) ? zone.kinds : [];
  return ZONE_KINDS.filter((kind) => raw.includes(kind));
}

function geometryKeyOf(zone) {
  return JSON.stringify([
    zone.shape ?? null,
    zone.center ?? null,
    zone.radiusM ?? null,
    zone.ring ?? null,
  ]);
}

/** The filter part of a kind's identity: a change re-baselines that kind. */
function filterKeyOf(zone, kind) {
  if (kind === 'aircraft') return String(zone?.aircraft?.militaryOnly === true);
  if (kind === 'fire') return String(finiteOrNull(zone?.fire?.minFrpMw));
  if (kind === 'quake') {
    return `${finiteOrNull(zone?.quake?.minMagnitude)}|${finiteOrNull(
      zone?.quake?.bufferKm,
    )}`;
  }
  return '';
}

function notifyOf(zone) {
  return ['all', 'watchlisted', 'none'].includes(zone?.notify)
    ? zone.notify
    : 'all';
}

/** Frozen-or-default policy table lookup per kind. */
function perKindRule(policy, name, kind) {
  const table = isRecord(policy?.[name]) ? policy[name] : null;
  const value = finiteOrNull(table?.[kind]);
  return value !== null ? value : PRESENCE_POLICY[name][kind];
}

function mergeLimits(limits) {
  const merged = { ...WATCH_ENGINE_LIMITS };
  if (isRecord(limits)) {
    for (const key of Object.keys(WATCH_ENGINE_LIMITS)) {
      const value = finiteOrNull(limits[key]);
      if (value !== null && value >= 0) merged[key] = value;
    }
  }
  return Object.freeze(merged);
}

function readDocument(doc) {
  const base = isRecord(doc) ? doc : {};
  const zones = Array.isArray(base.zones) ? base.zones.filter(isRecord) : [];
  const watchlist = Array.isArray(base.watchlist)
    ? base.watchlist.filter(isRecord)
    : [];
  const prefs = isRecord(base.prefs) ? base.prefs : {};
  return {
    zones,
    watchlist,
    prefs: {
      zonesVisible: prefs.zonesVisible !== false,
      toasts: prefs.toasts !== false,
      allEmergencies: prefs.allEmergencies === true,
    },
  };
}

/** The asset key an entry names directly (ICAO24 or MMSI), else null. */
function entryAssetKey(entry) {
  const value = textOrNull(entry?.value);
  if (!value) return null;
  if (entry.match === 'icao24') return value.toLowerCase();
  if (entry.match === 'mmsi') return value;
  return null;
}

function normalizeCallsign(value) {
  const text = textOrNull(value);
  return text ? text.toUpperCase().replace(/\s+/g, '') : null;
}

/**
 * Creates a Watch engine.
 *
 * @param {{limits?: Partial<typeof WATCH_ENGINE_LIMITS>,
 *   policies?: {presence?: object, watchlist?: object, emergency?: object,
 *     hazards?: object, occupancy?: {stepMs?: number, samples?: number}},
 *   onDeclined?: (entryId: string, code: string) => void,
 *   measureMs?: () => number}} [options]
 *   `onDeclined` is called (after the call that resolved it) when the
 *   privacy guard declines a watch entry that the document has not marked
 *   declined yet, so the controller can run `markDeclined`; the same
 *   decisions are also returned by `declinedUpdates()`. `measureMs` is an
 *   optional injected monotonic clock (for example `() => performance.now()`)
 *   used only to time each ingest for `diagnostics().evalMsByLayer`.
 * @returns {{setDocument: (doc: object) => void,
 *   ingest: (frame: object) => WatchEvent[],
 *   setSatellites: (rows: object[]|Map<string, object>|Object<string, object>,
 *     nowMs: number) => WatchEvent[],
 *   tick: (nowMs: number) => WatchEvent[],
 *   view: (nowMs?: number) => WatchView,
 *   brief: (zoneId: string, options?: {nowMs?: number,
 *     recentEvents?: object[]}) => object|null,
 *   lastSeenUpdates: () => Array<{entryId: string, lastSeen: object}>,
 *   declinedUpdates: () => Array<{entryId: string, code: string}>,
 *   diagnostics: () => object,
 *   reset: () => void}}
 */
export function createWatchEngine(options = {}) {
  const opts = isRecord(options) ? options : {};
  const limits = mergeLimits(opts.limits);
  const policies = isRecord(opts.policies) ? opts.policies : {};
  const presencePolicy = isRecord(policies.presence)
    ? policies.presence
    : PRESENCE_POLICY;
  const watchPolicy = isRecord(policies.watchlist)
    ? policies.watchlist
    : WATCHLIST_POLICY;
  const occupancyOptions = isRecord(policies.occupancy)
    ? policies.occupancy
    : {};
  const onDeclined =
    typeof opts.onDeclined === 'function' ? opts.onDeclined : null;
  const measureMs =
    typeof opts.measureMs === 'function' ? opts.measureMs : null;
  const reentryQuietMs =
    finiteOrNull(presencePolicy.reentryQuietMs) ??
    PRESENCE_POLICY.reentryQuietMs;

  const emergency = createEmergencyTracker(policies.emergency);
  const hazards = createHazardWatch(policies.hazards);
  let tracker = createWatchTracker(watchPolicy);

  let doc = readDocument(null);
  /** zoneId → zone state, in document order. */
  let zoneStates = new Map();
  let compiledWatchlist = compileWatchlist([]);
  /** entryId → watch runtime, in document order. */
  let watchRuntime = new Map();
  let neededLayers = new Set();

  /** layerId → latest frame. */
  let frames = new Map();
  let framesVersion = 0;
  /** layerId → when its latest frame was ingested. */
  let frameTimes = new Map();
  /** layerId → the previous answering frame and when it was ingested. */
  let prevFrames = new Map();
  /** layerId → feed pause bookkeeping. */
  let feedStates = new Map();
  /** Emergency keys whose start was reported (follow-ups stay in scope). */
  let reportedEmergencies = new Set();
  let pendingLastSeen = new Map();
  let pendingDeclines = new Map();
  let declineCallbacks = [];
  let assetMaps = new WeakMap();
  let frameScans = new WeakMap();
  let frameGrids = new WeakMap();
  let watchFrameCache = new WeakMap();
  let watchVersion = 0;
  /** Kinds with at least one matchable (not declined) watch entry. */
  let watchKinds = new Set();
  /** Watched values per identifier type, for a cheap match prefilter. */
  let watchValues = { icao24: new Set(), callsign: new Set(), mmsi: new Set() };

  let totalMembers = 0;
  let lastNowMs = null;
  let seq = 0;
  let counters = freshCounters();
  /** layerId → {count, lastMs, maxMs, totalMs} when `measureMs` is given. */
  let evalMs = new Map();

  function readClock() {
    if (!measureMs) return null;
    try {
      return finiteOrNull(measureMs());
    } catch {
      return null;
    }
  }

  function noteEvalMs(layerId, startMs) {
    const endMs = readClock();
    if (startMs === null || endMs === null) return;
    const spent = Math.max(0, endMs - startMs);
    const entry = evalMs.get(layerId) ?? {
      count: 0,
      lastMs: 0,
      maxMs: 0,
      totalMs: 0,
    };
    entry.count += 1;
    entry.lastMs = spent;
    entry.maxMs = Math.max(entry.maxMs, spent);
    entry.totalMs += spent;
    evalMs.set(layerId, entry);
  }

  function freshCounters() {
    return {
      ingests: 0,
      noops: 0,
      ticks: 0,
      emitted: 0,
      dropped: 0,
      suppressedByNotify: 0,
      coalesced: 0,
      busyCounted: 0,
      baselines: 0,
      rechecks: 0,
      cappedMembers: 0,
      emergencyOutOfScope: 0,
      invalidZones: 0,
    };
  }

  /** A monotonic evaluation clock from the given time. */
  function clock(value) {
    const t = timeOrNull(value);
    if (t === null) return lastNowMs;
    lastNowMs = lastNowMs === null ? t : Math.max(lastNowMs, t);
    return lastNowMs;
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  function assetMapOf(frame) {
    if (!isRecord(frame)) return new Map();
    let map = assetMaps.get(frame);
    if (!map) {
      map = new Map();
      const assets = Array.isArray(frame.assets) ? frame.assets : [];
      for (const asset of assets) {
        if (isRecord(asset) && typeof asset.key === 'string') {
          if (!map.has(asset.key)) map.set(asset.key, asset);
        }
      }
      assetMaps.set(frame, map);
    }
    return map;
  }

  /**
   * The asset with `key` in a frame, looked up first in the grid cells
   * around `nearPoint` (its last known position) and only then through a
   * full key index.
   */
  function findAsset(frame, key, nearPoint) {
    if (!frameHasKey(frame, key)) return null;
    const index = assetMaps.get(frame);
    if (index) return index.get(key) ?? null;
    const lat = finiteOrNull(nearPoint?.lat);
    const lon = finiteOrNull(nearPoint?.lon);
    if (lat !== null && lon !== null) {
      const assets = frame.assets;
      const grid = gridOf(frame);
      const latCell = Math.floor(lat);
      const lonCell = Math.floor(lon);
      for (let dLat = -1; dLat <= 1; dLat += 1) {
        for (let dLon = -1; dLon <= 1; dLon += 1) {
          const cell = grid.get(gridKey(latCell + dLat, lonCell + dLon));
          if (!cell) continue;
          for (const i of cell) if (assets[i]?.key === key) return assets[i];
        }
      }
    }
    return assetMapOf(frame).get(key) ?? null;
  }

  function frameHasKey(frame, key) {
    if (!isRecord(frame) || !isAnswering(answerOf(frame))) return false;
    if (frame.keys instanceof Set) return frame.keys.has(key);
    return assetMapOf(frame).has(key);
  }

  /** Answering latest frames of a kind, other than `layerId`. */
  function otherAnsweringFrames(kind, layerId) {
    const out = [];
    for (const id of KIND_LAYERS[kind] || []) {
      if (id === layerId) continue;
      const frame = frames.get(id);
      if (frame && isAnswering(answerOf(frame))) out.push(frame);
    }
    return out;
  }

  /**
   * Frames that can show an asset was outside before: this layer's previous
   * answering frame and the other layers' latest answering frames, each only
   * when ingested within `maxAgeMs` (an hour-old frame of a layer that was
   * off says nothing about how an asset arrived).
   */
  function priorFramesFor(kind, layerId, nowMs, maxAgeMs) {
    const recent = (atMs) =>
      typeof atMs === 'number' && nowMs - atMs <= maxAgeMs;
    const out = [];
    const prev = prevFrames.get(layerId);
    if (prev && recent(prev.atMs)) out.push(prev.frame);
    for (const other of otherAnsweringFrames(kind, layerId)) {
      if (recent(frameTimes.get(other.layerId))) out.push(other);
    }
    return out;
  }

  function isSameEpochNoop(prev, frame) {
    if (!prev) return false;
    const answer = answerOf(frame);
    if (!isAnswering(answer)) return false;
    const epochMs = timeOrNull(frame.epochMs);
    if (epochMs === null || epochMs !== timeOrNull(prev.epochMs)) return false;
    return sameAnswer(answer, answerOf(prev));
  }

  function epochSignature(kind) {
    return (WATCH_LAYERS[kind] || [])
      .map((id) => {
        const frame = frames.get(id);
        if (!frame) return `${id}:-`;
        return `${id}:${timeOrNull(frame.epochMs)}:${answerOf(frame).state}`;
      })
      .join('|');
  }

  // -------------------------------------------------------------------------
  // Watchlist matching
  // -------------------------------------------------------------------------

  function isMilitaryKey(key) {
    return frameHasKey(frames.get('military'), key);
  }

  /**
   * A cheap, never-missing prefilter in front of `matchAsset`: whether the
   * asset's ICAO24, callsign or MMSI is a watched value.
   */
  function mayMatchWatch(asset) {
    if (!isRecord(asset)) return false;
    const raw = textOrNull(asset.id ?? asset.key);
    if (asset.kind === 'aircraft') {
      if (raw) {
        const id = /[A-Z]/.test(raw) ? raw.toLowerCase() : raw;
        if (watchValues.icao24.has(id)) return true;
      }
      if (!watchValues.callsign.size) return false;
      const callsign = textOrNull(asset.callsign);
      if (!callsign) return false;
      const normalized = /[a-z\s]/.test(callsign)
        ? normalizeCallsign(callsign)
        : callsign;
      return watchValues.callsign.has(normalized);
    }
    if (asset.kind === 'vessel')
      return Boolean(raw) && watchValues.mmsi.has(raw);
    return false;
  }
  /** Whether an observed asset is a watched (and not declined) asset. */
  function isWatchlisted(asset) {
    if (!isRecord(asset) || compiledWatchlist.byValue.size === 0) return false;
    if (!matchAsset(compiledWatchlist, asset).length) return false;
    const military =
      asset.military === true ||
      (asset.kind === 'aircraft' && isMilitaryKey(asset.key));
    // A civil aircraft the guard cannot judge yet is not treated as watched.
    return (
      watchEligibility({ ...asset, military }, watchPolicy).ok &&
      watchClassKnown({ ...asset, military })
    );
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function makeEvent(type, fields) {
    const entry = WATCH_EVENT_CATALOGUE[type];
    return {
      type,
      severity: fields.severity ?? entry.severity,
      atMs: fields.atMs,
      dataAtMs: timeOrNull(fields.dataAtMs),
      zoneId: textOrNull(fields.zoneId),
      assetKey: textOrNull(fields.assetKey),
      kind: textOrNull(fields.kind),
      assetId: textOrNull(fields.assetId),
      assetLabel: textOrNull(fields.assetLabel),
      layerId: textOrNull(fields.layerId),
      position: positionOf(fields.position),
      params: pickParams(type, fields.params),
      caveats: orderCaveats(fields.caveats),
      watchlisted: fields.watchlisted === true,
      dedupeTail: textOrNull(fields.dedupeTail),
    };
  }

  /** Assigns seq, id and dedupe keys; caps the batch by severity. */
  function finalize(events) {
    let list = events;
    if (list.length > limits.eventsPerIngest) {
      const ranked = list
        .map((event, index) => ({
          index,
          rank: SEVERITY_ORDER[event.severity] ?? 0,
        }))
        .sort((a, b) => b.rank - a.rank || a.index - b.index);
      const keep = new Set(
        ranked.slice(0, limits.eventsPerIngest).map((item) => item.index),
      );
      counters.dropped += list.length - keep.size;
      list = list.filter((_, index) => keep.has(index));
    }
    const out = [];
    for (const event of list) {
      seq += 1;
      const tail = event.dedupeTail ?? event.assetKey ?? event.layerId ?? '';
      const tailOrKind = tail || event.kind || '';
      out.push({
        id: `e-${seq}`,
        seq,
        type: event.type,
        severity: event.severity,
        atMs: event.atMs,
        dataAtMs: event.dataAtMs,
        zoneId: event.zoneId,
        assetKey: event.assetKey,
        kind: event.kind,
        assetId: event.assetId,
        assetLabel: event.assetLabel,
        layerId: event.layerId,
        position: event.position,
        params: event.params,
        caveats: event.caveats,
        watchlisted: event.watchlisted,
        dedupeKey: `${event.type}|${event.zoneId ?? ''}|${tailOrKind}`,
      });
      if (event.severity === 'alert' && event.zoneId) {
        const zs = zoneStates.get(event.zoneId);
        if (zs) zs.lastAlertAtMs = event.atMs;
      }
    }
    counters.emitted += out.length;
    return out;
  }

  /**
   * Routes one zone's presence events: watched assets pass; otherwise the
   * zone's notify setting, busy counters and coalescing apply, in that
   * order.
   */
  function emitZoneEvents(zs, ks, events, out, context) {
    const plain = [];
    for (const event of events) {
      if (event.watchlisted) {
        out.push(event);
        continue;
      }
      if (zs.notify !== 'all') {
        counters.suppressedByNotify += 1;
        continue;
      }
      const counter = BUSY_COUNTER[event.type];
      if (ks && ks.busy && ks.busyCounters && counter) {
        ks.busyCounters[counter] += 1;
        counters.busyCounted += 1;
        continue;
      }
      plain.push(event);
    }
    if (!context.coalesce) {
      out.push(...plain);
      return;
    }
    const groups = [
      { types: ENTER_GROUP, summary: 'zone-enter-summary' },
      { types: EXIT_GROUP, summary: 'zone-exit-summary' },
    ];
    const replaced = new Map();
    for (const group of groups) {
      const members = plain.filter((event) => group.types.includes(event.type));
      if (members.length <= limits.coalesceAbove) continue;
      const labels = [];
      for (const event of members) {
        if (event.assetLabel && !labels.includes(event.assetLabel)) {
          labels.push(event.assetLabel);
        }
        if (labels.length >= MAX_LABELS) break;
      }
      const caveats = new Set();
      for (const event of members) {
        for (const code of event.caveats) {
          if (code === 'partial-coverage' || code === 'regional-fallback') {
            caveats.add(code);
          }
        }
        if (event.type === 'zone-exit-window') {
          caveats.add('unobserved-interval');
        }
      }
      const summary = makeEvent(group.summary, {
        atMs: context.nowMs,
        dataAtMs: context.dataAtMs,
        zoneId: zs.id,
        kind: ks?.kind ?? null,
        layerId: context.layerId,
        // One batch per frame: distinct batches never merge in the inbox.
        dedupeTail: `${context.layerId ?? ks?.kind ?? ''}:${
          timeOrNull(context.dataAtMs) ?? context.nowMs
        }`,
        params: {
          count: members.length,
          labels,
          assetKeys: members
            .map((event) => event.assetKey)
            .filter(Boolean)
            .slice(0, MAX_ASSET_KEYS),
        },
        caveats: [...caveats],
      });
      counters.coalesced += members.length;
      replaced.set(members[0], summary);
      for (const event of members.slice(1)) replaced.set(event, null);
    }
    for (const event of plain) {
      if (!replaced.has(event)) out.push(event);
      else if (replaced.get(event)) out.push(replaced.get(event));
    }
  }

  // -------------------------------------------------------------------------
  // Zones and members
  // -------------------------------------------------------------------------

  function createKindState(kind) {
    return {
      kind,
      members: new Map(),
      baselined: false,
      lastAnsweringAtMs: null,
      lastCount: null,
      lastFloor: false,
      series: PRESENCE_KINDS.includes(kind)
        ? createOccupancySeries(occupancyOptions)
        : null,
      busyWindow: [],
      busy: false,
      busyCounters: null,
      capped: false,
    };
  }

  function createZoneState(zone, compiled) {
    const state = {
      id: zone.id,
      zone,
      compiled,
      geometryKey: geometryKeyOf(zone),
      filterKeys: new Map(),
      kinds: new Map(),
      outline: outlineRing(compiled),
      notify: notifyOf(zone),
      lastAlertAtMs: null,
      answerCache: new Map(),
      boxes: new Map(),
    };
    for (const kind of zoneKindsOf(zone)) {
      state.kinds.set(kind, createKindState(kind));
      state.filterKeys.set(kind, filterKeyOf(zone, kind));
    }
    return state;
  }

  function clearMembers(ks) {
    totalMembers -= ks.members.size;
    ks.members.clear();
  }

  function zoneMemberCount(zs) {
    let count = 0;
    for (const ks of zs.kinds.values()) count += ks.members.size;
    return count;
  }

  function canAddMember(zs) {
    return (
      zoneMemberCount(zs) < limits.maxMembersPerZone &&
      totalMembers < limits.maxMembersTotal
    );
  }

  /**
   * A one-degree grid of a frame's asset indexes, built once per frame, so
   * each zone visits only the cells under its padded box.
   */
  function gridOf(frame) {
    let grid = frameGrids.get(frame);
    if (grid) return grid;
    grid = new Map();
    const assets = Array.isArray(frame.assets) ? frame.assets : [];
    for (let i = 0; i < assets.length; i += 1) {
      const lat = finiteOrNull(assets[i]?.lat);
      const lon = finiteOrNull(assets[i]?.lon);
      if (lat === null || lon === null) continue;
      const key = gridKey(Math.floor(lat), Math.floor(lon));
      const cell = grid.get(key);
      if (cell) cell.push(i);
      else grid.set(key, [i]);
    }
    frameGrids.set(frame, grid);
    return grid;
  }

  /**
   * Indexes of the frame's assets that may lie in `box`, in frame order (a
   * superset: `boxContains` and the signed distance still decide).
   */
  function candidateIndexes(frame, box) {
    const assets = Array.isArray(frame.assets) ? frame.assets : [];
    const latFrom = Math.max(-90, Math.floor(box.south));
    const latTo = Math.min(90, Math.floor(box.north));
    const lonCells = box.full ? 360 : Math.min(360, Math.floor(box.span) + 2);
    const cells = Math.max(0, latTo - latFrom + 1) * lonCells;
    if (cells * GRID_SCAN_FACTOR >= assets.length) {
      return assets.map((_, index) => index);
    }
    const grid = gridOf(frame);
    const lonFrom = box.full ? -180 : Math.floor(box.westU);
    const out = [];
    for (let latCell = latFrom; latCell <= latTo; latCell += 1) {
      for (let step = 0; step < lonCells; step += 1) {
        const cell = grid.get(gridKey(latCell, lonFrom + step));
        if (cell) for (const index of cell) out.push(index);
      }
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * One pass of one frame over one zone kind, cached per frame: the assets
   * near the zone (signed distance below the candidate pad, after the
   * zone's own filters) and the keys inside it that count.
   */
  function scanFor(zs, ks, frame) {
    let byKind = frameScans.get(frame);
    if (!byKind) {
      byKind = new Map();
      frameScans.set(frame, byKind);
    }
    let scan = byKind.get(ks);
    if (scan) return scan;
    const kind = ks.kind;
    const margin = PRESENCE_KINDS.includes(kind)
      ? marginM(zs.compiled, kind)
      : 0;
    const insideLimit = insideLimitM(kind, zs.zone);
    const pad = Math.max(limits.bboxPadMargins * margin, insideLimit);
    let box = zs.boxes.get(pad);
    if (!box) {
      box = paddedBox(zs.compiled, pad);
      zs.boxes.set(pad, box);
    }
    const near = [];
    const inside = new Set();
    const assets = Array.isArray(frame.assets) ? frame.assets : [];
    for (const index of candidateIndexes(frame, box)) {
      const asset = assets[index];
      if (!isRecord(asset) || asset.kind !== kind) continue;
      if (typeof asset.key !== 'string' || !asset.key) continue;
      const lat = finiteOrNull(asset.lat);
      const lon = finiteOrNull(asset.lon);
      if (lat === null || lon === null || !boxContains(box, lat, lon)) continue;
      if (
        kind === 'aircraft' &&
        zs.zone?.aircraft?.militaryOnly === true &&
        asset.military !== true
      ) {
        continue;
      }
      const distanceM = signedDistanceM(zs.compiled, lat, lon);
      if (distanceM < pad || distanceM <= insideLimit) {
        near.push({ asset, distanceM });
      }
      if (
        distanceM <= insideLimit &&
        countFilterAccepts(kind, zs.zone, asset)
      ) {
        inside.add(asset.key);
      }
    }
    scan = { margin, near, inside };
    byKind.set(ks, scan);
    return scan;
  }

  /**
   * The zone's answer for a kind (frames.js `zoneAnswer`), with its count
   * taken from the cached scans: distinct keys inside the zone across the
   * layers that answer for it.
   */
  function zoneAnswerFor(zs, kind) {
    const cached = zs.answerCache.get(kind);
    if (cached && cached.version === framesVersion) return cached.answer;
    const answer = zoneAnswer({
      kind,
      zone: zs.zone,
      compiled: zs.compiled,
      frames,
      countAssets: false,
    });
    const ks = zs.kinds.get(kind);
    if (isAnswering(answer) && ks) {
      const keys = new Set();
      for (const layerId of KIND_LAYERS[kind]) {
        const frame = frames.get(layerId);
        if (!frame || !isAnswering(layerAnswer(frame, zs.compiled))) continue;
        for (const key of scanFor(zs, ks, frame).inside) keys.add(key);
      }
      answer.count = keys.size;
    }
    zs.answerCache.set(kind, { version: framesVersion, answer });
    return answer;
  }

  function fixMetaOf(asset) {
    return {
      fixAtMs: timeOrNull(asset.fixAtMs),
      contactAtMs: timeOrNull(asset.contactAtMs),
    };
  }

  function snapshotOf(asset) {
    return {
      key: asset.key,
      kind: asset.kind,
      id: textOrNull(asset.id) ?? asset.key,
      callsign: textOrNull(asset.callsign),
      military: asset.military === true,
      aircraftClass: textOrNull(asset.aircraftClass),
      typeCode: textOrNull(asset.typeCode),
      shipType: textOrNull(asset.shipType),
      label: textOrNull(asset.label) ?? textOrNull(asset.callsign),
    };
  }

  function newWrapper(asset, rec, layerId) {
    const meta = fixMetaOf(asset);
    return {
      key: asset.key,
      rec,
      fixes: new Map([[layerId, meta]]),
      last: meta,
      asset: snapshotOf(asset),
      layerId,
    };
  }

  function pruneMember(ks, key, wrapper, nowMs) {
    const rec = wrapper.rec;
    if (rec.state !== MEMBER_STATE.OUTSIDE) return;
    const exitAtMs = finiteOrNull(rec.lastExitAtMs);
    if (exitAtMs !== null && nowMs - exitAtMs <= reentryQuietMs) return;
    ks.members.delete(key);
    totalMembers -= 1;
  }

  /** Caveats a presence event inherits from its answers. */
  function answerCaveats(frame, la, za) {
    const caveats = [];
    if (la.reason === 'partial-coverage' || za.reason === 'partial-coverage') {
      caveats.push('partial-coverage');
    }
    if (answerOf(frame).reason === 'regional-fallback') {
      caveats.push('regional-fallback');
    }
    return caveats;
  }

  function presenceEvent(type, zs, ks, wrapper, detail, context) {
    const watchlisted = isWatchlisted(wrapper.asset);
    const entry = WATCH_EVENT_CATALOGUE[type];
    let severity = entry.severity;
    if (watchlisted && entry.escalation === 'alert-if-watchlisted') {
      severity = 'alert';
    } else if (watchlisted && entry.escalation === 'notice-if-watchlisted') {
      severity = 'notice';
    }
    const fix = wrapper.rec.lastFix;
    const caveats = [...context.caveats];
    if (type === 'zone-exit' && detail?.dwellLowerBound === true) {
      caveats.push('lower-bound');
    }
    return makeEvent(type, {
      severity,
      atMs: context.nowMs,
      dataAtMs: context.dataAtMs ?? fix?.atMs ?? null,
      zoneId: zs.id,
      assetKey: wrapper.key,
      kind: ks.kind,
      assetId: wrapper.asset.id,
      assetLabel: wrapper.asset.label,
      layerId: wrapper.layerId,
      position: fix,
      params: detail,
      caveats,
      watchlisted,
    });
  }

  function handleTransition(step, zs, ks, wrapper, context, zoneEvents) {
    const detail = step.detail ?? {};
    switch (step.transition) {
      case PRESENCE_TRANSITION.ENTER:
        zoneEvents.push(
          presenceEvent('zone-enter', zs, ks, wrapper, detail, context),
        );
        break;
      case PRESENCE_TRANSITION.EXIT:
        zoneEvents.push(
          presenceEvent('zone-exit', zs, ks, wrapper, detail, context),
        );
        break;
      case PRESENCE_TRANSITION.EXIT_WINDOW:
        zoneEvents.push(
          presenceEvent('zone-exit-window', zs, ks, wrapper, detail, context),
        );
        break;
      default:
        break;
    }
  }

  /** Every member of a kind loses sight under a non-answering answer. */
  function loseAll(ks, state, nowMs, filter = null) {
    for (const [key, wrapper] of ks.members) {
      if (filter && !filter(wrapper)) continue;
      const step = stepMember(
        wrapper.rec,
        {
          kind: ks.kind,
          answer: state,
          nowMs,
          layerId: null,
          fix: null,
          fresh: false,
          distanceM: null,
          marginM: 0,
          seenOutsideBefore: false,
          absentEvidence: false,
        },
        presencePolicy,
      );
      wrapper.rec = step.next;
      pruneMember(ks, key, wrapper, nowMs);
    }
  }

  function baseline(zs, ks, kind, nowMs) {
    clearMembers(ks);
    ks.capped = false;
    for (const layerId of KIND_LAYERS[kind]) {
      const frame = frames.get(layerId);
      if (!frame || !isAnswering(layerAnswer(frame, zs.compiled))) continue;
      for (const { asset, distanceM } of scanFor(zs, ks, frame).near) {
        if (!(distanceM <= 0)) continue;
        const existing = ks.members.get(asset.key);
        if (existing) {
          const meta = fixMetaOf(asset);
          existing.fixes.set(layerId, meta);
          if (!existing.rec.sources.includes(layerId)) {
            existing.rec = {
              ...existing.rec,
              sources: [...existing.rec.sources, layerId],
            };
          }
          if (isFreshFix(existing.last, meta)) existing.last = meta;
          continue;
        }
        if (!canAddMember(zs)) {
          ks.capped = true;
          counters.cappedMembers += 1;
          continue;
        }
        const rec = baselineMember(asset, layerId, nowMs);
        ks.members.set(asset.key, newWrapper(asset, rec, layerId));
        totalMembers += 1;
      }
    }
    ks.baselined = true;
    counters.baselines += 1;
  }

  function busySample(zs, ks, count, nowMs, zoneOut) {
    if (finiteOrNull(count) === null) return;
    ks.busyWindow.push(count);
    while (ks.busyWindow.length > limits.busyWindowSamples) {
      ks.busyWindow.shift();
    }
    if (ks.busyWindow.length < limits.busyWindowSamples) return;
    const med = median(ks.busyWindow);
    if (!ks.busy && med > limits.busyEnterMedian) {
      ks.busy = true;
      ks.busyCounters = {
        sinceMs: nowMs,
        entered: 0,
        exited: 0,
        noLongerReported: 0,
      };
    } else if (ks.busy && med < limits.busyExitMedian) {
      flushBusy(zs, ks, nowMs, zoneOut);
      ks.busy = false;
      ks.busyCounters = null;
    }
  }

  function flushBusy(zs, ks, nowMs, out) {
    const c = ks.busyCounters;
    if (!c) return;
    if (c.entered + c.exited + c.noLongerReported > 0 && zs.notify === 'all') {
      out.push(
        makeEvent('zone-traffic-summary', {
          atMs: nowMs,
          zoneId: zs.id,
          kind: ks.kind,
          // One summary per window: distinct windows never merge.
          dedupeTail: `${ks.kind}:${c.sinceMs}`,
          params: {
            sinceMs: c.sinceMs,
            entered: c.entered,
            exited: c.exited,
            noLongerReported: c.noLongerReported,
            median: median(ks.busyWindow),
          },
        }),
      );
    }
    ks.busyCounters = {
      sinceMs: nowMs,
      entered: 0,
      exited: 0,
      noLongerReported: 0,
    };
  }

  function stepWithFix(zs, ks, kind, existing, asset, distanceM, ctx) {
    const { frame, la, margin, priorFrames, nowMs, zoneEvents } = ctx;
    const layerId = frame.layerId;
    const meta = fixMetaOf(asset);
    const fresh =
      meta.fixAtMs !== null &&
      isFreshFix(existing?.fixes.get(layerId) ?? null, meta) &&
      (!existing?.last || isFreshFix(existing.last, meta));
    // Only the first core-inside fix of an outside member latches whether
    // the asset was seen outside before (presence.js), so only then look.
    const latches =
      fresh &&
      (!existing || existing.rec.state === MEMBER_STATE.OUTSIDE) &&
      distanceM <= -Math.max(0, margin);
    const seenOutsideBefore =
      latches && priorFrames.some((prior) => wasOutside(zs, prior, asset));
    const step = stepMember(
      existing ? existing.rec : initialMember(),
      {
        kind,
        answer: la.state,
        nowMs,
        layerId,
        fix: asset,
        fresh,
        distanceM,
        marginM: margin,
        seenOutsideBefore,
        absentEvidence: false,
      },
      presencePolicy,
    );
    let wrapper = existing;
    if (!wrapper) {
      if (step.next.state === MEMBER_STATE.OUTSIDE) return;
      if (!canAddMember(zs)) {
        ks.capped = true;
        counters.cappedMembers += 1;
        return;
      }
      wrapper = newWrapper(asset, step.next, layerId);
      ks.members.set(asset.key, wrapper);
      totalMembers += 1;
    }
    wrapper.rec = step.next;
    if (fresh) {
      wrapper.fixes.set(layerId, meta);
      wrapper.last = meta;
    }
    wrapper.asset = snapshotOf(asset);
    wrapper.layerId = layerId;
    handleTransition(step, zs, ks, wrapper, ctx.eventContext, zoneEvents);
    pruneMember(ks, asset.key, wrapper, nowMs);
  }

  /**
   * Whether `frame` (this layer's previous answering frame, or the other
   * aircraft layer's latest, each within the re-baseline gap) reported the
   * asset outside the zone.
   */
  function wasOutside(zs, frame, asset) {
    if (!frame) return false;
    const prior = findAsset(frame, asset.key, asset);
    if (!prior) return false;
    return signedDistanceM(zs.compiled, prior.lat, prior.lon) > 0;
  }

  /**
   * Absence is evidence only when every layer that carried the member
   * answers counted for the zone and lacks it (a held source cannot vouch).
   */
  function absentFromEverySource(zs, wrapper, layerId) {
    const sources = wrapper.rec.sources;
    if (!Array.isArray(sources) || !sources.includes(layerId)) return false;
    return sources.every((source) => {
      if (source === layerId) return true;
      const frame = frames.get(source);
      if (!frame || layerAnswer(frame, zs.compiled).state !== COUNTED) {
        return false;
      }
      return !frameHasKey(frame, wrapper.key);
    });
  }

  function presenceStep(zs, kind, frame, { nowMs, newEpoch }, out) {
    const ks = zs.kinds.get(kind);
    const layerId = frame.layerId;
    const za = zoneAnswerFor(zs, kind);
    const answering = isAnswering(za);
    ks.series.record(nowMs, answering ? za.count : null, {
      floor: za.state === FLOOR,
    });
    const zoneEvents = [];
    if (za.state === COUNTED && newEpoch) {
      busySample(zs, ks, za.count, nowMs, out);
    }
    if (!answering) {
      loseAll(ks, za.state, nowMs);
      return;
    }
    const la = layerAnswer(frame, zs.compiled);
    if (!isAnswering(la)) {
      // Another layer still answers for the zone: only members this layer
      // carried, and no answering layer reports, lose sight.
      const others = otherAnsweringFrames(kind, layerId);
      loseAll(
        ks,
        la.state,
        nowMs,
        (wrapper) =>
          wrapper.rec.sources.includes(layerId) &&
          !others.some((other) => frameHasKey(other, wrapper.key)),
      );
      return;
    }
    const gapMs =
      ks.lastAnsweringAtMs === null ? null : nowMs - ks.lastAnsweringAtMs;
    const rebaselineGapMs = perKindRule(
      presencePolicy,
      'rebaselineGapMs',
      kind,
    );
    if (!ks.baselined || (gapMs !== null && gapMs > rebaselineGapMs)) {
      const wasBaselined = ks.baselined;
      const before = ks.lastCount;
      const beforeFloor = ks.lastFloor;
      baseline(zs, ks, kind, nowMs);
      if (
        wasBaselined &&
        gapMs !== null &&
        gapMs >= limits.recheckMinGapMs &&
        before !== null &&
        za.count !== null &&
        before !== za.count
      ) {
        counters.rechecks += 1;
        zoneEvents.push(
          makeEvent('zone-rechecked', {
            atMs: nowMs,
            dataAtMs: frame.epochMs,
            zoneId: zs.id,
            kind,
            layerId,
            params: {
              gapMs,
              before,
              after: za.count,
              beforeFloor,
              afterFloor: za.state === FLOOR,
            },
            // A floor on either side is a lower bound, never an exact count.
            caveats: [
              ...answerCaveats(frame, la, za),
              ...(beforeFloor || za.state === FLOOR ? ['lower-bound'] : []),
            ],
          }),
        );
      }
      ks.lastAnsweringAtMs = nowMs;
      ks.lastCount = za.count;
      ks.lastFloor = za.state === FLOOR;
      emitZoneEvents(zs, ks, zoneEvents, out, { coalesce: false });
      return;
    }

    const scan = scanFor(zs, ks, frame);
    const margin = scan.margin;
    const ctx = {
      frame,
      la,
      margin,
      // Only frames within the re-baseline gap can show an asset outside.
      priorFrames: priorFramesFor(kind, layerId, nowMs, rebaselineGapMs),
      others: otherAnsweringFrames(kind, layerId),
      nowMs,
      zoneEvents,
      eventContext: {
        nowMs,
        dataAtMs: timeOrNull(frame.epochMs),
        caveats: answerCaveats(frame, la, za),
      },
    };
    // Assets near the zone (new candidates and members), then every other
    // member: reported elsewhere in this frame, or absent.
    const handled = new Set();
    for (const { asset, distanceM } of scan.near) {
      if (handled.has(asset.key)) continue;
      handled.add(asset.key);
      const existing = ks.members.get(asset.key) ?? null;
      stepWithFix(zs, ks, kind, existing, asset, distanceM, ctx);
    }
    const evidenceFrame =
      la.state === COUNTED && newEpoch && frame.complete === true;
    for (const [key, wrapper] of [...ks.members]) {
      if (handled.has(key)) continue;
      const asset = findAsset(frame, key, wrapper.rec.lastFix);
      if (asset && acceptsAsset(kind, zs.zone, asset)) {
        const distanceM = signedDistanceM(zs.compiled, asset.lat, asset.lon);
        stepWithFix(zs, ks, kind, wrapper, asset, distanceM, ctx);
        continue;
      }
      if (ctx.others.some((other) => frameHasKey(other, key))) continue;
      const step = stepMember(
        wrapper.rec,
        {
          kind,
          answer: la.state,
          nowMs,
          layerId,
          fix: null,
          fresh: false,
          distanceM: null,
          marginM: margin,
          seenOutsideBefore: false,
          absentEvidence:
            evidenceFrame && absentFromEverySource(zs, wrapper, layerId),
        },
        presencePolicy,
      );
      wrapper.rec = step.next;
      pruneMember(ks, key, wrapper, nowMs);
    }
    ks.lastAnsweringAtMs = nowMs;
    ks.lastCount = za.count;
    ks.lastFloor = za.state === FLOOR;
    emitZoneEvents(zs, ks, zoneEvents, out, {
      coalesce: true,
      nowMs,
      dataAtMs: frame.epochMs,
      layerId,
    });
  }

  function hazardStep(zs, kind, frame, nowMs, out) {
    const za = zoneAnswerFor(zs, kind);
    const transitions = hazards.update({
      zone: zs.zone,
      compiled: zs.compiled,
      kind,
      assets: Array.isArray(frame.assets) ? frame.assets : [],
      answer: za,
      nowMs,
    });
    for (const t of transitions) {
      if (!WATCH_EVENT_CATALOGUE[t.type]) continue;
      if (zs.notify !== 'all') {
        counters.suppressedByNotify += 1;
        continue;
      }
      out.push(
        makeEvent(t.type, {
          severity: t.severity,
          atMs: nowMs,
          dataAtMs: t.dataAtMs,
          zoneId: zs.id,
          assetKey: t.assetKey,
          kind,
          assetId: t.assetId,
          assetLabel: t.assetLabel,
          layerId: t.layerId ?? frame.layerId,
          position: t.position,
          params: t.params,
          caveats: t.caveats,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Feeds
  // -------------------------------------------------------------------------

  function feedStateFor(layerId) {
    let state = feedStates.get(layerId);
    if (!state) {
      state = {
        answered: false,
        badSinceMs: null,
        badEvals: 0,
        paused: false,
        pauseReported: false,
        reason: null,
      };
      feedStates.set(layerId, state);
    }
    return state;
  }

  function feedStep(layerId, kind, frame, nowMs, out) {
    const state = feedStateFor(layerId);
    const answer = answerOf(frame);
    const needed = neededLayers.has(layerId);
    const base = {
      atMs: nowMs,
      dataAtMs: answer.asOfMs,
      kind,
      layerId,
    };
    if (isAnswering(answer)) {
      if (state.paused && state.pauseReported && needed) {
        out.push(
          makeEvent('feed-resumed', {
            ...base,
            params: { pausedMs: Math.max(0, nowMs - state.badSinceMs) },
          }),
        );
      }
      state.answered = true;
      state.badSinceMs = null;
      state.badEvals = 0;
      state.paused = false;
      state.pauseReported = false;
      state.reason = null;
      return;
    }
    if (answer.state === OFF || !state.answered) {
      state.badSinceMs = null;
      state.badEvals = 0;
      state.paused = false;
      state.pauseReported = false;
      state.reason = null;
      return;
    }
    if (state.badSinceMs === null) {
      state.badSinceMs = nowMs;
      state.badEvals = 0;
    }
    state.badEvals += 1;
    state.reason = answer.reason;
    if (
      !state.paused &&
      state.badEvals >= limits.feedPauseEvals &&
      nowMs - state.badSinceMs >= limits.feedPauseMs
    ) {
      state.paused = true;
      if (needed) {
        state.pauseReported = true;
        out.push(
          makeEvent('feed-paused', {
            ...base,
            params: { reason: answer.reason, sinceMs: state.badSinceMs },
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Emergencies
  // -------------------------------------------------------------------------

  function latestAircraftAsset(key, near) {
    for (const layerId of KIND_LAYERS.aircraft) {
      const asset = findAsset(frames.get(layerId), key, near);
      if (asset) return asset;
    }
    return null;
  }

  /** The first zone (document order, notify 'all') holding the aircraft. */
  function memberZoneOf(key) {
    for (const zs of zoneStates.values()) {
      if (zs.notify !== 'all') continue;
      const ks = zs.kinds.get('aircraft');
      const wrapper = ks?.members.get(key);
      if (wrapper && INSIDE_STATES.includes(wrapper.rec.state)) return zs.id;
    }
    return null;
  }

  /**
   * Drops reported keys whose track the tracker forgot or evicted without a
   * transition, so a later episode of the same aircraft starts in scope
   * afresh.
   */
  function pruneReportedEmergencies() {
    if (!reportedEmergencies.size) return;
    const live = new Set(emergency.active().map((track) => track.key));
    for (const key of reportedEmergencies) {
      if (!live.has(key)) reportedEmergencies.delete(key);
    }
  }

  function emergencyEvents(transitions, nowMs, out) {
    for (const t of transitions) {
      if (!isRecord(t) || !WATCH_EVENT_CATALOGUE[t.type]) continue;
      const key = textOrNull(t.key);
      if (!key) continue;
      const asset = latestAircraftAsset(key, t.position) ?? {
        key,
        kind: 'aircraft',
        id: key,
        callsign: null,
        military: false,
      };
      const watchlisted = isWatchlisted(asset);
      const zoneId = memberZoneOf(key);
      const follow = t.type !== EMERGENCY_TRANSITION.START;
      const inScope =
        watchlisted ||
        zoneId !== null ||
        doc.prefs.allEmergencies ||
        (follow && reportedEmergencies.has(key));
      if (!inScope) {
        counters.emergencyOutOfScope += 1;
        // An unreported start means its follow-ups are not reported either.
        if (t.type === EMERGENCY_TRANSITION.START) {
          reportedEmergencies.delete(key);
        }
        continue;
      }
      if (t.type === EMERGENCY_TRANSITION.START) reportedEmergencies.add(key);
      if (
        t.type === EMERGENCY_TRANSITION.END ||
        t.type === EMERGENCY_TRANSITION.UNRESOLVED
      ) {
        reportedEmergencies.delete(key);
      }
      let severity = WATCH_EVENT_CATALOGUE[t.type].severity;
      if (t.type === EMERGENCY_TRANSITION.START && t.onGround === true) {
        severity = 'notice';
      }
      out.push(
        makeEvent(t.type, {
          severity,
          atMs: nowMs,
          dataAtMs: t.lastFixAtMs,
          zoneId,
          assetKey: key,
          kind: 'aircraft',
          assetId: t.icao24 ?? key,
          assetLabel: t.label,
          layerId: t.layerId,
          position: t.position,
          params: t,
          caveats: t.caveats,
          watchlisted,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Watchlist
  // -------------------------------------------------------------------------

  function createRuntime(entry) {
    return {
      entry,
      presence:
        entry.kind === 'satellite'
          ? { ...AWAITING_PRESENCE, layerId: 'satellites' }
          : AWAITING_PRESENCE,
      sinceMs: null,
      lastSeen: entry.declined
        ? null
        : (positionOf(entry.lastSeen) && entry.lastSeen) || null,
      satellite: null,
      epochSig: null,
      declineReported: false,
    };
  }

  function setPresence(rt, presence, nowMs) {
    if (!rt.presence || rt.presence.state !== presence.state) {
      rt.sinceMs = nowMs;
    }
    rt.presence = presence;
  }

  function noteLastSeen(rt, presence) {
    if (rt.entry.kind === 'satellite') return;
    const state = presence.state;
    if (state !== WATCH_PRESENCE.LIVE && state !== WATCH_PRESENCE.STALE_FIX) {
      return;
    }
    const fix = presence.fix;
    const atMs = timeOrNull(fix?.atMs);
    const position = positionOf(fix);
    const layerId = textOrNull(presence.layerId);
    if (atMs === null || !position || !layerId) return;
    if (rt.lastSeen && timeOrNull(rt.lastSeen.atMs) >= atMs) return;
    rt.lastSeen = { atMs, lat: position.lat, lon: position.lon, layerId };
    pendingLastSeen.set(rt.entry.id, rt.lastSeen);
  }

  function noteDeclined(rt, presence) {
    if (rt.entry.declined || rt.declineReported) return;
    const code = textOrNull(presence.reason);
    if (!code) return;
    rt.declineReported = true;
    rt.lastSeen = null;
    pendingLastSeen.delete(rt.entry.id);
    pendingDeclines.set(rt.entry.id, code);
    declineCallbacks.push({ entryId: rt.entry.id, code });
  }

  function watchEvent(rt, presence, tracked, nowMs) {
    const entry = rt.entry;
    const asset = presence.asset;
    const position =
      tracked.type === 'watch-not-reported' ? rt.lastSeen : presence.fix;
    return makeEvent(tracked.type, {
      atMs: nowMs,
      dataAtMs:
        tracked.type === 'watch-not-reported'
          ? tracked.params?.lastSeenAtMs
          : presence.fix?.atMs,
      zoneId: null,
      assetKey: textOrNull(asset?.key) ?? entryAssetKey(entry),
      kind: entry.kind,
      assetId: textOrNull(asset?.id) ?? textOrNull(entry.value),
      assetLabel: textOrNull(entry.label) ?? textOrNull(asset?.label),
      layerId: tracked.layerId,
      position,
      params: tracked.params,
      caveats: tracked.caveats,
      watchlisted: true,
      dedupeTail: `${entry.match}:${entry.value}`,
    });
  }

  /**
   * The latest frames with each presence frame's assets narrowed to those
   * matching a watch entry (cached per frame and watchlist), so resolving
   * fifty entries does not scan every asset fifty times. Answers and
   * coverage are unchanged, so presence resolves exactly as with the full
   * frames.
   */
  function watchFrames() {
    const out = new Map();
    for (const [layerId, frame] of frames) {
      if (
        !WATCH_LAYERS.aircraft.includes(layerId) &&
        !WATCH_LAYERS.vessel.includes(layerId)
      ) {
        out.set(layerId, frame);
        continue;
      }
      let cached = watchFrameCache.get(frame);
      if (!cached || cached.version !== watchVersion) {
        const assets = Array.isArray(frame.assets) ? frame.assets : [];
        const kind = WATCH_SOURCES[layerId]?.kind;
        const matched = watchKinds.has(kind)
          ? assets.filter(
              (asset) =>
                mayMatchWatch(asset) &&
                matchAsset(compiledWatchlist, asset).length > 0,
            )
          : [];
        cached = {
          version: watchVersion,
          frame: { ...frame, assets: matched, keys: null },
        };
        watchFrameCache.set(frame, cached);
      }
      out.set(layerId, cached.frame);
    }
    return out;
  }

  function evaluateEntry(rt, nowMs, out, narrowed) {
    const entry = rt.entry;
    const presence = resolveWatchPresence(entry, {
      nowMs,
      frames: narrowed,
      lastSeen: rt.lastSeen,
      policy: watchPolicy,
    });
    setPresence(rt, presence, nowMs);
    if (presence.state === WATCH_PRESENCE.DECLINED) {
      noteDeclined(rt, presence);
      return;
    }
    noteLastSeen(rt, presence);
    const signature = epochSignature(entry.kind);
    if (
      (presence.state === WATCH_PRESENCE.NOT_REPORTED ||
        presence.state === WATCH_PRESENCE.STALE_FIX) &&
      rt.epochSig === signature
    ) {
      // The same frames are no new absence evidence, and a fix that only
      // aged while no new epoch arrived (a paused feed) is feed state, not
      // the asset going stale.
      return;
    }
    rt.epochSig = signature;
    const tracked = tracker.update(entry.id, presence, {
      nowMs,
      covered: presence.covered === true,
      lastSeenAtMs: timeOrNull(rt.lastSeen?.atMs),
    });
    if (tracked && WATCH_EVENT_CATALOGUE[tracked.type]) {
      out.push(watchEvent(rt, presence, tracked, nowMs));
    }
  }

  function watchStep(kind, nowMs, out) {
    let narrowed = null;
    for (const rt of watchRuntime.values()) {
      if (rt.entry.kind !== kind) continue;
      narrowed = narrowed ?? watchFrames();
      evaluateEntry(rt, nowMs, out, narrowed);
    }
  }

  function flushDeclines() {
    if (!declineCallbacks.length) return;
    const queue = declineCallbacks;
    declineCallbacks = [];
    if (!onDeclined) return;
    for (const { entryId, code } of queue) {
      try {
        onDeclined(entryId, code);
      } catch {
        // A failing callback never breaks the engine.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Document
  // -------------------------------------------------------------------------

  function computeNeededLayers() {
    const needed = new Set();
    for (const zs of zoneStates.values()) {
      for (const kind of zs.kinds.keys()) {
        for (const layerId of KIND_LAYERS[kind] || []) needed.add(layerId);
      }
    }
    for (const rt of watchRuntime.values()) {
      for (const layerId of WATCH_LAYERS[rt.entry.kind] || []) {
        if (SOURCE_LAYERS.includes(layerId)) needed.add(layerId);
      }
    }
    return needed;
  }

  function dropZoneState(zs) {
    for (const ks of zs.kinds.values()) clearMembers(ks);
    hazards.dropZone(zs.id);
  }

  /**
   * Replaces the Watch document. Zones whose geometry changed are rebuilt
   * (every kind re-baselines); a kind whose filters changed re-baselines
   * alone; removed zones and entries drop their state. The document is never
   * mutated.
   *
   * @param {object} nextDoc A Watch document (document.js shape).
   */
  function setDocument(nextDoc) {
    doc = readDocument(nextDoc);
    const nextZones = new Map();
    counters.invalidZones = 0;
    for (const zone of doc.zones) {
      const id = textOrNull(zone.id);
      if (!id || nextZones.has(id)) continue;
      const prev = zoneStates.get(id);
      if (prev && prev.geometryKey === geometryKeyOf(zone)) {
        prev.zone = zone;
        prev.notify = notifyOf(zone);
        const kinds = zoneKindsOf(zone);
        const hazardKinds = (list) =>
          HAZARD_KINDS.filter((kind) => list.includes(kind)).join(',');
        if (hazardKinds([...prev.kinds.keys()]) !== hazardKinds(kinds)) {
          // A hazard kind came or went: its record restarts with a silent
          // baseline (hazards.js keeps no per-kind drop).
          hazards.dropZone(id);
        }
        for (const [kind, ks] of prev.kinds) {
          if (!kinds.includes(kind)) {
            clearMembers(ks);
            prev.kinds.delete(kind);
            prev.filterKeys.delete(kind);
          }
        }
        for (const kind of kinds) {
          const filterKey = filterKeyOf(zone, kind);
          const ks = prev.kinds.get(kind);
          if (!ks || prev.filterKeys.get(kind) !== filterKey) {
            if (ks) clearMembers(ks);
            prev.kinds.set(kind, createKindState(kind));
            prev.filterKeys.set(kind, filterKey);
          }
        }
        prev.kinds = new Map(kinds.map((kind) => [kind, prev.kinds.get(kind)]));
        prev.answerCache.clear();
        nextZones.set(id, prev);
        continue;
      }
      const compiled = compileZone(zone);
      if (!compiled) {
        counters.invalidZones += 1;
        if (prev) dropZoneState(prev);
        continue;
      }
      if (prev) dropZoneState(prev);
      nextZones.set(id, createZoneState(zone, compiled));
    }
    for (const [id, zs] of zoneStates) {
      if (!nextZones.has(id)) dropZoneState(zs);
    }
    zoneStates = nextZones;

    compiledWatchlist = compileWatchlist(doc.watchlist);
    watchVersion += 1;
    watchValues = { icao24: new Set(), callsign: new Set(), mmsi: new Set() };
    for (const key of compiledWatchlist.byValue.keys()) {
      const split = key.indexOf(':');
      const match = key.slice(0, split);
      if (Object.hasOwn(watchValues, match)) {
        watchValues[match].add(key.slice(split + 1));
      }
    }
    watchKinds = new Set(
      doc.watchlist
        .filter(
          (entry) => !entry.declined && compiledWatchlist.entries.has(entry.id),
        )
        .map((entry) => entry.kind),
    );
    const nextRuntime = new Map();
    for (const entry of doc.watchlist) {
      const id = textOrNull(entry.id);
      if (!id || !compiledWatchlist.entries.has(id) || nextRuntime.has(id)) {
        continue;
      }
      const prev = watchRuntime.get(id);
      const same =
        prev &&
        prev.entry.match === entry.match &&
        prev.entry.value === entry.value &&
        Boolean(prev.entry.declined) === Boolean(entry.declined);
      if (same) {
        prev.entry = entry;
        const stored = entry.lastSeen;
        if (
          !entry.declined &&
          positionOf(stored) &&
          timeOrNull(stored.atMs) !== null &&
          (!prev.lastSeen || stored.atMs > prev.lastSeen.atMs)
        ) {
          prev.lastSeen = stored;
        }
        nextRuntime.set(id, prev);
        continue;
      }
      if (prev) tracker.forget(id);
      pendingLastSeen.delete(id);
      pendingDeclines.delete(id);
      const rt = createRuntime(entry);
      if (entry.kind !== 'satellite') {
        setPresence(
          rt,
          resolveWatchPresence(entry, {
            nowMs: lastNowMs,
            frames: watchFrames(),
            lastSeen: rt.lastSeen,
            policy: watchPolicy,
          }),
          lastNowMs,
        );
      } else if (prev?.satellite && !entry.declined) {
        rt.satellite = prev.satellite;
      }
      nextRuntime.set(id, rt);
    }
    for (const id of watchRuntime.keys()) {
      if (!nextRuntime.has(id)) {
        tracker.forget(id);
        pendingLastSeen.delete(id);
        pendingDeclines.delete(id);
      }
    }
    watchRuntime = nextRuntime;
    neededLayers = computeNeededLayers();
  }

  // -------------------------------------------------------------------------
  // Public calls
  // -------------------------------------------------------------------------

  /**
   * Feeds one observation frame (frames.js `buildFrame`). A same-epoch
   * answering frame with an unchanged answer is a no-op: the snapshot, its
   * answer and its data time are those already stored.
   *
   * @param {object} frame
   * @returns {WatchEvent[]}
   */
  function ingest(frame) {
    if (!isRecord(frame)) return [];
    const layerId = frame.layerId;
    if (typeof layerId !== 'string' || !SOURCE_LAYERS.includes(layerId)) {
      return [];
    }
    const nowMs = clock(frame.nowMs ?? frame.epochMs);
    if (nowMs === null) return [];
    const kind = WATCH_SOURCES[layerId].kind;
    counters.ingests += 1;
    const prev = frames.get(layerId) ?? null;
    const epochMs = timeOrNull(frame.epochMs);
    const newEpoch = epochMs !== null && epochMs !== timeOrNull(prev?.epochMs);
    if (isSameEpochNoop(prev, frame)) {
      // Same snapshot, same answer: the stored frame (and its caches) stays.
      counters.noops += 1;
      return [];
    }
    frames.set(layerId, frame);
    frameTimes.set(layerId, nowMs);
    framesVersion += 1;
    const startMs = readClock();

    const feedEvents = [];
    feedStep(layerId, kind, frame, nowMs, feedEvents);
    const transitions = kind === 'aircraft' ? emergency.observe(frame) : [];
    const zoneEvents = [];
    for (const zs of zoneStates.values()) {
      if (!zs.kinds.has(kind)) continue;
      if (HAZARD_KINDS.includes(kind)) {
        hazardStep(zs, kind, frame, nowMs, zoneEvents);
      } else {
        presenceStep(zs, kind, frame, { nowMs, newEpoch }, zoneEvents);
      }
    }
    const emergencyOut = [];
    if (transitions.length) emergencyEvents(transitions, nowMs, emergencyOut);
    if (kind === 'aircraft') pruneReportedEmergencies();
    const watchEvents = [];
    if (PRESENCE_KINDS.includes(kind)) watchStep(kind, nowMs, watchEvents);
    if (isAnswering(answerOf(frame))) {
      prevFrames.set(layerId, { frame, atMs: nowMs });
    }
    const events = finalize([
      ...feedEvents,
      ...emergencyOut,
      ...zoneEvents,
      ...watchEvents,
    ]);
    noteEvalMs(layerId, startMs);
    flushDeclines();
    return events;
  }

  /**
   * A no-longer-reported event needs the zone to answer counted for the
   * kind now, and every layer that carried the member to answer counted for
   * the zone: time while a feed is held or the zone is outside the loaded
   * area is not observed silence.
   */
  function canReportLoss(zs, kind, rec) {
    if (zoneAnswerFor(zs, kind).state !== COUNTED) return false;
    const sources = Array.isArray(rec.sources) ? rec.sources : [];
    return sources.every((source) => {
      const frame = frames.get(source);
      return (
        Boolean(frame) && layerAnswer(frame, zs.compiled).state === COUNTED
      );
    });
  }

  /**
   * Whether a deferred no-longer-reported has waited
   * {@link LOSS_DEFER_FACTOR} expiry times, so the member expires silently.
   */
  function lossDeferralOver(rec, kind, nowMs) {
    const sinceMs =
      finiteOrNull(rec.unknownSinceMs) ?? finiteOrNull(rec.lastFix?.atMs);
    const expireMs = perKindRule(presencePolicy, 'unknownExpireMs', kind);
    return sinceMs === null || nowMs - sinceMs >= LOSS_DEFER_FACTOR * expireMs;
  }

  /**
   * Advances time: expires unknown members (`zone-no-longer-reported` only
   * with counted absence evidence, while the zone and every layer that
   * carried the member answer counted; otherwise the event waits for such an
   * answer, and after {@link LOSS_DEFER_FACTOR} expiry times the member
   * expires silently), flushes busy summaries and re-evaluates watched
   * assets (a not-reported state needs a new epoch to count again).
   *
   * @param {number} nowMs
   * @returns {WatchEvent[]}
   */
  function tick(nowMs) {
    const now = clock(nowMs);
    if (now === null) return [];
    counters.ticks += 1;
    const zoneOut = [];
    for (const zs of zoneStates.values()) {
      for (const [kind, ks] of zs.kinds) {
        if (!PRESENCE_KINDS.includes(kind)) continue;
        const zoneEvents = [];
        for (const [key, wrapper] of ks.members) {
          if (wrapper.rec.state !== MEMBER_STATE.UNKNOWN) {
            pruneMember(ks, key, wrapper, now);
            continue;
          }
          const step = expireMember(
            wrapper.rec,
            { nowMs: now, kind },
            presencePolicy,
          );
          const before = wrapper.rec;
          const lost =
            step.transition === PRESENCE_TRANSITION.NO_LONGER_REPORTED;
          const reportable = lost && canReportLoss(zs, kind, before);
          if (lost && !reportable && !lossDeferralOver(before, kind, now)) {
            // Deferred until the zone and its sources can answer again.
            continue;
          }
          wrapper.rec = step.next;
          if (reportable) {
            const detail = step.detail ?? {};
            zoneEvents.push(
              presenceEvent(
                'zone-no-longer-reported',
                zs,
                ks,
                { ...wrapper, rec: before },
                detail,
                {
                  nowMs: now,
                  dataAtMs: detail.lastFixAtMs,
                  caveats: [],
                },
              ),
            );
          }
          pruneMember(ks, key, wrapper, now);
        }
        emitZoneEvents(zs, ks, zoneEvents, zoneOut, { coalesce: false });
        if (
          ks.busy &&
          ks.busyCounters &&
          now - ks.busyCounters.sinceMs >= limits.busySummaryMs
        ) {
          flushBusy(zs, ks, now, zoneOut);
        }
      }
    }
    const watchEvents = [];
    let narrowed = null;
    for (const rt of watchRuntime.values()) {
      if (rt.entry.kind === 'satellite') continue;
      narrowed = narrowed ?? watchFrames();
      evaluateEntry(rt, now, watchEvents, narrowed);
    }
    const events = finalize([...zoneOut, ...watchEvents]);
    flushDeclines();
    return events;
  }

  function satelliteLookups(rows) {
    const map = new Map();
    const add = (norad, row) => {
      const id = textOrNull(norad);
      if (id && isRecord(row)) map.set(String(Number(id)), row);
    };
    if (rows instanceof Map) {
      for (const [norad, row] of rows) add(norad, row);
    } else if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!isRecord(row)) continue;
        add(row.norad ?? row.value ?? row.result?.noradId, row);
      }
    } else if (isRecord(rows)) {
      for (const [norad, row] of Object.entries(rows)) add(norad, row);
    }
    return map;
  }

  /**
   * Stores the controller's satellite lookups (one per NORAD id:
   * `{norad, enabled, ready, complete, unavailable, result, atMs}`, as an
   * array, a Map or an object keyed by NORAD id) and re-resolves watched
   * satellites. Computed positions are never observations: no events and no
   * last-seen writes.
   *
   * @param {object[]|Map<string, object>|Object<string, object>} rows
   * @param {number} nowMs
   * @returns {WatchEvent[]} always empty in v1 (no satellite event types).
   */
  function setSatellites(rows, nowMs) {
    const now = clock(nowMs);
    const lookups = satelliteLookups(rows);
    for (const rt of watchRuntime.values()) {
      if (rt.entry.kind !== 'satellite') continue;
      const lookup = lookups.get(String(Number(rt.entry.value)));
      if (lookup) rt.satellite = lookup;
      if (!rt.satellite && !rt.entry.declined) continue;
      setPresence(
        rt,
        resolveWatchPresence(rt.entry, {
          nowMs: now,
          satellite: rt.satellite,
          policy: watchPolicy,
        }),
        now,
      );
    }
    return finalize([]);
  }

  function memberIndex() {
    const byKey = new Map();
    const byCallsign = new Map();
    for (const zs of zoneStates.values()) {
      for (const [kind, ks] of zs.kinds) {
        if (!PRESENCE_KINDS.includes(kind)) continue;
        for (const wrapper of ks.members.values()) {
          if (!INSIDE_STATES.includes(wrapper.rec.state)) continue;
          const item = { zoneId: zs.id, kind, wrapper };
          const keyList = byKey.get(`${kind}:${wrapper.key}`) ?? [];
          keyList.push(item);
          byKey.set(`${kind}:${wrapper.key}`, keyList);
          const callsign = normalizeCallsign(wrapper.asset.callsign);
          if (kind === 'aircraft' && callsign) {
            const list = byCallsign.get(callsign) ?? [];
            list.push(item);
            byCallsign.set(callsign, list);
          }
        }
      }
    }
    return { byKey, byCallsign };
  }

  function entryMembers(entry, index) {
    if (entry.kind === 'satellite' || entry.declined) return [];
    if (entry.match === 'callsign') {
      return index.byCallsign.get(normalizeCallsign(entry.value)) ?? [];
    }
    const key = entryAssetKey(entry);
    return key ? (index.byKey.get(`${entry.kind}:${key}`) ?? []) : [];
  }

  /**
   * The zone members a watch entry follows: none while the guard cannot
   * judge the aircraft yet (presence reason 'class-unknown').
   */
  function followedMembers(rt, index) {
    if (rt.presence?.reason === 'class-unknown') return [];
    return entryMembers(rt.entry, index);
  }

  function watchRow(rt, index) {
    const entry = rt.entry;
    const presence = rt.presence ?? AWAITING_PRESENCE;
    const members = followedMembers(rt, index);
    const zoneIds = [];
    for (const item of members) {
      if (!zoneIds.includes(item.zoneId)) zoneIds.push(item.zoneId);
    }
    const lastSeen = rt.lastSeen
      ? {
          atMs: rt.lastSeen.atMs,
          lat: rt.lastSeen.lat,
          lon: rt.lastSeen.lon,
          layerId: rt.lastSeen.layerId,
        }
      : null;
    return {
      entryId: entry.id,
      kind: entry.kind,
      match: entry.match,
      value: entry.value,
      label: textOrNull(entry.label),
      presence: { state: presence.state, reason: presence.reason ?? null },
      fix: presence.fix
        ? {
            lat: presence.fix.lat,
            lon: presence.fix.lon,
            atMs: timeOrNull(presence.fix.atMs),
            altM: finiteOrNull(presence.fix.altM),
            onGround: boolOrNull(presence.fix.onGround),
            vRateMps: finiteOrNull(presence.fix.vRateMps),
          }
        : null,
      layerId: textOrNull(presence.layerId),
      zoneIds,
      matches: finiteOrNull(presence.matches) ?? 0,
      lastSeen,
      sinceMs: timeOrNull(rt.sinceMs),
    };
  }

  function confirmedEmergencyKeys() {
    const keys = new Set();
    for (const item of emergency.active()) {
      if (ACTIVE_EMERGENCY_PHASES.includes(item.phase)) keys.add(item.key);
    }
    return keys;
  }

  /** Longest present first (earliest entry), then asset key. */
  function compareOccupants(a, b) {
    const at = a.enteredAtMs ?? Number.POSITIVE_INFINITY;
    const bt = b.enteredAtMs ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0;
  }

  /** Keeps the `occupantsShown` longest-present occupants, sorted. */
  function keepLongest(list, occupant) {
    const max = limits.occupantsShown;
    if (max <= 0) return;
    if (list.length >= max && compareOccupants(occupant, list[max - 1]) >= 0) {
      return;
    }
    let i = list.length;
    while (i > 0 && compareOccupants(occupant, list[i - 1]) < 0) i -= 1;
    list.splice(i, 0, occupant);
    if (list.length > max) list.length = max;
  }

  function zoneView(zs, nowMs, emergencyKeys) {
    const zone = zs.zone;
    const kinds = [...zs.kinds.keys()];
    const perKind = {};
    const series = {};
    const occupants = [];
    let timed = false;
    let capped = false;
    let alert =
      zs.lastAlertAtMs !== null &&
      nowMs !== null &&
      nowMs - zs.lastAlertAtMs < limits.alertHoldMs;
    for (const [kind, ks] of zs.kinds) {
      const za = zoneAnswerFor(zs, kind);
      const answering = isAnswering(za);
      perKind[kind] = {
        answer: za.state,
        reason: za.reason ?? null,
        count: answering ? finiteOrNull(za.count) : null,
        floor: za.state === FLOOR,
        asOfMs: timeOrNull(za.asOfMs),
        busy: ks.busy === true,
      };
      if (!PRESENCE_KINDS.includes(kind)) continue;
      series[kind] = ks.series.summary(nowMs ?? undefined);
      if (ks.baselined) timed = true;
      if (ks.capped) capped = true;
      for (const wrapper of ks.members.values()) {
        if (!INSIDE_STATES.includes(wrapper.rec.state)) continue;
        if (kind === 'aircraft' && emergencyKeys.has(wrapper.key)) {
          alert = true;
        }
        keepLongest(occupants, {
          assetKey: wrapper.key,
          label: wrapper.asset.label,
          kind,
          enteredAtMs: timeOrNull(wrapper.rec.enteredAtMs),
          lowerBound: wrapper.rec.enteredLowerBound === true,
        });
      }
    }
    return {
      id: zs.id,
      name: textOrNull(zone.name),
      shape: zs.compiled.shape,
      kinds,
      notify: zs.notify,
      alert,
      labelAnchor: {
        lat: zs.compiled.labelAnchor.lat,
        lon: zs.compiled.labelAnchor.lon,
      },
      outline: zs.outline.map(([lon, lat]) => [lon, lat]),
      perKind,
      occupants: occupants.slice(0, limits.occupantsShown),
      timed,
      capped,
      series,
    };
  }

  function feedsView() {
    const feeds = {};
    for (const layerId of SOURCE_LAYERS) {
      const frame = frames.get(layerId);
      const answer = frame
        ? answerOf(frame)
        : { state: UNKNOWN, reason: 'never-answered', asOfMs: null };
      feeds[layerId] = {
        answer: answer.state,
        reason: answer.reason,
        asOfMs: answer.asOfMs,
        paused: feedStates.get(layerId)?.paused === true,
      };
    }
    return feeds;
  }

  /**
   * The JSON-safe view for the panel, the renderer and the brief.
   *
   * @param {number} [nowMs] Defaults to the latest engine time.
   * @returns {WatchView}
   */
  function view(nowMs) {
    const now = timeOrNull(nowMs) ?? lastNowMs;
    const emergencyKeys = confirmedEmergencyKeys();
    const index = memberIndex();
    return {
      generatedAtMs: now,
      zones: [...zoneStates.values()].map((zs) =>
        zoneView(zs, now, emergencyKeys),
      ),
      watchlist: [...watchRuntime.values()].map((rt) => watchRow(rt, index)),
      emergencies: emergency
        .active()
        .filter((item) => VIEW_EMERGENCY_PHASES.includes(item.phase)),
      feeds: feedsView(),
    };
  }

  /**
   * The place brief of one zone (brief.js `buildPlaceBrief`) from the
   * engine's latest frames, zone view, watched assets inside and series.
   *
   * @param {string} zoneId
   * @param {{nowMs?: number, recentEvents?: object[]}} [options]
   * @returns {object|null} null for an unknown zone.
   */
  function brief(zoneId, options = {}) {
    const zs = zoneStates.get(zoneId);
    if (!zs) return null;
    const o = isRecord(options) ? options : {};
    const now = timeOrNull(o.nowMs) ?? lastNowMs;
    const index = memberIndex();
    const watchInside = [];
    for (const rt of watchRuntime.values()) {
      const members = followedMembers(rt, index).filter(
        (item) => item.zoneId === zs.id,
      );
      if (!members.length) continue;
      const row = watchRow(rt, index);
      const rec = members[0].wrapper.rec;
      watchInside.push({
        ...row,
        enteredAtMs: timeOrNull(rec.enteredAtMs),
        lowerBound: rec.enteredLowerBound === true,
      });
    }
    const series = {};
    for (const [kind, ks] of zs.kinds) {
      if (ks.series) series[kind] = ks.series;
    }
    return buildPlaceBrief({
      zone: zs.zone,
      compiled: zs.compiled,
      frames,
      zoneView: zoneView(zs, now, confirmedEmergencyKeys()),
      watchInside,
      recentEvents: Array.isArray(o.recentEvents) ? o.recentEvents : [],
      series,
      nowMs: now,
    });
  }

  /**
   * Last-seen fixes that changed since the previous call (drained).
   *
   * @returns {Array<{entryId: string, lastSeen: {atMs: number, lat: number,
   *   lon: number, layerId: string}}>}
   */
  function lastSeenUpdates() {
    const out = [];
    for (const [entryId, lastSeen] of pendingLastSeen) {
      out.push({ entryId, lastSeen: { ...lastSeen } });
    }
    pendingLastSeen = new Map();
    return out;
  }

  /**
   * Privacy-guard declines not yet in the document (drained).
   *
   * @returns {Array<{entryId: string, code: string}>}
   */
  function declinedUpdates() {
    const out = [];
    for (const [entryId, code] of pendingDeclines) out.push({ entryId, code });
    pendingDeclines = new Map();
    return out;
  }

  /**
   * Counters and sizes for debugging (JSON-safe).
   *
   * @returns {object}
   */
  function diagnostics() {
    let busyZones = 0;
    let cappedZones = 0;
    for (const zs of zoneStates.values()) {
      let busy = false;
      let capped = false;
      for (const ks of zs.kinds.values()) {
        busy = busy || ks.busy;
        capped = capped || ks.capped;
      }
      if (busy) busyZones += 1;
      if (capped) cappedZones += 1;
    }
    const layers = {};
    for (const [layerId, frame] of frames) {
      layers[layerId] = {
        epochMs: timeOrNull(frame.epochMs),
        answer: answerOf(frame).state,
        assets: Array.isArray(frame.assets) ? frame.assets.length : 0,
      };
    }
    return {
      ...counters,
      zones: zoneStates.size,
      watchEntries: watchRuntime.size,
      members: totalMembers,
      busyZones,
      cappedZones,
      lastNowMs,
      seq,
      layers,
      evalMsByLayer: Object.fromEntries(
        [...evalMs].map(([layerId, entry]) => [layerId, { ...entry }]),
      ),
      emergency: emergency.diagnostics(),
      hazards: hazards.diagnostics(),
    };
  }

  /**
   * Forgets every frame, member, track and counter but keeps the document,
   * so the next frames baseline silently. Event sequence numbers keep
   * growing, so ids never repeat within a session.
   */
  function reset() {
    frames = new Map();
    framesVersion += 1;
    frameTimes = new Map();
    prevFrames = new Map();
    feedStates = new Map();
    reportedEmergencies = new Set();
    pendingLastSeen = new Map();
    pendingDeclines = new Map();
    declineCallbacks = [];
    assetMaps = new WeakMap();
    frameScans = new WeakMap();
    frameGrids = new WeakMap();
    watchFrameCache = new WeakMap();
    emergency.reset();
    hazards.reset();
    tracker = createWatchTracker(watchPolicy);
    counters = freshCounters();
    evalMs = new Map();
    lastNowMs = null;
    const current = { ...doc };
    zoneStates = new Map();
    watchRuntime = new Map();
    totalMembers = 0;
    setDocument(current);
  }

  return Object.freeze({
    setDocument,
    ingest,
    setSatellites,
    tick,
    view,
    brief,
    lastSeenUpdates,
    declinedUpdates,
    diagnostics,
    reset,
  });
}
