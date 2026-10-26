/**
 * Every sentence the Watch feature shows: inbox rows, toasts, zone and
 * watched-asset status lines, globe label details and place briefs.
 *
 * The engine (src/watch/) emits only codes, numbers and feed strings; this
 * module owns their wording. Rules it keeps:
 * - Honest wording: an asset that stops appearing is "no longer reported" or
 *   "not reported", never more. A lower bound is shown with the ≥ prefix and
 *   a floor answer says "at least"; an unknown answer says why.
 * - Asset labels, identifiers, zone names and feed text (quake places) are
 *   values in templates and are never translated.
 * - Times are UTC; durations use `formatNumber` units.
 *
 * Presentation only: i18n, the shared label helpers and the pure brief
 * flattener (src/watch/brief.js); no DOM.
 * @module ui/watchWording
 */
import {
  formatDate,
  formatNumber,
  formatRelativeTime,
  formatUtcDayMonth,
  msg,
  t,
  tn,
} from '../i18n/index.js';
import { AIRCRAFT_CLASS_LABELS } from '../data/aircraftClass.js';
import { displayVesselType } from '../data/vesselLabels.js';
import { placeBriefLines } from '../watch/brief.js';
import { layerNameForId } from './layerNames.js';
import { formatQuantity } from './unitLabels.js';

const SEPARATOR = ' · ';
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const UTC_CLOCK = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const time = (value) => {
  const ms = finite(value);
  return ms !== null && ms > 0 ? ms : null;
};
const text = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};
const join = (parts) => parts.filter(Boolean).join(SEPARATOR);

/** Answer reason codes (frames.js ANSWER_REASONS and the answer fallbacks). */
const REASONS = Object.freeze({
  'feed-off': msg('the layer is off'),
  'key-required': msg('the layer needs an API key'),
  'feed-unavailable': msg('the feed is unavailable'),
  'feed-loading': msg('the feed is still loading'),
  'feed-stale': msg('the feed is stale'),
  'feed-degraded': msg('the feed reported an error'),
  'never-answered': msg('no data yet'),
  'cannot-answer': msg('the layer did not hand over its records'),
  truncated: msg('too many records to read them all'),
  'partial-snapshot': msg('the latest snapshot was incomplete'),
  'regional-fallback': msg('regional fallback feed'),
  'outside-loaded-area': msg('outside the loaded area'),
  'coverage-unknown': msg('the loaded area is not known'),
  'partial-coverage': msg('only part of the zone is in the loaded area'),
  'secondary-feed-only': msg('only the second aircraft feed answers'),
  'secondary-feed-stale': msg('the second aircraft feed is not answering'),
  'floor-answer': msg('the feed answered only in part'),
  // Watched-asset presence reasons (watchlist.js).
  'fix-old': msg('the last report is old'),
  'fix-time-unknown': msg('the report time is not known'),
  'no-last-position': msg(
    'no last position yet, and the feed covers only part of the world',
  ),
  'awaiting-frame': msg('waiting for the first data'),
  'catalog-loading': msg('the satellite catalog is loading'),
  'catalog-partial': msg('the satellite catalog is incomplete'),
  'no-position': msg('no computed position'),
  'bad-entry': msg('the entry cannot be read'),
  'not-in-catalog': msg('not in the satellite catalog'),
  'id-mismatch': msg('no exact NORAD match in the catalog'),
  'private-aircraft-class': msg(
    'private light aircraft, gliders and business jets are not watched',
  ),
  'private-vessel-type': msg('pleasure and sailing craft are not watched'),
  'class-unknown': msg('its type is not known yet, so it is not followed'),
});
const TRANSPORT_CONNECTING = msg('the AIS connection is still connecting');
const TRANSPORT_NOT_LIVE = msg('the AIS connection is not live');
const REASON_FALLBACK = msg('no complete answer');

/**
 * A reason code as a short phrase, or '' for null. Vessel transport reasons
 * (`transport-<status>`) read as one connection phrase.
 * @param {string|null} reason
 * @returns {string}
 */
export function describeReason(reason) {
  const code = text(reason);
  if (!code) return '';
  if (Object.hasOwn(REASONS, code)) return t(REASONS[code]);
  if (code === 'transport-connecting') return t(TRANSPORT_CONNECTING);
  if (code.startsWith('transport-')) return t(TRANSPORT_NOT_LIVE);
  return t(REASON_FALLBACK);
}

/** Every reason code this module words, for tests and callers. */
export const WATCH_WORDED_REASONS = Object.freeze([
  ...Object.keys(REASONS),
  'transport-connecting',
  'transport-reconnecting',
]);

const KIND_NAMES = Object.freeze({
  aircraft: msg('Aircraft'),
  vessel: msg('Vessels'),
  fire: msg('Fires'),
  quake: msg('Earthquakes'),
  satellite: msg('Satellites'),
  watched: msg('Watched assets'),
  occupancy: msg('Occupancy'),
  event: msg('Recent activity'),
});

/**
 * The display name of a zone kind (or brief section kind).
 * @param {string} kind
 * @returns {string}
 */
export function kindName(kind) {
  if (Object.hasOwn(KIND_NAMES, kind)) return t(KIND_NAMES[kind]);
  return text(kind) ?? '';
}

/**
 * A count with its kind noun ("12 aircraft", "1 vessel").
 * @param {string} kind
 * @param {number} count
 * @returns {string}
 */
export function countText(kind, count) {
  const n = finite(count) ?? 0;
  const values = { count: formatNumber(n) };
  switch (kind) {
    case 'aircraft':
      return tn(n, '{count} aircraft', '{count} aircraft', values);
    case 'vessel':
      return tn(n, '{count} vessel', '{count} vessels', values);
    case 'fire':
      return tn(n, '{count} fire detection', '{count} fire detections', values);
    case 'quake':
      return tn(n, '{count} earthquake', '{count} earthquakes', values);
    case 'watched':
      return tn(n, '{count} watched asset', '{count} watched assets', values);
    case 'event':
      return tn(n, '{count} recent event', '{count} recent events', values);
    default:
      return formatNumber(n);
  }
}

