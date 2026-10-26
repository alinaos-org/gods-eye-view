/**
 * The saved Watch document: watch zones, watched assets and preferences.
 *
 * Everything here is immutable and bounded. Builders and mutators return
 * `{ok: true, …}` or `{ok: false, code}` and never throw; the parser never
 * throws either and drops invalid entries instead of trusting them. Watched
 * assets are asset identifiers only (ICAO24, exact callsign, MMSI, NORAD id):
 * there is no owner, registrant, person or free-text note field anywhere.
 *
 * Pure module: no platform globals, timers or clocks. Time (`nowMs`), id
 * makers and storage are injected by the caller.
 */
import {
  SceneDocumentError,
  array,
  fail,
  fields,
  jsonTree,
  number,
  object,
  optional,
  string,
} from '../director/documentFields.js';
import { GEOMETRY_LIMITS, normalizeRing, validateCircle } from './geometry.js';

/** localStorage key that holds the serialized Watch document. */
export const WATCH_STORAGE_KEY = 'gev:watch:v1';

/** The only document version this module reads and writes. */
export const WATCH_DOCUMENT_VERSION = 1;

/** Largest serialized document accepted or written (256 KiB of UTF-16 units). */
export const WATCH_DOCUMENT_MAX_CHARS = 262_144;

/**
 * Document limits.
 *
 * - `maxZones`: zones per document.
 * - `maxWatchEntries`: watched assets per document.
 * - `nameMaxChars`: zone name length in code points.
 * - `labelMaxChars`: watch entry label length in code points.
 * - `maxTotalVertices`: distinct polygon vertices across every zone.
 */
export const WATCH_LIMITS = Object.freeze({
  maxZones: 24,
  maxWatchEntries: 50,
  nameMaxChars: 60,
  labelMaxChars: 40,
  maxTotalVertices: 1_024,
});

/** What a zone can watch, in canonical order. */
export const ZONE_KINDS = Object.freeze([
  'aircraft',
  'vessel',
  'fire',
  'quake',
]);

/** Kinds a new zone watches when the caller does not choose. */
export const DEFAULT_ZONE_KINDS = Object.freeze(['aircraft', 'vessel']);

/** Which zone events a zone surfaces: all, watchlisted assets only, or none. */
export const ZONE_NOTIFY = Object.freeze(['all', 'watchlisted', 'none']);

/** Circle radius choices offered by the panel, in kilometres. */
export const RADIUS_STEPS_KM = Object.freeze([5, 25, 100, 250, 500]);

/** Minimum fire radiative power choices, in megawatts. */
export const FIRE_FRP_STEPS = Object.freeze([0, 10, 50, 100]);

/** Minimum earthquake magnitude choices. */
export const QUAKE_MAG_STEPS = Object.freeze([2.5, 4, 5, 6]);

/** Earthquake buffer choices beyond the zone edge, in kilometres. */
export const QUAKE_BUFFER_STEPS_KM = Object.freeze([0, 25, 100]);

/**
 * Accepted ranges for zone filter values (inclusive). The panel offers the
 * step lists above; any value inside these ranges is still a valid document.
 */
export const ZONE_FILTER_RANGES = Object.freeze({
  minFrpMw: Object.freeze([0, 10_000]),
  minMagnitude: Object.freeze([0, 10]),
  alertMagnitude: Object.freeze([0, 10]),
  bufferKm: Object.freeze([0, 1_000]),
});

/** Filter values of a new zone. */
export const ZONE_DEFAULTS = Object.freeze({
  notify: 'all',
  aircraft: Object.freeze({ militaryOnly: false }),
  fire: Object.freeze({ minFrpMw: 0 }),
  quake: Object.freeze({ minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 }),
});

/** Grammar of each watch identifier after normalisation. */
export const WATCH_MATCH = Object.freeze({
  icao24: Object.freeze(/^~?[0-9a-f]{6}$/),
  callsign: Object.freeze(/^[A-Z0-9]{2,8}$/),
  mmsi: Object.freeze(/^[0-9]{9}$/),
  norad: Object.freeze(/^[1-9][0-9]{0,8}$/),
});

/** Asset kind implied by each identifier type. */
export const WATCH_MATCH_KIND = Object.freeze({
  icao24: 'aircraft',
  callsign: 'aircraft',
  mmsi: 'vessel',
  norad: 'satellite',
});

/** Why the privacy guard declined to follow a watched asset. */
export const WATCH_DECLINE_CODES = Object.freeze([
  'private-aircraft-class',
  'private-vessel-type',
]);

/** Id grammar for zones (`z-…`) and watch entries (`w-…`). */
export const WATCH_ID_PATTERNS = Object.freeze({
  zone: Object.freeze(/^z-[a-z0-9]{4,24}$/),
  entry: Object.freeze(/^w-[a-z0-9]{4,24}$/),
});

/** Preferences of a new document. */
export const WATCH_PREF_DEFAULTS = Object.freeze({
  zonesVisible: true,
  toasts: true,
  allEmergencies: false,
});

/**
 * A watch zone, as stored. Circles carry `center` and `radiusM`; polygons
 * carry a closed, counter-clockwise `ring` of `[lon, lat]` pairs with at most
 * 64 distinct vertices.
 *
 * @typedef {{
 *   id: string,
 *   name: string,
 *   shape: 'circle'|'polygon',
 *   center?: {lat: number, lon: number},
 *   radiusM?: number,
 *   ring?: Array<[number, number]>,
 *   kinds: string[],
 *   notify: 'all'|'watchlisted'|'none',
 *   aircraft: {militaryOnly: boolean},
 *   fire: {minFrpMw: number},
 *   quake: {minMagnitude: number, alertMagnitude: number, bufferKm: number},
 *   createdAtMs: number,
 *   updatedAtMs: number,
 * }} Zone
 */

/**
 * A watched asset, as stored. `label` is the feed's display label at the
 * time it was added (callsign, tail number, ship or satellite name), never
 * free text about a person.
 *
 * @typedef {{
 *   id: string,
 *   kind: 'aircraft'|'vessel'|'satellite',
 *   match: 'icao24'|'callsign'|'mmsi'|'norad',
 *   value: string,
 *   label: string|null,
 *   addedAtMs: number,
 *   declined: null|'private-aircraft-class'|'private-vessel-type',
 *   lastSeen: {atMs: number, lat: number, lon: number, layerId: string}|null,
 * }} WatchEntry
 */

/**
 * @typedef {{
 *   v: 1,
 *   zones: Zone[],
 *   watchlist: WatchEntry[],
 *   prefs: {zonesVisible: boolean, toasts: boolean, allEmergencies: boolean},
 * }} WatchDocument
 */

