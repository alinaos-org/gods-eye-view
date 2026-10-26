import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_ZONE_KINDS,
  FIRE_FRP_STEPS,
  QUAKE_BUFFER_STEPS_KM,
  QUAKE_MAG_STEPS,
  RADIUS_STEPS_KM,
  WATCH_DECLINE_CODES,
  WATCH_DOCUMENT_MAX_CHARS,
  WATCH_DOCUMENT_VERSION,
  WATCH_ID_PATTERNS,
  WATCH_LIMITS,
  WATCH_MATCH,
  WATCH_MATCH_KIND,
  WATCH_PREF_DEFAULTS,
  WATCH_STORAGE_KEY,
  ZONE_DEFAULTS,
  ZONE_FILTER_RANGES,
  ZONE_KINDS,
  ZONE_NOTIFY,
  addWatchEntry,
  addZone,
  cleanName,
  createCircleZone,
  createPolygonZone,
  emptyWatchDocument,
  isEmptyWatchDocument,
  markDeclined,
  parseWatchDocument,
  parseWatchInput,
  readStoredWatchDocument,
  removeWatchEntry,
  removeZone,
  replaceZone,
  serializeWatchDocument,
  setLastSeen,
  setPrefs,
  updateZone,
  watchEntryFromSelection,
  writeStoredWatchDocument,
  zoneFromAnnotation,
} from './document.js';
import { compileZone, signedDistanceM } from './geometry.js';

const NOW = 1_760_000_000_000;
const ZONE_KEYS_CIRCLE = [
  'id',
  'name',
  'shape',
  'center',
  'radiusM',
  'kinds',
  'notify',
  'aircraft',
  'fire',
  'quake',
  'createdAtMs',
  'updatedAtMs',
];
const ZONE_KEYS_POLYGON = [
  'id',
  'name',
  'shape',
  'ring',
  'kinds',
  'notify',
  'aircraft',
  'fire',
  'quake',
  'createdAtMs',
  'updatedAtMs',
];
const ENTRY_KEYS = [
  'id',
  'kind',
  'match',
  'value',
  'label',
  'addedAtMs',
  'declined',
  'lastSeen',
];

/** Sequential id maker; `bare` returns suffixes instead of full ids. */
function idMaker({ bare = false, start = 0 } = {}) {
  let n = start;
  return (prefix) => {
    n += 1;
    const suffix = `id${String(n).padStart(4, '0')}`;
    return bare ? suffix : `${prefix}-${suffix}`;
  };
}

function ctx(extra = {}) {
  return { nowMs: NOW, makeId: idMaker(), defaultName: 'Zone', ...extra };
}

function square(lon, lat, size) {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
  ];
}

/** Approximate circle ring; `wobble` modulates the radius sinusoidally. */
function roundRing(lat, lon, radiusKm, count, wobble = 0) {
  const ring = [];
  for (let i = 0; i < count; i += 1) {
    const theta = (2 * Math.PI * i) / count;
    const r = radiusKm * (1 + wobble * Math.sin(37 * theta));
    ring.push([
      lon + (r * Math.cos(theta)) / (111.32 * Math.cos((lat * Math.PI) / 180)),
      lat + (r * Math.sin(theta)) / 111.32,
    ]);
  }
  return ring;
}

function circleZone(id, extra = {}) {
  const result = createCircleZone(
    { name: `Zone ${id}`, center: { lat: 40, lon: -100 }, radiusM: 25_000 },
    ctx({ makeId: () => id, ...extra }),
  );
  assert.equal(result.ok, true);
  return result.zone;
}

function polygonZone(id, ring, extra = {}) {
  const result = createPolygonZone(
    { name: `Area ${id}`, ring },
    ctx({ makeId: () => id, ...extra }),
  );
  assert.equal(result.ok, true, result.code);
  return result.zone;
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  return value;
}