/**
 * A lower-bound value: "≥ 12 min", "≥ 3 vessels".
 * @param {string} value Already formatted.
 * @returns {string}
 */
export function lowerBoundText(value) {
  return t('≥ {value}', { value });
}

/**
 * A duration in minutes or hours ("4 min", "2 h 05 min"), with the ≥ prefix
 * for a lower bound. '' when the duration is not a finite number ≥ 0.
 * @param {number} ms
 * @param {{lowerBound?: boolean}} [options]
 * @returns {string}
 */
export function formatWatchDuration(ms, { lowerBound = false } = {}) {
  const value = finite(ms);
  if (value === null || value < 0) return '';
  let shown;
  if (value < MINUTE_MS) {
    shown = t('under {duration}', {
      duration: formatNumber(1, { style: 'unit', unit: 'minute' }),
    });
  } else if (value < HOUR_MS) {
    shown = formatNumber(Math.floor(value / MINUTE_MS), {
      style: 'unit',
      unit: 'minute',
    });
  } else {
    const hours = Math.floor(value / HOUR_MS);
    const minutes = Math.floor((value % HOUR_MS) / MINUTE_MS);
    const hourText = formatNumber(hours, { style: 'unit', unit: 'hour' });
    shown =
      minutes === 0 || hours >= 48
        ? hourText
        : t('{hours} {minutes}', {
            hours: hourText,
            minutes: formatNumber(minutes, { style: 'unit', unit: 'minute' }),
          });
  }
  return lowerBound ? lowerBoundText(shown) : shown;
}

/**
 * A UTC clock time ("14:05 UTC"), dated ("10-24 14:05 UTC") when it is not
 * within a day of `nowMs`. '' when the time is not one.
 * @param {number} ms
 * @param {{nowMs?: number|null}} [options]
 * @returns {string}
 */
export function formatWatchTime(ms, { nowMs = null } = {}) {
  const at = time(ms);
  if (at === null) return '';
  const clock = t('{time} UTC', { time: formatDate(at, UTC_CLOCK) });
  const now = time(nowMs);
  if (now !== null && Math.abs(now - at) < 20 * HOUR_MS) return clock;
  return t('{day} {time}', { day: formatUtcDayMonth(at), time: clock });
}

/** "4 min ago" for a past time, '' when unknown. */
function ago(atMs, nowMs) {
  const at = time(atMs);
  const now = time(nowMs);
  if (at === null || now === null) return '';
  const minutes = Math.max(0, Math.round((now - at) / MINUTE_MS));
  if (minutes < 90) return formatRelativeTime(-minutes, 'minute');
  return formatRelativeTime(-Math.round(minutes / 60), 'hour');
}

const ANSWER_TAGS = Object.freeze({
  held: msg('HELD'),
  unknown: msg('UNKNOWN'),
  off: msg('OFF'),
});

/**
 * One kind's answer as a status line: a count for a counted answer, "at
 * least" for a floor, and HELD / UNKNOWN / OFF with the reason otherwise.
 * Data times read "as of …" (counted, floor) or "last data …" (held).
 * @param {string} state counted | floor | held | unknown | off
 * @param {string|null} reason
 * @param {{count?: number|null, asOfMs?: number|null, kind?: string,
 *   nowMs?: number|null}} [options]
 * @returns {string}
 */
export function describeAnswer(
  state,
  reason,
  { count = null, asOfMs = null, kind = null, nowMs = null } = {},
) {
  const name = kind ? kindName(kind) : '';
  const when = formatWatchTime(asOfMs, { nowMs });
  const n = finite(count);
  if (state === 'counted') {
    return join([
      countText(kind, n ?? 0),
      reason ? describeReason(reason) : '',
      when ? t('as of {time}', { time: when }) : '',
    ]);
  }
  if (state === 'floor') {
    const head =
      n !== null && n > 0
        ? t('At least {count}', { count: countText(kind, n) })
        : name
          ? t('{kind}: none seen, but the count is incomplete', { kind: name })
          : t('None seen, but the count is incomplete');
    return join([
      head,
      describeReason(reason),
      when ? t('as of {time}', { time: when }) : '',
    ]);
  }
  const tag = Object.hasOwn(ANSWER_TAGS, state)
    ? t(ANSWER_TAGS[state])
    : t(ANSWER_TAGS.unknown);
  const why = describeReason(reason) || t(REASON_FALLBACK);
  return join([
    name ? t('{kind}: {state}', { kind: name, state: tag }) : tag,
    why,
    state === 'held' && when ? t('last data {time}', { time: when }) : '',
  ]);
}

/** Watched-asset presence states (watchlist.js WATCH_PRESENCE). */
const PRESENCE_TAGS = Object.freeze({
  checking: msg('CHECKING'),
  live: msg('LIVE'),
  'stale-fix': msg('OLD REPORT'),
  'feed-stale': msg('FEED STALE'),
  'not-reported': msg('NOT REPORTED'),
  'outside-coverage': msg('OUTSIDE COVERAGE'),
  'feed-off': msg('FEED OFF'),
  'feed-unavailable': msg('FEED UNAVAILABLE'),
  computed: msg('COMPUTED'),
  'not-in-catalog': msg('NOT IN CATALOG'),
  declined: msg('NOT WATCHED'),
});

/** Every presence state this module words. */
export const WATCH_WORDED_PRESENCE = Object.freeze(Object.keys(PRESENCE_TAGS));