/**
 * Builder context. `makeId(prefix)` returns either a full id (`z-…`, `w-…`)
 * or a bare 4-24 character `[a-z0-9]` suffix.
 *
 * @typedef {{nowMs: number, makeId: (prefix: string) => string,
 *   defaultName?: string}} WatchBuildContext
 */

const MAX_TIME_MS = 8.64e15;
const MAX_IDENTIFIER_INPUT = 64;
const MAX_NAME_INPUT = 65_536;
const MAX_ISSUES = 32;
const ID_SUFFIX = /^[a-z0-9]{4,24}$/;
const LAYER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const NORAD_INPUT = /^[0-9]{1,12}$/;
// Line and paragraph breaks become spaces; other C0/C1 controls and bidi
// overrides/isolates are removed; unpaired surrogates are removed.
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const CONTROLS_AND_BIDI =
  /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATES = /\p{Cs}/gu;
const SPACES = /\s+/g;

const DOC_KEYS = Object.freeze(['v', 'zones', 'watchlist', 'prefs']);
const PREF_KEYS = Object.freeze(['zonesVisible', 'toasts', 'allEmergencies']);
const ZONE_COMMON_KEYS = Object.freeze([
  'id',
  'name',
  'shape',
  'kinds',
  'notify',
  'aircraft',
  'fire',
  'quake',
  'createdAtMs',
  'updatedAtMs',
]);
const CIRCLE_ZONE_KEYS = Object.freeze([
  ...ZONE_COMMON_KEYS,
  'center',
  'radiusM',
]);
const POLYGON_ZONE_KEYS = Object.freeze([...ZONE_COMMON_KEYS, 'ring']);
const ZONE_PATCH_KEYS = Object.freeze([
  'name',
  'center',
  'radiusM',
  'ring',
  'kinds',
  'notify',
  'aircraft',
  'fire',
  'quake',
]);
const ENTRY_KEYS = Object.freeze([
  'id',
  'kind',
  'match',
  'value',
  'label',
  'addedAtMs',
  'declined',
  'lastSeen',
]);
const LAST_SEEN_KEYS = Object.freeze(['atMs', 'lat', 'lon', 'layerId']);
const FILTER_SPECS = Object.freeze({
  aircraft: Object.freeze({ militaryOnly: 'boolean' }),
  fire: Object.freeze({ minFrpMw: ZONE_FILTER_RANGES.minFrpMw }),
  quake: Object.freeze({
    minMagnitude: ZONE_FILTER_RANGES.minMagnitude,
    alertMagnitude: ZONE_FILTER_RANGES.alertMagnitude,
    bufferKm: ZONE_FILTER_RANGES.bufferKm,
  }),
});

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function failure(code) {
  return { ok: false, code };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

/** Positive zero for -0, so a round trip is exact. */
function num(value) {
  return value === 0 ? 0 : value;
}

function validTime(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TIME_MS
  );
}

function requireKeys(value, path, keys) {
  for (const key of keys) {
    if (!has(value, key)) fail(`${path}.${key}`, 'missing field');
  }
}

function makeWatchId(makeId, prefix, pattern) {
  if (typeof makeId !== 'function') return null;
  let raw;
  try {
    raw = makeId(prefix);
  } catch {
    return null;
  }
  if (typeof raw !== 'string') return null;
  if (pattern.test(raw)) return raw;
  return ID_SUFFIX.test(raw) ? `${prefix}-${raw}` : null;
}

function normalizeKinds(kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return null;
  if (kinds.length > ZONE_KINDS.length * 4) return null;
  const chosen = new Set();
  for (const kind of kinds) {
    if (!ZONE_KINDS.includes(kind)) return null;
    chosen.add(kind);
  }
  return ZONE_KINDS.filter((kind) => chosen.has(kind));
}

function zoneVertexCount(zone) {
  return zone.shape === 'polygon' ? zone.ring.length - 1 : 0;
}

function totalVertices(zones) {
  let total = 0;
  for (const zone of zones) total += zoneVertexCount(zone);
  return total;
}

function asDocument(doc) {
  if (
    !isPlainObject(doc) ||
    !Array.isArray(doc.zones) ||
    !Array.isArray(doc.watchlist) ||
    !isPlainObject(doc.prefs)
  ) {
    return null;
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Canonical builders (stable key order, positive zero).
// ---------------------------------------------------------------------------

function buildZone(zone) {
  const built = { id: zone.id, name: zone.name, shape: zone.shape };
  if (zone.shape === 'circle') {
    built.center = { lat: num(zone.center.lat), lon: num(zone.center.lon) };
    built.radiusM = num(zone.radiusM);
  } else {
    built.ring = zone.ring.map((pair) => [num(pair[0]), num(pair[1])]);
  }
  built.kinds = [...zone.kinds];
  built.notify = zone.notify;
  built.aircraft = { militaryOnly: zone.aircraft.militaryOnly };
  built.fire = { minFrpMw: num(zone.fire.minFrpMw) };
  built.quake = {
    minMagnitude: num(zone.quake.minMagnitude),
    alertMagnitude: num(zone.quake.alertMagnitude),
    bufferKm: num(zone.quake.bufferKm),
  };
  built.createdAtMs = num(zone.createdAtMs);
  built.updatedAtMs = num(zone.updatedAtMs);
  return built;
}

function buildLastSeen(lastSeen) {
  if (!lastSeen) return null;
  return {
    atMs: num(lastSeen.atMs),
    lat: num(lastSeen.lat),
    lon: num(lastSeen.lon),
    layerId: lastSeen.layerId,
  };
}

function buildEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    match: entry.match,
    value: entry.value,
    label: entry.label,
    addedAtMs: num(entry.addedAtMs),
    declined: entry.declined,
    // A declined asset never keeps a stored position.
    lastSeen: entry.declined ? null : buildLastSeen(entry.lastSeen),
  };
}

function buildPrefs(prefs) {
  return {
    zonesVisible: prefs.zonesVisible,
    toasts: prefs.toasts,
    allEmergencies: prefs.allEmergencies,
  };
}

// ---------------------------------------------------------------------------
// Validators. Each throws a SceneDocumentError carrying the field path and a
// reason, never the offending value, and returns the canonical form.
// ---------------------------------------------------------------------------

function nameOf(value, path, max) {
  if (typeof value !== 'string') fail(path, 'expected text');
  const cleaned = cleanName(value, max);
  if (cleaned === null) fail(path, 'expected nonempty text');
  return cleaned;
}

