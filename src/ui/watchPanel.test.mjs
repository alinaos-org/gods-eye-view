import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchEventLog } from '../watch/eventLog.js';
import {
  addWatchEntry,
  addZone,
  createCircleZone,
  emptyWatchDocument,
} from '../watch/document.js';
import { createWatchEngine } from '../watch/engine.js';
import { buildFrame } from '../watch/frames.js';
import { railFixture } from './railTestFixture.mjs';
import { WATCH_CONFIRM_MS, createWatchPanel } from './watchPanel.js';
import { describeWatchError } from './watchWording.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const MIN = 60_000;

const ZONE = Object.freeze({
  id: 'z-harbour',
  name: 'Harbour approach',
  shape: 'circle',
  center: { lat: 51.5, lon: -1 },
  radiusM: 25_000,
  kinds: ['aircraft', 'vessel'],
  notify: 'all',
  aircraft: { militaryOnly: false },
  fire: { minFrpMw: 0 },
  quake: { minMagnitude: 2.5, alertMagnitude: 5, bufferKm: 0 },
  createdAtMs: T0,
  updatedAtMs: T0,
});

function zoneView(overrides = {}) {
  return {
    id: ZONE.id,
    name: ZONE.name,
    shape: 'circle',
    kinds: ['aircraft', 'vessel'],
    notify: 'all',
    alert: false,
    labelAnchor: { lat: 51.7, lon: -1 },
    outline: [],
    perKind: {
      aircraft: {
        answer: 'counted',
        reason: null,
        count: 4,
        floor: false,
        asOfMs: T0 - MIN,
        busy: false,
      },
      vessel: {
        answer: 'unknown',
        reason: 'outside-loaded-area',
        count: null,
        floor: false,
        asOfMs: null,
        busy: false,
      },
    },
    occupants: [
      {
        assetKey: 'abc123',
        label: 'RYR12',
        kind: 'aircraft',
        enteredAtMs: T0 - 40 * MIN,
        lowerBound: true,
      },
    ],
    timed: true,
    capped: false,
    series: {},
    ...overrides,
  };
}

function row(id, overrides = {}) {
  return {
    id,
    seq: 1,
    type: 'zone-enter',
    severity: 'notice',
    atMs: T0 - 2 * MIN,
    dataAtMs: T0 - 2 * MIN,
    zoneId: ZONE.id,
    assetKey: 'abc123',
    kind: 'aircraft',
    assetId: 'abc123',
    assetLabel: 'RYR12',
    layerId: 'flights',
    position: null,
    params: { sinceMs: T0 - 3 * MIN, reentry: false },
    caveats: [],
    watchlisted: false,
    dedupeKey: `zone-enter|${ZONE.id}|abc123`,
    repeat: 1,
    firstAtMs: T0 - 2 * MIN,
    read: false,
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    visible: true,
    nowMs: T0,
    view: {
      generatedAtMs: T0,
      zones: [zoneView()],
      watchlist: [],
      emergencies: [],
      feeds: {
        flights: { answer: 'counted', reason: null, asOfMs: T0, paused: false },
        military: { answer: 'off', reason: 'feed-off', asOfMs: null },
        'ais-live-vessels': { answer: 'counted', reason: null, asOfMs: T0 },
      },
    },
    doc: {
      v: 1,
      zones: [ZONE],
      watchlist: [],
      prefs: { zonesVisible: true, toasts: true, allEmergencies: false },
    },
    inbox: { rows: [], alertRows: [], unread: 0 },
    selection: null,
    annotations: [],
    briefs: {},
    readError: null,
    writeError: null,
    notices: { watch: null, zones: null },
    ...overrides,
  };
}

