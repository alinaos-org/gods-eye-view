import test from 'node:test';
import assert from 'node:assert/strict';
import { getCatalog, setLocale } from '../i18n/index.js';
import { BRIEF_LINE_CODES, placeBriefLines } from '../watch/brief.js';
import {
  addZone,
  createCircleZone,
  emptyWatchDocument,
} from '../watch/document.js';
import {
  WATCH_EVENT_CATALOGUE,
  WATCH_EVENT_CAVEATS,
  createWatchEngine,
} from '../watch/engine.js';
import { ANSWER, ANSWER_REASONS, buildFrame } from '../watch/frames.js';
import { WATCH_PRESENCE } from '../watch/watchlist.js';
import {
  WATCH_WORDED_ERRORS,
  WATCH_WORDED_PRESENCE,
  WATCH_WORDED_REASONS,
  describeAnswer,
  describeCaveat,
  describeEmergency,
  describePresence,
  describeReadError,
  describeReason,
  describeWatchError,
  describeWatchEvent,
  describeWriteError,
  formatWatchDuration,
  formatWatchTime,
  placeBriefText,
  unknownEventText,
  zoneLabelDetails,
} from './watchWording.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;
const PLACEHOLDER = /\{[A-Za-z0-9_]+\}/;
const BANNED = /dark|disappear|vanish|lost contact|incident|hijack/i;
const JUNK = /undefined|NaN|\bnull\b|\[object/;

function assertClean(text, what) {
  assert.equal(typeof text, 'string', what);
  assert.ok(text.length > 0, `${what} is empty`);
  assert.doesNotMatch(text, PLACEHOLDER, `${what}: ${text}`);
  assert.doesNotMatch(text, BANNED, `${what}: ${text}`);
  assert.doesNotMatch(text, JUNK, `${what}: ${text}`);
}

/** A plausible value for every catalogue param key. */
const PARAM_VALUES = Object.freeze({
  sinceMs: T0 - 20 * MIN,
  reentry: true,
  exitAtMs: T0 - 2 * MIN,
  enteredAtMs: T0 - 40 * MIN,
  dwellMs: 38 * MIN,
  dwellLowerBound: true,
  fromMs: T0 - 30 * MIN,
  toMs: T0 - 5 * MIN,
  lastFixAtMs: T0 - 12 * MIN,
  lastAltM: 450,
  lastOnGround: false,
  descending: true,
  count: 7,
  labels: ['RYR12', 'BAW9'],
  assetKeys: ['abc123', 'def456'],
  entered: 12,
  exited: 9,
  noLongerReported: 1,
  median: 34,
  gapMs: 45 * MIN,
  before: 3,
  after: 5,
  reason: 'feed-stale',
  pausedMs: 6 * MIN,
  maxFrpMw: 140.5,
  firstAcqMs: T0 - 50 * MIN,
  lastAcqMs: T0 - 40 * MIN,
  magnitude: 5.4,
  depthKm: 12.3,
  timeMs: T0 - 9 * MIN,
  place: '12 km NNE of Testville',
  usgsId: 'us7000abcd',
  reportedAfterBaseline: true,
  outsideByKm: 14.2,
  hazard: 'quake',
  kind: 'general',
  squawk: '7700',
  source: 'squawk',
  fromKind: 'nordo',
  durationMs: 26 * MIN,
  layerId: 'flights',
  lastSeenAtMs: T0 - 70 * MIN,
  absentMs: 25 * MIN,
  coveredShare: 0.92,
});

function eventOf(type, overrides = {}) {
  const entry = WATCH_EVENT_CATALOGUE[type];
  const params = {};
  for (const key of entry.params) params[key] = PARAM_VALUES[key];
  return {
    id: 'e-1',
    seq: 1,
    type,
    severity: entry.severity,
    atMs: T0,
    dataAtMs: T0 - MIN,
    zoneId: 'z-harbour',
    assetKey: 'abc123',
    kind: type.startsWith('fires') ? 'fire' : 'aircraft',
    assetId: 'abc123',
    assetLabel: 'RYR12',
    layerId: 'flights',
    position: { lat: 51.5, lon: -1 },
    params,
    caveats: [],
    watchlisted: false,
    dedupeKey: `${type}|z-harbour|abc123`,
    ...overrides,
  };
}

test('every catalogued event type has its own honest sentence', () => {
  const fallback = unknownEventText();
  const types = Object.keys(WATCH_EVENT_CATALOGUE);
  assert.equal(types.length, 20);
  const seen = new Set();
  for (const type of types) {
    const { text, accent } = describeWatchEvent(eventOf(type), {
      zoneName: 'Harbour approach',
    });
    assertClean(text, type);
    assert.notEqual(text, fallback, `${type} uses the fallback`);
    assert.equal(accent, WATCH_EVENT_CATALOGUE[type].severity);
    seen.add(text);
    if (type.startsWith('zone-') || type.endsWith('-new')) {
      assert.match(text, /Harbour approach/, type);
    }
  }
  assert.equal(seen.size, types.length, 'sentences are distinct');
  assert.equal(describeWatchEvent({ type: 'made-up' }).text, fallback);
});

test('events with missing params, labels and zone names still read cleanly', () => {
  for (const type of Object.keys(WATCH_EVENT_CATALOGUE)) {
    const params = {};
    for (const key of WATCH_EVENT_CATALOGUE[type].params) params[key] = null;
    const bare = eventOf(type, {
      params,
      assetLabel: null,
      assetId: null,
      kind: null,
      layerId: null,
    });
    assertClean(describeWatchEvent(bare).text, `${type} (bare)`);
    assertClean(describeWatchEvent({ ...bare, params: {} }).text, type);
  }
  assertClean(describeWatchEvent(null).text, 'null event');
});

test('every caveat code is worded and appended to the event text', () => {
  for (const code of WATCH_EVENT_CAVEATS) {
    const phrase = describeCaveat(code);
    assertClean(phrase, code);
    const { text } = describeWatchEvent(
      eventOf('zone-enter', { caveats: [code] }),
    );
    assert.ok(text.endsWith(phrase), `${code}: ${text}`);
  }
  assert.notEqual(
    describeCaveat('lower-bound', { type: 'zone-exit' }),
    describeCaveat('lower-bound'),
  );
  assert.equal(describeCaveat('not-a-caveat'), '');
});

test('zone wording: re-entry, lower-bound dwell, exit windows and no longer reported', () => {
  const enter = describeWatchEvent(eventOf('zone-enter'), {
    zoneName: 'Port',
  }).text;
  assert.match(enter, /RYR12 entered Port again/);
  const exit = describeWatchEvent(
    eventOf('zone-exit', { caveats: ['lower-bound'] }),
    { zoneName: 'Port' },
  ).text;
  assert.match(exit, /RYR12 left Port/);
  assert.match(exit, /inside for ≥ 38 min/);
  assert.match(exit, /its entry was not observed/);
  const window = describeWatchEvent(eventOf('zone-exit-window'), {
    zoneName: 'Port',
  }).text;
  assert.match(window, /between 11:30 UTC and 11:55 UTC/);
  assert.match(window, /not observed in between/);
  const gone = describeWatchEvent(eventOf('zone-no-longer-reported'), {
    zoneName: 'Port',
  }).text;
  assert.match(gone, /no longer reported in Port/);
  assert.match(gone, /descending/);
  assert.match(gone, /last altitude 1500\sft/);
  const parked = describeWatchEvent(
    eventOf('zone-no-longer-reported', {
      params: {
        ...eventOf('zone-no-longer-reported').params,
        lastOnGround: true,
      },
    }),
  ).text;
  assert.match(parked, /on the ground/);
  assert.doesNotMatch(parked, /descending|altitude/);
});

test('emergency wording quotes the code only when the squawk names it', () => {
  const squawk = describeWatchEvent(
    eventOf('emergency-start', { caveats: ['on-ground'] }),
  ).text;
  assert.match(squawk, /RYR12 broadcasting squawk 7700 \(General emergency\)/);
  assert.match(squawk, /on the ground/);
  const adsb = describeWatchEvent(
    eventOf('emergency-start', {
      params: { kind: 'nordo', squawk: null, source: 'ads-b', sinceMs: T0 },
    }),
  ).text;
  assert.match(adsb, /ADS-B reports Radio failure for RYR12/);
  const unresolved = describeWatchEvent(eventOf('emergency-unresolved')).text;
  assert.match(unresolved, /outcome is not known/);
  const ended = describeWatchEvent(eventOf('emergency-end')).text;
  assert.match(ended, /≥ 26 min/);
  const active = describeEmergency(
    {
      key: 'abc123',
      icao24: 'abc123',
      label: 'RYR12',
      kind: 'unlawful',
      squawk: '7500',
      source: 'squawk',
      phase: 'unknown',
      firstSeenAtMs: T0 - 5 * MIN,
      onGround: false,
    },
    { nowMs: T0 },
  );
  assertClean(active, 'active emergency');
  assert.match(active, /squawk 7500 \(Unlawful interference\)/);
  assert.match(active, /not currently reported/);
  assert.match(active, /may be set in error/);
});

test('every answer reason and presence reason has a phrase', () => {
  for (const reason of ANSWER_REASONS) {
    assert.ok(WATCH_WORDED_REASONS.includes(reason), reason);
  }
  const fallback = describeReason('not-a-reason');
  for (const reason of WATCH_WORDED_REASONS) {
    const phrase = describeReason(reason);
    assertClean(phrase, reason);
    assert.notEqual(phrase, fallback, reason);
  }
  assert.notEqual(describeReason('transport-down'), fallback);
  assert.equal(describeReason(null), '');
});

test('answers: counts, "at least", HELD with its data time, UNKNOWN with why', () => {
  const options = { asOfMs: T0 - 3 * MIN, nowMs: T0, kind: 'aircraft' };
  assert.equal(
    describeAnswer(ANSWER.COUNTED, null, { ...options, count: 12 }),
    '12 aircraft · as of 11:57 UTC',
  );
  assert.match(
    describeAnswer(ANSWER.COUNTED, 'regional-fallback', {
      ...options,
      count: 0,
    }),
    /^0 aircraft · regional fallback feed/,
  );
  const floor = describeAnswer(ANSWER.FLOOR, 'partial-coverage', {
    ...options,
    count: 3,
    kind: 'vessel',
  });
  assert.match(floor, /^At least 3 vessels · only part of the zone/);
  const floorZero = describeAnswer(ANSWER.FLOOR, 'coverage-unknown', {
    ...options,
    count: 0,
    kind: 'vessel',
  });
  assert.doesNotMatch(floorZero, /\b0\b/);
  assert.match(floorZero, /incomplete/);
  const held = describeAnswer(ANSWER.HELD, 'feed-stale', options);
  assert.match(held, /^Aircraft: HELD · the feed is stale · last data/);
  const unknown = describeAnswer(ANSWER.UNKNOWN, 'outside-loaded-area', {
    ...options,
    kind: 'vessel',
  });
  assert.equal(unknown, 'Vessels: UNKNOWN · outside the loaded area');
  assert.match(describeAnswer(ANSWER.OFF, 'feed-off', options), /OFF/);
  for (const state of Object.values(ANSWER)) {
    for (const reason of [null, ...ANSWER_REASONS]) {
      assertClean(
        describeAnswer(state, reason, { ...options, count: 2 }),
        `${state}/${reason}`,
      );
    }
  }
});

test('every presence state reads cleanly, declined says why', () => {
  for (const state of Object.values(WATCH_PRESENCE)) {
    assert.ok(WATCH_WORDED_PRESENCE.includes(state), state);
    for (const reason of [null, 'feed-stale', 'fix-old', 'id-mismatch']) {
      assertClean(
        describePresence(state, reason, {
          fixAtMs: T0 - 3 * MIN,
          nowMs: T0,
          layerId: 'flights',
          matches: 2,
        }),
        `${state}/${reason}`,
      );
    }
  }
  const live = describePresence('live', null, {
    fixAtMs: T0 - 3 * MIN,
    nowMs: T0,
    layerId: 'flights',
  });
  assert.equal(live, 'LIVE · 3 minutes ago · Live Flights');
  assert.match(
    describePresence('declined', 'private-aircraft-class'),
    /^NOT WATCHED · private light aircraft/,
  );
  assert.match(
    describePresence('outside-coverage', 'outside-loaded-area'),
    /OUTSIDE COVERAGE · outside the loaded area/,
  );
});

test('durations and times: ≥ for lower bounds, UTC clocks, dated when old', () => {
  assert.equal(formatWatchDuration(4 * MIN), '4 min');
  assert.equal(formatWatchDuration(30_000), 'under 1 min');
  assert.equal(formatWatchDuration(125 * MIN), '2 hr 5 min');
  assert.equal(formatWatchDuration(3 * 3_600_000), '3 hr');
  assert.equal(formatWatchDuration(12 * MIN, { lowerBound: true }), '≥ 12 min');
  assert.equal(formatWatchDuration(null), '');
  assert.equal(formatWatchDuration(-1), '');
  assert.equal(formatWatchTime(T0, { nowMs: T0 + MIN }), '12:00 UTC');
  assert.equal(
    formatWatchTime(T0, { nowMs: T0 + 2 * 86_400_000 }),
    '10-26 12:00 UTC',
  );
  assert.equal(formatWatchTime(null), '');
});

test('zone label details give one short count line per zone', () => {
  const [line] = zoneLabelDetails({
    kinds: ['aircraft', 'vessel', 'fire', 'quake'],
    perKind: {
      aircraft: { answer: 'counted', count: 12 },
      vessel: { answer: 'floor', count: 3 },
      fire: { answer: 'unknown', count: null, reason: 'key-required' },
      quake: { answer: 'off', count: null },
    },
  });
  assert.equal(
    line,
    '12 aircraft · ≥ 3 vessels · Fires: UNKNOWN · Earthquakes: OFF',
  );
  assert.deepEqual(zoneLabelDetails({ kinds: [] }), []);
  assert.deepEqual(zoneLabelDetails(null), []);
});

test('document, read and write errors are worded', () => {
  const fallback = describeWatchError('not-a-code');
  for (const code of WATCH_WORDED_ERRORS) {
    const text = describeWatchError(code);
    assertClean(text, code);
    assert.notEqual(text, fallback, code);
  }
  for (const code of [
    'unavailable',
    'too-large',
    'malformed',
    'unsupported-version',
  ]) {
    assertClean(describeReadError(code), code);
  }
  const partial = describeReadError('partial', { zones: 2, watchlist: 1 });
  assert.match(partial, /2 zones were skipped/);
  assert.match(partial, /1 watched asset was skipped/);
  for (const reason of [
    'read-error',
    'unavailable',
    'quota',
    'too-large',
    'invalid',
  ]) {
    assertClean(describeWriteError(reason), reason);
  }
});

const BRIEF = Object.freeze({
  zoneId: 'z-harbour',
  name: 'Harbour approach',
  generatedAtMs: T0,
  sections: [
    {
      id: 'aircraft',
      answer: 'counted',
      reason: null,
      asOfMs: T0 - MIN,
      count: 2,
      floor: false,
      highlights: [
        {
          label: 'RYR12',
          kind: 'aircraft',
          facts: {
            altitudeM: 900,
            speedMps: 100,
            aircraftClass: 'airliner',
            military: false,
            emergencyKind: 'general',
            squawk: '7700',
            enteredAtMs: T0 - 20 * MIN,
            lowerBound: true,
          },
        },
      ],
    },
    {
      id: 'vessels',
      answer: 'floor',
      reason: 'partial-coverage',
      asOfMs: T0 - MIN,
      count: 3,
      floor: true,
      highlights: [
        {
          label: 'NORDIC STAR',
          kind: 'vessel',
          facts: { speedKts: 0.2, shipType: 'CARGO' },
        },
      ],
      buckets: [
        { key: 'CARGO', count: 2 },
        { key: 'untyped', count: 1 },
      ],
    },
    {
      id: 'fires',
      answer: 'counted',
      reason: null,
      asOfMs: T0 - MIN,
      count: 1,
      floor: false,
      maxFrpMw: 33.3,
      newestAcqMs: T0 - 30 * MIN,
      highlights: [
        {
          label: null,
          kind: 'fire',
          facts: { frpMw: 33.3, acqMs: T0 - 30 * MIN },
        },
      ],
    },
    {
      id: 'quakes',
      answer: 'counted',
      reason: null,
      asOfMs: T0 - 30 * MIN,
      count: 1,
      floor: false,
      maxMagnitude: 3.2,
      newestTimeMs: T0 - 50 * MIN,
      highlights: [
        {
          label: 'us7000wxyz',
          kind: 'quake',
          facts: {
            magnitude: 3.2,
            depthKm: 4,
            timeMs: T0 - 50 * MIN,
            place: '3 km E of Testville',
          },
        },
      ],
    },
    {
      id: 'watched',
      answer: 'counted',
      reason: null,
      asOfMs: T0 - MIN,
      count: 1,
      floor: false,
      highlights: [
        {
          label: 'RYR12',
          kind: 'aircraft',
          presence: 'live',
          facts: { altitudeM: 900, enteredAtMs: T0 - 20 * MIN },
        },
      ],
    },
    {
      id: 'occupancy',
      answer: 'floor',
      reason: 'never-answered',
      asOfMs: null,
      count: null,
      floor: true,
      series: {
        aircraft: {
          sinceMs: T0 - 90 * MIN,
          min: 1,
          median: 2.5,
          max: 4,
          samples: 90,
          floorSamples: 0,
        },
        vessel: null,
      },
      highlights: [
        {
          label: 'RYR12',
          kind: 'aircraft',
          facts: { enteredAtMs: T0 - 20 * MIN, lowerBound: true },
        },
      ],
    },
    {
      id: 'activity',
      answer: 'counted',
      reason: null,
      asOfMs: T0,
      count: 1,
      floor: false,
      highlights: [],
      events: [
        {
          type: 'quake-new',
          severity: 'alert',
          atMs: T0 - 4 * MIN,
          kind: 'quake',
          assetLabel: null,
          params: {
            magnitude: 5.1,
            depthKm: 8,
            timeMs: T0 - 10 * MIN,
            place: '5 km N of Testville',
            usgsId: 'us7000abcd',
            reportedAfterBaseline: false,
            outsideByKm: 0,
          },
          caveats: [],
          watchlisted: false,
          repeat: 2,
        },
      ],
    },
  ],
});

test('a brief section names its kind once, even when it cannot count', () => {
  const brief = {
    ...BRIEF,
    sections: BRIEF.sections.map((section) =>
      section.id === 'quakes'
        ? { ...section, answer: 'held', reason: 'feed-stale', count: null }
        : section.id === 'vessels'
          ? { ...section, count: 0 }
          : section,
    ),
  };
  const text = placeBriefText(brief).join('\n');
  assert.match(text, /^Earthquakes: HELD · the feed is stale · last data/m);
  assert.match(text, /^Vessels: None seen, but the count is incomplete/m);
  assert.doesNotMatch(text, /Earthquakes: Earthquakes|Vessels: Vessels/);
});

test('a place brief words every line code honestly', () => {
  const codes = new Set(placeBriefLines(BRIEF).map(({ code }) => code));
  assert.deepEqual(
    [...codes].sort(),
    Object.values(BRIEF_LINE_CODES).sort(),
    'the fixture reaches every line code',
  );
  const lines = placeBriefText(BRIEF);
  assert.equal(lines.length, placeBriefLines(BRIEF).length);
  for (const line of lines) assertClean(line, 'brief line');
  const text = lines.join('\n');
  assert.match(lines[0], /^Brief: Harbour approach · 12:00 UTC$/);
  assert.match(text, /Aircraft: 2 aircraft · as of 11:59 UTC/);
  assert.match(text, /squawk 7700 \(General emergency\)/);
  assert.match(text, /inside for ≥ 20 min/);
  assert.match(text, /Vessels: At least 3 vessels/);
  assert.match(text, /• CARGO: 2/);
  assert.match(text, /• No type reported: 1/);
  assert.match(text, /NORDIC STAR · CARGO · 0\.2\skt/);
  assert.doesNotMatch(text, /anchor|moor/i);
  assert.match(
    text,
    /Earthquakes: 1 earthquake · as of 11:30 UTC · strongest M3\.2/,
  );
  assert.match(
    text,
    /• M3\.2 · 3 km E of Testville · 4\skm deep · origin 11:10 UTC/,
  );
  assert.match(text, /min 1, median 2\.5, max 4/);
  assert.match(text, /no complete count recorded yet/);
  assert.match(text, /M5\.1 earthquake in Harbour approach/);
  assert.match(text, /×2/);
  assert.deepEqual(placeBriefText(null), []);
});

function frame(layerId, nowMs, rows, coverage = { kind: 'global' }) {
  return buildFrame({
    layerId,
    nowMs,
    enabled: true,
    snapshot: {
      enabled: true,
      feedState: 'nominal',
      count: rows.length,
      lastUpdate: nowMs,
    },
    stats: { count: rows.length, lastUpdate: nowMs },
    coverage,
    readRows: () => rows,
    previousEpochMs: null,
  });
}

test('a brief from the real engine reads cleanly', () => {
  const made = createCircleZone(
    {
      name: 'Harbour approach',
      center: { lat: 51.5, lon: -1 },
      radiusM: 25_000,
      kinds: ['aircraft', 'vessel', 'fire', 'quake'],
    },
    { nowMs: T0, makeId: () => 'harbour' },
  );
  assert.ok(made.ok);
  const doc = addZone(emptyWatchDocument(), made.zone).doc;
  const engine = createWatchEngine();
  engine.setDocument(doc);
  const now = T0 + MIN;
  engine.ingest(
    frame('flights', now, [
      {
        id: 'RYR12',
        icao24: 'abc123',
        lat: 51.52,
        lon: -1.01,
        altitudeM: 900,
        speedMps: 90,
        onGround: false,
        aircraftClass: 'airliner',
        squawk: '1200',
        emergency: false,
        receivedAtMs: now,
        lastContactAtMs: now,
      },
    ]),
  );
  engine.ingest(frame('military', now, []));
  engine.ingest(
    frame(
      'ais-live-vessels',
      now,
      [
        {
          id: 'NORDIC STAR',
          mmsi: '235000001',
          lat: 51.49,
          lon: -1.02,
          speedKts: 0.1,
          shipType: '70',
          positionAtMs: now - 5000,
        },
      ],
      { kind: 'circle', lat: 51.5, lon: -1, radiusKm: 200 },
    ),
  );
  engine.ingest(frame('local-firms', now, []));
  engine.ingest(frame('earthquakes', now, []));
  const brief = engine.brief(made.zone.id, { nowMs: now });
  const lines = placeBriefText(brief);
  assert.ok(lines.length > 5);
  for (const line of lines) assertClean(line, 'engine brief line');
  const text = lines.join('\n');
  assert.match(text, /Harbour approach/);
  assert.match(text, /1 aircraft/);
  assert.match(text, /NORDIC STAR/);
  assert.match(text, /0 fire detections/);
  const [label] = zoneLabelDetails(engine.view(now).zones[0]);
  assert.equal(
    label,
    '1 aircraft · 1 vessel · 0 fire detections · 0 earthquakes',
  );
});

test('Spanish smoke test: known strings translate and no placeholder leaks', (t) => {
  assert.ok(getCatalog('es'));
  setLocale('es');
  t.after(() => setLocale('en'));
  for (const type of Object.keys(WATCH_EVENT_CATALOGUE)) {
    const { text } = describeWatchEvent(eventOf(type), { zoneName: 'Puerto' });
    assert.doesNotMatch(text, PLACEHOLDER, type);
    assert.doesNotMatch(text, JUNK, type);
  }
  assert.match(
    describeAnswer(ANSWER.UNKNOWN, 'outside-loaded-area'),
    /DESCONOCIDO/,
  );
  assert.match(
    describeWatchEvent(eventOf('emergency-start')).text,
    /squawk 7700/,
  );
  for (const line of placeBriefText(BRIEF)) {
    assert.doesNotMatch(line, PLACEHOLDER);
  }
});

/** The honest-wording ban, per shipped translation. */
const BANNED_TRANSLATED = Object.freeze({
  es: /desapareci|desvaneci|perdi[óo] el contacto|incidente|secuestr|oscur/i,
  ru: /исчез|пропал|потер\S* (?:связь|контакт)|инцидент|угон|т[её]мн/i,
  'zh-CN': /消失|失联|劫持|事故|黑暗/,
});

test('translations keep the honest wording and use their plural forms', (t) => {
  t.after(() => setLocale('en'));
  for (const [locale, banned] of Object.entries(BANNED_TRANSLATED)) {
    setLocale(locale);
    const texts = [
      ...Object.keys(WATCH_EVENT_CATALOGUE).map(
        (type) =>
          describeWatchEvent(eventOf(type), { zoneName: 'Puerto' }).text,
      ),
      ...WATCH_WORDED_REASONS.map((reason) => describeReason(reason)),
      ...WATCH_WORDED_PRESENCE.map((state) => describePresence(state, null)),
      ...WATCH_EVENT_CAVEATS.map((code) => describeCaveat(code)),
      ...placeBriefText(BRIEF),
    ];
    for (const text of texts) {
      assert.doesNotMatch(text, PLACEHOLDER, `${locale}: ${text}`);
      assert.doesNotMatch(text, banned, `${locale}: ${text}`);
      assert.doesNotMatch(text, JUNK, `${locale}: ${text}`);
    }
  }
  // The busy-traffic counts are tn() literals the catalog extractor sees.
  setLocale('ru');
  const busy = describeWatchEvent(eventOf('zone-traffic-summary'), {
    zoneName: 'Puerto',
  }).text;
  assert.match(busy, /12 входов/);
  assert.match(busy, /9 выходов/);
  assert.match(busy, /без данных: 1/);
});