function booleanOf(value, path) {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function timeOf(value, path) {
  number(value, path, 0, MAX_TIME_MS);
  return value;
}

function filterOf(value, path, spec) {
  fields(value, path, Object.keys(spec));
  requireKeys(value, path, Object.keys(spec));
  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const at = `${path}.${key}`;
    if (rule === 'boolean') out[key] = booleanOf(value[key], at);
    else {
      number(value[key], at, rule[0], rule[1]);
      out[key] = value[key];
    }
  }
  return out;
}

function zoneOf(value, path) {
  object(value, path);
  const shape = value.shape;
  if (shape !== 'circle' && shape !== 'polygon') {
    fail(`${path}.shape`, 'expected circle or polygon');
  }
  const keys = shape === 'circle' ? CIRCLE_ZONE_KEYS : POLYGON_ZONE_KEYS;
  fields(value, path, keys);
  requireKeys(value, path, keys);
  if (typeof value.id !== 'string' || !WATCH_ID_PATTERNS.zone.test(value.id)) {
    fail(`${path}.id`, 'expected a zone id');
  }
  const zone = {
    id: value.id,
    name: nameOf(value.name, `${path}.name`, WATCH_LIMITS.nameMaxChars),
    shape,
  };
  if (shape === 'circle') {
    const at = `${path}.center`;
    fields(value.center, at, ['lat', 'lon']);
    requireKeys(value.center, at, ['lat', 'lon']);
    number(value.center.lat, `${at}.lat`, -90, 90);
    number(value.center.lon, `${at}.lon`, -180, 180);
    number(
      value.radiusM,
      `${path}.radiusM`,
      GEOMETRY_LIMITS.minRadiusM,
      GEOMETRY_LIMITS.maxRadiusM,
    );
    const check = validateCircle(value.center, value.radiusM);
    if (!check.ok) fail(at, `circle rejected: ${check.code}`);
    zone.center = { lat: value.center.lat, lon: value.center.lon };
    zone.radiusM = value.radiusM;
  } else {
    const at = `${path}.ring`;
    array(value.ring, at, GEOMETRY_LIMITS.maxVertices + 1);
    value.ring.forEach((pair, index) => {
      const pairPath = `${at}[${index}]`;
      array(pair, pairPath, 2);
      if (pair.length !== 2) fail(pairPath, 'expected a [lon, lat] pair');
      number(pair[0], `${pairPath}[0]`, -180, 180);
      number(pair[1], `${pairPath}[1]`, -90, 90);
    });
    const result = normalizeRing(value.ring);
    if (!result.ok) fail(at, `ring rejected: ${result.code}`);
    if (result.simplified) fail(at, 'ring rejected: too-many');
    zone.ring = result.ring;
  }
  array(value.kinds, `${path}.kinds`, ZONE_KINDS.length * 4);
  const kinds = normalizeKinds(value.kinds);
  if (!kinds) fail(`${path}.kinds`, 'expected known, nonempty kinds');
  zone.kinds = kinds;
  if (!ZONE_NOTIFY.includes(value.notify)) {
    fail(`${path}.notify`, 'unsupported notify mode');
  }
  zone.notify = value.notify;
  for (const key of ['aircraft', 'fire', 'quake']) {
    zone[key] = filterOf(value[key], `${path}.${key}`, FILTER_SPECS[key]);
  }
  zone.createdAtMs = timeOf(value.createdAtMs, `${path}.createdAtMs`);
  zone.updatedAtMs = timeOf(value.updatedAtMs, `${path}.updatedAtMs`);
  return buildZone(zone);
}

function lastSeenOf(value, path) {
  if (value === null) return null;
  fields(value, path, LAST_SEEN_KEYS);
  requireKeys(value, path, LAST_SEEN_KEYS);
  timeOf(value.atMs, `${path}.atMs`);
  number(value.lat, `${path}.lat`, -90, 90);
  number(value.lon, `${path}.lon`, -180, 180);
  if (typeof value.layerId !== 'string' || !LAYER_ID.test(value.layerId)) {
    fail(`${path}.layerId`, 'expected a layer id');
  }
  return buildLastSeen(value);
}

function entryOf(value, path) {
  fields(value, path, ENTRY_KEYS);
  requireKeys(value, path, ENTRY_KEYS);
  if (typeof value.id !== 'string' || !WATCH_ID_PATTERNS.entry.test(value.id)) {
    fail(`${path}.id`, 'expected a watch entry id');
  }
  if (typeof value.match !== 'string' || !has(WATCH_MATCH, value.match)) {
    fail(`${path}.match`, 'unsupported identifier type');
  }
  if (value.kind !== WATCH_MATCH_KIND[value.match]) {
    fail(`${path}.kind`, 'kind does not fit the identifier type');
  }
  string(value.value, `${path}.value`, MAX_IDENTIFIER_INPUT);
  const parsed = parseWatchInput({ match: value.match, value: value.value });
  if (!parsed.ok) fail(`${path}.value`, 'expected a valid identifier');
  let label = null;
  if (value.label !== null) {
    if (typeof value.label !== 'string') fail(`${path}.label`, 'expected text');
    label = cleanName(value.label, WATCH_LIMITS.labelMaxChars);
  }
  const declined = value.declined;
  if (declined !== null && !WATCH_DECLINE_CODES.includes(declined)) {
    fail(`${path}.declined`, 'unsupported decline code');
  }
  return buildEntry({
    id: value.id,
    kind: parsed.entry.kind,
    match: parsed.entry.match,
    value: parsed.entry.value,
    label,
    addedAtMs: timeOf(value.addedAtMs, `${path}.addedAtMs`),
    declined,
    lastSeen: lastSeenOf(value.lastSeen, `${path}.lastSeen`),
  });
}

function prefsOf(value, path) {
  fields(value, path, PREF_KEYS);
  const prefs = { ...WATCH_PREF_DEFAULTS };
  for (const key of PREF_KEYS) {
    optional(value, key, path, (item, at) => {
      prefs[key] = booleanOf(item, at);
    });
  }
  return buildPrefs(prefs);
}