function setup(options = {}) {
  const f = railFixture();
  const panel = f.document.createElement('section');
  panel.hidden = true;
  const countBadge = f.document.createElement('span');
  const actions = [];
  const timers = [];
  let clock = T0;
  const view = createWatchPanel({
    container: f.container,
    panel,
    countBadge,
    onAction: (action) => actions.push(action),
    now: () => clock,
    schedule: (callback, ms) => timers.push({ callback, ms }),
    ...options,
  });
  return {
    f,
    panel,
    countBadge,
    actions,
    timers,
    view,
    advance(ms) {
      clock += ms;
    },
    card(id) {
      return f.find((node) => node.dataset?.cardId === id);
    },
    within(root, predicate) {
      return f.find(predicate, root);
    },
    action(cardId, actionId) {
      return f.find(
        (node) => node.dataset?.actionId === actionId,
        this.card(cardId),
      );
    },
  };
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)]
    .filter(Boolean)
    .join('\n');
}

function openCard(h, id) {
  const card = h.card(id);
  if (card.dataset.open !== 'true') card.children[0].click();
  assert.equal(h.card(id).dataset.open, 'true', `${id} opens`);
  return h.card(id);
}

test('cards render in order; emergencies only when there are some', () => {
  const h = setup();
  h.view.update(model());
  const ids = () =>
    h.f
      .find((node) => node.className === 'watch-cards')
      .children.map((node) => node.dataset.cardId);
  assert.deepEqual(ids(), [
    'inbox',
    'watched',
    'zone:z-harbour',
    'add-zone',
    'settings',
  ]);
  h.view.update(
    model({
      view: {
        ...model().view,
        emergencies: [
          {
            key: 'abc123',
            icao24: 'abc123',
            label: 'RYR12',
            kind: 'general',
            squawk: '7700',
            source: 'squawk',
            phase: 'active',
            firstSeenAtMs: T0 - 5 * MIN,
            onGround: false,
          },
        ],
      },
    }),
  );
  assert.deepEqual(ids().slice(0, 2), ['inbox', 'emergencies']);
  const emergencies = openCard(h, 'emergencies');
  assert.match(allText(emergencies), /broadcasting squawk 7700/);
  h.f
    .find(
      (node) =>
        node.dataset?.listItemId === 'abc123' && node.tagName === 'BUTTON',
      emergencies,
    )
    .click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'focus-emergency',
    key: 'abc123',
  });
});

test('zone cards say UNKNOWN with why, ≥ for lower bounds and "as of" times', () => {
  const h = setup();
  h.view.update(model());
  const card = openCard(h, 'zone:z-harbour');
  const text = allText(card);
  assert.match(text, /4 aircraft · as of 11:59 UTC/);
  assert.match(text, /Vessels: UNKNOWN · outside the loaded area/);
  assert.match(text, /RYR12 · inside for ≥ 40 min/);
  assert.match(text, /Flying there loads its area/);
  assert.doesNotMatch(text, /\{[a-z]+\}/i);
  // The compact line (card closed) is the globe label line.
  card.children[0].click();
  assert.match(
    allText(h.card('zone:z-harbour')),
    /4 aircraft · Vessels: UNKNOWN/,
  );
});

test('zone settings and actions send precise actions', () => {
  const h = setup();
  h.view.update(model());
  const card = openCard(h, 'zone:z-harbour');
  const chip = (settingId, chipId) =>
    h.within(
      h.within(card, (node) => node.dataset?.blockId === settingId),
      (node) => node.dataset?.chipId === chipId,
    );
  chip('kinds', 'fire').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-update',
    zoneId: 'z-harbour',
    patch: { kinds: ['aircraft', 'vessel', 'fire'] },
  });
  chip('radius', '100').click();
  assert.deepEqual(h.actions.at(-1).patch, { radiusM: 100_000 });
  chip('military', 'military').click();
  assert.deepEqual(h.actions.at(-1).patch, {
    aircraft: { militaryOnly: true },
  });
  chip('notify', 'watchlisted').click();
  assert.deepEqual(h.actions.at(-1).patch, { notify: 'watchlisted' });
  h.action('zone:z-harbour', 'fly').click();
  assert.deepEqual(h.actions.at(-1), { type: 'zone-fly', zoneId: 'z-harbour' });
  h.action('zone:z-harbour', 'brief').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-brief',
    zoneId: 'z-harbour',
  });
  assert.equal(h.action('zone:z-harbour', 'copy').disabled, true);

  // The last watched kind cannot be switched off.
  h.view.update(
    model({
      view: { ...model().view, zones: [zoneView({ kinds: ['aircraft'] })] },
      doc: { ...model().doc, zones: [{ ...ZONE, kinds: ['aircraft'] }] },
    }),
  );
  assert.equal(chip('kinds', 'aircraft').disabled, true);
});