/**
 * A watched asset's presence as a status line, e.g. "LIVE · 2 minutes ago ·
 * Live Flights" or "NOT REPORTED · the feed covers its last position".
 * @param {string} state A WATCH_PRESENCE value.
 * @param {string|null} reason
 * @param {{fixAtMs?: number|null, nowMs?: number|null,
 *   layerId?: string|null, matches?: number}} [options]
 * @returns {string}
 */
export function describePresence(
  state,
  reason,
  { fixAtMs = null, nowMs = null, layerId = null, matches = 0 } = {},
) {
  const tag = Object.hasOwn(PRESENCE_TAGS, state)
    ? t(PRESENCE_TAGS[state])
    : t(PRESENCE_TAGS.checking);
  const layer = layerId ? layerNameForId(layerId) : null;
  const several =
    finite(matches) !== null && matches > 1
      ? tn(matches, '{count} matches', '{count} matches', {
          count: formatNumber(matches),
        })
      : '';
  switch (state) {
    case 'live':
    case 'stale-fix':
      return join([
        tag,
        state === 'stale-fix' ? describeReason(reason) : '',
        ago(fixAtMs, nowMs),
        layer,
        several,
      ]);
    case 'computed':
      return join([
        tag,
        t('a computed orbit position, not an observation'),
        layer,
      ]);
    case 'not-reported':
      return join([tag, t('the feed covers its last position')]);
    case 'feed-off':
      return join([tag, layer ? t('{layer} is off', { layer }) : '']);
    default:
      return join([tag, describeReason(reason), layer]);
  }
}

/** Caveat codes (engine WATCH_EVENT_CAVEATS). */
const CAVEATS = Object.freeze({
  'on-ground': msg('on the ground'),
  'code-may-be-in-error': msg('the code may be set in error'),
  'unobserved-interval': msg('not observed for part of the time'),
  'coverage-incomplete': msg('coverage was incomplete while it was unseen'),
  'partial-coverage': msg('only part of the zone is in the loaded area'),
  'regional-fallback': msg('regional fallback feed'),
  'lower-bound': msg('the count is a lower bound'),
});
const DWELL_LOWER_BOUND = msg('its entry was not observed');

/**
 * A caveat code as a phrase. For a zone exit, 'lower-bound' means the entry
 * time was not observed.
 * @param {string} code
 * @param {{type?: string}} [options]
 * @returns {string}
 */
export function describeCaveat(code, { type = null } = {}) {
  if (code === 'lower-bound' && type === 'zone-exit') {
    return t(DWELL_LOWER_BOUND);
  }
  return Object.hasOwn(CAVEATS, code) ? t(CAVEATS[code]) : '';
}

const EMERGENCY_KINDS = Object.freeze({
  general: msg('General emergency'),
  unlawful: msg('Unlawful interference'),
  nordo: msg('Radio failure'),
  downed: msg('Downed aircraft'),
});

function emergencyName(kind) {
  return Object.hasOwn(EMERGENCY_KINDS, kind)
    ? t(EMERGENCY_KINDS[kind])
    : t('an emergency code');
}

/** "broadcasting squawk 7700 (General emergency)" or the ADS-B form. */
function broadcastText(asset, { kind, squawk, source }) {
  const emergency = emergencyName(kind);
  const code = text(squawk);
  return source === 'squawk' && code
    ? t('{asset} broadcasting squawk {squawk} ({emergency})', {
        asset,
        squawk: code,
        emergency,
      })
    : t('ADS-B reports {emergency} for {asset}', { asset, emergency });
}

const SQUAWK_KINDS = Object.freeze({
  7500: 'unlawful',
  7600: 'nordo',
  7700: 'general',
});

/**
 * "squawk 7700 (General emergency)" when the squawk itself names the kind,
 * else "ADS-B: Radio failure".
 */
function emergencyFact(kind, squawk) {
  const code = text(squawk);
  return code && SQUAWK_KINDS[code] === kind
    ? t('squawk {squawk} ({emergency})', {
        squawk: code,
        emergency: emergencyName(kind),
      })
    : t('ADS-B: {emergency}', { emergency: emergencyName(kind) });
}

const ASSET_FALLBACKS = Object.freeze({
  aircraft: msg('An aircraft'),
  vessel: msg('A vessel'),
  satellite: msg('A satellite'),
});

function assetName(event) {
  const label = text(event.assetLabel) ?? text(event.assetId);
  if (label) return label;
  return t(
    Object.hasOwn(ASSET_FALLBACKS, event.kind)
      ? ASSET_FALLBACKS[event.kind]
      : msg('A watched asset'),
  );
}

/** A layer's name, else the kind's, else a generic name. */
function feedName(layerId, kind) {
  return layerName(layerId) || kindName(kind) || t('A watched feed');
}

function layerName(layerId) {
  const id = text(layerId);
  return id ? (layerNameForId(id) ?? id) : '';
}

function summaryText(direction, kind, params, zone) {
  const n = finite(params.count) ?? 0;
  const values = { count: formatNumber(n), zone };
  if (direction === 'enter') {
    if (kind === 'aircraft')
      return tn(
        n,
        '{count} aircraft entered {zone}',
        '{count} aircraft entered {zone}',
        values,
      );
    if (kind === 'vessel')
      return tn(
        n,
        '{count} vessel entered {zone}',
        '{count} vessels entered {zone}',
        values,
      );
    return tn(
      n,
      '{count} asset entered {zone}',
      '{count} assets entered {zone}',
      values,
    );
  }
  if (kind === 'aircraft')
    return tn(
      n,
      '{count} aircraft left {zone}',
      '{count} aircraft left {zone}',
      values,
    );
  if (kind === 'vessel')
    return tn(
      n,
      '{count} vessel left {zone}',
      '{count} vessels left {zone}',
      values,
    );
  return tn(
    n,
    '{count} asset left {zone}',
    '{count} assets left {zone}',
    values,
  );
}