/** Strict canonical form of a whole document; throws on anything invalid. */
function documentOf(doc) {
  fields(doc, '$', DOC_KEYS);
  requireKeys(doc, '$', DOC_KEYS);
  if (doc.v !== WATCH_DOCUMENT_VERSION) fail('$.v', 'unsupported version');
  array(doc.zones, '$.zones', WATCH_LIMITS.maxZones);
  array(doc.watchlist, '$.watchlist', WATCH_LIMITS.maxWatchEntries);
  const zoneIds = new Set();
  const zones = doc.zones.map((raw, index) => {
    const zone = zoneOf(raw, `$.zones[${index}]`);
    if (zoneIds.has(zone.id)) fail(`$.zones[${index}].id`, 'duplicate ID');
    zoneIds.add(zone.id);
    return zone;
  });
  if (totalVertices(zones) > WATCH_LIMITS.maxTotalVertices) {
    fail('$.zones', 'vertex budget exceeded');
  }
  const entryIds = new Set();
  const values = new Set();
  const watchlist = doc.watchlist.map((raw, index) => {
    const path = `$.watchlist[${index}]`;
    const entry = entryOf(raw, path);
    if (entryIds.has(entry.id)) fail(`${path}.id`, 'duplicate ID');
    const key = `${entry.match}:${entry.value}`;
    if (values.has(key)) fail(`${path}.value`, 'duplicate identifier');
    entryIds.add(entry.id);
    values.add(key);
    return entry;
  });
  return {
    v: WATCH_DOCUMENT_VERSION,
    zones,
    watchlist,
    prefs: prefsOf(doc.prefs, '$.prefs'),
  };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * A new, empty document with default preferences.
 *
 * @returns {WatchDocument} a fresh object on every call.
 */
export function emptyWatchDocument() {
  return {
    v: WATCH_DOCUMENT_VERSION,
    zones: [],
    watchlist: [],
    prefs: buildPrefs(WATCH_PREF_DEFAULTS),
  };
}

/**
 * Whether a document holds no zones and no watched assets (preferences do
 * not count).
 *
 * @param {WatchDocument|null|undefined} doc
 * @returns {boolean}
 */
export function isEmptyWatchDocument(doc) {
  const base = asDocument(doc);
  return !base || (base.zones.length === 0 && base.watchlist.length === 0);
}

/**
 * Cleans a display name: line breaks become spaces, other C0/C1 control
 * characters, bidi overrides and isolates (U+202A-202E, U+2066-2069) and
 * unpaired surrogates are removed, runs of whitespace collapse to one space,
 * the result is trimmed and cut to `max` code points.
 *
 * @param {unknown} text
 * @param {number} [max=WATCH_LIMITS.nameMaxChars] maximum code points.
 * @returns {string|null} null for non-strings and empty results.
 */
export function cleanName(text, max = WATCH_LIMITS.nameMaxChars) {
  if (typeof text !== 'string') return null;
  const limit =
    Number.isInteger(max) && max > 0 ? max : WATCH_LIMITS.nameMaxChars;
  const cleaned = text
    .slice(0, MAX_NAME_INPUT)
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROLS_AND_BIDI, '')
    .replace(LONE_SURROGATES, '')
    .replace(SPACES, ' ')
    .trim();
  if (!cleaned) return null;
  const points = Array.from(cleaned);
  if (points.length <= limit) return cleaned;
  return points.slice(0, limit).join('').trimEnd() || null;
}

function finishZone(geometry, input, ctx) {
  const name =
    cleanName(input.name, WATCH_LIMITS.nameMaxChars) ??
    cleanName(ctx.defaultName, WATCH_LIMITS.nameMaxChars);
  if (!name) return failure('bad-name');
  const kinds =
    input.kinds === undefined || input.kinds === null
      ? [...DEFAULT_ZONE_KINDS]
      : normalizeKinds(input.kinds);
  if (!kinds) return failure('bad-kinds');
  if (!validTime(ctx.nowMs)) return failure('bad-time');
  const id = makeWatchId(ctx.makeId, 'z', WATCH_ID_PATTERNS.zone);
  if (!id) return failure('id-unavailable');
  return {
    ok: true,
    zone: buildZone({
      id,
      name,
      ...geometry,
      kinds,
      notify: ZONE_DEFAULTS.notify,
      aircraft: ZONE_DEFAULTS.aircraft,
      fire: ZONE_DEFAULTS.fire,
      quake: ZONE_DEFAULTS.quake,
      createdAtMs: ctx.nowMs,
      updatedAtMs: ctx.nowMs,
    }),
  };
}

/**
 * Builds a circle zone with default filters.
 *
 * Codes: 'non-finite', 'pole', 'bad-radius' (from `validateCircle`; the
 * radius must be 1-1,000 km), 'bad-name' (no usable name or `defaultName`),
 * 'bad-kinds' (empty or unknown kinds), 'bad-time' (`nowMs` invalid) and
 * 'id-unavailable' (`makeId` gave no valid id).
 *
 * @param {{name?: string|null, center: {lat: number, lon: number},
 *   radiusM: number, kinds?: string[]}} input `kinds` defaults to
 *   {@link DEFAULT_ZONE_KINDS}; duplicates are dropped and the order made
 *   canonical.
 * @param {WatchBuildContext} ctx
 * @returns {{ok: true, zone: Zone} | {ok: false, code: string}}
 */
export function createCircleZone(input, ctx = {}) {
  const source = input ?? {};
  const { center, radiusM } = source;
  const check = validateCircle(center, radiusM);
  if (!check.ok) return failure(check.code);
  return finishZone(
    {
      shape: 'circle',
      center: { lat: center.lat, lon: center.lon },
      radiusM,
    },
    source,
    ctx ?? {},
  );
}

/**
 * Builds a polygon zone with default filters. The ring is normalised by
 * `normalizeRing` (closed, counter-clockwise, at most 64 distinct vertices).
 *
 * Codes: every `normalizeRing` code ('non-finite', 'too-few', 'too-many',
 * 'pole', 'span', 'self-intersecting', 'too-small', 'too-large',
 * 'degenerate'), plus 'bad-name', 'bad-kinds', 'bad-time' and
 * 'id-unavailable' as for {@link createCircleZone}.
 *
 * @param {{name?: string|null, ring: Array<[number, number]>,
 *   kinds?: string[]}} input
 * @param {WatchBuildContext} ctx
 * @returns {{ok: true, zone: Zone, simplified: boolean}
 *   | {ok: false, code: string}}
 */
export function createPolygonZone(input, ctx = {}) {
  const result = normalizeRing(input?.ring);
  if (!result.ok) return failure(result.code);
  const built = finishZone(
    { shape: 'polygon', ring: result.ring },
    input ?? {},
    ctx ?? {},
  );
  return built.ok ? { ...built, simplified: result.simplified } : built;
}

function pinAnchor(record) {
  const anchor = record.anchor;
  if (isPlainObject(anchor) && (has(anchor, 'lat') || has(anchor, 'lon'))) {
    return { lat: anchor.lat, lon: anchor.lon };
  }
  if (has(record, 'latitude') || has(record, 'longitude')) {
    return { lat: record.latitude, lon: record.longitude };
  }
  return null;
}