test('an off feed offers to turn its layer on', () => {
  const h = setup();
  const base = model();
  h.view.update(
    model({
      view: {
        ...base.view,
        zones: [
          zoneView({
            perKind: {
              ...zoneView().perKind,
              aircraft: {
                answer: 'off',
                reason: 'feed-off',
                count: null,
                floor: false,
                asOfMs: null,
                busy: false,
              },
            },
          }),
        ],
      },
    }),
  );
  openCard(h, 'zone:z-harbour');
  const turnOn = h.action('zone:z-harbour', 'enable-flights');
  assert.ok(turnOn, 'Turn on action');
  assert.match(turnOn.textContent, /Turn on Live Flights/);
  turnOn.click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'layer-enable',
    layerId: 'flights',
  });
});

test('delete needs a second click within 3 s', () => {
  const h = setup();
  h.view.update(model());
  openCard(h, 'zone:z-harbour');
  const remove = () => h.action('zone:z-harbour', 'delete');
  remove().click();
  assert.equal(h.actions.length, 0);
  assert.equal(remove().textContent, 'Confirm delete');
  h.advance(WATCH_CONFIRM_MS - 1);
  remove().click();
  assert.deepEqual(h.actions, [{ type: 'zone-delete', zoneId: 'z-harbour' }]);

  // A second click after the window only re-arms.
  remove().click();
  assert.equal(h.timers.length, 2);
  h.advance(WATCH_CONFIRM_MS + 1);
  h.timers.at(-1).callback();
  assert.equal(remove().textContent, 'Delete');
  remove().click();
  assert.equal(h.actions.length, 1);
  assert.equal(remove().textContent, 'Confirm delete');
});

test('the read-error banner offers keep and a confirmed reset', () => {
  const h = setup();
  h.view.update(
    model({
      readError: { code: 'partial', dropped: { zones: 1, watchlist: 0 } },
      writeError: 'read-error',
    }),
  );
  const banner = h.f.find((node) =>
    node.className?.includes('watch-banner panel-surface-error'),
  );
  assert.equal(banner.hidden, false);
  assert.equal(banner.getAttribute('role'), 'status');
  assert.match(allText(banner), /1 zone was skipped/);
  const writeError = h.f.find((node) =>
    node.className?.includes('watch-write-error'),
  );
  assert.equal(writeError.hidden, false);
  assert.match(writeError.textContent, /^Not saved/);
  const [keep, reset] = h.within(banner, (node) =>
    node.className?.includes('watch-banner-actions'),
  ).children;
  keep.click();
  assert.deepEqual(h.actions.at(-1), { type: 'storage-keep' });
  reset.click();
  assert.equal(h.actions.length, 1);
  assert.equal(reset.textContent, 'Confirm reset');
  reset.click();
  assert.deepEqual(h.actions.at(-1), { type: 'storage-reset' });
  h.view.update(model());
  assert.equal(banner.hidden, true);
  assert.equal(writeError.hidden, true);
});

