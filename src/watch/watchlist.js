/**
 * Watched assets for Watch: which watch entry an observed asset belongs to,
 * the privacy guard that declines private aircraft and pleasure craft, an
 * honest presence state for every entry, and a debounced tracker that turns
 * presence changes into watch events.
 *
 * Only asset identifiers travel through this module (ICAO24, exact callsign,
 * MMSI, NORAD id). It never reads or emits owner, registrant or person
 * fields.
 *
 * Presence is resolved from the latest observation frame of every layer that
 * can report the entry's kind ({@link WATCH_LAYERS}). The rules, best first:
 *
 * 1. `live`: a matching asset is in an answering (counted or floor) frame and
 *    its fix is at most `freshFixMs` old.
 * 2. `stale-fix`: a matching asset is reported, but its fix is older (or has
 *    no time).
 * 3. `not-reported`: every layer of the kind is enabled and counted, and each
 *    layer's coverage is global or contains the last-seen position. Only here
 *    is absence evidence.
 * 4. `outside-coverage`: a regional coverage does not contain the last
 *    position (or there is no last position and a regional layer answered).
 * 5. `feed-off`, `feed-unavailable`, `feed-stale`: the worst layer wins (off,
 *    then unknown, then held).
 * 6. `checking`: nothing above decides yet (a layer has not reported a frame,
 *    a coverage is unknown, or a layer answered only a floor).
 *
 * A declined entry, or a match the guard declines, resolves to `declined`
 * and never carries a position. Satellites resolve to `computed`,
 * `not-in-catalog`, `checking` (catalog not loaded) or `feed-off` from a
 * lookup the controller made, and the NORAD id is re-checked here.
 *
 * Pure module: no platform globals, timers, storage or clocks. Times come in
 * through `nowMs`, the frames and the fixes.
 */
import { coverageContainsPoint } from './geometry.js';
import { normalizeVesselType } from '../data/vesselTypes.js';

/**
 * Watchlist thresholds.
 *
 * - `confirmEvals` and `confirmMs`: a non-live state (and `not-reported` in
 *   particular) must hold for this many evaluations and this long before it
 *   counts.
 * - `reappearAfterMs` and `coveredShare`: a return after a not-reported event
 *   is a reappearance when the absence lasted this long and at least this
 *   share of it was covered unseen time.
 * - `freshFixMs`: the oldest fix that still reads as live, per kind.
 * - `declinedAircraftClasses` and `declinedVesselTypes`: the privacy guard
 *   (civil aircraft classes and normalized AIS types the watchlist declines
 *   to follow). This is the one rule a maintainer decides.
 * - `satellitePollMs`: how often the controller looks up watched satellites.
 *
 * @type {Readonly<{confirmEvals: number, confirmMs: number,
 *   reappearAfterMs: number, coveredShare: number,
 *   freshFixMs: Readonly<{aircraft: number, vessel: number}>,
 *   declinedAircraftClasses: ReadonlyArray<string>,
 *   declinedVesselTypes: ReadonlyArray<string>,
 *   satellitePollMs: number}>}
 */
export const WATCHLIST_POLICY = Object.freeze({
  confirmEvals: 2,
  confirmMs: 45_000,
  reappearAfterMs: 1_200_000,
  coveredShare: 0.8,
  freshFixMs: Object.freeze({ aircraft: 120_000, vessel: 900_000 }),
  declinedAircraftClasses: Object.freeze(['light', 'glider', 'bizjet']),
  declinedVesselTypes: Object.freeze(['SAILING', 'PLEASURE']),
  satellitePollMs: 30_000,
});

/**
 * Presence states of a watch entry.
 * @type {Readonly<{CHECKING: 'checking', LIVE: 'live',
 *   STALE_FIX: 'stale-fix', FEED_STALE: 'feed-stale',
 *   NOT_REPORTED: 'not-reported', OUTSIDE_COVERAGE: 'outside-coverage',
 *   FEED_OFF: 'feed-off', FEED_UNAVAILABLE: 'feed-unavailable',
 *   COMPUTED: 'computed', NOT_IN_CATALOG: 'not-in-catalog',
 *   DECLINED: 'declined'}>}
 */
export const WATCH_PRESENCE = Object.freeze({
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
});

/**
 * Layers that can report each watched kind. Aircraft list military first,
 * so a tie between layers prefers the military copy.
 * @type {Readonly<{aircraft: ReadonlyArray<string>,
 *   vessel: ReadonlyArray<string>, satellite: ReadonlyArray<string>}>}
 */