/** A document with both zone shapes, two entries and non-default prefs. */
function sampleDocument() {
  let doc = emptyWatchDocument();
  doc = addZone(doc, circleZone('z-harbour')).doc;
  doc = addZone(
    doc,
    polygonZone('z-delta01', [
      [170, -10],
      [-170, -10],
      [-170, 10],
      [170, 10],
    ]),
  ).doc;
  const make = idMaker();
  doc = addWatchEntry(
    doc,
    { match: 'icao24', value: 'A1B2C3', label: 'BAW123' },
    { nowMs: NOW, makeId: make },
  ).doc;
  doc = addWatchEntry(
    doc,
    { match: 'mmsi', value: '366999712', label: 'EVER GIVEN' },
    { nowMs: NOW + 1, makeId: make },
  ).doc;
  doc = setLastSeen(doc, 'w-id0001', {
    atMs: NOW + 5,
    lat: 51.47,
    lon: -0.45,
    layerId: 'flights',
  }).doc;
  doc = setPrefs(doc, { toasts: false, allEmergencies: true }).doc;
  return doc;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const calls = { get: 0, set: 0 };
  return {
    map,
    calls,
    getItem(key) {
      calls.get += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      calls.set += 1;
      map.set(key, String(value));
    },
  };
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// Constants and the empty document.
// ---------------------------------------------------------------------------

test('constants match the plan contract and are frozen', () => {
  assert.equal(WATCH_STORAGE_KEY, 'gev:watch:v1');
  assert.equal(WATCH_DOCUMENT_VERSION, 1);
  assert.equal(WATCH_DOCUMENT_MAX_CHARS, 262_144);
  assert.deepEqual(WATCH_LIMITS, {
    maxZones: 24,
    maxWatchEntries: 50,
    nameMaxChars: 60,
    labelMaxChars: 40,
    maxTotalVertices: 1_024,
  });
  assert.deepEqual(ZONE_KINDS, ['aircraft', 'vessel', 'fire', 'quake']);
  assert.deepEqual(ZONE_NOTIFY, ['all', 'watchlisted', 'none']);
  assert.deepEqual(RADIUS_STEPS_KM, [5, 25, 100, 250, 500]);
  assert.deepEqual(FIRE_FRP_STEPS, [0, 10, 50, 100]);
  assert.deepEqual(QUAKE_MAG_STEPS, [2.5, 4, 5, 6]);
  assert.deepEqual(QUAKE_BUFFER_STEPS_KM, [0, 25, 100]);
  assert.deepEqual(Object.keys(WATCH_MATCH), [
    'icao24',
    'callsign',
    'mmsi',
    'norad',
  ]);
  assert.equal(WATCH_MATCH.icao24.source, '^~?[0-9a-f]{6}$');
  assert.equal(WATCH_MATCH.callsign.source, '^[A-Z0-9]{2,8}$');
  assert.equal(WATCH_MATCH.mmsi.source, '^[0-9]{9}$');
  assert.equal(WATCH_MATCH.norad.source, '^[1-9][0-9]{0,8}$');
  assert.deepEqual(WATCH_MATCH_KIND, {
    icao24: 'aircraft',
    callsign: 'aircraft',
    mmsi: 'vessel',
    norad: 'satellite',
  });
  assert.deepEqual(WATCH_DECLINE_CODES, [
    'private-aircraft-class',
    'private-vessel-type',
  ]);
  for (const constant of [
    WATCH_LIMITS,
    ZONE_KINDS,
    DEFAULT_ZONE_KINDS,
    ZONE_NOTIFY,
    RADIUS_STEPS_KM,
    FIRE_FRP_STEPS,
    QUAKE_MAG_STEPS,
    QUAKE_BUFFER_STEPS_KM,
    WATCH_MATCH,
    WATCH_MATCH.icao24,
    WATCH_MATCH_KIND,
    WATCH_DECLINE_CODES,
    WATCH_ID_PATTERNS,
    WATCH_PREF_DEFAULTS,
    ZONE_DEFAULTS,
    ZONE_DEFAULTS.quake,
    ZONE_FILTER_RANGES,
    ZONE_FILTER_RANGES.bufferKm,
  ]) {
    assert.ok(Object.isFrozen(constant));
  }
  // Every panel step is inside the accepted filter ranges.
  for (const step of FIRE_FRP_STEPS) {
    assert.ok(step >= ZONE_FILTER_RANGES.minFrpMw[0]);
    assert.ok(step <= ZONE_FILTER_RANGES.minFrpMw[1]);
  }
  for (const step of QUAKE_BUFFER_STEPS_KM) {
    assert.ok(step <= ZONE_FILTER_RANGES.bufferKm[1]);
  }
});

test('emptyWatchDocument is fresh, versioned and empty', () => {
  const a = emptyWatchDocument();
  const b = emptyWatchDocument();
  assert.deepEqual(a, {
    v: 1,
    zones: [],
    watchlist: [],
    prefs: { zonesVisible: true, toasts: true, allEmergencies: false },
  });
  assert.notEqual(a, b);
  assert.notEqual(a.prefs, b.prefs);
  assert.equal(isEmptyWatchDocument(a), true);
  assert.equal(isEmptyWatchDocument(null), true);
  assert.equal(isEmptyWatchDocument(sampleDocument()), false);
  // Preferences alone do not make a document non-empty.
  assert.equal(isEmptyWatchDocument(setPrefs(a, { toasts: false }).doc), true);
});

// ---------------------------------------------------------------------------
// cleanName.
// ---------------------------------------------------------------------------

test('cleanName trims, strips controls and bidi overrides, collapses spaces', () => {
  assert.equal(cleanName('  North   Sea  ', 60), 'North Sea');
  assert.equal(cleanName('a\nb\tc\r\nd', 60), 'a b c d');
  assert.equal(
    cleanName('ab\u0000\u0007\u001bcd\u007f\u0085e\u009f', 60),
    'abcd e',
  );
  assert.equal(cleanName('evil\u202egnp.exe', 60), 'evilgnp.exe');
  for (const mark of ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e']) {
    assert.equal(cleanName(`x${mark}y`, 60), 'xy');
  }
  for (const mark of ['\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(cleanName(`x${mark}y`, 60), 'xy');
  }
  assert.equal(cleanName('line\u2028para\u2029end', 60), 'line para end');
  assert.equal(cleanName('lone\ud800surrogate', 60), 'lonesurrogate');
  assert.equal(cleanName('', 60), null);
  assert.equal(cleanName('   \u202e\u0000  ', 60), null);
  assert.equal(cleanName(null, 60), null);
  assert.equal(cleanName(42, 60), null);
  assert.equal(cleanName({ toString: () => 'x' }, 60), null);
});

test('cleanName cuts to max code points, never splitting a pair', () => {
  assert.equal(cleanName('abcdef', 3), 'abc');
  assert.equal(cleanName('ab cdef', 3), 'ab');
  const rockets = '\u{1f680}'.repeat(10);
  const cut = cleanName(rockets, 4);
  assert.equal(Array.from(cut).length, 4);
  assert.equal(cut, '\u{1f680}'.repeat(4));
  assert.equal(cleanName('x'.repeat(100)).length, 60);
  assert.equal(cleanName('x'.repeat(100), 0).length, 60);
});

// ---------------------------------------------------------------------------
// Zone builders.
// ---------------------------------------------------------------------------

test('createCircleZone builds a canonical circle with default filters', () => {
  const result = createCircleZone(
    {
      name: '  Heathrow  ',
      center: { lat: 51.47, lon: -0.45 },
      radiusM: 25_000,
    },
    ctx(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result), ['ok', 'zone']);
  assert.deepEqual(Object.keys(result.zone), ZONE_KEYS_CIRCLE);
  assert.deepEqual(result.zone, {
    id: 'z-id0001',
    name: 'Heathrow',
    shape: 'circle',
    center: { lat: 51.47, lon: -0.45 },
    radiusM: 25_000,
    kinds: ['aircraft', 'vessel'],
    notify: 'all',
    aircraft: { militaryOnly: false },
    fire: { minFrpMw: 0 },
    quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 },
    createdAtMs: NOW,
    updatedAtMs: NOW,
  });
  assert.ok(!Object.isFrozen(result.zone.aircraft));
});

test('createCircleZone validates radius, centre, name, kinds, time and id', () => {
  const base = { name: 'X', center: { lat: 10, lon: 10 }, radiusM: 5_000 };
  const make = (input, extra) =>
    createCircleZone({ ...base, ...input }, ctx(extra));
  assert.deepEqual(make({ radiusM: 999 }), { ok: false, code: 'bad-radius' });
  assert.equal(make({ radiusM: 1_000 }).ok, true);
  assert.equal(make({ radiusM: 1_000_000 }).ok, true);
  assert.equal(make({ radiusM: 1_000_001 }).code, 'bad-radius');
  assert.equal(make({ radiusM: Number.NaN }).code, 'bad-radius');
  assert.equal(make({ radiusM: '5000' }).code, 'bad-radius');
  assert.equal(make({ center: { lat: 86, lon: 0 } }).code, 'pole');
  assert.equal(make({ center: { lat: 10 } }).code, 'non-finite');
  assert.equal(make({ center: null }).code, 'non-finite');
  assert.equal(createCircleZone(null, ctx()).code, 'non-finite');
  assert.equal(make({ name: null }, { defaultName: null }).code, 'bad-name');
  assert.equal(
    make({ name: '  ' }, { defaultName: '\u202e' }).code,
    'bad-name',
  );
  assert.equal(
    make({ name: null }, { defaultName: ' Zone 3 ' }).zone.name,
    'Zone 3',
  );
  assert.equal(make({ kinds: [] }).code, 'bad-kinds');
  assert.equal(make({ kinds: ['aircraft', 'person'] }).code, 'bad-kinds');
  assert.equal(make({ kinds: 'aircraft' }).code, 'bad-kinds');
  assert.deepEqual(make({ kinds: ['quake', 'aircraft', 'quake'] }).zone.kinds, [
    'aircraft',
    'quake',
  ]);
  assert.equal(make({}, { nowMs: Number.NaN }).code, 'bad-time');
  assert.equal(make({}, { nowMs: -1 }).code, 'bad-time');
  assert.equal(make({}, { nowMs: undefined }).code, 'bad-time');
  assert.equal(make({}, { makeId: null }).code, 'id-unavailable');
  assert.equal(make({}, { makeId: () => 'Z-BAD' }).code, 'id-unavailable');
  assert.equal(make({}, { makeId: () => 'abc' }).code, 'id-unavailable');
  assert.equal(
    make(
      {},
      {
        makeId: () => {
          throw new Error('no ids');
        },
      },
    ).code,
    'id-unavailable',
  );
  // makeId may return a bare suffix; the prefix is added.
  assert.equal(
    make({}, { makeId: idMaker({ bare: true }) }).zone.id,
    'z-id0001',
  );
  assert.equal(make({ name: 'n'.repeat(80) }).zone.name.length, 60);
});

test('createPolygonZone normalises rings and rejects bad ones', () => {
  const ok = createPolygonZone(
    { name: 'Box', ring: square(10, 10, 0.1) },
    ctx(),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.simplified, false);
  assert.deepEqual(Object.keys(ok.zone), ZONE_KEYS_POLYGON);
  assert.equal(ok.zone.ring.length, 5);
  assert.deepEqual(ok.zone.ring[0], ok.zone.ring[4]);
  // A clockwise input is stored counter-clockwise.
  const cw = createPolygonZone(
    { name: 'Box', ring: square(10, 10, 0.1).reverse() },
    ctx(),
  );
  assert.equal(cw.ok, true);
  const [a, b, c] = cw.zone.ring;
  const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  assert.ok(cross > 0);

  // About 1.2 km² is under the 2 km² minimum; about 4.9 km² is fine.
  assert.deepEqual(
    createPolygonZone({ name: 'Tiny', ring: square(0, 0, 0.01) }, ctx()),
    { ok: false, code: 'too-small' },
  );
  assert.equal(
    createPolygonZone({ name: 'Small', ring: square(0, 0, 0.02) }, ctx()).ok,
    true,
  );
  const bowTie = [
    [0, 0],
    [1, 1],
    [1, 0],
    [0, 1],
  ];
  assert.equal(
    createPolygonZone({ name: 'Bow', ring: bowTie }, ctx()).code,
    'self-intersecting',
  );
  assert.equal(
    createPolygonZone({ name: 'X', ring: null }, ctx()).code,
    'non-finite',
  );
  assert.equal(createPolygonZone(null, ctx()).code, 'non-finite');
  assert.equal(
    createPolygonZone({ name: 'X', ring: square(0, 0, 1).slice(0, 2) }, ctx())
      .code,
    'too-few',
  );
  assert.equal(
    createPolygonZone({ name: 'X', ring: square(0, 84, 2) }, ctx()).code,
    'pole',
  );
  assert.equal(
    createPolygonZone({ name: 'X', ring: square(0, 0, 50) }, ctx()).code,
    'span',
  );
  assert.equal(
    createPolygonZone(
      { name: null, ring: square(0, 0, 1) },
      ctx({ defaultName: null }),
    ).code,
    'bad-name',
  );
});

// ---------------------------------------------------------------------------
// zoneFromAnnotation.
// ---------------------------------------------------------------------------

test('zoneFromAnnotation turns an area into a polygon zone', () => {
  const ring = [...square(2.2, 48.8, 0.1), [2.2, 48.8]];
  const record = {
    id: 'anno-3',
    type: 'area',
    color: 'primary',
    label: 'Paris centre',
    anchor: { lon: 2.25, lat: 48.85, height: 0 },
    ring,
    polygons: null,
  };
  const result = zoneFromAnnotation(record, ctx({ kinds: ['fire'] }));
  assert.equal(result.ok, true);
  assert.equal(result.simplified, false);
  assert.equal(result.zone.shape, 'polygon');
  assert.equal(result.zone.name, 'Paris centre');
  assert.deepEqual(result.zone.kinds, ['fire']);
  assert.equal(result.zone.ring.length, 5);
  // A manual drawn area (drawMode record) with no label takes the default name.
  const drawn = zoneFromAnnotation(
    { type: 'area', manual: true, ring, label: null, color: 'primary' },
    ctx({ defaultName: 'Zone 2' }),
  );
  assert.equal(drawn.ok, true);
  assert.equal(drawn.zone.name, 'Zone 2');
});

test('zoneFromAnnotation turns a pin into a circle zone', () => {
  const pin = {
    id: 'anno-4',
    type: 'pin',
    label: 'Gate 7',
    anchor: { lon: -0.45, lat: 51.47, height: 12 },
    ring: null,
  };
  const result = zoneFromAnnotation(pin, ctx());
  assert.equal(result.ok, true);
  assert.equal(result.simplified, false);
  assert.equal(result.zone.shape, 'circle');
  assert.equal(result.zone.radiusM, 10_000);
  assert.deepEqual(result.zone.center, { lat: 51.47, lon: -0.45 });
  assert.equal(result.zone.name, 'Gate 7');
  assert.equal(
    zoneFromAnnotation(pin, ctx({ defaultRadiusM: 5_000 })).zone.radiusM,
    5_000,
  );
  assert.equal(
    zoneFromAnnotation(pin, ctx({ defaultRadiusM: 500 })).code,
    'bad-radius',
  );
  // A drawMode pin record carries latitude/longitude instead of an anchor.
  const drawnPin = zoneFromAnnotation(
    { type: 'pin', manual: true, latitude: 10, longitude: 20, label: null },
    ctx(),
  );
  assert.equal(drawnPin.ok, true);
  assert.deepEqual(drawnPin.zone.center, { lat: 10, lon: 20 });
  assert.equal(
    zoneFromAnnotation(
      { type: 'pin', anchor: { lat: Number.NaN, lon: 0 } },
      ctx(),
    ).code,
    'non-finite',
  );
});

test('zoneFromAnnotation simplifies a 512-vertex area and a 20,000-vertex outline', () => {
  const drawn = zoneFromAnnotation(
    { type: 'area', label: 'Bay', ring: roundRing(37.7, -122.4, 30, 512) },
    ctx(),
  );
  assert.equal(drawn.ok, true);
  assert.equal(drawn.simplified, true);
  assert.ok(drawn.zone.ring.length <= WATCH_LIMITS.maxTotalVertices);
  assert.ok(drawn.zone.ring.length - 1 <= 64);

  const outline = roundRing(52.5, 13.4, 40, 20_000, 0.05);
  const voice = zoneFromAnnotation(
    { type: 'area', label: 'Berlin', ring: [...outline, outline[0]] },
    ctx(),
  );
  assert.equal(voice.ok, true);
  assert.equal(voice.simplified, true);
  assert.ok(voice.zone.ring.length - 1 <= 64);
  assert.ok(voice.zone.ring.length - 1 >= 3);

  const tooMany = roundRing(52.5, 13.4, 40, 20_001, 0.05);
  assert.equal(
    zoneFromAnnotation({ type: 'area', ring: tooMany }, ctx()).code,
    'too-many',
  );
});

test('zoneFromAnnotation refuses everything else', () => {
  const unsupported = { ok: false, code: 'unsupported-annotation' };
  const ring = square(0, 0, 1);
  for (const record of [
    null,
    undefined,
    'area',
    [],
    { type: 'route', path: ring },
    { type: 'arrow', anchor: { lat: 0, lon: 0 }, to: { lat: 1, lon: 1 } },
    { type: 'label', anchor: { lat: 0, lon: 0 } },
    { type: 'highlight', ring, anchor: { lat: 0.5, lon: 0.5 } },
    { type: 'area', ring: null, pendingOutline: true },
    { type: 'area', ring: [] },
    { type: 'pin' },
    { type: 'pin', anchor: null },
  ]) {
    assert.deepEqual(zoneFromAnnotation(record, ctx()), unsupported);
  }
});

// ---------------------------------------------------------------------------
// updateZone.
// ---------------------------------------------------------------------------

test('updateZone renames, changes geometry and merges filters', () => {
  const zone = circleZone('z-edit01');
  const renamed = updateZone(zone, { name: ' Port ' }, { nowMs: NOW + 10 });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.zone.name, 'Port');
  assert.equal(renamed.geometryChanged, false);
  assert.equal(renamed.zone.updatedAtMs, NOW + 10);
  assert.equal(renamed.zone.createdAtMs, NOW);
  assert.equal(zone.name, 'Zone z-edit01');

  const moved = updateZone(zone, { radiusM: 100_000 }, { nowMs: NOW + 20 });
  assert.equal(moved.geometryChanged, true);
  assert.equal(moved.zone.radiusM, 100_000);
  const recentred = updateZone(
    zone,
    { center: { lat: 41, lon: -100 } },
    { nowMs: NOW + 20 },
  );
  assert.equal(recentred.geometryChanged, true);
  assert.deepEqual(recentred.zone.center, { lat: 41, lon: -100 });

  const filters = updateZone(
    zone,
    {
      kinds: ['quake', 'aircraft'],
      notify: 'watchlisted',
      aircraft: { militaryOnly: true },
      fire: { minFrpMw: 50 },
      quake: { bufferKm: 25 },
    },
    { nowMs: NOW + 30 },
  );
  assert.equal(filters.ok, true);
  assert.equal(filters.geometryChanged, false);
  assert.deepEqual(filters.zone.kinds, ['aircraft', 'quake']);
  assert.equal(filters.zone.notify, 'watchlisted');
  assert.deepEqual(filters.zone.aircraft, { militaryOnly: true });
  assert.deepEqual(filters.zone.fire, { minFrpMw: 50 });
  assert.deepEqual(filters.zone.quake, {
    minMagnitude: 2.5,
    alertMagnitude: 5,
    bufferKm: 25,
  });
  assert.deepEqual(Object.keys(filters.zone), ZONE_KEYS_CIRCLE);
});