/**
 * Builds a zone from an annotation record (`annotations.list()`): an 'area'
 * with a ring becomes a polygon, a 'pin' becomes a circle of
 * `defaultRadiusM` around its anchor. The annotation label, when usable,
 * becomes the zone name; otherwise `defaultName` is used.
 *
 * Codes: 'unsupported-annotation' for any other record (routes, arrows,
 * labels, highlights, areas whose outline has not arrived), plus every
 * {@link createCircleZone} / {@link createPolygonZone} code.
 *
 * @param {object} record annotation record.
 * @param {WatchBuildContext & {defaultRadiusM?: number, kinds?: string[]}}
 *   [options] `defaultRadiusM` defaults to 10 km.
 * @returns {{ok: true, zone: Zone, simplified: boolean}
 *   | {ok: false, code: string}}
 */
export function zoneFromAnnotation(record, options = {}) {
  const { defaultRadiusM = 10_000, kinds, ...ctx } = options ?? {};
  if (!isPlainObject(record)) return failure('unsupported-annotation');
  const name = typeof record.label === 'string' ? record.label : null;
  if (
    record.type === 'area' &&
    Array.isArray(record.ring) &&
    record.ring.length
  ) {
    return createPolygonZone({ name, ring: record.ring, kinds }, ctx);
  }
  if (record.type === 'pin') {
    const center = pinAnchor(record);
    if (!center) return failure('unsupported-annotation');
    const result = createCircleZone(
      { name, center, radiusM: defaultRadiusM, kinds },
      ctx,
    );
    return result.ok ? { ...result, simplified: false } : result;
  }
  return failure('unsupported-annotation');
}

function mergeFilter(current, patch, spec) {
  if (!isPlainObject(patch)) return null;
  const merged = { ...current };
  for (const key of Object.keys(patch)) {
    if (!has(spec, key)) return null;
    const rule = spec[key];
    const value = patch[key];
    if (rule === 'boolean') {
      if (typeof value !== 'boolean') return null;
    } else if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < rule[0] ||
      value > rule[1]
    ) {
      return null;
    }
    merged[key] = value;
  }
  return merged;
}

function geometryKey(zone) {
  return JSON.stringify([zone.center ?? null, zone.radiusM ?? null, zone.ring]);
}

/**
 * Applies a patch to a zone. Patchable keys: name, center and radiusM
 * (circles), ring (polygons), kinds, notify, and partial `aircraft`, `fire`
 * and `quake` filter objects, which merge into the current filters.
 *
 * Codes: 'invalid' (the zone itself is invalid), 'bad-patch' (not an object,
 * an unknown key, or geometry of the other shape), 'bad-name', 'bad-kinds',
 * 'bad-notify', 'bad-filter', 'bad-time', and the `validateCircle` /
 * `normalizeRing` codes.
 *
 * @param {Zone} zone
 * @param {object} patch
 * @param {{nowMs: number}} ctx `nowMs` becomes `updatedAtMs` when anything
 *   changed.
 * @returns {{ok: true, zone: Zone, geometryChanged: boolean,
 *   simplified: boolean} | {ok: false, code: string}} an unchanged zone is
 *   returned as the same object.
 */
export function updateZone(zone, patch, ctx = {}) {
  let current;
  try {
    current = zoneOf(zone, '$');
  } catch {
    return failure('invalid');
  }
  if (!isPlainObject(patch)) return failure('bad-patch');
  for (const key of Object.keys(patch)) {
    if (!ZONE_PATCH_KEYS.includes(key)) return failure('bad-patch');
  }
  const next = { ...current };
  let simplified = false;
  if (has(patch, 'name')) {
    const name = cleanName(patch.name, WATCH_LIMITS.nameMaxChars);
    if (!name) return failure('bad-name');
    next.name = name;
  }
  if (has(patch, 'center') || has(patch, 'radiusM')) {
    if (current.shape !== 'circle') return failure('bad-patch');
    const center = has(patch, 'center') ? patch.center : current.center;
    const radiusM = has(patch, 'radiusM') ? patch.radiusM : current.radiusM;
    const check = validateCircle(center, radiusM);
    if (!check.ok) return failure(check.code);
    next.center = { lat: center.lat, lon: center.lon };
    next.radiusM = radiusM;
  }
  if (has(patch, 'ring')) {
    if (current.shape !== 'polygon') return failure('bad-patch');
    const result = normalizeRing(patch.ring);
    if (!result.ok) return failure(result.code);
    next.ring = result.ring;
    simplified = result.simplified;
  }
  if (has(patch, 'kinds')) {
    const kinds = normalizeKinds(patch.kinds);
    if (!kinds) return failure('bad-kinds');
    next.kinds = kinds;
  }
  if (has(patch, 'notify')) {
    if (!ZONE_NOTIFY.includes(patch.notify)) return failure('bad-notify');
    next.notify = patch.notify;
  }
  for (const key of ['aircraft', 'fire', 'quake']) {
    if (!has(patch, key)) continue;
    const merged = mergeFilter(current[key], patch[key], FILTER_SPECS[key]);
    if (!merged) return failure('bad-filter');
    next[key] = merged;
  }
  const candidate = buildZone(next);
  if (JSON.stringify(candidate) === JSON.stringify(current)) {
    return { ok: true, zone, geometryChanged: false, simplified: false };
  }
  if (!validTime(ctx?.nowMs)) return failure('bad-time');
  candidate.updatedAtMs = num(ctx.nowMs);
  return {
    ok: true,
    zone: candidate,
    geometryChanged: geometryKey(candidate) !== geometryKey(current),
    simplified,
  };
}

function canonicalZone(zone) {
  try {
    return zoneOf(zone, '$');
  } catch {
    return null;
  }
}

/**
 * Appends a zone.
 *
 * Codes: 'invalid' (bad document or zone), 'duplicate' (id already used),
 * 'full' (24 zones) and 'too-many-vertices' (more than 1,024 distinct
 * polygon vertices in total).
 *
 * @param {WatchDocument} doc
 * @param {Zone} zone
 * @returns {{ok: true, doc: WatchDocument} | {ok: false, code: string}}
 */
export function addZone(doc, zone) {
  const base = asDocument(doc);
  const next = canonicalZone(zone);
  if (!base || !next) return failure('invalid');
  if (base.zones.some((item) => item.id === next.id)) {
    return failure('duplicate');
  }
  if (base.zones.length >= WATCH_LIMITS.maxZones) return failure('full');
  if (
    totalVertices(base.zones) + zoneVertexCount(next) >
    WATCH_LIMITS.maxTotalVertices
  ) {
    return failure('too-many-vertices');
  }
  return { ok: true, doc: { ...base, zones: [...base.zones, next] } };
}