export const WATCH_LAYERS = Object.freeze({
  aircraft: Object.freeze(['military', 'flights']),
  vessel: Object.freeze(['ais-live-vessels']),
  satellite: Object.freeze(['satellites']),
});

/**
 * Event types the tracker emits.
 * @type {Readonly<{SEEN: 'watch-seen', NOT_REPORTED: 'watch-not-reported',
 *   REAPPEARED: 'watch-reappeared'}>}
 */
export const WATCH_EVENT_TYPES = Object.freeze({
  SEEN: 'watch-seen',
  NOT_REPORTED: 'watch-not-reported',
  REAPPEARED: 'watch-reappeared',
});

/**
 * @typedef {{id: string, kind: 'aircraft'|'vessel'|'satellite',
 *   match: 'icao24'|'callsign'|'mmsi'|'norad', value: string,
 *   label?: string|null, declined?: string|null,
 *   lastSeen?: {atMs: number, lat: number, lon: number,
 *     layerId: string}|null}} WatchEntryInput
 *   A stored watch entry (see document.js).
 */

/**
 * @typedef {{byValue: Map<string, string[]>,
 *   entries: Map<string, WatchEntryInput>}} CompiledWatchlist
 *   `byValue` keys are `<match>:<normalized value>`; declined entries are in
 *   `entries` but never in `byValue`.
 */

/**
 * @typedef {{lat: number, lon: number, atMs: number|null,
 *   altM: number|null, onGround: boolean|null,
 *   vRateMps: number|null}} WatchFix
 */

/**
 * @typedef {{state: string, reason: string|null, fix: WatchFix|null,
 *   layerId: string|null, matches: number, asset: object|null,
 *   covered: boolean}} WatchPresence
 *   `layerId` is the layer of the fix, or the layer that decided a non-live
 *   state (null when every layer decided). `covered` is true when every
 *   layer of the kind is counted and its coverage is global or contains the
 *   reference position (the fix, or else the last-seen position).
 */

/**
 * @typedef {{enabled: boolean, ready?: boolean,
 *   result: {noradId: number|string, name?: string,
 *     latitude?: number, longitude?: number, lat?: number, lon?: number,
 *     altitudeM?: number}|null,
 *   atMs?: number|null}} SatelliteLookup
 *   The controller's lookup for one NORAD id: whether the satellites layer is
 *   enabled, whether its catalog has loaded (`ready: false` reads as
 *   checking), the plain fields of `findByQuery(String(norad))` (or null),
 *   and when the position was propagated.
 */

/**
 * @typedef {{type: 'watch-seen'|'watch-not-reported'|'watch-reappeared',
 *   entryId: string, atMs: number, layerId: string|null,
 *   params: object, caveats: string[]}} WatchTrackerEvent
 *   Params: watch-seen `{layerId}`; watch-not-reported `{lastSeenAtMs}`;
 *   watch-reappeared `{absentMs, coveredShare}`. The only caveat is
 *   'coverage-incomplete' (watch-seen).
 */

const ANSWER_COUNTED = 'counted';
const ANSWER_FLOOR = 'floor';
const ANSWER_HELD = 'held';
const ANSWER_UNKNOWN = 'unknown';
const ANSWER_OFF = 'off';
const ANSWER_STATES = Object.freeze([
  ANSWER_COUNTED,
  ANSWER_FLOOR,
  ANSWER_HELD,
  ANSWER_UNKNOWN,
  ANSWER_OFF,
]);
const ANSWERING = Object.freeze([ANSWER_COUNTED, ANSWER_FLOOR]);

/** Feed failure ranks (higher is worse) and the presence each one reads. */
const FEED_FAILURE = Object.freeze({
  [ANSWER_OFF]: Object.freeze({
    rank: 3,
    state: WATCH_PRESENCE.FEED_OFF,
    reason: 'feed-off',
  }),
  [ANSWER_UNKNOWN]: Object.freeze({
    rank: 2,
    state: WATCH_PRESENCE.FEED_UNAVAILABLE,
    reason: 'feed-unavailable',
  }),
  [ANSWER_HELD]: Object.freeze({
    rank: 1,
    state: WATCH_PRESENCE.FEED_STALE,
    reason: 'feed-stale',
  }),
});

const MATCH_KIND = Object.freeze({
  icao24: 'aircraft',
  callsign: 'aircraft',
  mmsi: 'vessel',
  norad: 'satellite',
});

const DECLINE_AIRCRAFT = 'private-aircraft-class';
const DECLINE_VESSEL = 'private-vessel-type';
const SATELLITE_LAYER = 'satellites';
const CAVEAT_COVERAGE = 'coverage-incomplete';
const MAX_VALUE_CHARS = 32;
const PRESENCE_STATES = Object.freeze(Object.values(WATCH_PRESENCE));

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
  return typeof value === 'boolean' ? value : null;
}