test('updateZone returns the same zone when nothing changes', () => {
  const zone = circleZone('z-same01');
  for (const patch of [
    {},
    { name: zone.name },
    { radiusM: 25_000 },
    { quake: {} },
  ]) {
    const result = updateZone(zone, patch, { nowMs: NOW + 99 });
    assert.equal(result.ok, true);
    assert.equal(result.zone, zone);
    assert.equal(result.geometryChanged, false);
  }
  // No clock is needed for a no-op.
  assert.equal(updateZone(zone, {}, {}).zone, zone);
});

test('updateZone rejects unknown keys and invalid values', () => {
  const zone = circleZone('z-bad001');
  const polygon = polygonZone('z-poly01', square(0, 0, 0.5));
  const at = { nowMs: NOW + 1 };
  assert.equal(updateZone(zone, { owner: 'x' }, at).code, 'bad-patch');
  assert.equal(updateZone(zone, { shape: 'polygon' }, at).code, 'bad-patch');
  assert.equal(updateZone(zone, { id: 'z-other1' }, at).code, 'bad-patch');
  assert.equal(updateZone(zone, null, at).code, 'bad-patch');
  assert.equal(
    updateZone(zone, { ring: square(0, 0, 1) }, at).code,
    'bad-patch',
  );
  assert.equal(updateZone(polygon, { radiusM: 5_000 }, at).code, 'bad-patch');
  assert.equal(updateZone(zone, { radiusM: 999 }, at).code, 'bad-radius');
  assert.equal(
    updateZone(zone, { center: { lat: 89, lon: 0 } }, at).code,
    'pole',
  );
  assert.equal(updateZone(zone, { name: ' ' }, at).code, 'bad-name');
  assert.equal(updateZone(zone, { kinds: [] }, at).code, 'bad-kinds');
  assert.equal(updateZone(zone, { notify: 'loud' }, at).code, 'bad-notify');
  assert.equal(
    updateZone(zone, { aircraft: { militaryOnly: 'yes' } }, at).code,
    'bad-filter',
  );
  assert.equal(
    updateZone(zone, { fire: { minFrpMw: -1 } }, at).code,
    'bad-filter',
  );
  assert.equal(updateZone(zone, { fire: { owner: 1 } }, at).code, 'bad-filter');
  assert.equal(
    updateZone(zone, { quake: { minMagnitude: Number.NaN } }, at).code,
    'bad-filter',
  );
  assert.equal(updateZone(zone, { quake: 5 }, at).code, 'bad-filter');
  assert.equal(updateZone(zone, { name: 'New' }, {}).code, 'bad-time');
  assert.equal(updateZone({ ...zone, owner: 'x' }, {}, at).code, 'invalid');
  assert.equal(updateZone(null, {}, at).code, 'invalid');
});