test('identifiers: bad ids and duplicates are refused in place, a good one is sent once', () => {
  const h = setup();
  const watched = {
    id: 'w-abcd',
    kind: 'aircraft',
    match: 'icao24',
    value: '4ca7b3',
    label: null,
    addedAtMs: T0,
    declined: null,
    lastSeen: null,
  };
  h.view.update(model({ doc: { ...model().doc, watchlist: [watched] } }));
  const card = openCard(h, 'watched');
  h.action('watched', 'add-id').click();
  const form = h.within(card, (node) =>
    node.className?.includes('watch-inline-form'),
  );
  assert.ok(form, 'form mounted in the watched card');
  assert.equal(form.hidden, false);
  const input = h.within(form, (node) => node.tagName === 'INPUT');
  const error = h.within(form, (node) =>
    node.className?.includes('watch-inline-error'),
  );
  const [save] = h.within(form, (node) =>
    node.className?.includes('watch-inline-buttons'),
  ).children;
  input.value = 'zzz';
  save.click();
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, describeWatchError('bad-id'));
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  input.value = ' 4CA7B3 ';
  save.click();
  assert.equal(error.textContent, describeWatchError('duplicate'));
  assert.equal(h.actions.length, 0);

  // Switch to MMSI with the match chips, then submit with Enter.
  h.within(form, (node) => node.dataset?.chipId === 'mmsi').click();
  assert.match(input.getAttribute('placeholder'), /235012345/);
  input.value = '235 012 345';
  const enter = new Event('keydown');
  Object.defineProperty(enter, 'key', { value: 'Enter' });
  input.dispatchEvent(enter);
  assert.deepEqual(h.actions, [
    { type: 'watch-add-id', match: 'mmsi', value: '235012345' },
  ]);
  assert.equal(form.hidden, false);
  // The form closes once the controller's view lists the entry.
  const base = model();
  h.view.update(
    model({
      view: {
        ...base.view,
        watchlist: [
          {
            entryId: 'w-efgh',
            kind: 'vessel',
            match: 'mmsi',
            value: '235012345',
            label: null,
            presence: { state: 'checking', reason: 'awaiting-frame' },
            fix: null,
            layerId: null,
            zoneIds: [],
            matches: 0,
            lastSeen: null,
            sinceMs: T0,
          },
        ],
      },
    }),
  );
  assert.equal(form.hidden, true);
  assert.equal(input.value, '');
  assert.match(
    allText(h.card('watched')),
    /CHECKING · waiting for the first data/,
  );
});

test('a refused add from the controller shows its reason in the form', () => {
  const h = setup();
  h.view.update(model());
  openCard(h, 'watched');
  h.action('watched', 'add-id').click();
  const form = h.f.find((node) =>
    node.className?.includes('watch-inline-form'),
  );
  const input = h.within(form, (node) => node.tagName === 'INPUT');
  input.value = 'a1b2c3';
  h.within(
    form,
    (node) =>
      node.dataset?.actionId === undefined &&
      node.tagName === 'BUTTON' &&
      node.textContent === 'Add',
  ).click();
  assert.equal(h.actions.at(-1).type, 'watch-add-id');
  h.view.update(model({ notices: { watch: 'full', zones: null } }));
  const error = h.within(form, (node) =>
    node.className?.includes('watch-inline-error'),
  );
  assert.equal(error.textContent, describeWatchError('full'));
  assert.equal(form.hidden, false);
});