/**
 * Removes a zone by id.
 *
 * @param {WatchDocument} doc
 * @param {string} zoneId
 * @returns {{ok: true, doc: WatchDocument}
 *   | {ok: false, code: 'invalid'|'not-found'}}
 */
export function removeZone(doc, zoneId) {
  const base = asDocument(doc);
  if (!base) return failure('invalid');
  const index = base.zones.findIndex((item) => item.id === zoneId);
  if (index < 0) return failure('not-found');
  return {
    ok: true,
    doc: { ...base, zones: base.zones.filter((_, i) => i !== index) },
  };
}

/**
 * Replaces the zone with the same id, keeping its position in the list.
 *
 * Codes: 'invalid', 'not-found' and 'too-many-vertices'.
 *
 * @param {WatchDocument} doc
 * @param {Zone} zone
 * @returns {{ok: true, doc: WatchDocument} | {ok: false, code: string}}
 */
export function replaceZone(doc, zone) {
  const base = asDocument(doc);
  const next = canonicalZone(zone);
  if (!base || !next) return failure('invalid');
  const index = base.zones.findIndex((item) => item.id === next.id);
  if (index < 0) return failure('not-found');
  const zones = base.zones.map((item, i) => (i === index ? next : item));
  if (totalVertices(zones) > WATCH_LIMITS.maxTotalVertices) {
    return failure('too-many-vertices');
  }
  return { ok: true, doc: { ...base, zones } };
}

function normalizeWatchValue(match, raw) {
  let text = raw;
  if (typeof text === 'number') {
    if (!Number.isFinite(text)) return null;
    text = String(text);
  }
  if (typeof text !== 'string' || text.length > MAX_IDENTIFIER_INPUT) {
    return null;
  }
  let value;
  if (match === 'icao24') value = text.trim().toLowerCase();
  else if (match === 'callsign') value = text.replace(SPACES, '').toUpperCase();
  else if (match === 'mmsi') value = text.replace(SPACES, '');
  else {
    const digits = text.trim();
    if (!NORAD_INPUT.test(digits)) return null;
    value = String(Number(digits));
  }
  return WATCH_MATCH[match].test(value) ? value : null;
}

/**
 * Parses a typed or selected identifier.
 *
 * Normalisation: ICAO24 is trimmed and lowercased (a leading `~` marks a
 * non-ICAO address), a callsign is uppercased with all spaces removed, an
 * MMSI has its spaces removed and must be 9 digits, and a NORAD id is digits
 * written as `String(Number(v))` (so leading zeros go, and 0 is rejected).
 * Numbers are accepted for every type. Callsigns match exactly; there are no
 * prefixes.
 *
 * @param {{match: string, value: string|number}} input
 * @returns {{ok: true, entry: {kind: string, match: string, value: string}}
 *   | {ok: false, code: 'bad-match'|'bad-id'}}
 */
export function parseWatchInput(input) {
  const match = input?.match;
  if (typeof match !== 'string' || !has(WATCH_MATCH, match)) {
    return failure('bad-match');
  }
  const value = normalizeWatchValue(match, input.value);
  if (value === null) return failure('bad-id');
  return { ok: true, entry: { kind: WATCH_MATCH_KIND[match], match, value } };
}

/**
 * Appends a watched asset.
 *
 * Codes: 'invalid' (bad document), 'bad-match' (unknown identifier type, or
 * an `input.kind` that does not fit it), 'bad-id' (identifier grammar),
 * 'duplicate' (same type and value already watched), 'full' (50 entries),
 * 'bad-time' and 'id-unavailable'.
 *
 * @param {WatchDocument} doc
 * @param {{match: string, value: string|number, kind?: string,
 *   label?: string|null}} input e.g. the result of
 *   {@link watchEntryFromSelection}.
 * @param {{nowMs: number, makeId: (prefix: string) => string}} ctx
 * @returns {{ok: true, doc: WatchDocument, entry: WatchEntry}
 *   | {ok: false, code: string}}
 */
export function addWatchEntry(doc, input, ctx = {}) {
  const base = asDocument(doc);
  if (!base) return failure('invalid');
  const parsed = parseWatchInput(input);
  if (!parsed.ok) return parsed;
  const { kind, match, value } = parsed.entry;
  if (input.kind !== undefined && input.kind !== kind) {
    return failure('bad-match');
  }
  if (
    base.watchlist.some((item) => item.match === match && item.value === value)
  ) {
    return failure('duplicate');
  }
  if (base.watchlist.length >= WATCH_LIMITS.maxWatchEntries) {
    return failure('full');
  }
  if (!validTime(ctx?.nowMs)) return failure('bad-time');
  const id = makeWatchId(ctx.makeId, 'w', WATCH_ID_PATTERNS.entry);
  if (!id || base.watchlist.some((item) => item.id === id)) {
    return failure('id-unavailable');
  }
  const entry = buildEntry({
    id,
    kind,
    match,
    value,
    label: cleanName(input.label, WATCH_LIMITS.labelMaxChars),
    addedAtMs: ctx.nowMs,
    declined: null,
    lastSeen: null,
  });
  return {
    ok: true,
    doc: { ...base, watchlist: [...base.watchlist, entry] },
    entry,
  };
}

function updateEntry(doc, entryId, change) {
  const base = asDocument(doc);
  if (!base) return failure('invalid');
  const index = base.watchlist.findIndex((item) => item.id === entryId);
  if (index < 0) return failure('not-found');
  const current = base.watchlist[index];
  const result = change(current);
  if (!result.ok) return result;
  if (result.entry === current) return { ok: true, doc: base };
  const watchlist = base.watchlist.map((item, i) =>
    i === index ? result.entry : item,
  );
  return { ok: true, doc: { ...base, watchlist } };
}

/**
 * Removes a watched asset by id.
 *
 * @param {WatchDocument} doc
 * @param {string} entryId
 * @returns {{ok: true, doc: WatchDocument}
 *   | {ok: false, code: 'invalid'|'not-found'}}
 */
export function removeWatchEntry(doc, entryId) {
  const base = asDocument(doc);
  if (!base) return failure('invalid');
  const index = base.watchlist.findIndex((item) => item.id === entryId);
  if (index < 0) return failure('not-found');
  return {
    ok: true,
    doc: {
      ...base,
      watchlist: base.watchlist.filter((_, i) => i !== index),
    },
  };
}