test('updateZone replaces a polygon ring', () => {
  const polygon = polygonZone('z-poly02', square(0, 0, 0.5));
  const bigger = updateZone(
    polygon,
    { ring: square(0, 0, 1) },
    { nowMs: NOW + 5 },
  );
  assert.equal(bigger.ok, true);
  assert.equal(bigger.geometryChanged, true);
  assert.equal(bigger.simplified, false);
  const bowTie = updateZone(
    polygon,
    {
      ring: [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
    },
    { nowMs: NOW + 5 },
  );
  assert.equal(bowTie.code, 'self-intersecting');
  const dense = updateZone(
    polygon,
    { ring: roundRing(0, 0, 30, 300) },
    { nowMs: NOW + 5 },
  );
  assert.equal(dense.ok, true);
  assert.equal(dense.simplified, true);
});

// ---------------------------------------------------------------------------
// Document mutators and limits.
// ---------------------------------------------------------------------------

test('the 25th zone is rejected', () => {
  let doc = emptyWatchDocument();
  for (let i = 0; i < 24; i += 1) {
    const result = addZone(doc, circleZone(`z-n${String(i).padStart(4, '0')}`));
    assert.equal(result.ok, true);
    doc = result.doc;
  }
  assert.equal(doc.zones.length, 24);
  assert.deepEqual(addZone(doc, circleZone('z-extra1')), {
    ok: false,
    code: 'full',
  });
  assert.equal(addZone(doc, circleZone('z-n0003')).code, 'duplicate');
});

test('the total vertex budget is enforced', () => {
  let doc = emptyWatchDocument();
  for (let i = 0; i < 16; i += 1) {
    const zone = polygonZone(
      `z-v${String(i).padStart(4, '0')}`,
      roundRing(10 + i, 20, 20, 64),
    );
    assert.equal(zone.ring.length, 65);
    const result = addZone(doc, zone);
    assert.equal(result.ok, true, result.code);
    doc = result.doc;
  }
  const extra = polygonZone('z-vextra', square(0, 0, 0.5));
  assert.deepEqual(addZone(doc, extra), {
    ok: false,
    code: 'too-many-vertices',
  });
  // Circles add no vertices.
  assert.equal(addZone(doc, circleZone('z-circle1')).ok, true);
  // Replacing a 64-vertex ring with a 4-vertex one frees budget.
  const smaller = updateZone(
    doc.zones[0],
    { ring: square(0, 0, 0.5) },
    { nowMs: NOW + 1 },
  ).zone;
  const replaced = replaceZone(doc, smaller);
  assert.equal(replaced.ok, true);
  assert.equal(addZone(replaced.doc, extra).ok, true);
  assert.equal(serializeWatchDocument(doc).length > 0, true);
});

test('addZone, replaceZone and removeZone are immutable', () => {
  const doc = deepFreeze(sampleDocument());
  const before = JSON.stringify(doc);
  const zone = circleZone('z-new001');
  const added = addZone(doc, zone);
  assert.equal(added.ok, true);
  assert.equal(added.doc.zones.length, 3);
  assert.equal(doc.zones.length, 2);
  assert.equal(added.doc.watchlist, doc.watchlist);

  const changed = updateZone(
    doc.zones[0],
    { name: 'Renamed' },
    { nowMs: NOW + 9 },
  );
  assert.equal(changed.ok, true);
  const replaced = replaceZone(doc, changed.zone);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.doc.zones[0].name, 'Renamed');
  assert.equal(replaced.doc.zones[1], doc.zones[1]);
  assert.equal(replaceZone(doc, zone).code, 'not-found');
  assert.equal(replaceZone(doc, { ...zone, owner: 1 }).code, 'invalid');

  const removed = removeZone(doc, 'z-harbour');
  assert.equal(removed.ok, true);
  assert.deepEqual(
    removed.doc.zones.map((item) => item.id),
    ['z-delta01'],
  );
  assert.equal(removeZone(doc, 'z-missing').code, 'not-found');
  assert.equal(addZone(null, zone).code, 'invalid');
  assert.equal(addZone(doc, { ...zone, extra: true }).code, 'invalid');
  assert.equal(addZone(doc, { ...zone, id: 'zone-1' }).code, 'invalid');
  assert.equal(JSON.stringify(doc), before);
});

// ---------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------

test('parseWatchInput accepts and normalises the identifier grammar', () => {
  const ok = (match, value) => parseWatchInput({ match, value });
  assert.deepEqual(ok('icao24', '~a1b2c3'), {
    ok: true,
    entry: { kind: 'aircraft', match: 'icao24', value: '~a1b2c3' },
  });
  assert.equal(ok('icao24', ' A1B2C3 ').entry.value, 'a1b2c3');
  assert.equal(ok('icao24', '~A1B2C3').entry.value, '~a1b2c3');
  assert.deepEqual(ok('callsign', ' baw 12 3 '), {
    ok: true,
    entry: { kind: 'aircraft', match: 'callsign', value: 'BAW123' },
  });
  assert.equal(ok('callsign', 'N1').entry.value, 'N1');
  assert.deepEqual(ok('mmsi', '366 999 712'), {
    ok: true,
    entry: { kind: 'vessel', match: 'mmsi', value: '366999712' },
  });
  assert.equal(ok('mmsi', 366999712).entry.value, '366999712');
  assert.deepEqual(ok('norad', '25544'), {
    ok: true,
    entry: { kind: 'satellite', match: 'norad', value: '25544' },
  });
  assert.equal(ok('norad', '0025544').entry.value, '25544');
  assert.equal(ok('norad', 25544).entry.value, '25544');
  assert.equal(ok('norad', ' 7 ').entry.value, '7');
  assert.equal(ok('norad', '999999999').entry.value, '999999999');
});

test('parseWatchInput rejects bad identifiers and types', () => {
  const code = (match, value) => parseWatchInput({ match, value }).code;
  assert.equal(code('mmsi', '36699971'), 'bad-id'); // 8 digits
  assert.equal(code('mmsi', '3669997120'), 'bad-id');
  assert.equal(code('mmsi', '36699971a'), 'bad-id');
  assert.equal(code('norad', 0), 'bad-id');
  assert.equal(code('norad', '0'), 'bad-id');
  assert.equal(code('norad', '000'), 'bad-id');
  assert.equal(code('norad', '-5'), 'bad-id');
  assert.equal(code('norad', '1e3'), 'bad-id');
  assert.equal(code('norad', '0x10'), 'bad-id');
  assert.equal(code('norad', '25544.5'), 'bad-id');
  assert.equal(code('norad', 25544.5), 'bad-id');
  assert.equal(code('norad', '1234567890'), 'bad-id');
  assert.equal(code('norad', ''), 'bad-id');
  assert.equal(code('icao24', 'a1b2c'), 'bad-id');
  assert.equal(code('icao24', 'a1b2c3d'), 'bad-id');
  assert.equal(code('icao24', 'g1b2c3'), 'bad-id');
  assert.equal(code('icao24', '~~a1b2c3'), 'bad-id');
  assert.equal(code('callsign', 'B'), 'bad-id');
  assert.equal(code('callsign', 'ABCDEFGHI'), 'bad-id');
  assert.equal(code('callsign', 'BAW*'), 'bad-id'); // no prefixes or wildcards
  assert.equal(code('callsign', 'BAW-12'), 'bad-id');
  assert.equal(code('callsign', 'x'.repeat(200)), 'bad-id');
  assert.equal(code('icao24', null), 'bad-id');
  assert.equal(code('icao24', { value: 'a1b2c3' }), 'bad-id');
  assert.equal(code('icao24', Number.POSITIVE_INFINITY), 'bad-id');
  assert.equal(code('registration', 'G-ABCD'), 'bad-match');
  assert.equal(code('owner', 'x'), 'bad-match');
  assert.equal(code('__proto__', 'x'), 'bad-match');
  assert.equal(code('toString', 'x'), 'bad-match');
  assert.equal(parseWatchInput(null).code, 'bad-match');
  assert.equal(parseWatchInput(undefined).code, 'bad-match');
});