test('watched assets: select a row, focus it, remove after confirmation', () => {
  const h = setup();
  const base = model();
  const watchRow = {
    entryId: 'w-abcd',
    kind: 'aircraft',
    match: 'callsign',
    value: 'RYR12',
    label: 'Ryanair 12',
    presence: { state: 'live', reason: null },
    fix: { lat: 51.5, lon: -1, atMs: T0 - 2 * MIN },
    layerId: 'flights',
    zoneIds: ['z-harbour'],
    matches: 1,
    lastSeen: null,
    sinceMs: T0 - 10 * MIN,
  };
  h.view.update(
    model({
      view: { ...base.view, watchlist: [watchRow] },
      selection: {
        kind: 'vessel',
        match: 'mmsi',
        value: '235012345',
        label: 'NORDIC STAR',
        watched: false,
        zoneable: true,
      },
    }),
  );
  const card = openCard(h, 'watched');
  assert.match(
    allText(card),
    /Ryanair 12 · RYR12 · LIVE · 2 minutes ago · Live Flights · inside Harbour approach/,
  );
  assert.equal(h.action('watched', 'focus').disabled, true);
  h.within(
    card,
    (node) =>
      node.dataset?.listItemId === 'w-abcd' && node.tagName === 'BUTTON',
  ).click();
  assert.equal(h.action('watched', 'focus').disabled, false);
  h.action('watched', 'focus').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'watch-focus',
    entryId: 'w-abcd',
  });
  h.action('watched', 'remove').click();
  assert.equal(h.actions.length, 1);
  h.action('watched', 'remove').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'watch-remove',
    entryId: 'w-abcd',
  });
  h.action('watched', 'watch-selection').click();
  assert.deepEqual(h.actions.at(-1), { type: 'watch-add-selection' });
  assert.match(allText(card), /NORDIC STAR/);
});

test('add zone: radius chips, selection default radius, drawn shapes and limits', () => {
  const h = setup();
  const selection = {
    kind: 'vessel',
    match: 'mmsi',
    value: '235012345',
    label: 'NORDIC STAR',
    watched: false,
    zoneable: true,
  };
  h.view.update(
    model({
      selection,
      annotations: [{ id: 'anno-3', type: 'area', label: null }],
      notices: { watch: null, zones: 'too-small' },
    }),
  );
  const card = openCard(h, 'add-zone');
  assert.match(allText(card), /Zones must cover at least 2 km²/);
  h.action('add-zone', 'view').click();
  assert.deepEqual(h.actions.at(-1), { type: 'zone-add-view', radiusKm: 25 });
  h.action('add-zone', 'selection').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-add-selection',
    radiusKm: 5,
  });
  h.within(card, (node) => node.dataset?.chipId === '100').click();
  h.action('add-zone', 'selection').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-add-selection',
    radiusKm: 100,
  });
  h.within(
    card,
    (node) =>
      node.dataset?.listItemId === 'anno-3' && node.tagName === 'BUTTON',
  ).click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-add-annotation',
    annotationId: 'anno-3',
  });
  h.view.update(model({ selection: null }));
  assert.equal(h.action('add-zone', 'selection').disabled, true);
  const zones = Array.from({ length: 24 }, (_, i) => ({
    ...ZONE,
    id: `z-${i}aaaa`,
  }));
  h.view.update(model({ doc: { ...model().doc, zones } }));
  assert.equal(h.action('add-zone', 'view').disabled, true);
  assert.match(allText(h.card('add-zone')), /limit of 24 zones/);
});

test('inbox: unread badge caps at 99+, alert filter, focus and confirmed clear', () => {
  const h = setup();
  const rows = [
    row('e-2', {
      severity: 'alert',
      type: 'watch-reappeared',
      zoneId: null,
      params: { absentMs: 25 * MIN, coveredShare: 1 },
    }),
    row('e-1', { read: true }),
  ];
  h.view.update(model({ inbox: { rows, alertRows: [rows[0]], unread: 150 } }));
  assert.equal(h.countBadge.textContent, '99+');
  const card = h.card('inbox');
  assert.equal(card.dataset.open, 'true', 'the inbox starts open');
  const text = allText(card);
  assert.match(text, /99\+ new/);
  assert.match(text, /RYR12 entered Harbour approach/);
  assert.match(text, /● 11:58 UTC/);
  h.within(card, (node) => node.dataset?.chipId === 'alerts').click();
  assert.doesNotMatch(allText(h.card('inbox')), /entered Harbour/);
  assert.match(allText(h.card('inbox')), /reported again after 25 min/);
  h.within(
    h.card('inbox'),
    (node) => node.dataset?.listItemId === 'e-2' && node.tagName === 'BUTTON',
  ).click();
  assert.deepEqual(h.actions.at(-1), { type: 'focus-event', eventId: 'e-2' });
  h.action('inbox', 'read').click();
  assert.deepEqual(h.actions.at(-1), { type: 'inbox-mark-all-read' });
  h.action('inbox', 'clear').click();
  assert.notDeepEqual(h.actions.at(-1), { type: 'inbox-clear' });
  h.action('inbox', 'clear').click();
  assert.deepEqual(h.actions.at(-1), { type: 'inbox-clear' });
  h.view.update(model());
  assert.equal(h.countBadge.textContent, '');
  assert.equal(h.action('inbox', 'read').disabled, true);
});