/**
 * Records (or clears, with null) the privacy guard's decline on an entry.
 * Declining also drops the entry's stored last-seen position.
 *
 * Codes: 'invalid', 'not-found' and 'bad-code'.
 *
 * @param {WatchDocument} doc
 * @param {string} entryId
 * @param {null|'private-aircraft-class'|'private-vessel-type'} code
 * @returns {{ok: true, doc: WatchDocument} | {ok: false, code: string}} the
 *   same document when nothing changed.
 */
export function markDeclined(doc, entryId, code) {
  if (code !== null && !WATCH_DECLINE_CODES.includes(code)) {
    return failure('bad-code');
  }
  return updateEntry(doc, entryId, (current) => {
    if (current.declined === code && (!code || current.lastSeen === null)) {
      return { ok: true, entry: current };
    }
    return { ok: true, entry: buildEntry({ ...current, declined: code }) };
  });
}

/**
 * Stores (or clears, with null) an entry's single last-seen fix.
 *
 * Codes: 'invalid', 'not-found', 'bad-last-seen' (not
 * `{atMs, lat, lon, layerId}` with valid values) and 'declined' (a declined
 * entry never stores a position).
 *
 * @param {WatchDocument} doc
 * @param {string} entryId
 * @param {{atMs: number, lat: number, lon: number, layerId: string}|null}
 *   lastSeen
 * @returns {{ok: true, doc: WatchDocument} | {ok: false, code: string}} the
 *   same document when nothing changed.
 */
export function setLastSeen(doc, entryId, lastSeen) {
  let next;
  try {
    next = lastSeenOf(lastSeen, '$');
  } catch {
    return failure('bad-last-seen');
  }
  return updateEntry(doc, entryId, (current) => {
    if (next && current.declined) return failure('declined');
    if (JSON.stringify(current.lastSeen) === JSON.stringify(next)) {
      return { ok: true, entry: current };
    }
    return { ok: true, entry: buildEntry({ ...current, lastSeen: next }) };
  });
}

/**
 * Merges boolean preferences (`zonesVisible`, `toasts`, `allEmergencies`).
 *
 * @param {WatchDocument} doc
 * @param {object} patch
 * @returns {{ok: true, doc: WatchDocument}
 *   | {ok: false, code: 'invalid'|'bad-prefs'}}
 */
export function setPrefs(doc, patch) {
  const base = asDocument(doc);
  if (!base) return failure('invalid');
  if (!isPlainObject(patch)) return failure('bad-prefs');
  const prefs = buildPrefs({ ...WATCH_PREF_DEFAULTS, ...base.prefs });
  for (const key of Object.keys(patch)) {
    if (!PREF_KEYS.includes(key) || typeof patch[key] !== 'boolean') {
      return failure('bad-prefs');
    }
    prefs[key] = patch[key];
  }
  return { ok: true, doc: { ...base, prefs } };
}

/**
 * Watch entry for the current selection.
 *
 * - `gev:awareness-subject-selected` detail `{layerId: 'flights'|'military',
 *   id}` gives an ICAO24 entry; `{layerId: 'satellites', id}` a NORAD entry.
 * - `gev:entity-selected` detail `{layerId: 'ais-live-vessels',
 *   properties: {mmsi}}` gives an MMSI entry.
 * - Anything else (local ADS-B, cameras, ALPR, …) gives null.
 *
 * @param {object|null|undefined} detail event detail.
 * @returns {{kind: string, match: string, value: string,
 *   label: string|null}|null} `label` is the selection's display label,
 *   cleaned and cut to 40 code points.
 */
export function watchEntryFromSelection(detail) {
  if (!isPlainObject(detail)) return null;
  const layerId = detail.layerId;
  let input = null;
  if (layerId === 'flights' || layerId === 'military') {
    input = { match: 'icao24', value: detail.id };
  } else if (layerId === 'satellites') {
    input = { match: 'norad', value: detail.id };
  } else if (layerId === 'ais-live-vessels') {
    const properties = isPlainObject(detail.properties)
      ? detail.properties
      : null;
    input = { match: 'mmsi', value: properties?.mmsi };
  }
  if (!input) return null;
  const parsed = parseWatchInput(input);
  if (!parsed.ok) return null;
  return {
    ...parsed.entry,
    label: cleanName(detail.label, WATCH_LIMITS.labelMaxChars),
  };
}

function issueFrom(error, fallbackPath) {
  if (error instanceof SceneDocumentError) {
    return { path: error.path, reason: error.reason };
  }
  return { path: fallbackPath, reason: 'invalid entry' };
}

/**
 * Parses stored text. Never throws.
 *
 * - `null`/`undefined` (nothing stored) gives an empty document and no error.
 * - 'too-large': longer than {@link WATCH_DOCUMENT_MAX_CHARS}.
 * - 'malformed': not JSON, not an object, unsafe keys (`__proto__`,
 *   `constructor`, `prototype`), too deep, no `v`, or `zones`/`watchlist`
 *   that are not arrays.
 * - 'unsupported-version': `v` is not 1.
 * - 'partial': something was dropped (invalid, duplicate or over-limit zones
 *   or entries, unknown top-level keys, invalid prefs); the rest is kept.
 *
 * `issues` lists up to 32 `{path, reason}` pairs; they name the field and
 * the check, never the stored value.
 *
 * @param {string|null|undefined} text
 * @returns {{doc: WatchDocument,
 *   error: null|'too-large'|'malformed'|'unsupported-version'|'partial',
 *   dropped: {zones: number, watchlist: number},
 *   issues: Array<{path: string, reason: string}>}}
 */