test('addWatchEntry adds identifier-only entries and enforces limits', () => {
  const doc = deepFreeze(emptyWatchDocument());
  const result = addWatchEntry(
    doc,
    { match: 'callsign', value: 'baw 123', label: ' Speedbird\n123 ' },
    { nowMs: NOW, makeId: idMaker() },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.entry), ENTRY_KEYS);
  assert.deepEqual(result.entry, {
    id: 'w-id0001',
    kind: 'aircraft',
    match: 'callsign',
    value: 'BAW123',
    label: 'Speedbird 123',
    addedAtMs: NOW,
    declined: null,
    lastSeen: null,
  });
  assert.deepEqual(result.doc.watchlist, [result.entry]);
  assert.equal(doc.watchlist.length, 0);

  const at = { nowMs: NOW, makeId: idMaker({ start: 10 }) };
  assert.equal(
    addWatchEntry(result.doc, { match: 'callsign', value: 'BAW123' }, at).code,
    'duplicate',
  );
  assert.equal(
    addWatchEntry(doc, { match: 'mmsi', value: '1234' }, at).code,
    'bad-id',
  );
  assert.equal(
    addWatchEntry(doc, { match: 'tail', value: 'G-ABCD' }, at).code,
    'bad-match',
  );
  assert.equal(
    addWatchEntry(doc, { kind: 'vessel', match: 'icao24', value: 'a1b2c3' }, at)
      .code,
    'bad-match',
  );
  assert.equal(addWatchEntry(doc, null, at).code, 'bad-match');
  assert.equal(
    addWatchEntry(
      doc,
      { match: 'icao24', value: 'a1b2c3' },
      { makeId: idMaker() },
    ).code,
    'bad-time',
  );
  assert.equal(
    addWatchEntry(doc, { match: 'icao24', value: 'a1b2c3' }, { nowMs: NOW })
      .code,
    'id-unavailable',
  );
  assert.equal(
    addWatchEntry(
      result.doc,
      { match: 'icao24', value: 'a1b2c3' },
      { nowMs: NOW, makeId: () => 'w-id0001' },
    ).code,
    'id-unavailable',
  );
  assert.equal(
    addWatchEntry(null, { match: 'icao24', value: 'a1b2c3' }, at).code,
    'invalid',
  );
  // Non-string labels are dropped, long ones cut to 40 code points.
  const labelled = addWatchEntry(
    doc,
    { match: 'icao24', value: 'a1b2c3', label: 'L'.repeat(90) },
    at,
  );
  assert.equal(labelled.entry.label.length, 40);
  assert.equal(
    addWatchEntry(doc, { match: 'icao24', value: 'a1b2c3', label: 7 }, at).entry
      .label,
    null,
  );
});

test('the 51st watch entry is rejected', () => {
  let doc = emptyWatchDocument();
  const make = idMaker();
  for (let i = 1; i <= 50; i += 1) {
    const result = addWatchEntry(
      doc,
      { match: 'mmsi', value: String(366_000_000 + i) },
      { nowMs: NOW + i, makeId: make },
    );
    assert.equal(result.ok, true);
    doc = result.doc;
  }
  assert.equal(doc.watchlist.length, 50);
  assert.deepEqual(
    addWatchEntry(
      doc,
      { match: 'mmsi', value: '366000051' },
      { nowMs: NOW, makeId: make },
    ),
    { ok: false, code: 'full' },
  );
  // An entry that is already watched reads as a duplicate, even when full.
  assert.equal(
    addWatchEntry(
      doc,
      { match: 'mmsi', value: '366000001' },
      { nowMs: NOW, makeId: make },
    ).code,
    'duplicate',
  );
  const removed = removeWatchEntry(doc, doc.watchlist[0].id);
  assert.equal(removed.ok, true);
  assert.equal(removed.doc.watchlist.length, 49);
  assert.equal(removeWatchEntry(doc, 'w-missing').code, 'not-found');
  assert.equal(removeWatchEntry(null, 'w-missing').code, 'invalid');
});

test('markDeclined drops the stored position and blocks new ones', () => {
  const doc = deepFreeze(sampleDocument());
  const entry = doc.watchlist[0];
  assert.notEqual(entry.lastSeen, null);
  const declined = markDeclined(doc, entry.id, 'private-aircraft-class');
  assert.equal(declined.ok, true);
  assert.equal(declined.doc.watchlist[0].declined, 'private-aircraft-class');
  assert.equal(declined.doc.watchlist[0].lastSeen, null);
  assert.equal(declined.doc.watchlist[1], doc.watchlist[1]);
  assert.equal(doc.watchlist[0].declined, null);
  // Unchanged decline returns the same document.
  const again = markDeclined(declined.doc, entry.id, 'private-aircraft-class');
  assert.equal(again.doc, declined.doc);
  assert.equal(
    setLastSeen(declined.doc, entry.id, {
      atMs: NOW,
      lat: 1,
      lon: 2,
      layerId: 'flights',
    }).code,
    'declined',
  );
  // Clearing a position on a declined entry is still allowed.
  assert.equal(setLastSeen(declined.doc, entry.id, null).ok, true);
  const cleared = markDeclined(declined.doc, entry.id, null);
  assert.equal(cleared.doc.watchlist[0].declined, null);
  assert.equal(markDeclined(doc, entry.id, 'dark').code, 'bad-code');
  assert.equal(markDeclined(doc, 'w-missing', null).code, 'not-found');
  assert.equal(markDeclined(null, entry.id, null).code, 'invalid');
});

test('setLastSeen stores one validated fix', () => {
  const doc = deepFreeze(sampleDocument());
  const id = doc.watchlist[1].id;
  const fix = { layerId: 'ais-live-vessels', lon: 32.5, lat: 30.1, atMs: NOW };
  const stored = setLastSeen(doc, id, fix);
  assert.equal(stored.ok, true);
  assert.deepEqual(Object.keys(stored.doc.watchlist[1].lastSeen), [
    'atMs',
    'lat',
    'lon',
    'layerId',
  ]);
  assert.deepEqual(stored.doc.watchlist[1].lastSeen, {
    atMs: NOW,
    lat: 30.1,
    lon: 32.5,
    layerId: 'ais-live-vessels',
  });
  assert.equal(setLastSeen(stored.doc, id, { ...fix }).doc, stored.doc);
  assert.equal(
    setLastSeen(stored.doc, id, null).doc.watchlist[1].lastSeen,
    null,
  );
  for (const bad of [
    { ...fix, lat: 91 },
    { ...fix, lon: -181 },
    { ...fix, atMs: -1 },
    { ...fix, atMs: Number.NaN },
    { ...fix, layerId: 'Flights!' },
    { ...fix, layerId: '' },
    { atMs: NOW, lat: 1, lon: 2 },
    { ...fix, owner: 'x' },
    'here',
    [],
  ]) {
    assert.equal(setLastSeen(doc, id, bad).code, 'bad-last-seen');
  }
  assert.equal(setLastSeen(doc, 'w-missing', fix).code, 'not-found');
});