/**
 * A magnitude as "M4.2", '' when unknown.
 * @param {number} value
 * @returns {string}
 */
export function magnitudeText(value) {
  const magnitude = finite(value);
  if (magnitude === null) return '';
  return t('M{magnitude}', {
    magnitude: formatNumber(magnitude, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
}

/**
 * Fire radiative power as "33.3 MW", '' when unknown.
 * @param {number} value
 * @returns {string}
 */
export function frpText(value) {
  const frp = finite(value);
  return frp === null
    ? ''
    : formatQuantity(Math.round(frp * 10) / 10, 'MW', {
        maximumFractionDigits: 1,
      });
}

/**
 * A distance as "25 km", '' when unknown.
 * @param {number} value
 * @returns {string}
 */
export function kmText(value) {
  const km = finite(value);
  return km === null
    ? ''
    : formatQuantity(km, 'km', { maximumFractionDigits: 1 });
}

function altitudeText(meters) {
  const m = finite(meters);
  if (m === null) return '';
  return formatQuantity(Math.round((m * 3.28084) / 100) * 100, 'ft');
}

/**
 * The main sentence and detail parts of one event type.
 * @returns {{main: string, parts: string[]}}
 */
function eventSentence(event, zone, at) {
  const params = isRecord(event.params) ? event.params : {};
  const asset = assetName(event);
  const kind = text(event.kind);
  const when = (ms) => at(ms);
  switch (event.type) {
    case 'zone-enter':
      return {
        main:
          params.reentry === true
            ? t('{asset} entered {zone} again', { asset, zone })
            : t('{asset} entered {zone}', { asset, zone }),
        parts: [
          when(params.sinceMs)
            ? t('inside since {time}', { time: when(params.sinceMs) })
            : '',
        ],
      };
    case 'zone-exit': {
      const dwell = formatWatchDuration(params.dwellMs, {
        lowerBound: params.dwellLowerBound === true,
      });
      return {
        main: t('{asset} left {zone}', { asset, zone }),
        parts: [
          dwell ? t('inside for {duration}', { duration: dwell }) : '',
          when(params.exitAtMs)
            ? t('outside since {time}', { time: when(params.exitAtMs) })
            : '',
        ],
      };
    }
    case 'zone-exit-window':
      return {
        main:
          when(params.fromMs) && when(params.toMs)
            ? t(
                '{asset} left {zone} between {from} and {to}; it was not observed in between',
                {
                  asset,
                  zone,
                  from: when(params.fromMs),
                  to: when(params.toMs),
                },
              )
            : t('{asset} left {zone} while it was not observed', {
                asset,
                zone,
              }),
        parts: [],
      };
    case 'zone-no-longer-reported':
      return {
        main: t('{asset} is no longer reported in {zone}', { asset, zone }),
        parts: [
          when(params.lastFixAtMs)
            ? t('last report {time}', { time: when(params.lastFixAtMs) })
            : '',
          params.lastOnGround === true
            ? t('the last report was on the ground')
            : '',
          params.lastOnGround !== true && params.descending === true
            ? t('the last report was descending')
            : '',
          params.lastOnGround !== true && altitudeText(params.lastAltM)
            ? t('last altitude {altitude}', {
                altitude: altitudeText(params.lastAltM),
              })
            : '',
        ],
      };
    case 'zone-enter-summary':
    case 'zone-exit-summary': {
      const labels = Array.isArray(params.labels)
        ? params.labels.map(text).filter(Boolean)
        : [];
      return {
        main: summaryText(
          event.type === 'zone-enter-summary' ? 'enter' : 'exit',
          kind,
          params,
          zone,
        ),
        parts: [
          labels.length
            ? t('including {labels}', { labels: labels.join(', ') })
            : '',
        ],
      };
    }
    case 'zone-traffic-summary': {
      // Literal tn() arguments, so scripts/i18n.mjs extracts each message.
      const entered = finite(params.entered) ?? 0;
      const exited = finite(params.exited) ?? 0;
      const gone = finite(params.noLongerReported) ?? 0;
      return {
        main: when(params.sinceMs)
          ? t('Busy traffic in {zone} since {time}', {
              zone,
              time: when(params.sinceMs),
            })
          : t('Busy traffic in {zone}', { zone }),
        parts: [
          tn(entered, '{count} entered', '{count} entered', {
            count: formatNumber(entered),
          }),
          tn(exited, '{count} left', '{count} left', {
            count: formatNumber(exited),
          }),
          tn(gone, '{count} no longer reported', '{count} no longer reported', {
            count: formatNumber(gone),
          }),
          finite(params.median) !== null
            ? t('median {count} inside', {
                count: formatNumber(params.median, {
                  maximumFractionDigits: 1,
                }),
              })
            : '',
        ],
      };
    }
    case 'zone-rechecked': {
      const gap = formatWatchDuration(params.gapMs);
      return {
        main: gap
          ? t('{zone} rechecked after a {duration} gap', {
              zone,
              duration: gap,
            })
          : t('{zone} rechecked after a gap', { zone }),
        parts: [
          finite(params.before) !== null && finite(params.after) !== null
            ? t('{before} before, {after} now', {
                before: params.beforeFloor
                  ? lowerBoundText(countText(kind, params.before))
                  : countText(kind, params.before),
                after: params.afterFloor
                  ? lowerBoundText(countText(kind, params.after))
                  : countText(kind, params.after),
              })
            : '',
        ],
      };
    }
    case 'feed-paused':
      return {
        main: t('{layer} paused: {reason}', {
          layer: feedName(event.layerId, kind),
          reason: describeReason(params.reason) || t(REASON_FALLBACK),
        }),
        parts: [
          when(params.sinceMs)
            ? t('since {time}', { time: when(params.sinceMs) })
            : '',
        ],
      };
    case 'feed-resumed': {
      const paused = formatWatchDuration(params.pausedMs);
      return {
        main: paused
          ? t('{layer} answering again after {duration}', {
              layer: feedName(event.layerId, kind),
              duration: paused,
            })
          : t('{layer} answering again', {
              layer: feedName(event.layerId, kind),
            }),
        parts: [],
      };
    }
    case 'fires-new': {
      const n = finite(params.count) ?? 0;
      const first = when(params.firstAcqMs);
      const last = when(params.lastAcqMs);
      return {
        main: tn(
          n,
          '{count} new fire detection in {zone}',
          '{count} new fire detections in {zone}',
          { count: formatNumber(n), zone },
        ),
        parts: [
          frpText(params.maxFrpMw)
            ? t('strongest {frp}', { frp: frpText(params.maxFrpMw) })
            : '',
          first && last && first !== last
            ? t('acquired {from} to {to}', { from: first, to: last })
            : first
              ? t('acquired {time}', { time: first })
              : '',
        ],
      };
    }
    case 'quake-new': {
      const outside = finite(params.outsideByKm);
      const magnitude = magnitudeText(params.magnitude);
      const distance = outside !== null && outside > 0 ? kmText(outside) : '';
      let main;
      if (magnitude && distance)
        main = t('{magnitude} earthquake {distance} outside {zone}', {
          magnitude,
          distance,
          zone,
        });
      else if (magnitude)
        main = t('{magnitude} earthquake in {zone}', { magnitude, zone });
      else if (distance)
        main = t('Earthquake {distance} outside {zone}', { distance, zone });
      else main = t('Earthquake in {zone}', { zone });
      return {
        main,
        parts: [
          text(params.place),
          kmText(params.depthKm)
            ? t('{depth} deep', { depth: kmText(params.depthKm) })
            : '',
          when(params.timeMs)
            ? t('origin {time}', { time: when(params.timeMs) })
            : '',
          params.reportedAfterBaseline === true
            ? t('it occurred before the watch began and was reported late')
            : '',
        ],
      };
    }
    case 'hazard-gap-summary': {
      const n = finite(params.count) ?? 0;
      const gap = formatWatchDuration(params.gapMs);
      const values = { count: formatNumber(n), zone, duration: gap };
      return {
        main:
          params.hazard === 'quake'
            ? tn(
                n,
                '{count} new earthquake in {zone} after a {duration} gap',
                '{count} new earthquakes in {zone} after a {duration} gap',
                values,
              )
            : tn(
                n,
                '{count} new fire detection in {zone} after a {duration} gap',
                '{count} new fire detections in {zone} after a {duration} gap',
                values,
              ),
        parts: [],
      };
    }
    case 'emergency-start':
      return {
        main: broadcastText(asset, params),
        parts: [
          when(params.sinceMs)
            ? t('since {time}', { time: when(params.sinceMs) })
            : '',
        ],
      };
    case 'emergency-change':
      return {
        main: t('{asset} now reports {emergency} (was {previous})', {
          asset,
          emergency: emergencyName(params.kind),
          previous: emergencyName(params.fromKind),
        }),
        parts: [],
      };
    case 'emergency-end': {
      const duration = formatWatchDuration(params.durationMs, {
        lowerBound: true,
      });
      return {
        main: t('{asset} no longer broadcasting {emergency}', {
          asset,
          emergency: emergencyName(params.kind),
        }),
        parts: [
          duration ? t('broadcast seen for {duration}', { duration }) : '',
        ],
      };
    }
    case 'emergency-unresolved':
      return {
        main: t(
          '{asset} broadcasting {emergency} is no longer reported; the outcome is not known',
          { asset, emergency: emergencyName(params.kind) },
        ),
        parts: [
          when(params.lastFixAtMs)
            ? t('last report {time}', { time: when(params.lastFixAtMs) })
            : '',
        ],
      };
    case 'watch-seen':
      return {
        main: t('{asset} reported again', { asset }),
        parts: [
          layerName(params.layerId)
            ? t('by {layer}', { layer: layerName(params.layerId) })
            : '',
        ],
      };
    case 'watch-not-reported':
      return {
        main: t(
          '{asset} not reported where the feed covers its last position',
          {
            asset,
          },
        ),
        parts: [
          when(params.lastSeenAtMs)
            ? t('last seen {time}', { time: when(params.lastSeenAtMs) })
            : '',
        ],
      };
    case 'watch-reappeared': {
      const absent = formatWatchDuration(params.absentMs);
      const share = finite(params.coveredShare);
      return {
        main: absent
          ? t('{asset} reported again after {duration} unreported', {
              asset,
              duration: absent,
            })
          : t('{asset} reported again', { asset }),
        parts: [
          share !== null
            ? t('{share} of that time in covered areas', {
                share: formatNumber(share, {
                  style: 'percent',
                  maximumFractionDigits: 0,
                }),
              })
            : '',
        ],
      };
    }
    default:
      return { main: t('Watch event'), parts: [] };
  }
}

/** The fallback text of an event type this module does not know. */
export function unknownEventText() {
  return t('Watch event');
}

const ACCENTS = Object.freeze(['info', 'notice', 'alert']);

/**
 * One watch event (or log row) as text for the inbox, a toast or a brief.
 * `accent` is the event severity ('info' | 'notice' | 'alert'), for styling.
 * @param {object} event A WatchEvent or LogRow (engine.js shape).
 * @param {{zoneName?: string|null, nowMs?: number|null}} [options]
 *   `zoneName` is the zone's own name (never translated); `nowMs` decides
 *   whether times carry a date (defaults to the event time).
 * @returns {{text: string, accent: 'info'|'notice'|'alert'}}
 */
export function describeWatchEvent(
  event,
  { zoneName = null, nowMs = null } = {},
) {
  const e = isRecord(event) ? event : {};
  const zone = text(zoneName) ?? t('a watch zone');
  const reference = time(nowMs) ?? time(e.atMs);
  const at = (ms) => formatWatchTime(ms, { nowMs: reference });
  const { main, parts } = eventSentence(e, zone, at);
  const caveats = Array.isArray(e.caveats)
    ? e.caveats.map((code) => describeCaveat(code, { type: e.type }))
    : [];
  const repeat = finite(e.repeat);
  return {
    text: join([
      main,
      ...parts,
      ...caveats,
      repeat !== null && repeat > 1
        ? t('×{count}', { count: formatNumber(repeat) })
        : '',
    ]),
    accent: ACCENTS.includes(e.severity) ? e.severity : 'info',
  };
}

const PHASES = Object.freeze({
  active: msg('broadcasting now'),
  clearing: msg('the code was not seen in the latest report'),
  unknown: msg('not currently reported'),
});

/**
 * An active emergency (engine view `emergencies` row) as one line.
 * @param {object} item ActiveEmergency.
 * @param {{nowMs?: number|null}} [options]
 * @returns {string}
 */
export function describeEmergency(item, { nowMs = null } = {}) {
  const e = isRecord(item) ? item : {};
  const asset = text(e.label) ?? text(e.icao24) ?? t(ASSET_FALLBACKS.aircraft);
  const since = formatWatchTime(e.firstSeenAtMs, { nowMs });
  return join([
    broadcastText(asset, e),
    since ? t('since {time}', { time: since }) : '',
    Object.hasOwn(PHASES, e.phase) ? t(PHASES[e.phase]) : '',
    e.onGround === true ? t(CAVEATS['on-ground']) : '',
    e.kind === 'unlawful' ? t(CAVEATS['code-may-be-in-error']) : '',
  ]);
}

/**
 * The detail line(s) of a zone's globe label: one short count per kind
 * ("12 aircraft · ≥ 3 vessels · Fires: UNKNOWN").
 * @param {object} zoneView A WatchView zone.
 * @returns {string[]} [] when the zone watches nothing.
 */
export function zoneLabelDetails(zoneView) {
  const zone = isRecord(zoneView) ? zoneView : {};
  const kinds = Array.isArray(zone.kinds) ? zone.kinds : [];
  const perKind = isRecord(zone.perKind) ? zone.perKind : {};
  const parts = kinds.map((kind) => {
    const view = isRecord(perKind[kind]) ? perKind[kind] : {};
    const n = finite(view.count);
    if (view.answer === 'counted' && n !== null) return countText(kind, n);
    // A floor is a lower bound, "≥ 0" included: never a plain count.
    if (view.answer === 'floor' && n !== null) {
      return lowerBoundText(countText(kind, n));
    }
    const tag = Object.hasOwn(ANSWER_TAGS, view.answer)
      ? t(ANSWER_TAGS[view.answer])
      : t(ANSWER_TAGS.unknown);
    return t('{kind}: {state}', { kind: kindName(kind), state: tag });
  });
  return parts.length ? [join(parts)] : [];
}

/** A zone's longest-present occupant as a line ("RYR12 · inside ≥ 40 min"). */
export function describeOccupant(occupant, { nowMs = null } = {}) {
  const o = isRecord(occupant) ? occupant : {};
  const entered = time(o.enteredAtMs);
  const now = time(nowMs);
  const dwell =
    entered !== null && now !== null
      ? formatWatchDuration(now - entered, {
          lowerBound: o.lowerBound === true,
        })
      : '';
  return join([
    text(o.label) ?? text(o.assetKey) ?? '',
    dwell ? t('inside for {duration}', { duration: dwell }) : '',
  ]);
}

const NOTIFY_LABELS = Object.freeze({
  all: msg('All events'),
  watchlisted: msg('Watched only'),
  none: msg('Quiet'),
});

/** A zone `notify` value as a chip label. */
export function notifyName(notify) {
  return Object.hasOwn(NOTIFY_LABELS, notify)
    ? t(NOTIFY_LABELS[notify])
    : String(notify);
}

const MATCH_LABELS = Object.freeze({
  icao24: msg('ICAO24 hex'),
  callsign: msg('Exact callsign'),
  mmsi: msg('MMSI'),
  norad: msg('NORAD ID'),
});

/** A watch identifier type as a chip label. */
export function matchName(match) {
  return Object.hasOwn(MATCH_LABELS, match)
    ? t(MATCH_LABELS[match])
    : String(match);
}

/** Document and geometry codes (document.js, geometry.js) as messages. */
const ERRORS = Object.freeze({
  'non-finite': msg('That position is not valid.'),
  'too-few': msg('An area needs at least three corners.'),
  'too-many': msg('That outline has too many points.'),
  pole: msg('Zones must stay between 85° south and 85° north.'),
  span: msg('Zones can span at most 40° of latitude and 60° of longitude.'),
  'self-intersecting': msg('That outline crosses itself.'),
  'too-small': msg('Zones must cover at least 2 km².'),
  'too-large': msg('That zone is too large.'),
  degenerate: msg('That outline has no area.'),
  'bad-radius': msg('The radius must be between 1 and 1,000 km.'),
  'bad-name': msg('That name cannot be used.'),
  'bad-kinds': msg('A zone must watch at least one kind.'),
  'bad-notify': msg('That alert setting is not available.'),
  'bad-filter': msg('That filter value is out of range.'),
  'bad-patch': msg('That change cannot be applied to this zone.'),
  'bad-time': msg('The clock is not available.'),
  'id-unavailable': msg('No free id is available; try again.'),
  'unsupported-annotation': msg('Only drawn areas and pins can become zones.'),
  'too-many-vertices': msg('Zones together have too many outline points.'),
  'bad-match': msg('Choose an identifier type.'),
  'bad-id': msg('That identifier does not match the chosen type.'),
  duplicate: msg('That is already watched.'),
  full: msg('The limit is reached.'),
  invalid: msg('The watch data cannot be changed.'),
  'not-found': msg('That item no longer exists.'),
  declined: msg('That asset is not watched.'),
  'class-unknown': msg(
    'The type of that aircraft or vessel is not known yet, so Watch does not follow it.',
  ),
  'no-selection': msg('Select an aircraft, vessel or satellite first.'),
  'no-position': msg('The selection has no current position.'),
});

/** Every error code this module words. */
export const WATCH_WORDED_ERRORS = Object.freeze(Object.keys(ERRORS));

/**
 * A document, geometry or controller error code as a sentence.
 * @param {string} code
 * @returns {string}
 */
export function describeWatchError(code) {
  return Object.hasOwn(ERRORS, code)
    ? t(ERRORS[code])
    : t('That change could not be made.');
}

const READ_ERRORS = Object.freeze({
  unavailable: msg('Saved watch data could not be read from this browser.'),
  'too-large': msg('Saved watch data is too large to load.'),
  malformed: msg('Saved watch data is damaged and was not loaded.'),
  'unsupported-version': msg(
    'Saved watch data comes from a newer version and was not loaded.',
  ),
});

/**
 * The read-error banner text. Nothing is saved until the person chooses.
 * @param {string} code readStoredWatchDocument `readError`.
 * @param {{zones?: number, watchlist?: number}} [dropped]
 * @returns {string}
 */
export function describeReadError(code, dropped = {}) {
  const tail = t('Changes are not saved until you choose below.');
  if (code === 'partial') {
    const zones = finite(dropped?.zones) ?? 0;
    const entries = finite(dropped?.watchlist) ?? 0;
    return join([
      t('Some saved watch data could not be read.'),
      zones
        ? tn(zones, '{count} zone was skipped', '{count} zones were skipped', {
            count: formatNumber(zones),
          })
        : '',
      entries
        ? tn(
            entries,
            '{count} watched asset was skipped',
            '{count} watched assets were skipped',
            { count: formatNumber(entries) },
          )
        : '',
      tail,
    ]);
  }
  return join([
    Object.hasOwn(READ_ERRORS, code)
      ? t(READ_ERRORS[code])
      : t('Saved watch data could not be read.'),
    tail,
  ]);
}

const WRITE_ERRORS = Object.freeze({
  'read-error': msg('Not saved: choose what to do with the unreadable data.'),
  unavailable: msg('Not saved: this browser does not allow storage here.'),
  quota: msg('Not saved: browser storage is full.'),
  'too-large': msg('Not saved: the watch data is too large.'),
  invalid: msg('Not saved: the watch data is not valid.'),
});

/**
 * A failed save as a sentence.
 * @param {string} reason writeStoredWatchDocument `reason`.
 * @returns {string}
 */
export function describeWriteError(reason) {
  return Object.hasOwn(WRITE_ERRORS, reason)
    ? t(WRITE_ERRORS[reason])
    : t('Not saved.');
}

/**
 * A default zone name: "Zone 3", or "Around RYR12" for a selection.
 * @param {{index?: number, label?: string|null}} [options]
 * @returns {string}
 */
export function defaultZoneName({ index = 1, label = null } = {}) {
  const name = text(label);
  return name
    ? t('Around {label}', { label: name })
    : t('Zone {number}', { number: formatNumber(finite(index) ?? 1) });
}

// ---------------------------------------------------------------------------
// Place briefs
// ---------------------------------------------------------------------------

const SECTION_KINDS = Object.freeze({
  'brief-aircraft': 'aircraft',
  'brief-vessels': 'vessel',
  'brief-fires': 'fire',
  'brief-quakes': 'quake',
  'brief-watched': 'watched',
  'brief-activity': 'event',
});

const BUCKET_LABELS = Object.freeze({
  untyped: msg('No type reported'),
  rest: msg('Other types'),
});

function sectionLine(code, values, nowMs) {
  const kind = SECTION_KINDS[code];
  const count = finite(values.count);
  // The section name already leads the line: only a count needs the noun.
  const counts =
    values.answer === 'counted' ||
    (values.answer === 'floor' && count !== null && count > 0);
  const answer = describeAnswer(values.answer, values.reason, {
    count,
    asOfMs: values.asOfMs,
    kind: counts ? kind : null,
    nowMs,
  });
  const head = t('{section}: {answer}', {
    section: kindName(kind),
    answer,
  });
  if (code === 'brief-fires') {
    return join([
      head,
      frpText(values.maxFrpMw)
        ? t('strongest {frp}', { frp: frpText(values.maxFrpMw) })
        : '',
      formatWatchTime(values.newestAcqMs, { nowMs })
        ? t('newest {time}', {
            time: formatWatchTime(values.newestAcqMs, { nowMs }),
          })
        : '',
    ]);
  }
  if (code === 'brief-quakes') {
    return join([
      head,
      magnitudeText(values.maxMagnitude)
        ? t('strongest {magnitude}', {
            magnitude: magnitudeText(values.maxMagnitude),
          })
        : '',
      formatWatchTime(values.newestTimeMs, { nowMs })
        ? t('newest {time}', {
            time: formatWatchTime(values.newestTimeMs, { nowMs }),
          })
        : '',
    ]);
  }
  return head;
}

function dwellPart(values, nowMs) {
  const entered = time(values.enteredAtMs);
  const now = time(nowMs);
  if (entered === null || now === null) return '';
  // An entry stamped a little ahead of the clock has no duration to show.
  const duration = formatWatchDuration(now - entered, {
    lowerBound: values.lowerBound === true,
  });
  return duration ? t('inside for {duration}', { duration }) : '';
}

function speedKnots(mps) {
  const value = finite(mps);
  return value === null
    ? ''
    : formatQuantity(Math.round(value * 1.943844), 'kt');
}

function item(parts) {
  return t('• {item}', { item: join(parts) });
}

function briefLine(line, ctx) {
  const v = isRecord(line.values) ? line.values : {};
  const { nowMs } = ctx;
  switch (line.code) {
    case 'brief-header': {
      const at = formatWatchTime(v.generatedAtMs, { nowMs });
      const name = text(v.name);
      if (name && at) return t('Brief: {name} · {time}', { name, time: at });
      if (name) return t('Brief: {name}', { name });
      return at ? t('Brief · {time}', { time: at }) : t('Brief');
    }
    case 'brief-aircraft':
    case 'brief-vessels':
    case 'brief-fires':
    case 'brief-quakes':
    case 'brief-watched':
    case 'brief-activity':
      return sectionLine(line.code, v, nowMs);
    case 'brief-aircraft-item':
      return item([
        text(v.label) ?? t(ASSET_FALLBACKS.aircraft),
        Object.hasOwn(AIRCRAFT_CLASS_LABELS, v.aircraftClass)
          ? t(AIRCRAFT_CLASS_LABELS[v.aircraftClass])
          : '',
        v.military === true ? t('military') : '',
        altitudeText(v.altitudeM),
        speedKnots(v.speedMps),
        text(v.emergencyKind) ? emergencyFact(v.emergencyKind, v.squawk) : '',
        dwellPart(v, nowMs),
      ]);
    case 'brief-vessel-type': {
      const type = text(v.type);
      const label = Object.hasOwn(BUCKET_LABELS, type)
        ? t(BUCKET_LABELS[type])
        : displayVesselType(type ?? '');
      const count = formatNumber(finite(v.count) ?? 0);
      return item([
        t('{type}: {count}', {
          type: label,
          count: v.floor === true ? lowerBoundText(count) : count,
        }),
      ]);
    }
    case 'brief-vessel-item':
      return item([
        text(v.label) ?? t(ASSET_FALLBACKS.vessel),
        text(v.shipType) ? displayVesselType(v.shipType) : '',
        finite(v.speedKts) !== null
          ? formatQuantity(v.speedKts, 'kt', {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })
          : '',
        dwellPart(v, nowMs),
      ]);
    case 'brief-fire-item':
      return item([
        frpText(v.frpMw) || t('fire detection'),
        formatWatchTime(v.acqMs, { nowMs })
          ? t('acquired {time}', { time: formatWatchTime(v.acqMs, { nowMs }) })
          : '',
      ]);
    case 'brief-quake-item':
      return item([
        magnitudeText(v.magnitude),
        text(v.place) ?? text(v.label),
        kmText(v.depthKm)
          ? t('{depth} deep', { depth: kmText(v.depthKm) })
          : '',
        formatWatchTime(v.timeMs, { nowMs })
          ? t('origin {time}', { time: formatWatchTime(v.timeMs, { nowMs }) })
          : '',
      ]);
    case 'brief-watched-item':
      return item([
        text(v.label) ?? t('A watched asset'),
        Object.hasOwn(PRESENCE_TAGS, v.presence)
          ? t(PRESENCE_TAGS[v.presence])
          : '',
        altitudeText(v.altitudeM),
        dwellPart(v, nowMs),
      ]);
    case 'brief-occupancy': {
      const head = t('{section}: {answer}', {
        section: kindName('occupancy'),
        answer:
          v.answer === 'counted'
            ? t('the last 6 hours')
            : join([
                v.answer === 'floor'
                  ? t('partly recorded')
                  : t(ANSWER_TAGS.unknown),
                describeReason(v.reason),
              ]),
      });
      return head;
    }
    case 'brief-occupancy-series': {
      const since = time(v.sinceMs);
      const span =
        since !== null && time(nowMs) !== null
          ? formatWatchDuration(nowMs - since)
          : '';
      return item([
        kindName(v.kind),
        span ? t('over {duration}', { duration: span }) : '',
        t('min {min}, median {median}, max {max}', {
          min: formatNumber(finite(v.min) ?? 0),
          median: formatNumber(finite(v.median) ?? 0, {
            maximumFractionDigits: 1,
          }),
          max: formatNumber(finite(v.max) ?? 0),
        }),
      ]);
    }
    case 'brief-occupancy-gap':
      return item([kindName(v.kind), t('no complete count recorded yet')]);
    case 'brief-occupant':
      return item([
        text(v.label) ?? kindName(v.kind),
        t('longest present'),
        dwellPart(v, nowMs),
      ]);
    case 'brief-activity-event': {
      const at = formatWatchTime(v.atMs, { nowMs });
      const described = describeWatchEvent(
        {
          type: v.type,
          severity: v.severity,
          atMs: v.atMs,
          kind: v.kind,
          assetLabel: v.label,
          params: v.params,
          caveats: v.caveats,
          repeat: v.repeat,
        },
        { zoneName: ctx.zoneName, nowMs },
      );
      return item([at, described.text]);
    }
    default:
      return '';
  }
}

/**
 * A place brief (engine `brief()` / brief.js `buildPlaceBrief`) as text
 * lines, in order: the header, each section's answer and its items. Copy
 * text is `lines.join('\n')`.
 * @param {object} brief
 * @param {{nowMs?: number|null}} [options] Defaults to the brief's time.
 * @returns {string[]}
 */
export function placeBriefText(brief, { nowMs = null } = {}) {
  if (!isRecord(brief)) return [];
  const ctx = {
    nowMs: time(nowMs) ?? time(brief.generatedAtMs),
    zoneName: text(brief.name),
  };
  return placeBriefLines(brief)
    .map((line) => briefLine(line, ctx))
    .filter(Boolean);
}
