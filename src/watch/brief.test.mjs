// src/watch/brief.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BRIEF_BUCKET_KEYS,
  BRIEF_EVENT_PARAM_KEYS,
  BRIEF_EXTRA_LIMITS,
  BRIEF_FACT_KEYS,
  BRIEF_LIMITS,
  BRIEF_LINE_CODES,
  BRIEF_SECTION_IDS,
  buildPlaceBrief,
  placeBriefLines,
} from './brief.js';
import { compileZone } from './geometry.js';
import { createOccupancySeries } from './occupancy.js';

const MIN = 60_000;
const NOW = 1_790_000_000_000;
const AS_OF = NOW - 20_000;
const CENTER = Object.freeze({ lat: 51.5, lon: -0.1 });
const ALL_KINDS = Object.freeze(['aircraft', 'vessel', 'fire', 'quake']);
const LINE_CODES = new Set(Object.values(BRIEF_LINE_CODES));

function makeZone(overrides = {}) {
  return {
    id: 'z-test01',
    name: 'Harbour approach',
    shape: 'circle',
    center: { ...CENTER },
    radiusM: 25_000,
    kinds: [...ALL_KINDS],
    notify: 'all',
    aircraft: { militaryOnly: false },
    fire: { minFrpMw: 0 },
    quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 },
    createdAtMs: NOW - 3_600_000,
    updatedAtMs: NOW - 3_600_000,
    ...overrides,
  };
}

/** A point `dNorthKm` north of the zone centre (25 km radius). */
function north(dNorthKm) {
  return { lat: CENTER.lat + dNorthKm / 111.2, lon: CENTER.lon };
}

function aircraft(icao24, overrides = {}) {
  return {
    key: icao24,
    kind: 'aircraft',
    id: icao24,
    label: icao24.toUpperCase(),
    callsign: null,
    ...north(1),
    altM: 3_000,
    speedMps: 150,
    headingDeg: 90,
    vRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    squawk: '1234',
    emergency: false,
    emergencyKind: null,
    emergencySource: null,
    fixAtMs: NOW - 30_000,
    contactAtMs: NOW - 30_000,
    layerId: 'flights',
    ...overrides,
  };
}

function vessel(mmsi, overrides = {}) {
  return {
    key: mmsi,
    kind: 'vessel',
    id: mmsi,
    label: mmsi,
    ...north(2),
    speedKts: 12,
    courseDeg: 45,
    shipType: '70',
    fixAtMs: NOW - 60_000,
    layerId: 'ais-live-vessels',
    ...overrides,
  };
}

function fire(n, overrides = {}) {
  const at = north(n / 10);
  return {
    key: `fire:${at.lat.toFixed(4)}:${at.lon.toFixed(4)}:${NOW - n * MIN}:N20`,
    kind: 'fire',
    ...at,
    frpMw: 10 * n,
    confidence: 80,
    acqMs: NOW - n * MIN,
    satellite: 'N20',
    ...overrides,
  };
}

function quake(id, overrides = {}) {
  return {
    key: id,
    kind: 'quake',
    id,
    ...north(3),
    magnitude: 3.1,
    depthKm: 10,
    timeMs: NOW - 10 * MIN,
    place: '5 km N of Somewhere',
    ...overrides,
  };
}

function frame(layerId, kind, assets = [], answer = {}) {
  const state = answer.state ?? 'counted';
  return {
    layerId,
    kind,
    nowMs: NOW,
    epochMs: AS_OF,
    newEpoch: true,
    answer: {
      state,
      reason: answer.reason ?? null,
      asOfMs: answer.asOfMs === undefined ? AS_OF : answer.asOfMs,
    },
    coverage: { kind: 'global' },
    complete: state === 'counted',
    assets: state === 'counted' || state === 'floor' ? assets : [],
    keys: new Set(assets.filter(Boolean).map((asset) => asset.key)),
    rejected: 0,
  };
}

function kindAnswer(state = 'counted', reason = null, count = null) {
  return {
    answer: state,
    reason,
    count,
    floor: state === 'floor',
    asOfMs: state === 'off' ? null : AS_OF,
    busy: false,
  };
}

function makeView(perKind = {}, overrides = {}) {
  return {
    id: 'z-test01',
    name: 'Harbour approach',
    shape: 'circle',
    kinds: [...ALL_KINDS],
    notify: 'all',
    alert: false,
    labelAnchor: { lat: 51.72, lon: -0.1 },
    outline: [],
    perKind: {
      aircraft: kindAnswer(),
      vessel: kindAnswer(),
      fire: kindAnswer(),
      quake: kindAnswer(),
      ...perKind,
    },
    occupants: [],
    timed: true,
    capped: false,
    series: { aircraft: null, vessel: null },
    ...overrides,
  };
}

function framesFor({
  flights = [],
  military = [],
  vessels = [],
  fires = [],
  quakes = [],
} = {}) {
  return new Map([
    ['flights', frame('flights', 'aircraft', flights)],
    ['military', frame('military', 'aircraft', military)],
    ['ais-live-vessels', frame('ais-live-vessels', 'vessel', vessels)],
    ['local-firms', frame('local-firms', 'fire', fires)],
    ['earthquakes', frame('earthquakes', 'quake', quakes)],
  ]);
}

function brief(input = {}) {
  const zone = input.zone ?? makeZone();
  return buildPlaceBrief({
    zone,
    compiled: input.compiled === undefined ? compileZone(zone) : input.compiled,
    frames: input.frames ?? framesFor(),
    zoneView: input.zoneView === undefined ? makeView() : input.zoneView,
    watchInside: input.watchInside === undefined ? [] : input.watchInside,
    recentEvents: input.recentEvents ?? [],
    series: input.series ?? null,
    nowMs: input.nowMs === undefined ? NOW : input.nowMs,
  });
}

function section(result, id) {
  return result.sections.find((entry) => entry.id === id) ?? null;
}

/** Every key used anywhere in a JSON value. */
function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      allKeys(item, out);
    }
  }
  return out;
}

/** Throws unless a value is plain JSON with no NaN, Infinity or undefined. */
function assertJsonSafe(value, path = '$') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  assert.equal(type, 'object', `${path} is ${type}`);
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${path}`);
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} is undefined`);
    assertJsonSafe(item, `${path}.${key}`);
  }
}

/** Deterministic pseudo-random numbers in [0, 1). */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

// ------------------------------------------------------------- constants