test('setPrefs merges boolean preferences only', () => {
  const doc = deepFreeze(emptyWatchDocument());
  const result = setPrefs(doc, { zonesVisible: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.doc.prefs, {
    zonesVisible: false,
    toasts: true,
    allEmergencies: false,
  });
  assert.equal(doc.prefs.zonesVisible, true);
  assert.equal(setPrefs(doc, { toasts: 'no' }).code, 'bad-prefs');
  assert.equal(setPrefs(doc, { sound: true }).code, 'bad-prefs');
  assert.equal(setPrefs(doc, null).code, 'bad-prefs');
  assert.equal(setPrefs(null, {}).code, 'invalid');
});

// ---------------------------------------------------------------------------
// Selection.
// ---------------------------------------------------------------------------

test('watchEntryFromSelection handles every selection shape', () => {
  // gev:awareness-subject-selected from flights, military and satellites.
  assert.deepEqual(
    watchEntryFromSelection({
      layerId: 'flights',
      id: 'a1b2c3',
      label: 'BAW123',
      position: { x: 1, y: 2, z: 3 },
      origin: 'user',
    }),
    { kind: 'aircraft', match: 'icao24', value: 'a1b2c3', label: 'BAW123' },
  );
  assert.deepEqual(
    watchEntryFromSelection({ layerId: 'flights', id: '~a1b2c3', label: null }),
    { kind: 'aircraft', match: 'icao24', value: '~a1b2c3', label: null },
  );
  assert.deepEqual(
    watchEntryFromSelection({
      layerId: 'military',
      id: 'AE1234',
      label: 'RCH123',
      origin: 'programmatic',
    }),
    { kind: 'aircraft', match: 'icao24', value: 'ae1234', label: 'RCH123' },
  );
  assert.deepEqual(
    watchEntryFromSelection({
      layerId: 'satellites',
      id: 25544,
      label: 'ISS (ZARYA)',
    }),
    { kind: 'satellite', match: 'norad', value: '25544', label: 'ISS (ZARYA)' },
  );
  assert.deepEqual(
    watchEntryFromSelection({ layerId: 'satellites', id: '43013' }),
    { kind: 'satellite', match: 'norad', value: '43013', label: null },
  );
  // gev:entity-selected from live AIS vessels (a context-store record).
  const vessel = {
    id: 'ais-366999712',
    layerId: 'ais-live-vessels',
    layerName: 'Live AIS Vessels',
    label: 'EVER\u202e GIVEN',
    latitude: 30.1,
    longitude: 32.5,
    properties: { mmsi: '366999712', type: 70, speedKt: 11.2 },
    entity: { id: 'cesium-entity' },
    updatedAt: NOW,
  };
  assert.deepEqual(watchEntryFromSelection(vessel), {
    kind: 'vessel',
    match: 'mmsi',
    value: '366999712',
    label: 'EVER GIVEN',
  });
  assert.equal(
    watchEntryFromSelection({ ...vessel, properties: { mmsi: 366999712 } })
      .value,
    '366999712',
  );
  // Long labels are cut to 40 code points.
  assert.equal(
    watchEntryFromSelection({
      layerId: 'flights',
      id: 'a1b2c3',
      label: 'x'.repeat(99),
    }).label.length,
    40,
  );
  // Everything else gives null.
  for (const detail of [
    null,
    undefined,
    'flights',
    { layerId: 'local-adsb', id: 'a1b2c3', label: 'N123AB' },
    { layerId: 'cctv', id: 'cam-12', label: 'Camera' },
    { layerId: 'alpr-cameras', id: 'alpr-3', label: 'Reader' },
    { layerId: 'military-installations', id: 'base-1' },
    { layerId: 'earthquakes', id: 'us7000abcd' },
    { layerId: 'flights' },
    { layerId: 'flights', id: 'not-hex' },
    { layerId: 'satellites', id: 0 },
    { layerId: 'satellites', id: 'ISS' },
    { layerId: 'ais-live-vessels', id: 'ais-366999712' },
    { layerId: 'ais-live-vessels', properties: { mmsi: '1234' } },
    { layerId: 'ais-live-vessels', properties: 'mmsi' },
    { id: 'a1b2c3' },
  ]) {
    assert.equal(watchEntryFromSelection(detail), null);
  }
});

test('a selection feeds addWatchEntry directly', () => {
  const selection = watchEntryFromSelection({
    layerId: 'ais-live-vessels',
    label: 'EVER GIVEN',
    properties: { mmsi: '353136000' },
  });
  const result = addWatchEntry(emptyWatchDocument(), selection, {
    nowMs: NOW,
    makeId: idMaker(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.entry.kind, 'vessel');
  assert.equal(result.entry.label, 'EVER GIVEN');
});

// ---------------------------------------------------------------------------
// Serialization and parsing.
// ---------------------------------------------------------------------------

test('serialization round-trips and is stable', () => {
  const doc = sampleDocument();
  const text = serializeWatchDocument(doc);
  const parsed = parseWatchDocument(text);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.dropped, { zones: 0, watchlist: 0 });
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.doc, doc);
  assert.equal(serializeWatchDocument(parsed.doc), text);
  // Key order of the input objects does not matter.
  assert.equal(serializeWatchDocument(reverseKeys(doc)), text);
  assert.ok(text.startsWith('{"v":1,"zones":[{"id":"z-harbour","name":'));
  assert.ok(
    text.endsWith(
      '"prefs":{"zonesVisible":true,"toasts":false,"allEmergencies":true}}',
    ),
  );
  // The antimeridian ring survives unchanged.
  assert.deepEqual(parsed.doc.zones[1].ring, doc.zones[1].ring);
  // Negative zero is written and read back as zero.
  const zero = addZone(
    emptyWatchDocument(),
    createCircleZone(
      { name: 'Null Island', center: { lat: -0, lon: -0 }, radiusM: 5_000 },
      ctx(),
    ).zone,
  ).doc;
  assert.deepEqual(parseWatchDocument(serializeWatchDocument(zero)).doc, zero);
  // The empty document round-trips too.
  const empty = emptyWatchDocument();
  assert.deepEqual(
    parseWatchDocument(serializeWatchDocument(empty)).doc,
    empty,
  );
});

test('serializeWatchDocument refuses invalid documents and oversize text', () => {
  const doc = sampleDocument();
  assert.throws(() => serializeWatchDocument(null), TypeError);
  assert.throws(
    () => serializeWatchDocument({ ...doc, v: 2 }),
    (error) =>
      error instanceof TypeError &&
      error.message === '$.v: unsupported version',
  );
  const secretZone = { ...doc.zones[0], notify: 'SECRET-NOTIFY-VALUE' };
  assert.throws(
    () => serializeWatchDocument({ ...doc, zones: [secretZone] }),
    (error) =>
      error instanceof TypeError &&
      error.message.startsWith('$.zones[0].notify:') &&
      !error.message.includes('SECRET'),
  );
  assert.throws(
    () =>
      serializeWatchDocument({ ...doc, zones: [doc.zones[0], doc.zones[0]] }),
    /duplicate ID/,
  );
  assert.throws(
    () => serializeWatchDocument({ ...doc, extra: 1 }),
    /unsupported field/,
  );
  const length = serializeWatchDocument(doc).length;
  assert.equal(
    serializeWatchDocument(doc, { maxChars: length }).length,
    length,
  );
  assert.throws(
    () => serializeWatchDocument(doc, { maxChars: length - 1 }),
    RangeError,
  );
});

test('a document at every limit stays under the size cap', () => {
  let doc = emptyWatchDocument();
  const wide = '\u{1f6f0}'.repeat(60); // 60 code points, 120 UTF-16 units
  for (let i = 0; i < 24; i += 1) {
    const id = `z-${'m'.repeat(20)}${String(i).padStart(4, '0')}`;
    const ring = roundRing(-60 + i * 5, 179.123456789 - i, 40, 64).map(
      ([lon, lat]) => [lon > 180 ? lon - 360 : lon, lat],
    );
    const zone = i < 16 ? polygonZone(id, ring) : circleZone(id);
    doc = addZone(
      doc,
      updateZone(zone, { name: wide }, { nowMs: NOW }).zone,
    ).doc;
  }
  const make = idMaker();
  for (let i = 0; i < 50; i += 1) {
    const result = addWatchEntry(
      doc,
      { match: 'mmsi', value: String(200_000_000 + i), label: '"'.repeat(40) },
      { nowMs: NOW, makeId: make },
    );
    doc = setLastSeen(result.doc, result.entry.id, {
      atMs: NOW,
      lat: -12.345678901234567,
      lon: -123.45678901234567,
      layerId: 'ais-live-vessels',
    }).doc;
  }
  assert.equal(doc.zones.length, 24);
  assert.equal(doc.watchlist.length, 50);
  const text = serializeWatchDocument(doc);
  assert.ok(text.length < WATCH_DOCUMENT_MAX_CHARS, `${text.length}`);
  assert.equal(parseWatchDocument(text).error, null);
});

test('parse error codes: malformed, unsupported-version, too-large', () => {
  const empty = emptyWatchDocument();
  for (const text of [
    '{',
    'not json',
    '',
    '[]',
    '5',
    'null',
    '"text"',
    '{"zones":[]}',
  ]) {
    const result = parseWatchDocument(text);
    assert.equal(result.error, 'malformed', text);
    assert.deepEqual(result.doc, empty);
  }
  assert.equal(parseWatchDocument(42).error, 'malformed');
  assert.equal(parseWatchDocument({ v: 1 }).error, 'malformed');
  assert.equal(parseWatchDocument('{"v":1,"zones":{}}').error, 'malformed');
  assert.equal(
    parseWatchDocument('{"v":1,"watchlist":"x"}').error,
    'malformed',
  );

  for (const v of [2, 0, '1', null, 1.5]) {
    const result = parseWatchDocument(
      JSON.stringify({ ...sampleDocument(), v }),
    );
    assert.equal(result.error, 'unsupported-version');
    assert.deepEqual(result.doc, empty);
  }

  const base = serializeWatchDocument(sampleDocument());
  const exact = base + ' '.repeat(WATCH_DOCUMENT_MAX_CHARS - base.length);
  assert.equal(exact.length, 256 * 1024);
  assert.equal(parseWatchDocument(exact).error, null);
  const over = parseWatchDocument(`${exact} `);
  assert.equal(over.error, 'too-large');
  assert.deepEqual(over.doc, empty);

  // Nothing stored is not an error.
  assert.deepEqual(parseWatchDocument(null), {
    doc: empty,
    error: null,
    dropped: { zones: 0, watchlist: 0 },
    issues: [],
  });
  assert.equal(parseWatchDocument(undefined).error, null);
  // A bare {v:1} is a valid empty document.
  assert.deepEqual(parseWatchDocument('{"v":1}'), {
    doc: empty,
    error: null,
    dropped: { zones: 0, watchlist: 0 },
    issues: [],
  });
});

test('__proto__ and other unsafe keys make the document malformed', () => {
  const zone = serializeWatchDocument(sampleDocument());
  for (const text of [
    '{"v":1,"__proto__":{"polluted":true}}',
    '{"v":1,"zones":[{"__proto__":{"polluted":true}}]}',
    zone.replace('"name":', '"__proto__":{"x":1},"name":'),
    zone.replace('"prefs":{', '"prefs":{"constructor":{},'),
    '{"v":1,"watchlist":[{"prototype":1}]}',
  ]) {
    const result = parseWatchDocument(text);
    assert.equal(result.error, 'malformed', text.slice(0, 60));
    assert.deepEqual(result.doc, emptyWatchDocument());
  }
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('one bad zone gives partial and keeps the rest', () => {
  const doc = sampleDocument();
  const raw = JSON.parse(serializeWatchDocument(doc));
  raw.zones.splice(1, 0, { ...raw.zones[0], id: 'z-broken1', radiusM: 500 });
  const result = parseWatchDocument(JSON.stringify(raw));
  assert.equal(result.error, 'partial');
  assert.deepEqual(result.dropped, { zones: 1, watchlist: 0 });
  assert.deepEqual(result.doc, doc);
  assert.deepEqual(result.issues, [
    {
      path: '$.zones[1].radiusM',
      reason: 'expected a number from 1000 to 1000000',
    },
  ]);
});

test('invalid zones and entries are dropped with their field path', () => {
  const doc = sampleDocument();
  const raw = JSON.parse(serializeWatchDocument(doc));
  const circle = raw.zones[0];
  const polygon = raw.zones[1];
  const bowTie = [
    [0, 0],
    [1, 1],
    [1, 0],
    [0, 1],
    [0, 0],
  ];
  raw.zones.push(
    { ...circle, id: 'z-extra01', owner: 'someone' },
    { ...polygon, id: 'z-extra02', ring: bowTie },
    { ...polygon, id: 'z-extra03', ring: square(0, 0, 0.01) },
    { ...polygon, id: 'z-extra04', ring: [...roundRing(0, 0, 30, 70), [0, 0]] },
    { ...circle, id: 'z-extra05', ring: bowTie },
    { ...circle, id: 'z-extra06', kinds: ['aircraft', 'people'] },
    { ...circle, id: 'z-extra07', notify: 'SECRET-NOTIFY' },
    { ...circle, id: 'z-extra08', quake: { minMagnitude: 2.5, bufferKm: 0 } },
    { ...circle, id: 'z-harbour' },
    { ...circle, id: 'not-a-zone-id' },
    { ...circle, name: '\u202e\u0000' },
    { ...circle, id: 'z-extra09', shape: 'hexagon' },
    'zone',
  );
  raw.watchlist.push(
    { ...raw.watchlist[1], id: 'w-extra01', value: 'SECRET-36699' },
    { ...raw.watchlist[1], id: 'w-extra02', owner: 'A. Person' },
    { ...raw.watchlist[1], id: 'w-extra03', kind: 'aircraft' },
    { ...raw.watchlist[1], id: 'w-extra04', value: '366999712' },
    { ...raw.watchlist[1], id: raw.watchlist[0].id, value: '111111111' },
    { ...raw.watchlist[1], id: 'w-extra05', declined: 'dark' },
    {
      ...raw.watchlist[1],
      id: 'w-extra06',
      value: '222222222',
      lastSeen: { atMs: 1, lat: 95, lon: 0, layerId: 'flights' },
    },
    { ...raw.watchlist[1], id: 'w-extra07', registrant: 'Someone' },
  );
  raw.unknownTopLevel = { anything: true };
  const result = parseWatchDocument(JSON.stringify(raw));
  assert.equal(result.error, 'partial');
  assert.deepEqual(result.dropped, { zones: 13, watchlist: 8 });
  assert.deepEqual(result.doc, doc);
  const paths = result.issues.map((issue) => issue.path);
  assert.deepEqual(paths, [
    '$.unknownTopLevel',
    '$.zones[2].owner',
    '$.zones[3].ring',
    '$.zones[4].ring',
    '$.zones[5].ring',
    '$.zones[6].ring',
    '$.zones[7].kinds',
    '$.zones[8].notify',
    '$.zones[9].quake.alertMagnitude',
    '$.zones[10].id',
    '$.zones[11].id',
    '$.zones[12].name',
    '$.zones[13].shape',
    '$.zones[14]',
    '$.watchlist[2].value',
    '$.watchlist[3].owner',
    '$.watchlist[4].kind',
    '$.watchlist[5].value',
    '$.watchlist[6].id',
    '$.watchlist[7].declined',
    '$.watchlist[8].lastSeen.lat',
    '$.watchlist[9].registrant',
  ]);
  const reasons = Object.fromEntries(
    result.issues.map((issue) => [issue.path, issue.reason]),
  );
  assert.equal(reasons['$.zones[3].ring'], 'ring rejected: self-intersecting');
  assert.equal(reasons['$.zones[4].ring'], 'ring rejected: too-small');
  assert.equal(reasons['$.zones[10].id'], 'duplicate ID');
  assert.equal(reasons['$.watchlist[5].value'], 'duplicate identifier');
  // Errors carry the field path, never the value.
  const serialized = JSON.stringify(result);
  for (const secret of [
    'SECRET',
    'someone',
    'A. Person',
    'Someone',
    'people',
    'hexagon',
    'dark',
  ]) {
    assert.ok(!serialized.includes(secret), secret);
  }
});

test('over-limit stored lists keep the first valid entries', () => {
  const zones = [];
  for (let i = 0; i < 30; i += 1) {
    zones.push(circleZone(`z-o${String(i).padStart(4, '0')}`));
  }
  const watchlist = [];
  for (let i = 0; i < 55; i += 1) {
    watchlist.push({
      id: `w-o${String(i).padStart(4, '0')}`,
      kind: 'vessel',
      match: 'mmsi',
      value: String(300_000_000 + i),
      label: null,
      addedAtMs: NOW,
      declined: null,
      lastSeen: null,
    });
  }
  const text = JSON.stringify({
    v: 1,
    zones,
    watchlist,
    prefs: WATCH_PREF_DEFAULTS,
  });
  const result = parseWatchDocument(text);
  assert.equal(result.error, 'partial');
  assert.deepEqual(result.dropped, { zones: 6, watchlist: 5 });
  assert.equal(result.doc.zones.length, 24);
  assert.equal(result.doc.zones[23].id, 'z-o0023');
  assert.equal(result.doc.watchlist.length, 50);

  // The vertex budget applies to stored documents too.
  const polygons = [];
  for (let i = 0; i < 17; i += 1) {
    polygons.push(
      polygonZone(
        `z-p${String(i).padStart(4, '0')}`,
        roundRing(10, 20 + i, 20, 64),
      ),
    );
  }
  const heavy = parseWatchDocument(JSON.stringify({ v: 1, zones: polygons }));
  assert.equal(heavy.error, 'partial');
  assert.deepEqual(heavy.dropped, { zones: 1, watchlist: 0 });
  assert.equal(heavy.doc.zones.length, 16);
  assert.deepEqual(heavy.issues, [
    { path: '$.zones[16].ring', reason: 'vertex budget exceeded' },
  ]);
});

test('prefs and lenient normalisation on parse', () => {
  const doc = sampleDocument();
  const raw = JSON.parse(serializeWatchDocument(doc));
  // Missing prefs keys fall back to defaults without an error.
  const partialPrefs = parseWatchDocument(
    JSON.stringify({ ...raw, prefs: { toasts: false } }),
  );
  assert.equal(partialPrefs.error, null);
  assert.deepEqual(partialPrefs.doc.prefs, {
    zonesVisible: true,
    toasts: false,
    allEmergencies: false,
  });
  // Invalid prefs fall back to defaults and mark the read partial.
  const badPrefs = parseWatchDocument(
    JSON.stringify({ ...raw, prefs: { toasts: 'sometimes', theme: 'x' } }),
  );
  assert.equal(badPrefs.error, 'partial');
  assert.deepEqual(badPrefs.doc.prefs, WATCH_PREF_DEFAULTS);
  assert.deepEqual(badPrefs.dropped, { zones: 0, watchlist: 0 });
  assert.equal(badPrefs.doc.zones.length, 2);

  // Names are cleaned, kinds made canonical, identifiers normalised and a
  // declined entry loses its stored position.
  raw.zones[0].name = '  Harbour\u202e  zone ';
  raw.zones[0].kinds = ['vessel', 'aircraft', 'vessel'];
  raw.watchlist[0].value = 'A1B2C3';
  raw.watchlist[0].declined = 'private-aircraft-class';
  raw.watchlist[1].label = '';
  const lenient = parseWatchDocument(JSON.stringify(raw));
  assert.equal(lenient.error, null);
  assert.equal(lenient.doc.zones[0].name, 'Harbour zone');
  assert.deepEqual(lenient.doc.zones[0].kinds, ['aircraft', 'vessel']);
  assert.equal(lenient.doc.watchlist[0].value, 'a1b2c3');
  assert.equal(lenient.doc.watchlist[0].lastSeen, null);
  assert.equal(lenient.doc.watchlist[1].label, null);
});

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

test('readStoredWatchDocument reads through the injected storage', () => {
  const doc = sampleDocument();
  const text = serializeWatchDocument(doc);
  const stored = readStoredWatchDocument(
    memoryStorage({ [WATCH_STORAGE_KEY]: text }),
  );
  assert.equal(stored.readError, null);
  assert.equal(stored.raw, text);
  assert.deepEqual(stored.doc, doc);

  const nothing = readStoredWatchDocument(memoryStorage());
  assert.deepEqual(nothing, {
    doc: emptyWatchDocument(),
    readError: null,
    raw: null,
    dropped: { zones: 0, watchlist: 0 },
    issues: [],
  });

  const broken = readStoredWatchDocument(
    memoryStorage({ [WATCH_STORAGE_KEY]: '{"v":1,' }),
  );
  assert.equal(broken.readError, 'malformed');
  assert.equal(broken.raw, '{"v":1,');
  assert.deepEqual(broken.doc, emptyWatchDocument());

  const newer = readStoredWatchDocument(
    memoryStorage({ [WATCH_STORAGE_KEY]: '{"v":2,"zones":[]}' }),
  );
  assert.equal(newer.readError, 'unsupported-version');

  const throwing = readStoredWatchDocument({
    getItem() {
      throw new Error('SecurityError');
    },
  });
  assert.equal(throwing.readError, 'unavailable');
  assert.deepEqual(throwing.doc, emptyWatchDocument());
  assert.equal(throwing.raw, null);

  for (const storage of [null, undefined, {}]) {
    const result = readStoredWatchDocument(storage);
    assert.equal(result.readError, null);
    assert.deepEqual(result.doc, emptyWatchDocument());
  }
});

test('a write after a read error is refused and nothing is overwritten', () => {
  for (const initial of [
    '{"v":1,',
    '{"v":9}',
    JSON.stringify({ v: 1, zones: [{}] }),
  ]) {
    const storage = memoryStorage({ [WATCH_STORAGE_KEY]: initial });
    const read = readStoredWatchDocument(storage);
    assert.ok(read.readError);
    const doc = addZone(read.doc, circleZone('z-after01')).doc;
    assert.deepEqual(
      writeStoredWatchDocument(doc, storage, { readError: read.readError }),
      {
        ok: false,
        reason: 'read-error',
      },
    );
    assert.equal(storage.calls.set, 0);
    assert.equal(storage.map.get(WATCH_STORAGE_KEY), initial);
    // After the person chooses to keep the loaded entries, the write goes through.
    assert.deepEqual(
      writeStoredWatchDocument(doc, storage, { readError: null }),
      {
        ok: true,
      },
    );
    assert.equal(
      storage.map.get(WATCH_STORAGE_KEY),
      serializeWatchDocument(doc),
    );
  }
  const unavailable = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('should not be called');
    },
  };
  const read = readStoredWatchDocument(unavailable);
  assert.equal(
    writeStoredWatchDocument(read.doc, unavailable, read).reason,
    'read-error',
  );
});

test('writeStoredWatchDocument reports storage failures by reason', () => {
  const doc = sampleDocument();
  const storage = memoryStorage();
  assert.deepEqual(writeStoredWatchDocument(doc, storage), { ok: true });
  assert.equal(storage.map.get(WATCH_STORAGE_KEY), serializeWatchDocument(doc));
  assert.deepEqual(readStoredWatchDocument(storage).doc, doc);

  const throwing = (error) => ({
    setItem() {
      throw error;
    },
  });
  assert.deepEqual(
    writeStoredWatchDocument(doc, throwing(new Error('blocked'))),
    {
      ok: false,
      reason: 'unavailable',
    },
  );
  assert.deepEqual(
    writeStoredWatchDocument(
      doc,
      throwing(new DOMException('full', 'QuotaExceededError')),
    ),
    { ok: false, reason: 'quota' },
  );
  assert.equal(
    writeStoredWatchDocument(
      doc,
      throwing({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }),
    ).reason,
    'quota',
  );
  assert.equal(
    writeStoredWatchDocument(doc, throwing({ name: 'Error', code: 22 })).reason,
    'quota',
  );
  for (const missing of [null, undefined, {}, { setItem: 'no' }]) {
    assert.deepEqual(writeStoredWatchDocument(doc, missing), {
      ok: false,
      reason: 'unavailable',
    });
  }
  const small = memoryStorage();
  assert.deepEqual(writeStoredWatchDocument(doc, small, { maxChars: 100 }), {
    ok: false,
    reason: 'too-large',
  });
  assert.equal(small.calls.set, 0);
  assert.deepEqual(writeStoredWatchDocument({ ...doc, v: 3 }, small), {
    ok: false,
    reason: 'invalid',
  });
  assert.equal(small.calls.set, 0);
});

// ---------------------------------------------------------------------------
// Portability and "the line".
// ---------------------------------------------------------------------------

test('document.js stays portable and identifier-only', () => {
  const source = readFileSync(
    new URL('./document.js', import.meta.url),
    'utf8',
  );
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), [
    '../director/documentFields.js',
    './geometry.js',
  ]);
  const code = stripComments(source);
  for (const pattern of [
    /\bDate\.now\b/,
    /\bnew Date\b/,
    /\bMath\.random\b/,
    /\b(?:localStorage|sessionStorage|indexedDB)\b/,
    /\bglobalThis\b/,
    /\b(?:window|document|navigator)\s*(?:\.|\?\.|\[)/,
    /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/,
    /cesium/i,
    /i18n/,
    /\b(?:label|title|status|hint)\s*:\s*['"`]/,
    /owner|registrant|person/i,
  ]) {
    assert.ok(!pattern.test(code), String(pattern));
  }
});

test('created zones and entries carry identifier fields only', () => {
  const doc = sampleDocument();
  for (const zone of doc.zones) {
    assert.deepEqual(
      Object.keys(zone),
      zone.shape === 'circle' ? ZONE_KEYS_CIRCLE : ZONE_KEYS_POLYGON,
    );
    assert.match(zone.id, WATCH_ID_PATTERNS.zone);
    // Stored zones compile with the geometry module as they are.
    const compiled = compileZone(zone);
    assert.ok(compiled);
    assert.equal(compiled.id, zone.id);
    assert.equal(compiled.shape, zone.shape);
  }
  // The antimeridian polygon contains points on both sides of 180°.
  const compiled = compileZone(doc.zones[1]);
  assert.ok(signedDistanceM(compiled, 0, 179.9) < 0);
  assert.ok(signedDistanceM(compiled, 0, -179.9) < 0);
  assert.ok(signedDistanceM(compiled, 0, 0) > 0);
  for (const entry of doc.watchlist) {
    assert.deepEqual(Object.keys(entry), ENTRY_KEYS);
    assert.match(entry.id, WATCH_ID_PATTERNS.entry);
    assert.match(entry.value, WATCH_MATCH[entry.match]);
  }
  const text = serializeWatchDocument(doc);
  assert.ok(!/owner|registrant|person|undefined|NaN/i.test(text));
});