function validPoint(lat, lon) {
  return (
    lat !== null &&
    lon !== null &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** Normalized identifier for a match type, or null. */
function normalizeValue(match, value) {
  const text = textOrNull(value);
  if (!text || text.length > MAX_VALUE_CHARS) return null;
  if (match === 'icao24') return text.toLowerCase();
  if (match === 'callsign') return text.toUpperCase().replace(/\s+/g, '');
  if (match === 'mmsi') return text;
  if (match === 'norad') {
    if (!/^[0-9]{1,12}$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? String(number) : null;
  }
  return null;
}

/** The fields of a stored entry this module uses, or null when invalid. */
function readEntry(entry) {
  if (!isRecord(entry)) return null;
  const id = textOrNull(entry.id);
  const match = typeof entry.match === 'string' ? entry.match : null;
  const kind = match ? MATCH_KIND[match] : undefined;
  if (!id || !kind || (entry.kind !== undefined && entry.kind !== kind)) {
    return null;
  }
  const value = normalizeValue(match, entry.value);
  if (!value) return null;
  return {
    id,
    kind,
    match,
    value,
    declined: textOrNull(entry.declined),
  };
}

function valueKey(match, value) {
  return `${match}:${value}`;
}

/** Index keys an observed asset can match, in entry-order-neutral form. */
function assetValueKeys(asset) {
  if (!isRecord(asset)) return [];
  if (asset.kind === 'aircraft') {
    const keys = [];
    const icao24 = normalizeValue('icao24', asset.id ?? asset.key);
    if (icao24) keys.push(valueKey('icao24', icao24));
    const callsign = normalizeValue('callsign', asset.callsign);
    if (callsign) keys.push(valueKey('callsign', callsign));
    return keys;
  }
  if (asset.kind === 'vessel') {
    const mmsi = normalizeValue('mmsi', asset.id ?? asset.key);
    return mmsi ? [valueKey('mmsi', mmsi)] : [];
  }
  return [];
}

function entryMatchesAsset(entry, asset) {
  if (!isRecord(asset) || asset.kind !== entry.kind) return false;
  return assetValueKeys(asset).includes(valueKey(entry.match, entry.value));
}

function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function textListOr(value, fallback) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : fallback;
}

/** A complete policy: valid overrides on top of {@link WATCHLIST_POLICY}. */
function mergePolicy(policy) {
  const base = WATCHLIST_POLICY;
  if (!isRecord(policy) || policy === base) return base;
  const fresh = isRecord(policy.freshFixMs) ? policy.freshFixMs : {};
  const share = finiteOrNull(policy.coveredShare);
  return {
    confirmEvals: Math.max(
      1,
      Math.floor(positiveOr(policy.confirmEvals, base.confirmEvals)),
    ),
    confirmMs:
      finiteOrNull(policy.confirmMs) !== null && policy.confirmMs >= 0
        ? policy.confirmMs
        : base.confirmMs,
    reappearAfterMs: positiveOr(policy.reappearAfterMs, base.reappearAfterMs),
    coveredShare:
      share !== null && share >= 0 && share <= 1 ? share : base.coveredShare,
    freshFixMs: {
      aircraft: positiveOr(fresh.aircraft, base.freshFixMs.aircraft),
      vessel: positiveOr(fresh.vessel, base.freshFixMs.vessel),
    },
    declinedAircraftClasses: textListOr(
      policy.declinedAircraftClasses,
      base.declinedAircraftClasses,
    ),
    declinedVesselTypes: textListOr(
      policy.declinedVesselTypes,
      base.declinedVesselTypes,
    ),
    satellitePollMs: positiveOr(policy.satellitePollMs, base.satellitePollMs),
  };
}

/** The latest frame of a layer from a Map, a keyed object or an array. */
function frameFor(frames, layerId) {
  let frame = null;
  if (frames instanceof Map) {
    frame = frames.get(layerId);
  } else if (Array.isArray(frames)) {
    for (const item of frames) {
      if (isRecord(item) && item.layerId === layerId) frame = item;
    }
  } else if (isRecord(frames) && Object.hasOwn(frames, layerId)) {
    frame = frames[layerId];
  }
  return isRecord(frame) ? frame : null;
}

function answerOf(frame) {
  const answer = isRecord(frame?.answer) ? frame.answer : null;
  const state = ANSWER_STATES.includes(answer?.state)
    ? answer.state
    : ANSWER_UNKNOWN;
  return { state, reason: textOrNull(answer?.reason) };
}

function assetsOf(frame) {
  return Array.isArray(frame?.assets) ? frame.assets : [];
}

/** Fix time of an asset: its own fix time, else its contact time. */
function fixTimeOf(asset) {
  return timeOrNull(asset.fixAtMs) ?? timeOrNull(asset.contactAtMs);
}

function fixOf(asset, atMs) {
  return {
    lat: asset.lat,
    lon: asset.lon,
    atMs,
    altM: finiteOrNull(asset.altM),
    onGround: boolOrNull(asset.onGround),
    vRateMps: finiteOrNull(asset.vRateMps),
  };
}

function lastSeenPoint(lastSeen) {
  if (!isRecord(lastSeen)) return null;
  const lat = finiteOrNull(lastSeen.lat);
  const lon = finiteOrNull(lastSeen.lon);
  return validPoint(lat, lon) ? { lat, lon } : null;
}

function isGlobal(coverage) {
  return isRecord(coverage) && coverage.kind === 'global';
}

function isRegional(coverage) {
  return isRecord(coverage) && coverage.kind === 'circle';
}

/** Every layer counted, with global coverage or coverage over `point`. */
function coveredFor(views, point) {
  return views.every(({ frame, answer }) => {
    if (!frame || answer.state !== ANSWER_COUNTED) return false;
    if (isGlobal(frame.coverage)) return true;
    if (!point) return false;
    return coverageContainsPoint(frame.coverage, point.lat, point.lon) === true;
  });
}

function presence(state, reason, extra = {}) {
  return {
    state,
    reason: reason ?? null,
    fix: extra.fix ?? null,
    layerId: extra.layerId ?? null,
    matches: extra.matches ?? 0,
    asset: extra.asset ?? null,
    covered: extra.covered === true,
  };
}

function vesselTypeDeclined(shipType, declinedTypes) {
  const type = normalizeVesselType(textOrNull(shipType) ?? '').toUpperCase();
  if (!type) return false;
  const padded = ` ${type.replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  return declinedTypes.some((declined) => {
    const token = String(declined).toUpperCase().trim();
    return token !== '' && (type === token || padded.includes(` ${token} `));
  });
}

/**
 * Builds the lookup index of a watchlist. Invalid entries (unknown match,
 * kind mismatch, empty or malformed value, no id) and repeated ids are
 * skipped. Declined entries stay in `entries` (they resolve to declined) but
 * never match an asset.
 *
 * @param {WatchEntryInput[]|null|undefined} entries The document watchlist.
 * @returns {CompiledWatchlist}
 */
export function compileWatchlist(entries) {
  const byValue = new Map();
  const byId = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = readEntry(raw);
    if (!entry || byId.has(entry.id)) continue;
    byId.set(entry.id, raw);
    if (entry.declined) continue;
    const key = valueKey(entry.match, entry.value);
    const ids = byValue.get(key);
    if (ids) ids.push(entry.id);
    else byValue.set(key, [entry.id]);
  }
  return { byValue, entries: byId };
}

/**
 * Entry ids an observed asset belongs to. Aircraft match by ICAO24 and by
 * exact callsign (uppercased, spaces removed; no prefixes); vessels by MMSI.
 * Other kinds never match.
 *
 * @param {CompiledWatchlist|null|undefined} compiled
 * @param {object|null|undefined} asset A frame asset.
 * @returns {string[]} A fresh array, each id once, ICAO24 matches first.
 */
export function matchAsset(compiled, asset) {
  const byValue = compiled?.byValue;
  if (!(byValue instanceof Map)) return [];
  const ids = [];
  for (const key of assetValueKeys(asset)) {
    for (const id of byValue.get(key) || []) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The privacy guard. A civil aircraft (`military` not true) classed light,
 * glider or bizjet is declined with 'private-aircraft-class'; a vessel whose
 * normalized AIS type is SAILING or PLEASURE (the numeric codes 36 and 37,
 * or a free-text type naming either as a word) is declined with
 * 'private-vessel-type'. Everything else, including unknown classes and
 * types, is allowed.
 *
 * @param {object|null|undefined} asset A frame asset.
 * @param {typeof WATCHLIST_POLICY} [policy]
 * @returns {{ok: true}|{ok: false, code: 'private-aircraft-class'|'private-vessel-type'}}
 */
export function watchEligibility(asset, policy = WATCHLIST_POLICY) {
  if (!isRecord(asset)) return { ok: true };
  const p = mergePolicy(policy);
  if (asset.kind === 'aircraft') {
    if (asset.military === true) return { ok: true };
    const aircraftClass = textOrNull(asset.aircraftClass);
    const declined = p.declinedAircraftClasses.map((item) =>
      String(item).toLowerCase(),
    );
    if (aircraftClass && declined.includes(aircraftClass.toLowerCase())) {
      return { ok: false, code: DECLINE_AIRCRAFT };
    }
    return { ok: true };
  }
  if (asset.kind === 'vessel') {
    if (vesselTypeDeclined(asset.shipType, p.declinedVesselTypes)) {
      return { ok: false, code: DECLINE_VESSEL };
    }
  }
  return { ok: true };
}

function resolveSatellite(entry, satellite, nowMs) {
  const layer = { layerId: SATELLITE_LAYER };
  if (!isRecord(satellite) || satellite.enabled !== true) {
    return presence(WATCH_PRESENCE.FEED_OFF, 'feed-off', layer);
  }
  if (satellite.ready === false) {
    return presence(WATCH_PRESENCE.CHECKING, 'catalog-loading', layer);
  }
  const result = isRecord(satellite.result) ? satellite.result : null;
  if (!result) {
    return presence(WATCH_PRESENCE.NOT_IN_CATALOG, 'not-in-catalog', layer);
  }
  if (normalizeValue('norad', result.noradId) !== entry.value) {
    return presence(WATCH_PRESENCE.NOT_IN_CATALOG, 'id-mismatch', layer);
  }
  const lat = finiteOrNull(result.latitude ?? result.lat);
  const lon = finiteOrNull(result.longitude ?? result.lon);
  if (
    lat === null ||
    lon === null ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return presence(WATCH_PRESENCE.CHECKING, 'no-position', layer);
  }
  const atMs = timeOrNull(satellite.atMs) ?? timeOrNull(nowMs);
  const altM = finiteOrNull(result.altitudeM ?? result.altM);
  return presence(WATCH_PRESENCE.COMPUTED, null, {
    layerId: SATELLITE_LAYER,
    matches: 1,
    fix: { lat, lon, atMs, altM, onGround: null, vRateMps: null },
    asset: {
      key: entry.value,
      kind: 'satellite',
      id: entry.value,
      name: textOrNull(result.name),
      lat,
      lon,
      altM,
      layerId: SATELLITE_LAYER,
    },
  });
}

/** Every matching asset in answering frames, one per key (freshest copy). */
function collectMatches(entry, views) {
  const found = new Map();
  for (const { layerId, frame, answer } of views) {
    if (!frame || !ANSWERING.includes(answer.state)) continue;
    for (const asset of assetsOf(frame)) {
      if (!entryMatchesAsset(entry, asset)) continue;
      const lat = finiteOrNull(asset.lat);
      const lon = finiteOrNull(asset.lon);
      if (!validPoint(lat, lon)) continue;
      const key = textOrNull(asset.key) ?? textOrNull(asset.id);
      if (!key) continue;
      const atMs = fixTimeOf(asset);
      const military = asset.military === true;
      const prev = found.get(key);
      if (!prev) {
        found.set(key, { asset, layerId, atMs, military });
        continue;
      }
      prev.military = prev.military || military;
      if (atMs !== null && (prev.atMs === null || atMs > prev.atMs)) {
        prev.asset = asset;
        prev.layerId = layerId;
        prev.atMs = atMs;
      }
    }
  }
  return [...found.values()];
}

/**
 * Resolves the presence of one watch entry from the latest frame of each
 * layer (see the module rules). Several matches (two aircraft sharing an
 * exact callsign) report `matches: n` and use the freshest fix; if the guard
 * declines any of them the entry resolves to declined, with no position.
 * A fix time is the asset's `fixAtMs`, else its `contactAtMs`; without one
 * the fix is never live.
 *
 * Reasons: live, computed and not-reported null; stale-fix 'fix-old' or
 * 'fix-time-unknown'; outside-coverage 'outside-loaded-area' or
 * 'no-last-position'; feed states carry the deciding layer's answer reason;
 * checking 'awaiting-frame', 'coverage-unknown', a floor answer's reason,
 * 'catalog-loading', 'no-position' or 'bad-entry'; not-in-catalog
 * 'not-in-catalog' or 'id-mismatch'; declined the decline code.
 *
 * @param {WatchEntryInput} entry
 * @param {{nowMs?: number, frames?: Map<string, object>|Object<string, object>|object[],
 *   satellite?: SatelliteLookup|null,
 *   lastSeen?: {atMs: number, lat: number, lon: number, layerId: string}|null,
 *   policy?: typeof WATCHLIST_POLICY}} [context] `frames` holds the latest
 *   ObservationFrame per layer (frames.js shape). `lastSeen` defaults to
 *   the entry's own.
 * @returns {WatchPresence}
 */
export function resolveWatchPresence(entry, context = {}) {
  const { nowMs, frames, satellite, policy } = isRecord(context) ? context : {};
  const p = mergePolicy(policy);
  const e = readEntry(entry);
  if (!e) return presence(WATCH_PRESENCE.CHECKING, 'bad-entry');
  if (e.declined) return presence(WATCH_PRESENCE.DECLINED, e.declined);
  if (e.kind === 'satellite') return resolveSatellite(e, satellite, nowMs);

  const views = WATCH_LAYERS[e.kind].map((layerId) => {
    const frame = frameFor(frames, layerId);
    return { layerId, frame, answer: answerOf(frame) };
  });
  const hits = collectMatches(e, views);
  const matches = hits.length;

  if (matches > 0) {
    for (const hit of hits) {
      const verdict = watchEligibility(
        { ...hit.asset, military: hit.military },
        p,
      );
      if (!verdict.ok) {
        return presence(WATCH_PRESENCE.DECLINED, verdict.code, { matches });
      }
    }
    let best = hits[0];
    for (const hit of hits) {
      if (hit.atMs !== null && (best.atMs === null || hit.atMs > best.atMs)) {
        best = hit;
      }
    }
    const asset = { ...best.asset, military: best.military };
    const extra = {
      fix: fixOf(asset, best.atMs),
      layerId: best.layerId,
      matches,
      asset,
      covered: coveredFor(views, { lat: asset.lat, lon: asset.lon }),
    };
    const now = finiteOrNull(nowMs);
    if (best.atMs === null || now === null) {
      return presence(WATCH_PRESENCE.STALE_FIX, 'fix-time-unknown', extra);
    }
    if (now - best.atMs <= p.freshFixMs[e.kind]) {
      return presence(WATCH_PRESENCE.LIVE, null, extra);
    }
    return presence(WATCH_PRESENCE.STALE_FIX, 'fix-old', extra);
  }

  const lastSeen =
    isRecord(context) && context.lastSeen !== undefined
      ? context.lastSeen
      : entry.lastSeen;
  const point = lastSeenPoint(lastSeen);
  if (coveredFor(views, point)) {
    return presence(WATCH_PRESENCE.NOT_REPORTED, null, { covered: true });
  }

  for (const { layerId, frame, answer } of views) {
    if (!frame || answer.state === ANSWER_OFF) continue;
    if (!isRegional(frame.coverage)) continue;
    if (point) {
      const inside = coverageContainsPoint(
        frame.coverage,
        point.lat,
        point.lon,
      );
      if (inside === false) {
        return presence(
          WATCH_PRESENCE.OUTSIDE_COVERAGE,
          'outside-loaded-area',
          { layerId },
        );
      }
    } else if (ANSWERING.includes(answer.state)) {
      return presence(WATCH_PRESENCE.OUTSIDE_COVERAGE, 'no-last-position', {
        layerId,
      });
    }
  }

  let worst = null;
  for (const view of views) {
    const failure = view.frame ? FEED_FAILURE[view.answer.state] : null;
    if (failure && (!worst || failure.rank > worst.failure.rank)) {
      worst = { failure, view };
    }
  }
  if (worst) {
    return presence(
      worst.failure.state,
      worst.view.answer.reason ?? worst.failure.reason,
      { layerId: worst.view.layerId },
    );
  }

  const missing = views.find((view) => !view.frame);
  if (missing) {
    return presence(WATCH_PRESENCE.CHECKING, 'awaiting-frame', {
      layerId: missing.layerId,
    });
  }
  const floor = views.find((view) => view.answer.state === ANSWER_FLOOR);
  if (floor) {
    return presence(
      WATCH_PRESENCE.CHECKING,
      floor.answer.reason ?? 'floor-answer',
      { layerId: floor.layerId },
    );
  }
  const unclear = views.find(
    (view) =>
      !isGlobal(view.frame.coverage) && !isRegional(view.frame.coverage),
  );
  return presence(WATCH_PRESENCE.CHECKING, 'coverage-unknown', {
    layerId: unclear ? unclear.layerId : null,
  });
}

function trackerEvent(type, entryId, atMs, layerId, params, caveats = []) {
  return { type, entryId, atMs, layerId: layerId ?? null, params, caveats };
}

/**
 * The observed unseen span of an absence: from its start (the last live
 * evaluation, or the baseline) to the latest non-live evaluation. The
 * interval in which an asset comes back is neither seen nor unseen.
 */
function unseenSpan(record) {
  if (record.absentSinceMs === null || record.lastUnseenAtMs === null) {
    return 0;
  }
  return Math.max(0, record.lastUnseenAtMs - record.absentSinceMs);
}

function shareOf(coveredMs, spanMs) {
  if (spanMs === null || !(spanMs > 0)) return null;
  return round3(Math.min(1, Math.max(0, coveredMs) / spanMs));
}

/**
 * Creates the per-entry watch debounce. Feed it one resolved presence per
 * entry per evaluation; it returns at most one event per update.
 *
 * - The first evaluation of an entry is a silent baseline.
 * - A non-live state counts (is confirmed) once non-live evaluations have
 *   run `confirmEvals` times, after the baseline, over at least `confirmMs`.
 *   Going live never needs confirmation.
 * - `watch-not-reported`: not-reported for `confirmEvals` consecutive
 *   evaluations over at least `confirmMs`, once the entry has been reported
 *   (live or stale-fix) in this session. It fires once per absence.
 * - On going live after a confirmed non-live state (not the baseline):
 *   `watch-reappeared` when a not-reported event fired in this absence, the
 *   absence lasted at least `reappearAfterMs` and the covered share is at
 *   least `coveredShare`; otherwise `watch-seen`, with caveat
 *   'coverage-incomplete' when the covered share is below `coveredShare`
 *   (or unknown).
 * - Covered unseen time grows by the epoch delta (`epochDeltaMs`, else the
 *   time since the previous update) on each non-live evaluation that was
 *   covered (`covered`, else `presence.covered`): every layer counted with
 *   coverage global or over the last-seen position. An absence runs from the
 *   last live evaluation (or the baseline); its covered share is covered
 *   unseen time over the span up to the latest non-live evaluation (the
 *   interval in which the asset comes back is neither seen nor unseen), and
 *   covered time never exceeds that span. `absentMs` runs to the return.
 *
 * @param {typeof WATCHLIST_POLICY} [policy]
 * @returns {{update: (entryId: string, presence: WatchPresence,
 *     options: {nowMs: number, epochDeltaMs?: number|null,
 *       covered?: boolean, lastSeenAtMs?: number|null}) =>
 *     WatchTrackerEvent|null,
 *   status: (entryId: string) => object|null,
 *   forget: (entryId: string) => boolean}}
 */
export function createWatchTracker(policy = WATCHLIST_POLICY) {
  const p = mergePolicy(policy);
  const records = new Map();

  function update(entryId, resolved, options = {}) {
    const id = textOrNull(entryId);
    const opts = isRecord(options) ? options : {};
    const nowMs = finiteOrNull(opts.nowMs);
    if (!id || nowMs === null) return null;
    const state = PRESENCE_STATES.includes(resolved?.state)
      ? resolved.state
      : WATCH_PRESENCE.CHECKING;
    const live = state === WATCH_PRESENCE.LIVE;
    const reported = live || state === WATCH_PRESENCE.STALE_FIX;
    const layerId = textOrNull(resolved?.layerId);
    const fixAtMs = reported ? timeOrNull(resolved?.fix?.atMs) : null;
    const covered =
      typeof opts.covered === 'boolean'
        ? opts.covered
        : resolved?.covered === true;
    const hintSeenAtMs = timeOrNull(opts.lastSeenAtMs);

    let record = records.get(id);
    if (!record) {
      record = {
        state,
        sinceMs: nowMs,
        evals: 1,
        baseline: true,
        confirmedLive: live,
        lastNowMs: nowMs,
        lastLiveAtMs: live ? nowMs : null,
        lastSeenAtMs: fixAtMs ?? hintSeenAtMs,
        layerId: reported ? layerId : null,
        absentSinceMs: live ? null : nowMs,
        lastUnseenAtMs: live ? null : nowMs,
        coveredUnseenMs: 0,
        nonLiveCount: 0,
        nonLiveSinceMs: null,
        notReportedCount: 0,
        notReportedSinceMs: null,
        armed: reported,
        notReportedEmitted: false,
      };
      records.set(id, record);
      return null;
    }

    const delta =
      finiteOrNull(opts.epochDeltaMs) !== null && opts.epochDeltaMs >= 0
        ? opts.epochDeltaMs
        : Math.max(0, nowMs - record.lastNowMs);
    record.evals += 1;
    record.lastNowMs = Math.max(record.lastNowMs, nowMs);
    if (state !== record.state) {
      record.state = state;
      record.sinceMs = nowMs;
    }
    if (reported) {
      record.armed = true;
      if (layerId) record.layerId = layerId;
      if (
        fixAtMs !== null &&
        (record.lastSeenAtMs === null || fixAtMs > record.lastSeenAtMs)
      ) {
        record.lastSeenAtMs = fixAtMs;
      }
    }
    if (record.lastSeenAtMs === null && hintSeenAtMs !== null) {
      record.lastSeenAtMs = hintSeenAtMs;
    }

    if (live) {
      let event = null;
      if (!record.confirmedLive && !record.baseline) {
        const absentMs =
          record.absentSinceMs === null
            ? null
            : Math.max(0, nowMs - record.absentSinceMs);
        const share = shareOf(record.coveredUnseenMs, unseenSpan(record));
        if (
          record.notReportedEmitted &&
          absentMs !== null &&
          absentMs >= p.reappearAfterMs &&
          share !== null &&
          share >= p.coveredShare
        ) {
          event = trackerEvent(
            WATCH_EVENT_TYPES.REAPPEARED,
            id,
            nowMs,
            layerId,
            { absentMs, coveredShare: share },
          );
        } else {
          event = trackerEvent(
            WATCH_EVENT_TYPES.SEEN,
            id,
            nowMs,
            layerId,
            { layerId },
            share === null || share < p.coveredShare ? [CAVEAT_COVERAGE] : [],
          );
        }
      }
      record.confirmedLive = true;
      record.baseline = false;
      record.lastLiveAtMs = nowMs;
      record.absentSinceMs = null;
      record.lastUnseenAtMs = null;
      record.coveredUnseenMs = 0;
      record.nonLiveCount = 0;
      record.nonLiveSinceMs = null;
      record.notReportedCount = 0;
      record.notReportedSinceMs = null;
      record.notReportedEmitted = false;
      return event;
    }

    if (record.absentSinceMs === null) {
      record.absentSinceMs = record.lastLiveAtMs ?? nowMs;
    }
    record.lastUnseenAtMs = Math.max(record.lastUnseenAtMs ?? nowMs, nowMs);
    if (covered) record.coveredUnseenMs += delta;
    const span = unseenSpan(record);
    if (record.coveredUnseenMs > span) record.coveredUnseenMs = span;

    if (record.nonLiveCount === 0) record.nonLiveSinceMs = nowMs;
    record.nonLiveCount += 1;
    if (
      record.nonLiveCount >= p.confirmEvals &&
      nowMs - record.nonLiveSinceMs >= p.confirmMs
    ) {
      record.confirmedLive = false;
      record.baseline = false;
    }

    if (state !== WATCH_PRESENCE.NOT_REPORTED) {
      record.notReportedCount = 0;
      record.notReportedSinceMs = null;
      return null;
    }
    if (record.notReportedCount === 0) record.notReportedSinceMs = nowMs;
    record.notReportedCount += 1;
    if (
      record.armed &&
      !record.notReportedEmitted &&
      record.notReportedCount >= p.confirmEvals &&
      nowMs - record.notReportedSinceMs >= p.confirmMs
    ) {
      record.notReportedEmitted = true;
      return trackerEvent(
        WATCH_EVENT_TYPES.NOT_REPORTED,
        id,
        nowMs,
        record.layerId,
        { lastSeenAtMs: record.lastSeenAtMs },
      );
    }
    return null;
  }

  /**
   * @param {string} entryId
   * @returns {{state: string, sinceMs: number, evals: number,
   *   baseline: boolean, confirmedLive: boolean,
   *   lastLiveAtMs: number|null, lastSeenAtMs: number|null,
   *   absentSinceMs: number|null, coveredUnseenMs: number,
   *   coveredShare: number|null, notReported: boolean}|null}
   */
  function status(entryId) {
    const record = records.get(textOrNull(entryId));
    if (!record) return null;
    return {
      state: record.state,
      sinceMs: record.sinceMs,
      evals: record.evals,
      baseline: record.baseline,
      confirmedLive: record.confirmedLive,
      lastLiveAtMs: record.lastLiveAtMs,
      lastSeenAtMs: record.lastSeenAtMs,
      absentSinceMs: record.absentSinceMs,
      coveredUnseenMs: record.coveredUnseenMs,
      coveredShare: shareOf(record.coveredUnseenMs, unseenSpan(record)),
      notReported: record.notReportedEmitted,
    };
  }

  function forget(entryId) {
    return records.delete(textOrNull(entryId));
  }

  return Object.freeze({ update, status, forget });
}