test('limits, fact keys and section ids match the plan and are frozen', () => {
  assert.deepEqual(BRIEF_LIMITS, {
    aircraftHighlights: 5,
    vesselNames: 3,
    vesselTypeBuckets: 4,
    fireHighlights: 3,
    quakeHighlights: 3,
    activity: 10,
  });
  assert.deepEqual(BRIEF_FACT_KEYS, [
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
  assert.deepEqual(BRIEF_SECTION_IDS, [
    'aircraft',
    'vessels',
    'fires',
    'quakes',
    'watched',
    'occupancy',
    'activity',
  ]);
  assert.deepEqual(BRIEF_EXTRA_LIMITS, {
    watchedHighlights: 10,
    occupantHighlights: 3,
  });
  assert.deepEqual(BRIEF_BUCKET_KEYS, { untyped: 'untyped', rest: 'rest' });
  for (const constant of [
    BRIEF_LIMITS,
    BRIEF_FACT_KEYS,
    BRIEF_SECTION_IDS,
    BRIEF_EXTRA_LIMITS,
    BRIEF_BUCKET_KEYS,
    BRIEF_LINE_CODES,
    BRIEF_EVENT_PARAM_KEYS,
  ]) {
    assert.ok(Object.isFrozen(constant));
  }
  assert.equal(
    new Set(BRIEF_EVENT_PARAM_KEYS).size,
    BRIEF_EVENT_PARAM_KEYS.length,
  );
  for (const key of BRIEF_EVENT_PARAM_KEYS) {
    assert.doesNotMatch(
      key,
      /owner|registr|operator|person|lat$|lon$|position/i,
    );
  }
  assert.equal(LINE_CODES.size, Object.keys(BRIEF_LINE_CODES).length);
  for (const code of LINE_CODES) assert.match(code, /^brief-[a-z-]+$/);
});

test('the module stays portable and keeps literals off UI keys', () => {
  const source = readFileSync(new URL('./brief.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(imports.sort(), ['../data/vesselTypes.js', './geometry.js']);
  assert.doesNotMatch(source, /\bDate\.now\b|\bMath\.random\b|new Date\(/);
  assert.doesNotMatch(
    source,
    /\b(?:window|document|localStorage|sessionStorage|setTimeout|setInterval)\b/,
  );
  assert.doesNotMatch(source, /cesium/i);
  assert.doesNotMatch(
    source,
    /(?:^|[{,\s])(?:label|title|status|hint)\s*:\s*['"`]/m,
  );
  assert.doesNotMatch(source, /from '\.\/(?:frames|engine)\.js'/);
});

// --------------------------------------------------------------- shape

test('a brief lists every section in order and is JSON-safe', () => {
  const result = brief({
    frames: framesFor({
      flights: [aircraft('a00001')],
      vessels: [vessel('235000001', { label: 'NORDIC STAR' })],
      fires: [fire(1)],
      quakes: [quake('us7000aaaa')],
    }),
  });
  assert.equal(result.zoneId, 'z-test01');
  assert.equal(result.name, 'Harbour approach');
  assert.equal(result.generatedAtMs, NOW);
  assert.deepEqual(
    result.sections.map((entry) => entry.id),
    BRIEF_SECTION_IDS,
  );
  assertJsonSafe(result);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  for (const entry of result.sections) {
    for (const key of [
      'id',
      'answer',
      'reason',
      'asOfMs',
      'count',
      'floor',
      'highlights',
    ]) {
      assert.ok(Object.hasOwn(entry, key), `${entry.id} lacks ${key}`);
    }
  }
});

test('sections follow the zone kinds; watched needs a watchInside array', () => {
  const fireOnly = makeZone({ kinds: ['fire'] });
  const result = brief({
    zone: fireOnly,
    zoneView: makeView({}, { kinds: ['fire'] }),
  });
  assert.deepEqual(
    result.sections.map((entry) => entry.id),
    ['fires', 'activity'],
  );
  const noWatch = brief({ watchInside: null });
  assert.deepEqual(
    noWatch.sections.map((entry) => entry.id),
    ['aircraft', 'vessels', 'fires', 'quakes', 'occupancy', 'activity'],
  );
  const vesselsOnly = brief({
    zone: makeZone({ kinds: ['quake', 'vessel'] }),
  });
  assert.deepEqual(
    vesselsOnly.sections.map((entry) => entry.id),
    ['vessels', 'quakes', 'watched', 'occupancy', 'activity'],
  );
});

test('the zone view supplies id, name and kinds when the zone is missing', () => {
  const zone = makeZone();
  const result = buildPlaceBrief({
    compiled: compileZone(zone),
    frames: framesFor({ flights: [aircraft('a00001')] }),
    zoneView: makeView({}, { kinds: ['aircraft'] }),
    nowMs: NOW,
  });
  assert.equal(result.zoneId, 'z-test01');
  assert.equal(result.name, 'Harbour approach');
  assert.equal(section(result, 'aircraft').count, 1);
});

test('generatedAtMs is null without a usable nowMs', () => {
  assert.equal(brief({ nowMs: null }).generatedAtMs, null);
  assert.equal(brief({ nowMs: Number.NaN }).generatedAtMs, null);
});

test('an empty call still returns a JSON-safe brief', () => {
  const result = buildPlaceBrief();
  assert.deepEqual(result, {
    zoneId: null,
    name: null,
    generatedAtMs: null,
    sections: [
      {
        id: 'activity',
        answer: 'unknown',
        reason: 'cannot-answer',
        asOfMs: null,
        count: null,
        floor: false,
        highlights: [],
        events: [],
      },
    ],
  });
});

// ------------------------------------------------------------- honesty

test('off, held and unknown sections never report a count, even 0', () => {
  for (const state of ['off', 'held', 'unknown']) {
    const reason = { off: 'feed-off', held: 'feed-stale', unknown: 'x' }[state];
    const perKind = {};
    for (const kind of ALL_KINDS) perKind[kind] = kindAnswer(state, reason, 0);
    const result = brief({
      frames: framesFor({
        flights: [aircraft('a00001')],
        vessels: [vessel('235000001', { label: 'NORDIC STAR' })],
        fires: [fire(1)],
        quakes: [quake('us7000aaaa')],
      }),
      zoneView: makeView(perKind),
      watchInside: [],
    });
    for (const entry of result.sections) {
      assert.equal(entry.count, null, `${state} ${entry.id}`);
      if (entry.id === 'occupancy') continue;
      assert.equal(entry.answer, state, `${state} ${entry.id}`);
      if (entry.id !== 'activity') {
        assert.deepEqual(entry.highlights, [], `${state} ${entry.id}`);
      }
    }
    assert.deepEqual(section(result, 'vessels').buckets, []);
    assert.equal(section(result, 'fires').maxFrpMw, null);
    assert.equal(section(result, 'quakes').maxMagnitude, null);
  }
});

test('a floor section reports a positive count but never 0', () => {
  const perKind = {};
  for (const kind of ALL_KINDS) {
    perKind[kind] = kindAnswer('floor', 'partial-coverage', 0);
  }
  const empty = brief({ zoneView: makeView(perKind) });
  for (const id of ['aircraft', 'vessels', 'fires', 'quakes', 'watched']) {
    const entry = section(empty, id);
    assert.equal(entry.answer, 'floor', id);
    assert.equal(entry.count, null, id);
    assert.equal(entry.floor, true, id);
  }
  const busy = brief({
    frames: framesFor({ flights: [aircraft('a00001'), aircraft('a00002')] }),
    zoneView: makeView(perKind),
  });
  const air = section(busy, 'aircraft');
  assert.equal(air.count, 2);
  assert.equal(air.floor, true);
  assert.equal(air.reason, 'partial-coverage');
  assert.equal(air.highlights.length, 2);
});

test('a counted section with nothing inside reports 0', () => {
  const result = brief({
    frames: framesFor({ flights: [aircraft('a00001', north(80))] }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.answer, 'counted');
  assert.equal(air.count, 0);
  assert.equal(air.floor, false);
  assert.deepEqual(air.highlights, []);
  assert.equal(section(result, 'watched').count, 0);
  assert.equal(section(result, 'activity').count, 0);
});

test('the view answer wins over frames that still carry assets', () => {
  const frames = framesFor({ flights: [aircraft('a00001')] });
  const result = brief({
    frames,
    zoneView: makeView({ aircraft: kindAnswer('held', 'feed-stale', 4) }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.answer, 'held');
  assert.equal(air.reason, 'feed-stale');
  assert.equal(air.count, null);
  assert.deepEqual(air.highlights, []);
});

test('the view answer may be an answer object', () => {
  const result = brief({
    frames: framesFor({ flights: [aircraft('a00001')] }),
    zoneView: makeView({
      aircraft: {
        answer: {
          state: 'floor',
          reason: 'secondary-feed-stale',
          asOfMs: NOW - 99_000,
        },
        count: 1,
      },
    }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.answer, 'floor');
  assert.equal(air.reason, 'secondary-feed-stale');
  assert.equal(air.asOfMs, NOW - 99_000);
  assert.equal(air.count, 1);
});

test('a malformed view answer cannot answer', () => {
  const result = brief({
    frames: framesFor({ flights: [aircraft('a00001')] }),
    zoneView: makeView({ aircraft: { answer: 'fallback', count: 3 } }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.answer, 'unknown');
  assert.equal(air.reason, 'cannot-answer');
  assert.equal(air.count, null);
});

test('without a view answer a section is never counted or floor', () => {
  const zone = makeZone({ kinds: ['aircraft', 'vessel', 'fire'] });
  const frames = new Map([
    ['flights', frame('flights', 'aircraft', [aircraft('a00001')])],
    [
      'ais-live-vessels',
      frame('ais-live-vessels', 'vessel', [], { state: 'off' }),
    ],
  ]);
  const result = brief({ zone, frames, zoneView: null });
  assert.deepEqual(
    [section(result, 'aircraft'), section(result, 'vessels')].map((entry) => [
      entry.answer,
      entry.reason,
      entry.count,
    ]),
    [
      ['unknown', 'cannot-answer', null],
      ['off', 'feed-off', null],
    ],
  );
  assert.deepEqual(section(result, 'aircraft').highlights, []);
  const fires = section(result, 'fires');
  assert.equal(fires.answer, 'unknown');
  assert.equal(fires.reason, 'never-answered');
  assert.equal(fires.count, null);
});

test('with no answering frame the view count is used, honestly', () => {
  const counted = brief({
    frames: new Map(),
    zoneView: makeView({
      aircraft: kindAnswer('counted', null, 7),
      vessel: kindAnswer('floor', 'partial-coverage', 0),
    }),
  });
  assert.equal(section(counted, 'aircraft').count, 7);
  assert.deepEqual(section(counted, 'aircraft').highlights, []);
  assert.equal(section(counted, 'vessels').count, null);
});

test('the compiled zone defaults to compileZone(zone)', () => {
  const frames = framesFor({ flights: [aircraft('a00001')] });
  const withCompiled = brief({ frames });
  const withoutCompiled = brief({ frames, compiled: null });
  assert.deepEqual(withoutCompiled, withCompiled);
});

test('an uncompilable zone lists no highlights and falls back to the view', () => {
  const zone = makeZone({ radiusM: 10 });
  const result = brief({
    zone,
    compiled: null,
    frames: framesFor({ flights: [aircraft('a00001')] }),
    zoneView: makeView({ aircraft: kindAnswer('counted', null, 3) }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.count, 3);
  assert.deepEqual(air.highlights, []);
});

test('property: no section that is not counted ever reports 0', () => {
  const states = ['counted', 'floor', 'held', 'unknown', 'off'];
  const random = lcg(20261026);
  const pick = (list) => list[Math.floor(random() * list.length)];
  for (let run = 0; run < 300; run += 1) {
    const perKind = {};
    for (const kind of ALL_KINDS) {
      perKind[kind] = kindAnswer(
        pick(states),
        pick([null, 'feed-stale', 'partial-coverage']),
        pick([null, 0, 1, 5]),
      );
    }
    const count = Math.floor(random() * 4);
    const flights = [];
    const vessels = [];
    for (let i = 0; i < count; i += 1) {
      flights.push(aircraft(`b0000${i}`, north(random() * 40)));
      vessels.push(vessel(`23500000${i}`, north(random() * 40)));
    }
    const events = random() < 0.5 ? [] : [{ id: 'e-1', zoneId: 'z-test01' }];
    const result = brief({
      frames: framesFor({ flights, vessels }),
      zoneView: makeView(perKind, {
        series: { aircraft: random() < 0.5 ? null : { min: 0 } },
      }),
      watchInside: random() < 0.5 ? [] : null,
      recentEvents: events,
    });
    assertJsonSafe(result);
    for (const entry of result.sections) {
      if (entry.answer !== 'counted') {
        assert.notEqual(entry.count, 0, `${entry.id} reported 0`);
      }
      if (entry.count !== null && entry.answer !== 'counted') {
        assert.equal(entry.floor, true, entry.id);
      }
      if (!['counted', 'floor'].includes(entry.answer)) {
        if (['aircraft', 'vessels', 'fires', 'quakes'].includes(entry.id)) {
          assert.equal(entry.count, null, entry.id);
          assert.deepEqual(entry.highlights, [], entry.id);
        }
      }
    }
  }
});

// ------------------------------------------------------------- aircraft

test('aircraft: emergencies first, then airborne by lowest altitude', () => {
  const flights = [
    aircraft('a00001', { altM: 1_200 }),
    aircraft('a00002', { altM: 300 }),
    aircraft('a00003', { altM: null }),
    aircraft('a00004', { altM: 0, onGround: true }),
    aircraft('a00005', {
      altM: 11_000,
      emergency: true,
      emergencyKind: 'general',
      squawk: '7700',
    }),
    aircraft('a00006', { altM: 300 }),
    aircraft('a00007', { altM: 9_000 }),
  ];
  const result = brief({ frames: framesFor({ flights }) });
  const air = section(result, 'aircraft');
  assert.equal(air.count, 7);
  assert.deepEqual(
    air.highlights.map((highlight) => highlight.label),
    ['A00005', 'A00002', 'A00006', 'A00001', 'A00007'],
  );
  assert.deepEqual(air.highlights[0].facts, {
    altitudeM: 11_000,
    speedMps: 150,
    aircraftClass: 'airliner',
    military: false,
    emergencyKind: 'general',
    squawk: '7700',
    enteredAtMs: null,
    lowerBound: null,
  });
  assert.equal(air.highlights[0].kind, 'aircraft');
  const everyone = brief({
    frames: framesFor({ flights: flights.slice(0, 4) }),
  });
  assert.deepEqual(
    section(everyone, 'aircraft').highlights.map((h) => h.label),
    ['A00002', 'A00001', 'A00003', 'A00004'],
  );
});

test('aircraft: one count per ICAO24 across flights and military', () => {
  const flights = [
    aircraft('ae1234', { altM: 2_000, fixAtMs: NOW - 40_000 }),
    aircraft('a00001'),
  ];
  const military = [
    aircraft('ae1234', {
      altM: 1_500,
      fixAtMs: NOW - 10_000,
      military: true,
      layerId: 'military',
    }),
  ];
  const result = brief({ frames: framesFor({ flights, military }) });
  const air = section(result, 'aircraft');
  assert.equal(air.count, 2);
  const shared = air.highlights.find((h) => h.label === 'AE1234');
  assert.equal(shared.facts.altitudeM, 1_500);
  assert.equal(shared.facts.military, true);
});

test('aircraft: militaryOnly zones count military aircraft only', () => {
  const zone = makeZone({ aircraft: { militaryOnly: true } });
  const result = brief({
    zone,
    frames: framesFor({
      flights: [aircraft('a00001'), aircraft('a00002', { military: true })],
      military: [aircraft('ae0001', { military: true, layerId: 'military' })],
    }),
  });
  const air = section(result, 'aircraft');
  assert.equal(air.count, 2);
  assert.deepEqual(air.highlights.map((h) => h.label).sort(), [
    'A00002',
    'AE0001',
  ]);
});

test('aircraft: labels fall back to callsign then ICAO24', () => {
  const result = brief({
    frames: framesFor({
      flights: [
        aircraft('a00001', { label: null, callsign: 'BAW12' }),
        aircraft('a00002', { label: null, callsign: null, altM: 100 }),
      ],
    }),
  });
  assert.deepEqual(
    section(result, 'aircraft').highlights.map((h) => h.label),
    ['a00002', 'BAW12'],
  );
});

test('aircraft: occupants give entered times and lower bounds', () => {
  const result = brief({
    frames: framesFor({ flights: [aircraft('a00001')] }),
    zoneView: makeView(
      {},
      {
        occupants: [
          {
            assetKey: 'a00001',
            label: 'A00001',
            kind: 'aircraft',
            enteredAtMs: NOW - 20 * MIN,
            lowerBound: true,
          },
        ],
      },
    ),
  });
  const facts = section(result, 'aircraft').highlights[0].facts;
  assert.equal(facts.enteredAtMs, NOW - 20 * MIN);
  assert.equal(facts.lowerBound, true);
});

test('assets outside the zone or with bad positions are not counted', () => {
  const result = brief({
    frames: framesFor({
      flights: [
        aircraft('a00001'),
        aircraft('a00002', north(26)),
        aircraft('a00003', { lat: 0, lon: 0 }),
        aircraft('a00004', { lat: Number.NaN }),
        aircraft('a00005', { kind: 'vessel' }),
        { kind: 'aircraft', lat: CENTER.lat, lon: CENTER.lon },
        null,
      ],
    }),
  });
  assert.equal(section(result, 'aircraft').count, 1);
});

test('polygon zones count by the polygon boundary', () => {
  const zone = makeZone({
    shape: 'polygon',
    center: undefined,
    radiusM: undefined,
    ring: [
      [-0.3, 51.4],
      [0.1, 51.4],
      [0.1, 51.6],
      [-0.3, 51.6],
      [-0.3, 51.4],
    ],
  });
  const result = brief({
    zone,
    frames: framesFor({
      flights: [
        aircraft('a00001', { lat: 51.5, lon: -0.1 }),
        aircraft('a00002', { lat: 51.5, lon: 0.3 }),
      ],
    }),
  });
  assert.equal(section(result, 'aircraft').count, 1);
});

// -------------------------------------------------------------- vessels

test('vessels: type buckets from normalizeVesselType, most first', () => {
  const vessels = [
    vessel('235000001', { shipType: '70' }),
    vessel('235000002', { shipType: '79' }),
    vessel('235000003', { shipType: '80' }),
    vessel('235000004', { shipType: '0' }),
    vessel('235000005', { shipType: null }),
    vessel('235000006', { shipType: 'Cargo' }),
  ];
  const result = brief({ frames: framesFor({ vessels }) });
  const ships = section(result, 'vessels');
  assert.equal(ships.count, 6);
  assert.deepEqual(ships.buckets, [
    { key: 'CARGO', count: 3 },
    { key: 'untyped', count: 2 },
    { key: 'TANKER', count: 1 },
  ]);
});

test('vessels: past four types the last bucket folds the rest', () => {
  const types = ['70', '71', '80', '30', '52', '60', '36'];
  const vessels = types.map((shipType, index) =>
    vessel(`23500001${index}`, { shipType }),
  );
  const result = brief({ frames: framesFor({ vessels }) });
  assert.deepEqual(section(result, 'vessels').buckets, [
    { key: 'CARGO', count: 2 },
    { key: 'FISHING', count: 1 },
    { key: 'PASSENGER', count: 1 },
    { key: BRIEF_BUCKET_KEYS.rest, count: 3 },
  ]);
});

test('vessels: up to three named vessels, longest present first', () => {
  const vessels = [
    vessel('235000001', { label: 'ALPHA', fixAtMs: NOW - 10_000 }),
    vessel('235000002', { label: 'BRAVO', fixAtMs: NOW - 90_000 }),
    vessel('235000003', { label: 'CHARLIE', fixAtMs: NOW - 5_000 }),
    vessel('235000004'),
    vessel('235000005', { label: 'ECHO', fixAtMs: NOW - 50_000 }),
  ];
  const result = brief({
    frames: framesFor({ vessels }),
    zoneView: makeView(
      {},
      {
        occupants: [
          {
            assetKey: '235000002',
            label: 'BRAVO',
            kind: 'vessel',
            enteredAtMs: NOW - 50 * MIN,
            lowerBound: false,
          },
        ],
      },
    ),
  });
  const ships = section(result, 'vessels');
  assert.equal(ships.count, 5);
  assert.deepEqual(
    ships.highlights.map((h) => h.label),
    ['BRAVO', 'CHARLIE', 'ALPHA'],
  );
  assert.deepEqual(ships.highlights[0].facts, {
    speedKts: 12,
    shipType: 'CARGO',
    enteredAtMs: NOW - 50 * MIN,
    lowerBound: false,
  });
});

test('vessels: a slow vessel is stated as a speed, never as anchored', () => {
  const result = brief({
    frames: framesFor({
      vessels: [vessel('235000001', { label: 'STILL WATER', speedKts: 0.2 })],
    }),
  });
  const ships = section(result, 'vessels');
  assert.equal(ships.highlights[0].facts.speedKts, 0.2);
  const text = JSON.stringify([result, placeBriefLines(result)]);
  assert.doesNotMatch(text, /anchor|moor|stationary|parked|dark/i);
});

// ---------------------------------------------------------------- fires

test('fires: count, strongest FRP, newest acquisition and top three', () => {
  const fires = [
    fire(1, { frpMw: 5 }),
    fire(2, { frpMw: 120 }),
    fire(3, { frpMw: null }),
    fire(4, { frpMw: 40 }),
    fire(5, { frpMw: 40 }),
  ];
  const result = brief({ frames: framesFor({ fires }) });
  const hot = section(result, 'fires');
  assert.equal(hot.count, 5);
  assert.equal(hot.maxFrpMw, 120);
  assert.equal(hot.newestAcqMs, NOW - MIN);
  assert.deepEqual(
    hot.highlights.map((h) => h.facts),
    [
      { frpMw: 120, acqMs: NOW - 2 * MIN },
      { frpMw: 40, acqMs: NOW - 4 * MIN },
      { frpMw: 40, acqMs: NOW - 5 * MIN },
    ],
  );
  for (const highlight of hot.highlights) {
    assert.equal(highlight.label, null);
    assert.equal(highlight.kind, 'fire');
  }
});

test('fires: the zone FRP filter applies to count and highlights', () => {
  const zone = makeZone({ fire: { minFrpMw: 50 } });
  const result = brief({
    zone,
    frames: framesFor({
      fires: [fire(1, { frpMw: 49 }), fire(2, { frpMw: 50 }), fire(3)],
    }),
  });
  const hot = section(result, 'fires');
  assert.equal(hot.count, 1);
  assert.equal(hot.maxFrpMw, 50);
});

// --------------------------------------------------------------- quakes

test('quakes: count, strongest magnitude and the three most recent', () => {
  const quakes = [
    quake('us1', { magnitude: 4.8, timeMs: NOW - 60 * MIN }),
    quake('us2', { magnitude: 2.9, timeMs: NOW - 5 * MIN }),
    quake('us3', { magnitude: 3.3, timeMs: NOW - 30 * MIN }),
    quake('us4', { magnitude: 3.0, timeMs: null }),
    quake('us5', { magnitude: 2.0, timeMs: NOW }),
  ];
  const result = brief({ frames: framesFor({ quakes }) });
  const shakes = section(result, 'quakes');
  assert.equal(shakes.count, 4);
  assert.equal(shakes.maxMagnitude, 4.8);
  assert.equal(shakes.newestTimeMs, NOW - 5 * MIN);
  assert.deepEqual(
    shakes.highlights.map((h) => h.label),
    ['us2', 'us3', 'us1'],
  );
  assert.deepEqual(shakes.highlights[0].facts, {
    magnitude: 2.9,
    depthKm: 10,
    timeMs: NOW - 5 * MIN,
    place: '5 km N of Somewhere',
  });
});

test('quakes: the buffer reaches past the zone edge', () => {
  const outside = quake('us9', north(40));
  const tight = brief({ frames: framesFor({ quakes: [outside] }) });
  assert.equal(section(tight, 'quakes').count, 0);
  const buffered = brief({
    zone: makeZone({
      quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 25 },
    }),
    frames: framesFor({ quakes: [outside] }),
  });
  assert.equal(section(buffered, 'quakes').count, 1);
});

// -------------------------------------------------------------- watched

function watchRow(entryId, kind, match, value, overrides = {}) {
  return {
    entryId,
    kind,
    match,
    value,
    label: null,
    presence: { state: 'live', reason: null },
    fix: null,
    layerId: null,
    zoneIds: ['z-test01'],
    matches: 1,
    lastSeen: null,
    sinceMs: NOW - 10 * MIN,
    ...overrides,
  };
}

test('watched: entries inside the zone, with facts from the zone assets', () => {
  const result = brief({
    frames: framesFor({
      flights: [
        aircraft('a0b1c2', { altM: 900 }),
        aircraft('a00009', { callsign: 'RCH 401', altM: 7_000 }),
      ],
      vessels: [vessel('235000001', { label: 'NORDIC STAR', speedKts: 0 })],
    }),
    watchInside: [
      watchRow('w-0003', 'vessel', 'mmsi', '235000001'),
      watchRow('w-0001', 'aircraft', 'icao24', 'A0B1C2', { label: 'Tanker' }),
      watchRow('w-0002', 'aircraft', 'callsign', 'RCH401'),
      watchRow('w-0004', 'aircraft', 'icao24', 'ffffff', {
        presence: { state: 'stale-fix', reason: 'fix-old' },
        fix: { lat: 51.5, lon: -0.1, atMs: NOW - 9 * MIN, altM: 450 },
        enteredAtMs: NOW - 30 * MIN,
        lowerBound: true,
      }),
      watchRow('w-0005', 'aircraft', 'icao24', 'eeeeee', {
        zoneIds: ['z-other'],
      }),
      watchRow('w-0006', 'satellite', 'norad', '25544'),
      'junk',
    ],
  });
  const watched = section(result, 'watched');
  assert.equal(watched.answer, 'counted');
  assert.equal(watched.count, 4);
  assert.deepEqual(
    watched.highlights.map((h) => [h.label, h.kind, h.presence]),
    [
      ['RCH401', 'aircraft', 'live'],
      ['Tanker', 'aircraft', 'live'],
      ['ffffff', 'aircraft', 'stale-fix'],
      ['235000001', 'vessel', 'live'],
    ],
  );
  assert.equal(watched.highlights[0].facts.altitudeM, 7_000);
  assert.equal(watched.highlights[1].facts.altitudeM, 900);
  assert.deepEqual(watched.highlights[2].facts, {
    altitudeM: 450,
    speedMps: null,
    aircraftClass: null,
    military: null,
    emergencyKind: null,
    squawk: null,
    enteredAtMs: NOW - 30 * MIN,
    lowerBound: true,
  });
  assert.deepEqual(watched.highlights[3].facts, {
    speedKts: 0,
    shipType: 'CARGO',
    enteredAtMs: null,
    lowerBound: null,
  });
});

test('watched: the answer combines the aircraft and vessel answers', () => {
  const held = brief({
    zoneView: makeView({
      aircraft: kindAnswer('held', 'feed-stale'),
      vessel: kindAnswer('off', 'feed-off'),
    }),
  });
  const none = section(held, 'watched');
  assert.equal(none.answer, 'held');
  assert.equal(none.reason, 'feed-stale');
  assert.equal(none.count, null);
  const mixed = brief({
    zoneView: makeView({
      vessel: kindAnswer('unknown', 'outside-loaded-area'),
    }),
    watchInside: [watchRow('w-0001', 'aircraft', 'icao24', 'a00001')],
  });
  const one = section(mixed, 'watched');
  assert.equal(one.answer, 'floor');
  assert.equal(one.reason, 'outside-loaded-area');
  assert.equal(one.count, 1);
  assert.equal(one.floor, true);
  assert.equal(one.asOfMs, AS_OF);
});

test('watched: kinds the zone does not watch are dropped', () => {
  const result = brief({
    zone: makeZone({ kinds: ['vessel'] }),
    watchInside: [watchRow('w-0001', 'aircraft', 'icao24', 'a00001')],
  });
  assert.equal(section(result, 'watched').count, 0);
});

test('watched: at most ten entries are listed', () => {
  const rows = [];
  for (let i = 0; i < 14; i += 1) {
    rows.push(watchRow(`w-${100 + i}`, 'aircraft', 'icao24', `a001${10 + i}`));
  }
  const result = brief({ watchInside: rows });
  const watched = section(result, 'watched');
  assert.equal(watched.count, 14);
  assert.equal(watched.highlights.length, BRIEF_EXTRA_LIMITS.watchedHighlights);
});

// ------------------------------------------------------------ occupancy

const SUMMARY = Object.freeze({
  sinceMs: NOW - 60 * MIN,
  min: 2,
  median: 5,
  max: 9,
  samples: 60,
  floorSamples: 3,
});

test('occupancy: summaries from the series argument', () => {
  const result = brief({
    series: { aircraft: { ...SUMMARY }, vessel: { ...SUMMARY, median: 1 } },
  });
  const occupancy = section(result, 'occupancy');
  assert.equal(occupancy.answer, 'counted');
  assert.equal(occupancy.reason, null);
  assert.equal(occupancy.count, null);
  assert.equal(occupancy.floor, false);
  assert.deepEqual(occupancy.series, {
    aircraft: { ...SUMMARY },
    vessel: { ...SUMMARY, median: 1 },
  });
});

test('occupancy: series objects and values() data are summarised', () => {
  const live = createOccupancySeries();
  live.record(NOW - 3 * MIN, 4);
  live.record(NOW - 2 * MIN, 6);
  live.record(NOW - MIN, 9, { floor: true });
  const values = {
    startMs: NOW - 4 * MIN,
    stepMs: MIN,
    values: [null, 1, 3, 2],
    floor: [false, false, true, false],
  };
  const result = brief({ series: { aircraft: live, vessel: values } });
  const occupancy = section(result, 'occupancy');
  assert.deepEqual(occupancy.series.aircraft, live.summary(NOW));
  assert.deepEqual(occupancy.series.vessel, {
    sinceMs: NOW - 3 * MIN,
    min: 1,
    median: 1.5,
    max: 2,
    samples: 2,
    floorSamples: 1,
  });
});

test('occupancy: falls back to the view series; a gap reads floor or unknown', () => {
  const fromView = brief({
    zoneView: makeView({}, { series: { aircraft: { ...SUMMARY } } }),
  });
  const partial = section(fromView, 'occupancy');
  assert.equal(partial.answer, 'floor');
  assert.equal(partial.reason, 'never-answered');
  assert.deepEqual(partial.series, { aircraft: { ...SUMMARY }, vessel: null });
  const none = section(
    brief({ series: { aircraft: { min: 1, median: 1, max: 1, samples: 0 } } }),
    'occupancy',
  );
  assert.equal(none.answer, 'unknown');
  assert.equal(none.count, null);
  assert.deepEqual(none.series, { aircraft: null, vessel: null });
  const throwing = section(
    brief({
      series: {
        aircraft: {
          summary() {
            throw new Error('boom');
          },
        },
      },
    }),
    'occupancy',
  );
  assert.equal(throwing.series.aircraft, null);
});

test('occupancy: only the watched presence kinds are summarised', () => {
  const result = brief({
    zone: makeZone({ kinds: ['vessel', 'fire'] }),
    series: { aircraft: { ...SUMMARY }, vessel: { ...SUMMARY } },
  });
  assert.deepEqual(Object.keys(section(result, 'occupancy').series), [
    'vessel',
  ]);
});

test('occupancy: the longest-present occupants, at most three', () => {
  const occupants = [
    {
      assetKey: 'a1',
      label: 'ONE',
      kind: 'aircraft',
      enteredAtMs: NOW - 5 * MIN,
      lowerBound: false,
    },
    {
      assetKey: 'a2',
      label: 'TWO',
      kind: 'aircraft',
      enteredAtMs: NOW - 50 * MIN,
      lowerBound: true,
    },
    {
      assetKey: 'v1',
      label: 'SHIP',
      kind: 'vessel',
      enteredAtMs: NOW - 20 * MIN,
      lowerBound: false,
    },
    {
      assetKey: 'a3',
      label: 'THREE',
      kind: 'aircraft',
      enteredAtMs: null,
      lowerBound: null,
    },
    {
      assetKey: 'f1',
      label: 'FIRE',
      kind: 'fire',
      enteredAtMs: NOW - 90 * MIN,
      lowerBound: false,
    },
  ];
  const result = brief({ zoneView: makeView({}, { occupants }) });
  const occupancy = section(result, 'occupancy');
  assert.deepEqual(occupancy.highlights, [
    {
      label: 'TWO',
      kind: 'aircraft',
      facts: { enteredAtMs: NOW - 50 * MIN, lowerBound: true },
    },
    {
      label: 'SHIP',
      kind: 'vessel',
      facts: { enteredAtMs: NOW - 20 * MIN, lowerBound: false },
    },
    {
      label: 'ONE',
      kind: 'aircraft',
      facts: { enteredAtMs: NOW - 5 * MIN, lowerBound: false },
    },
  ]);
});

// ------------------------------------------------------------- activity

function event(seq, overrides = {}) {
  return {
    id: `e-${seq}`,
    seq,
    type: 'zone-enter',
    severity: 'notice',
    atMs: NOW - (20 - seq) * MIN,
    dataAtMs: NOW - (20 - seq) * MIN - 5_000,
    zoneId: 'z-test01',
    assetKey: `a0000${seq % 10}`,
    kind: 'aircraft',
    assetId: `a0000${seq % 10}`,
    assetLabel: `FLT${seq}`,
    layerId: 'flights',
    position: { lat: 51.5, lon: -0.1 },
    params: { sinceMs: NOW - (21 - seq) * MIN, reentry: false },
    caveats: [],
    watchlisted: false,
    dedupeKey: `zone-enter|z-test01|a0000${seq % 10}`,
    ...overrides,
  };
}

test('activity: this zone only, newest first, at most ten', () => {
  const events = [];
  for (let seq = 1; seq <= 14; seq += 1) events.push(event(seq));
  events.push(event(15, { zoneId: 'z-other' }));
  events.push(event(16, { zoneId: null, type: 'feed-paused' }));
  events.push(event(17, { atMs: NOW - 5 * MIN })); // same time as seq 15
  const result = brief({ recentEvents: events.reverse() });
  const activity = section(result, 'activity');
  assert.equal(activity.answer, 'counted');
  assert.equal(activity.count, 15);
  assert.deepEqual(activity.highlights, []);
  assert.equal(activity.events.length, BRIEF_LIMITS.activity);
  assert.deepEqual(
    activity.events.map((entry) => entry.id),
    [
      'e-17',
      'e-14',
      'e-13',
      'e-12',
      'e-11',
      'e-10',
      'e-9',
      'e-8',
      'e-7',
      'e-6',
    ],
  );
});

test('activity: events are copied without positions and JSON-safe', () => {
  const result = brief({
    recentEvents: [
      event(1, {
        type: 'zone-exit-summary',
        severity: 'info',
        assetKey: null,
        params: {
          count: 6,
          labels: ['A', 'B', Number.NaN, { owner: 'Someone' }],
          assetKeys: ['a1', 'a2'],
          gapMs: Number.NaN,
          before: undefined,
          place: () => 1,
          reason: { nested: 'Someone' },
          nested: { ok: 1, owner: 'Someone' },
          owner: 'ACME HOLDINGS',
          registeredOwner: 'ACME HOLDINGS',
          operator: 'ACME AIR',
          position: { lat: 51.5, lon: -0.1 },
        },
        caveats: ['lower-bound', 7, '', null],
        repeat: 3,
        firstAtMs: NOW - 30 * MIN,
        read: false,
      }),
    ],
  });
  const [copied] = section(result, 'activity').events;
  assertJsonSafe(result);
  assert.deepEqual(copied, {
    id: 'e-1',
    seq: 1,
    type: 'zone-exit-summary',
    severity: 'info',
    atMs: NOW - 19 * MIN,
    dataAtMs: NOW - 19 * MIN - 5_000,
    zoneId: 'z-test01',
    kind: 'aircraft',
    assetKey: null,
    assetId: 'a00001',
    assetLabel: 'FLT1',
    layerId: 'flights',
    params: {
      assetKeys: ['a1', 'a2'],
      before: null,
      count: 6,
      gapMs: null,
      labels: ['A', 'B', null, null],
      place: null,
      reason: null,
    },
    caveats: ['lower-bound', '7'],
    watchlisted: false,
    repeat: 3,
  });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /ACME|Someone|"position"|"lat"|"lon"|nested/);
});

test('activity: the answer combines every kind answer', () => {
  const counted = section(brief(), 'activity');
  assert.deepEqual(
    [counted.answer, counted.reason, counted.count, counted.asOfMs],
    ['counted', null, 0, AS_OF],
  );
  const mixed = section(
    brief({
      zoneView: makeView({ fire: kindAnswer('off', 'feed-off') }),
      recentEvents: [event(1)],
    }),
    'activity',
  );
  assert.deepEqual(
    [mixed.answer, mixed.reason, mixed.count, mixed.floor],
    ['floor', 'feed-off', 1, true],
  );
  const silent = section(
    brief({
      zoneView: makeView({
        aircraft: kindAnswer('off', 'feed-off'),
        vessel: kindAnswer('unknown', 'feed-unavailable'),
        fire: kindAnswer('held', 'feed-stale'),
        quake: kindAnswer('off', 'feed-off'),
      }),
    }),
    'activity',
  );
  assert.deepEqual(
    [silent.answer, silent.reason, silent.count],
    ['held', 'feed-stale', null],
  );
  const offOnly = section(
    brief({
      zoneView: makeView({
        aircraft: kindAnswer('off', 'feed-off'),
        vessel: kindAnswer('unknown', 'feed-unavailable'),
        fire: kindAnswer('off', 'feed-off'),
        quake: kindAnswer('off', 'feed-off'),
      }),
      recentEvents: [event(1), event(2)],
    }),
    'activity',
  );
  assert.deepEqual(
    [offOnly.answer, offOnly.reason, offOnly.count, offOnly.floor],
    ['unknown', 'feed-unavailable', 2, true],
  );
});

// ------------------------------------------------------------ whitelist

test('facts are whitelisted: no owner, operator or registrant data', () => {
  const leaky = {
    owner: 'ACME HOLDINGS',
    registeredOwner: 'ACME HOLDINGS',
    registrationOwner: 'ACME HOLDINGS',
    registrant: 'J DOE',
    operator: 'ACME AIR',
    originCountry: 'Ruritania',
    registration: 'G-SECRET',
    destination: 'SECRET PORT',
    personName: 'J DOE',
  };
  const result = brief({
    frames: framesFor({
      flights: [aircraft('a00001', leaky)],
      military: [aircraft('ae0001', { ...leaky, layerId: 'military' })],
      vessels: [vessel('235000001', { ...leaky, label: 'NORDIC STAR' })],
      fires: [fire(1, leaky)],
      quakes: [quake('us1', leaky)],
    }),
    watchInside: [
      watchRow('w-0001', 'aircraft', 'icao24', 'a00001', {
        ...leaky,
        fix: { lat: 51.5, lon: -0.1, atMs: NOW, altM: 3_000, ...leaky },
      }),
    ],
    zoneView: makeView(
      {},
      {
        occupants: [
          {
            assetKey: 'a00001',
            label: 'A00001',
            kind: 'aircraft',
            enteredAtMs: NOW - MIN,
            lowerBound: false,
            ...leaky,
          },
        ],
      },
    ),
    recentEvents: [event(1, { ...leaky, params: { ...leaky, count: 1 } })],
  });
  const lines = placeBriefLines(result);
  const text = JSON.stringify([result, lines]);
  assert.doesNotMatch(text, /ACME|J DOE|Ruritania|G-SECRET|SECRET PORT/);
  const keys = allKeys([result, lines]);
  for (const key of keys) {
    assert.doesNotMatch(key, /owner|registr|operator|country|person|destin/i);
  }
  const allowed = new Set(BRIEF_FACT_KEYS);
  for (const entry of result.sections) {
    for (const highlight of entry.highlights) {
      for (const key of Object.keys(highlight.facts)) {
        assert.ok(allowed.has(key), `${entry.id} fact ${key}`);
      }
    }
  }
});

test('a brief carries no coordinates', () => {
  const result = brief({
    frames: framesFor({
      flights: [aircraft('a00001')],
      vessels: [vessel('235000001', { label: 'NORDIC STAR' })],
      fires: [fire(1)],
      quakes: [quake('us1')],
    }),
    watchInside: [
      watchRow('w-0001', 'aircraft', 'icao24', 'a00001', {
        fix: { lat: 51.5, lon: -0.1, atMs: NOW, altM: 3_000 },
        lastSeen: { atMs: NOW, lat: 51.5, lon: -0.1, layerId: 'flights' },
      }),
    ],
    recentEvents: [event(1)],
  });
  const keys = allKeys([result, placeBriefLines(result)]);
  for (const key of ['lat', 'lon', 'position', 'center', 'lastSeen', 'fix']) {
    assert.ok(!keys.has(key), key);
  }
});

// ---------------------------------------------------------- determinism

test('the brief is deterministic for fixed inputs and nowMs', () => {
  const flights = [
    aircraft('a00003', { altM: 500 }),
    aircraft('a00001', { altM: 500 }),
    aircraft('a00002', { altM: 500 }),
  ];
  const vessels = [
    vessel('235000002', { label: 'SAME', fixAtMs: NOW - MIN }),
    vessel('235000001', { label: 'SAME', fixAtMs: NOW - MIN }),
  ];
  const fires = [
    fire(2, { frpMw: 30 }),
    fire(1, { frpMw: 30, acqMs: NOW - 2 * MIN }),
  ];
  const recentEvents = [event(2, { atMs: NOW }), event(1, { atMs: NOW })];
  const first = brief({
    frames: framesFor({ flights, vessels, fires }),
    recentEvents,
  });
  const reversed = brief({
    frames: framesFor({
      flights: [...flights].reverse(),
      vessels: [...vessels].reverse(),
      fires: [...fires].reverse(),
    }),
    recentEvents: [...recentEvents].reverse(),
  });
  assert.deepEqual(reversed, first);
  assert.deepEqual(
    section(first, 'aircraft').highlights.map((h) => h.label),
    ['A00001', 'A00002', 'A00003'],
  );
  assert.deepEqual(
    section(first, 'activity').events.map((e) => e.id),
    ['e-2', 'e-1'],
  );
  const asArray = brief({
    frames: [...framesFor({ flights, vessels, fires }).values()],
    recentEvents,
  });
  const asObject = brief({
    frames: Object.fromEntries(framesFor({ flights, vessels, fires })),
    recentEvents,
  });
  assert.deepEqual(asArray, first);
  assert.deepEqual(asObject, first);
  assert.deepEqual(placeBriefLines(first), placeBriefLines(reversed));
});

test('the last frame of a layer in an array wins', () => {
  const stale = frame('flights', 'aircraft', [aircraft('a00001')]);
  const fresh = frame('flights', 'aircraft', [
    aircraft('a00001'),
    aircraft('a00002'),
  ]);
  const result = brief({ frames: [stale, fresh] });
  assert.equal(section(result, 'aircraft').count, 2);
});

// --------------------------------------------------------------- lines

test('placeBriefLines: one header, section lines in order, known codes', () => {
  const result = brief({
    frames: framesFor({
      flights: [aircraft('a00001'), aircraft('a00002', { altM: 200 })],
      vessels: [vessel('235000001', { label: 'NORDIC STAR' })],
      fires: [fire(1)],
      quakes: [quake('us1')],
    }),
    watchInside: [watchRow('w-0001', 'aircraft', 'icao24', 'a00001')],
    series: { aircraft: { ...SUMMARY } },
    zoneView: makeView(
      {},
      {
        occupants: [
          {
            assetKey: 'a00001',
            label: 'A00001',
            kind: 'aircraft',
            enteredAtMs: NOW - 9 * MIN,
            lowerBound: false,
          },
        ],
      },
    ),
    recentEvents: [event(1)],
  });
  const lines = placeBriefLines(result);
  assertJsonSafe(lines);
  for (const line of lines) assert.ok(LINE_CODES.has(line.code), line.code);
  assert.deepEqual(
    lines.map((line) => line.code),
    [
      'brief-header',
      'brief-aircraft',
      'brief-aircraft-item',
      'brief-aircraft-item',
      'brief-vessels',
      'brief-vessel-type',
      'brief-vessel-item',
      'brief-fires',
      'brief-fire-item',
      'brief-quakes',
      'brief-quake-item',
      'brief-watched',
      'brief-watched-item',
      'brief-occupancy',
      'brief-occupancy-series',
      'brief-occupancy-gap',
      'brief-occupant',
      'brief-activity',
      'brief-activity-event',
    ],
  );
  const byCode = (code) => lines.filter((line) => line.code === code);
  assert.deepEqual(byCode('brief-header')[0].values, {
    name: 'Harbour approach',
    generatedAtMs: NOW,
  });
  assert.deepEqual(byCode('brief-aircraft')[0].values, {
    answer: 'counted',
    reason: null,
    count: 2,
    floor: false,
    asOfMs: AS_OF,
  });
  assert.deepEqual(byCode('brief-aircraft-item')[0].values, {
    label: 'A00002',
    altitudeM: 200,
    speedMps: 150,
    aircraftClass: 'airliner',
    military: false,
    emergencyKind: null,
    squawk: '1234',
    enteredAtMs: null,
    lowerBound: null,
  });
  assert.deepEqual(byCode('brief-vessel-type')[0].values, {
    type: 'CARGO',
    count: 1,
    floor: false,
  });
  assert.deepEqual(byCode('brief-vessel-item')[0].values, {
    label: 'NORDIC STAR',
    speedKts: 12,
    shipType: 'CARGO',
    enteredAtMs: null,
    lowerBound: null,
  });
  assert.deepEqual(byCode('brief-fires')[0].values, {
    answer: 'counted',
    reason: null,
    count: 1,
    floor: false,
    asOfMs: AS_OF,
    maxFrpMw: 10,
    newestAcqMs: NOW - MIN,
  });
  assert.deepEqual(byCode('brief-fire-item')[0].values, {
    label: null,
    frpMw: 10,
    acqMs: NOW - MIN,
  });
  assert.deepEqual(byCode('brief-quakes')[0].values, {
    answer: 'counted',
    reason: null,
    count: 1,
    floor: false,
    asOfMs: AS_OF,
    maxMagnitude: 3.1,
    newestTimeMs: NOW - 10 * MIN,
  });
  assert.deepEqual(byCode('brief-quake-item')[0].values, {
    label: 'us1',
    magnitude: 3.1,
    depthKm: 10,
    timeMs: NOW - 10 * MIN,
    place: '5 km N of Somewhere',
  });
  assert.deepEqual(byCode('brief-watched-item')[0].values, {
    label: 'a00001',
    kind: 'aircraft',
    presence: 'live',
    altitudeM: 3_000,
    speedMps: 150,
    aircraftClass: 'airliner',
    military: false,
    emergencyKind: null,
    squawk: '1234',
    enteredAtMs: NOW - 9 * MIN,
    lowerBound: false,
  });
  assert.deepEqual(byCode('brief-occupancy')[0].values, {
    answer: 'floor',
    reason: 'never-answered',
    count: null,
    floor: true,
    asOfMs: null,
  });
  assert.deepEqual(byCode('brief-occupancy-series')[0].values, {
    kind: 'aircraft',
    ...SUMMARY,
  });
  assert.deepEqual(byCode('brief-occupancy-gap')[0].values, { kind: 'vessel' });
  assert.deepEqual(byCode('brief-occupant')[0].values, {
    label: 'A00001',
    kind: 'aircraft',
    enteredAtMs: NOW - 9 * MIN,
    lowerBound: false,
  });
  assert.deepEqual(byCode('brief-activity-event')[0].values, {
    type: 'zone-enter',
    severity: 'notice',
    atMs: NOW - 19 * MIN,
    label: 'FLT1',
    kind: 'aircraft',
    repeat: null,
    watchlisted: false,
    params: { reentry: false, sinceMs: NOW - 20 * MIN },
    caveats: [],
  });
});

test('placeBriefLines: non-counted sections carry their answer, never 0', () => {
  const perKind = {};
  for (const kind of ALL_KINDS)
    perKind[kind] = kindAnswer('held', 'feed-stale', 0);
  const lines = placeBriefLines(brief({ zoneView: makeView(perKind) }));
  const headers = lines.filter((line) =>
    [
      'brief-aircraft',
      'brief-vessels',
      'brief-fires',
      'brief-quakes',
      'brief-watched',
      'brief-activity',
    ].includes(line.code),
  );
  assert.equal(headers.length, 6);
  for (const line of headers) {
    assert.equal(line.values.answer, 'held', line.code);
    assert.equal(line.values.reason, 'feed-stale', line.code);
    assert.equal(line.values.count, null, line.code);
  }
  assert.ok(!lines.some((line) => /-item$|-type$/.test(line.code)));
});

test('placeBriefLines: same lines after a JSON round trip; junk gives []', () => {
  const result = brief({
    frames: framesFor({ flights: [aircraft('a00001')], fires: [fire(1)] }),
    recentEvents: [event(1)],
  });
  assert.deepEqual(
    placeBriefLines(JSON.parse(JSON.stringify(result))),
    placeBriefLines(result),
  );
  assert.deepEqual(placeBriefLines(null), []);
  assert.deepEqual(placeBriefLines('brief'), []);
  assert.deepEqual(placeBriefLines([]), []);
  assert.deepEqual(
    placeBriefLines({ name: 'X', sections: [null, { id: 'nope' }, 3] }),
    [{ code: 'brief-header', values: { name: 'X', generatedAtMs: null } }],
  );
});

test('placeBriefLines: facts are re-filtered through the whitelist', () => {
  const lines = placeBriefLines({
    zoneId: 'z-1',
    name: 'Z',
    generatedAtMs: NOW,
    sections: [
      {
        id: 'aircraft',
        answer: 'counted',
        reason: null,
        asOfMs: AS_OF,
        count: 1,
        floor: false,
        highlights: [
          {
            label: 'X',
            facts: { altitudeM: 10, owner: 'ACME', speedMps: Number.NaN },
          },
        ],
      },
    ],
  });
  assert.deepEqual(lines[2].values, {
    label: 'X',
    altitudeM: 10,
    speedMps: null,
  });
});