test('briefs render as a result block, copy as shown and clear', () => {
  const h = setup();
  const brief = {
    zoneId: 'z-harbour',
    name: 'Harbour approach',
    generatedAtMs: T0,
    sections: [
      {
        id: 'aircraft',
        answer: 'floor',
        reason: 'partial-coverage',
        asOfMs: T0 - MIN,
        count: 3,
        floor: true,
        highlights: [],
      },
    ],
  };
  h.view.update(model({ briefs: { 'z-harbour': brief } }));
  const card = openCard(h, 'zone:z-harbour');
  const result = h.within(card, (node) => node.dataset?.blockId === 'brief');
  assert.ok(result);
  assert.match(allText(result), /At least 3 aircraft/);
  h.action('zone:z-harbour', 'copy').click();
  const copied = h.actions.at(-1);
  assert.equal(copied.type, 'zone-brief-copy');
  assert.equal(
    copied.text,
    'Brief: Harbour approach · 12:00 UTC\nAircraft: At least 3 aircraft · only part of the zone is in the loaded area · as of 11:59 UTC',
  );
  h.within(result, (node) => node.dataset?.actionId === 'clear').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'zone-brief-clear',
    zoneId: 'z-harbour',
  });
});

test('rename opens prefilled, refuses an empty name and sends a clean one', () => {
  const h = setup();
  h.view.update(model());
  const card = openCard(h, 'zone:z-harbour');
  h.action('zone:z-harbour', 'rename').click();
  const form = h.within(card, (node) =>
    node.className?.includes('watch-inline-form'),
  );
  const input = h.within(form, (node) => node.tagName === 'INPUT');
  assert.equal(input.value, 'Harbour approach');
  const [save] = h.within(form, (node) =>
    node.className?.includes('watch-inline-buttons'),
  ).children;
  input.value = '   ';
  save.click();
  assert.equal(h.actions.length, 0);
  input.value = 'Outer  harbour';
  save.click();
  assert.deepEqual(h.actions, [
    { type: 'zone-rename', zoneId: 'z-harbour', name: 'Outer harbour' },
  ]);
  assert.equal(form.hidden, true);
});

test('settings send prefs patches', () => {
  const h = setup();
  h.view.update(model());
  const card = openCard(h, 'settings');
  const toggle = (setting, chip) =>
    h.within(
      h.within(card, (node) => node.dataset?.blockId === setting),
      (node) => node.dataset?.chipId === chip,
    );
  assert.equal(
    toggle('zones-visible', 'on').getAttribute('aria-pressed'),
    'true',
  );
  toggle('all-emergencies', 'on').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'prefs',
    patch: { allEmergencies: true },
  });
  toggle('toasts', 'off').click();
  assert.deepEqual(h.actions.at(-1), {
    type: 'prefs',
    patch: { toasts: false },
  });
});