export function parseWatchDocument(text) {
  const dropped = { zones: 0, watchlist: 0 };
  const issues = [];
  let lossy = false;
  const note = (issue) => {
    lossy = true;
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  const done = (doc, error) => ({ doc, error, dropped, issues });
  if (text === null || text === undefined) {
    return done(emptyWatchDocument(), null);
  }
  if (typeof text !== 'string') {
    note({ path: '$', reason: 'expected text' });
    return done(emptyWatchDocument(), 'malformed');
  }
  if (text.length > WATCH_DOCUMENT_MAX_CHARS) {
    note({ path: '$', reason: 'document is too large' });
    return done(emptyWatchDocument(), 'too-large');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // The SyntaxError message quotes the text, so it is not passed on.
    note({ path: '$', reason: 'expected JSON' });
    return done(emptyWatchDocument(), 'malformed');
  }
  try {
    object(value, '$');
    jsonTree(value, '$', { nodes: 0 });
    if (!has(value, 'v')) fail('$.v', 'missing field');
    for (const key of ['zones', 'watchlist']) {
      if (has(value, key) && !Array.isArray(value[key])) {
        fail(`$.${key}`, 'expected an array');
      }
    }
  } catch (error) {
    note(issueFrom(error, '$'));
    return done(emptyWatchDocument(), 'malformed');
  }
  if (value.v !== WATCH_DOCUMENT_VERSION) {
    note({ path: '$.v', reason: 'unsupported version' });
    return done(emptyWatchDocument(), 'unsupported-version');
  }
  for (const key of Object.keys(value)) {
    if (!DOC_KEYS.includes(key)) {
      note({ path: `$.${key}`, reason: 'unsupported field' });
    }
  }

  const doc = emptyWatchDocument();
  const zoneIds = new Set();
  let vertices = 0;
  (value.zones ?? []).forEach((raw, index) => {
    const path = `$.zones[${index}]`;
    const drop = (issue) => {
      dropped.zones += 1;
      note(issue);
    };
    if (doc.zones.length >= WATCH_LIMITS.maxZones) {
      drop({ path, reason: 'too many zones' });
      return;
    }
    let zone;
    try {
      zone = zoneOf(raw, path);
    } catch (error) {
      drop(issueFrom(error, path));
      return;
    }
    if (zoneIds.has(zone.id)) {
      drop({ path: `${path}.id`, reason: 'duplicate ID' });
      return;
    }
    const count = zoneVertexCount(zone);
    if (vertices + count > WATCH_LIMITS.maxTotalVertices) {
      drop({ path: `${path}.ring`, reason: 'vertex budget exceeded' });
      return;
    }
    zoneIds.add(zone.id);
    vertices += count;
    doc.zones.push(zone);
  });

  const entryIds = new Set();
  const values = new Set();
  (value.watchlist ?? []).forEach((raw, index) => {
    const path = `$.watchlist[${index}]`;
    const drop = (issue) => {
      dropped.watchlist += 1;
      note(issue);
    };
    if (doc.watchlist.length >= WATCH_LIMITS.maxWatchEntries) {
      drop({ path, reason: 'too many watch entries' });
      return;
    }
    let entry;
    try {
      entry = entryOf(raw, path);
    } catch (error) {
      drop(issueFrom(error, path));
      return;
    }
    const key = `${entry.match}:${entry.value}`;
    if (entryIds.has(entry.id)) {
      drop({ path: `${path}.id`, reason: 'duplicate ID' });
      return;
    }
    if (values.has(key)) {
      drop({ path: `${path}.value`, reason: 'duplicate identifier' });
      return;
    }
    entryIds.add(entry.id);
    values.add(key);
    doc.watchlist.push(entry);
  });

  if (has(value, 'prefs')) {
    try {
      doc.prefs = prefsOf(value.prefs, '$.prefs');
    } catch (error) {
      note(issueFrom(error, '$.prefs'));
    }
  }
  return done(doc, lossy ? 'partial' : null);
}

/**
 * Serializes a document with a stable key order (independent of the input
 * objects' key order). The document is validated first.
 *
 * @param {WatchDocument} doc
 * @param {{maxChars?: number}} [options] size cap; defaults to
 *   {@link WATCH_DOCUMENT_MAX_CHARS}.
 * @returns {string}
 * @throws {TypeError} when the document is invalid; the message names the
 *   field path, never the value.
 * @throws {RangeError} when the text would exceed the size cap.
 */
export function serializeWatchDocument(doc, options = {}) {
  const maxChars = options?.maxChars ?? WATCH_DOCUMENT_MAX_CHARS;
  let canonical;
  try {
    canonical = documentOf(doc);
  } catch (error) {
    const issue = issueFrom(error, '$');
    throw new TypeError(`${issue.path}: ${issue.reason}`);
  }
  const text = JSON.stringify(canonical);
  if (text.length > maxChars) {
    throw new RangeError('watch document exceeds the size cap');
  }
  return text;
}

/**
 * Reads the stored document through an injected storage
 * (`getItem(key)`).
 *
 * `readError` is null when nothing is stored or the text parsed cleanly,
 * 'unavailable' when `getItem` threw, or the {@link parseWatchDocument}
 * error. A missing storage reads as empty with no error (writes will then
 * report 'unavailable').
 *
 * @param {{getItem: (key: string) => string|null}|null|undefined} storage
 * @returns {{doc: WatchDocument, readError: string|null, raw: string|null,
 *   dropped: {zones: number, watchlist: number},
 *   issues: Array<{path: string, reason: string}>}}
 */
export function readStoredWatchDocument(storage) {
  const none = { zones: 0, watchlist: 0 };
  if (!storage || typeof storage.getItem !== 'function') {
    return {
      doc: emptyWatchDocument(),
      readError: null,
      raw: null,
      dropped: none,
      issues: [],
    };
  }
  let raw;
  try {
    raw = storage.getItem(WATCH_STORAGE_KEY);
  } catch {
    return {
      doc: emptyWatchDocument(),
      readError: 'unavailable',
      raw: null,
      dropped: none,
      issues: [],
    };
  }
  const parsed = parseWatchDocument(raw ?? null);
  return {
    doc: parsed.doc,
    readError: parsed.error,
    raw: typeof raw === 'string' ? raw : null,
    dropped: parsed.dropped,
    issues: parsed.issues,
  };
}

function isQuotaError(error) {
  return (
    error?.name === 'QuotaExceededError' ||
    error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    error?.code === 22 ||
    error?.code === 1014
  );
}

/**
 * Writes the document through an injected storage (`setItem(key, text)`).
 * Never throws.
 *
 * Any read error blocks the write, so an unreadable or newer saved document
 * is never overwritten; the caller clears it (passes `readError: null`) only
 * after the person chooses to keep the loaded entries or reset.
 *
 * Reasons: 'read-error', 'unavailable' (no storage, or `setItem` threw),
 * 'quota' (QuotaExceededError), 'too-large' (past the size cap) and
 * 'invalid' (the document failed validation).
 *
 * @param {WatchDocument} doc
 * @param {{setItem: (key: string, text: string) => void}|null|undefined}
 *   storage
 * @param {{readError?: string|null, maxChars?: number}} [options]
 * @returns {{ok: true}
 *   | {ok: false,
 *     reason: 'read-error'|'unavailable'|'quota'|'too-large'|'invalid'}}
 */
export function writeStoredWatchDocument(doc, storage, options = {}) {
  if (options?.readError) return { ok: false, reason: 'read-error' };
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }
  let text;
  try {
    text = serializeWatchDocument(doc, { maxChars: options?.maxChars });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof RangeError ? 'too-large' : 'invalid',
    };
  }
  try {
    storage.setItem(WATCH_STORAGE_KEY, text);
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? 'quota' : 'unavailable' };
  }
  return { ok: true };
}