test('restored zones stay shut; a zone added later opens', () => {
  const h = setup();
  h.view.update(model({ view: null, doc: null }));
  h.view.update(model());
  assert.equal(h.card('zone:z-harbour').dataset.open, 'false');
  const base = model();
  const added = zoneView({ id: 'z-outer', name: 'Outer anchorage' });
  h.view.update(
    model({
      view: { ...base.view, zones: [zoneView(), added] },
      doc: { ...base.doc, zones: [ZONE, { ...ZONE, id: 'z-outer' }] },
    }),
  );
  assert.equal(h.card('zone:z-outer').dataset.open, 'true');
  assert.equal(h.card('zone:z-harbour').dataset.open, 'false');
});

test('visibility follows the model, repeats write nothing, destroy cleans up', () => {
  let writes = 0;
  const f = railFixture(() => writes++);
  const panel = f.document.createElement('section');
  const countBadge = f.document.createElement('span');
  const view = createWatchPanel({
    container: f.container,
    panel,
    countBadge,
    now: () => T0,
    schedule: () => {},
  });
  view.update(model({ visible: false }));
  assert.equal(panel.hidden, true);
  const shown = model({
    inbox: { rows: [row('e-1')], alertRows: [], unread: 1 },
  });
  view.update(shown);
  assert.equal(panel.hidden, false);
  assert.equal(countBadge.textContent, '1');
  writes = 0;
  view.update(shown);
  assert.equal(writes, 0, 'an identical model writes nothing');
  view.destroy();
  assert.equal(f.container.children.length, 0);
  assert.equal(panel.hidden, true);
  assert.equal(countBadge.textContent, '');
  view.update(shown);
  assert.equal(f.container.children.length, 0);
  assert.equal(createWatchPanel({}), null);
});

test('a model built from the real engine, log and document renders', () => {
  const made = createCircleZone(
    {
      name: 'Harbour approach',
      center: { lat: 51.5, lon: -1 },
      radiusM: 25_000,
      kinds: ['aircraft', 'vessel'],
    },
    { nowMs: T0, makeId: () => 'harbour' },
  );
  let doc = addZone(emptyWatchDocument(), made.zone).doc;
  doc = addWatchEntry(
    doc,
    { match: 'icao24', value: 'abc123' },
    { nowMs: T0, makeId: () => 'abcd' },
  ).doc;
  const engine = createWatchEngine();
  engine.setDocument(doc);
  const log = createWatchEventLog();
  const frame = (layerId, nowMs, rows, coverage) =>
    buildFrame({
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
  const now = T0 + MIN;
  log.add(
    engine.ingest(
      frame(
        'flights',
        now,
        [
          {
            id: 'RYR12',
            icao24: 'abc123',
            lat: 51.52,
            lon: -1.01,
            altitudeM: 900,
            onGround: false,
            squawk: '1200',
            emergency: false,
            receivedAtMs: now,
            lastContactAtMs: now,
          },
        ],
        { kind: 'global' },
      ),
    ),
    { nowMs: now },
  );
  log.add(
    engine.ingest(
      frame('ais-live-vessels', now, [], {
        kind: 'circle',
        lat: 10,
        lon: 10,
        radiusKm: 100,
      }),
    ),
    { nowMs: now },
  );
  const h = setup();
  h.view.update({
    visible: true,
    nowMs: now,
    view: engine.view(now),
    doc,
    inbox: {
      rows: log.list({ limit: 50 }),
      alertRows: log.list({ minSeverity: 'alert', limit: 50 }),
      unread: log.unreadCount(),
    },
    selection: null,
    annotations: [],
    briefs: { [made.zone.id]: engine.brief(made.zone.id, { nowMs: now }) },
    readError: null,
    writeError: null,
    notices: { watch: null, zones: null },
  });
  const zone = openCard(h, `zone:${made.zone.id}`);
  const text = allText(zone);
  assert.match(text, /Vessels: UNKNOWN · outside the loaded area/);
  assert.match(text, /Brief: Harbour approach/);
  assert.match(allText(openCard(h, 'watched')), /abc123 · /);
  assert.doesNotMatch(allText(h.f.container), /\{[A-Za-z]+\}|undefined|NaN/);
});
