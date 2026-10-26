import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { describeUnsavedWork } from '../i18n/index.js';
import { COCKPIT_REFUSAL_NOUNS } from '../navigationPolicy.js';
import { coverageViewer } from '../testSupport/streetLevelFakes.mjs';
import { railFixture } from '../ui/railTestFixture.mjs';
import { createWatchPanel } from '../ui/watchPanel.js';
import {
  WATCH_STORAGE_KEY,
  addWatchEntry,
  addZone,
  createCircleZone,
  emptyWatchDocument,
  serializeWatchDocument,
  setPrefs,
} from '../watch/document.js';
import {
  WATCH_LAST_SEEN_WRITE_MS,
  WATCH_TICK_MS,
  WATCH_TOAST_GAP_MS,
  installWatch,
} from './watch.js';
import { WATCH_OVERLAY_SOURCE_ID } from './watchZones.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const KM_PER_DEG = 111.195;
const ZLAT = 51.5;
const ZLON = -1;

/** A point `km` north of the zone centre (east for a bearing of 90). */
function at(km, bearingDeg = 0) {
  const b = (bearingDeg * Math.PI) / 180;
  return {
    lat: ZLAT + (km * Math.cos(b)) / KM_PER_DEG,
    lon:
      ZLON +
      (km * Math.sin(b)) / (KM_PER_DEG * Math.cos((ZLAT * Math.PI) / 180)),
  };
}

let ids = 0;
const makeId = (prefix) => `${prefix}-t${String((ids += 1)).padStart(5, '0')}`;

function zone({ kinds = ['aircraft', 'vessel'], name = 'Harbour' } = {}) {
  const made = createCircleZone(
    { name, center: { lat: ZLAT, lon: ZLON }, radiusM: 25_000, kinds },
    { nowMs: T0, makeId },
  );
  assert.ok(made.ok, made.code);
  return made.zone;
}

function makeDoc({ zones = [], watch = [], prefs = null } = {}) {
  let doc = emptyWatchDocument();
  for (const item of zones) {
    const added = addZone(doc, item);
    assert.ok(added.ok, added.code);
    doc = added.doc;
  }
  for (const input of watch) {
    const added = addWatchEntry(doc, input, { nowMs: T0, makeId });
    assert.ok(added.ok, added.code);
    doc = added.doc;
  }
  if (prefs) doc = setPrefs(doc, prefs).doc;
  return doc;
}

function aircraft(icao24, point, t, overrides = {}) {
  return {
    id: overrides.callsign ?? icao24.toUpperCase(),
    icao24,
    callsign: null,
    lat: point.lat,
    lon: point.lon,
    altitudeM: 3000,
    speedMps: 120,
    heading: 90,
    verticalRateMps: 0,
    onGround: false,
    military: false,
    aircraftClass: 'airliner',
    // Enriched: the privacy guard can judge it (watchClassKnown).
    typeCode: 'A320',
    squawk: '1200',
    emergency: false,
    emergencyKind: null,
    emergencySource: null,
    lastContactAtMs: t - 2 * SEC,
    receivedAtMs: t,
    ...overrides,
  };
}

function fire(point, acqTime, frp) {
  return {
    id: 'FIRE-00001',
    lat: point.lat,
    lon: point.lon,
    frp,
    confidence: 0.8,
    satellite: 'N20',
    acqTime,
  };
}

function fakeStorage(text = null) {
  const items = new Map();
  if (text !== null) items.set(WATCH_STORAGE_KEY, text);
  const writes = [];
  return {
    items,
    writes,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      writes.push(key);
      items.set(key, value);
    },
    read: () => JSON.parse(items.get(WATCH_STORAGE_KEY)),
  };
}

/** A data manager over plain layer states (enabled, rows, lastUpdate…). */
function fakeManager(specs) {
  const listeners = new Set();
  const reads = {};
  const enabledCalls = [];
  const layers = new Map();
  for (const [id, spec] of Object.entries(specs)) {
    const state = {
      enabled: true,
      rows: [],
      lastUpdate: T0,
      stats: {},
      coverage: { kind: 'global' },
      ...spec,
    };
    const module = {
      getAnalystRecords() {
        reads[id] = (reads[id] ?? 0) + 1;
        return state.rows;
      },
      getCoverageArea: () => state.coverage,
      ...(spec.module ?? {}),
    };
    layers.set(id, { module, state });
  }
  return {
    reads,
    enabledCalls,
    listeners,
    state: (id) => layers.get(id).state,
    layers: {
      get: (id) => (layers.has(id) ? { module: layers.get(id).module } : null),
    },
    getAll: () =>
      [...layers].map(([id, { state }]) => ({
        id,
        name: id,
        enabled: state.enabled,
        stats: {
          count: state.rows.length,
          lastUpdate: state.lastUpdate,
          ...state.stats,
        },
      })),
    isEnabled: (id) => layers.get(id)?.state.enabled === true,
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    setEnabled(id, enabled, options) {
      enabledCalls.push({ id, enabled, options });
      return Promise.resolve(true);
    },
    emit(change) {
      for (const callback of [...listeners]) callback(change);
    },
  };
}

function element(id = '') {
  const node = new EventTarget();
  Object.assign(node, {
    id,
    hidden: false,
    className: '',
    attributes: new Map(),
    setAttribute(key, value) {
      node.attributes.set(key, String(value));
    },
    getAttribute: (key) => node.attributes.get(key) ?? null,
    click: () => node.dispatchEvent(new Event('click')),
  });
  node.classList = {
    contains: (name) => node.className.split(' ').includes(name),
    toggle(name, on) {
      const set = new Set(node.className.split(' ').filter(Boolean));
      if (on ?? !set.has(name)) set.add(name);
      else set.delete(name);
      node.className = [...set].join(' ');
    },
  };
  return node;
}

/**
 * Watch on fakes. The panel is a recorder (the real one is covered in
 * src/ui/watchPanel.test.mjs and once below); its collapse button stands in
 * for the panel chrome.
 */
function setup(t, options = {}) {
  const clock = { now: options.now ?? T0 };
  const storage =
    options.storage ??
    fakeStorage(options.doc ? serializeWatchDocument(options.doc) : null);
  const manager = fakeManager(options.layers ?? {});
  const panel = element('watch-panel');
  panel.className = 'panel-collapsible collapsed';
  panel.hidden = true;
  const collapse = element();
  collapse.addEventListener('click', () => panel.classList.toggle('collapsed'));
  panel.querySelector = (selector) =>
    selector === '[data-collapse-target="watch-panel"]' ? collapse : null;
  const elements = {
    'watch-panel': panel,
    'watch-panel-body': element('watch-panel-body'),
    'watch-panel-count': element('watch-panel-count'),
    'watch-toggle': element('watch-toggle'),
  };
  const documentRef = { getElementById: (id) => elements[id] ?? null };
  const idleQueue = [];
  const windowRef = Object.assign(new EventTarget(), {
    requestIdleCallback(callback, opts) {
      idleQueue.push({ callback, opts, live: true });
      return idleQueue.length - 1;
    },
    cancelIdleCallback(handle) {
      if (idleQueue[handle]) idleQueue[handle].live = false;
    },
  });
  const timers = [];
  const schedule = (callback, ms) => {
    const timer = { callback, due: clock.now + ms, live: true };
    timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  const models = [];
  const panelCalls = { created: 0, destroyed: 0 };
  let onAction = null;
  const createPanel =
    options.createPanel ??
    ((opts) => {
      panelCalls.created += 1;
      panelCalls.options = opts;
      onAction = opts.onAction;
      return {
        update(model) {
          models.push(model);
          opts.panel.hidden = model.visible !== true;
        },
        destroy() {
          panelCalls.destroyed += 1;
        },
      };
    });
  const rendererCalls = { syncs: [], visible: [], destroyed: 0 };
  const createRenderer = () => ({
    sync: (views) => rendererCalls.syncs.push(views),
    setVisible: (visible) => rendererCalls.visible.push(visible),
    destroy() {
      rendererCalls.destroyed += 1;
    },
    diagnostics: () => ({}),
  });
  const navigationCalls = [];
  const navigation = {
    runImmediateNavigation(noun, fly) {
      navigationCalls.push(noun);
      return options.cockpit ? false : fly();
    },
  };
  const focusRequests = [];
  const flights = [];
  const viewCentre =
    'viewCentre' in options ? options.viewCentre : { lat: ZLAT, lon: ZLON };
  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      flyTo: (flight) => flights.push(flight),
      pickEllipsoid: () =>
        viewCentre
          ? Cesium.Cartesian3.fromDegrees(viewCentre.lon, viewCentre.lat)
          : undefined,
      positionCartographic: Cesium.Cartographic.fromDegrees(10, 20, 9000),
    },
  };
  const toasts = [];
  const watch = installWatch({
    viewer,
    dataManager: manager,
    annotations: options.annotations ?? null,
    navigation,
    notify: (text) => toasts.push(text),
    overlayHost: null,
    requestRender: () => {},
    storage,
    now: () => clock.now,
    schedule,
    requestWorldFocus: (detail) => {
      focusRequests.push(detail);
      return true;
    },
    windowRef,
    documentRef,
    makeId,
    clipboard: options.clipboard ?? null,
    createPanel,
    createRenderer,
  });
  t.after(() => watch?.destroy());

  function flushIdle() {
    let ran = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const next = idleQueue.find((entry) => entry.live);
      if (!next) break;
      next.live = false;
      next.callback();
      ran += 1;
    }
    return ran;
  }
  function advance(ms) {
    const target = clock.now + ms;
    for (let guard = 0; guard < 1000; guard += 1) {
      const next = timers
        .filter((timer) => timer.live && timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock.now = Math.max(clock.now, next.due);
      next.live = false;
      next.callback();
    }
    clock.now = target;
  }
  /** New rows for a layer at `clock.now`, one refresh, then the idle read. */
  function refresh(layerId, rows, extra = {}) {
    const state = manager.state(layerId);
    if (rows) state.rows = rows;
    state.lastUpdate = clock.now;
    Object.assign(state, extra);
    manager.emit({ type: 'refresh', layerId, enabled: true });
    flushIdle();
  }
  return {
    watch,
    clock,
    storage,
    manager,
    elements,
    windowRef,
    idleQueue,
    timers,
    models,
    model: () => models.at(-1),
    act: (action) => onAction(action),
    panelCalls,
    rendererCalls,
    navigationCalls,
    focusRequests,
    flights,
    viewer,
    toasts,
    flushIdle,
    advance,
    refresh,
  };
}

const AIR_LAYERS = () => ({
  flights: { rows: [] },
  military: { rows: [] },
});

// -------------------------------------------------------------------------

test('install needs #watch-panel and #watch-panel-body', () => {
  const documentRef = { getElementById: () => null };
  assert.equal(installWatch({ documentRef, windowRef: null }), null);
});

test('while nothing is watched and the panel is closed, no layer is read', (t) => {
  const h = setup(t, {
    layers: {
      ...AIR_LAYERS(),
      'ais-live-vessels': { rows: [{ id: 'S', mmsi: '235012345' }] },
      'local-firms': {},
      earthquakes: {},
    },
  });
  for (const layerId of ['flights', 'ais-live-vessels', 'local-firms']) {
    h.manager.emit({ type: 'refresh', layerId, enabled: true });
    h.manager.emit({ type: 'visibility', layerId, enabled: true });
  }
  assert.equal(h.flushIdle(), 0);
  h.advance(3 * WATCH_TICK_MS);
  assert.deepEqual(h.manager.reads, {});
  assert.equal(h.model().visible, false);
  assert.equal(h.elements['watch-panel'].hidden, true);
  assert.equal(h.watch.diagnostics().active, false);
  assert.deepEqual(h.watch.diagnostics().neededLayers, []);
});

test('the Watch toggle shows and expands the panel, then reads aircraft only', (t) => {
  const h = setup(t, {
    layers: { ...AIR_LAYERS(), 'ais-live-vessels': {}, earthquakes: {} },
  });
  const toggle = h.elements['watch-toggle'];
  const panel = h.elements['watch-panel'];
  toggle.click();
  assert.equal(panel.hidden, false);
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.classList.contains('active'), true);
  h.flushIdle();
  // The Active emergencies card watches every aircraft; nothing else is read.
  assert.deepEqual(h.manager.reads, { military: 1, flights: 1 });
  // Pressing it again closes an empty panel and stops the reads.
  toggle.click();
  assert.equal(panel.classList.contains('collapsed'), true);
  assert.equal(panel.hidden, true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  h.refresh('flights', []);
  assert.deepEqual(h.manager.reads, { military: 1, flights: 1 });
});

test('the panel chrome collapsing Watch on its own updates the toggle', (t) => {
  const observers = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const h = setup(t, { layers: AIR_LAYERS() });
  // A second install sees the observer on its window.
  h.watch.destroy();
  const panelElement = element('watch-panel');
  panelElement.className = 'panel-collapsible';
  const toggle = element('watch-toggle');
  const ids = {
    'watch-panel': panelElement,
    'watch-panel-body': element(),
    'watch-toggle': toggle,
  };
  const windowRef = Object.assign(new EventTarget(), {
    MutationObserver: FakeObserver,
  });
  const watch = installWatch({
    dataManager: h.manager,
    storage: fakeStorage(),
    windowRef,
    documentRef: { getElementById: (id) => ids[id] ?? null },
    schedule: () => () => {},
    createPanel: () => ({ update() {}, destroy() {} }),
  });
  t.after(() => watch.destroy());
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].options.attributeFilter, ['class', 'hidden']);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  panelElement.classList.toggle('collapsed', true);
  observers[0].callback([]);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  watch.destroy();
  assert.equal(observers[0].disconnected, true);
});

test('a refresh burst reads each needed layer once; other events are ignored', (t) => {
  const h = setup(t, {
    doc: makeDoc({ zones: [zone({ kinds: ['aircraft'] })] }),
    layers: {
      ...AIR_LAYERS(),
      'ais-live-vessels': {},
      cctv: {},
    },
  });
  // Install queues every needed layer once.
  h.flushIdle();
  assert.deepEqual(h.manager.reads, { military: 1, flights: 1 });
  for (const type of ['refresh', 'refresh-failed', 'visibility', 'refresh']) {
    h.manager.emit({ type, layerId: 'flights', enabled: true });
  }
  h.manager.emit({ type: 'status' });
  h.manager.emit({ type: 'params', layerId: 'flights' });
  h.manager.emit({ type: 'refresh', layerId: 'cctv' });
  // Vessels are not needed by an aircraft-only zone.
  h.manager.emit({ type: 'refresh', layerId: 'ais-live-vessels' });
  assert.equal(h.flushIdle(), 1);
  assert.deepEqual(h.manager.reads, { military: 1, flights: 2 });
  assert.equal(h.watch.diagnostics().frames.flights, 2);
  assert.ok(h.idleQueue.every((entry) => entry.opts?.timeout === 2000));
});

test('a turned-off layer gives an off answer without a read', async (t) => {
  const h = setup(t, {
    doc: makeDoc({ zones: [zone({ kinds: ['aircraft'] })] }),
    layers: {
      flights: { enabled: false, rows: [aircraft('abc123', at(5), T0)] },
      military: { enabled: false },
    },
  });
  h.flushIdle();
  assert.deepEqual(h.manager.reads, {});
  const view = h.model().view;
  assert.equal(view.zones[0].perKind.aircraft.answer, 'off');
  assert.equal(view.feeds.flights.answer, 'off');
  assert.equal(h.model().visible, true);
  // "Turn on" asks the manager, as the person.
  h.act({ type: 'layer-enable', layerId: 'flights' });
  h.act({ type: 'layer-enable', layerId: 'cctv' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(h.manager.enabledCalls, [
    { id: 'flights', enabled: true, options: { origin: 'user' } },
  ]);
});

test('an unreadable saved document blocks every write until the person resets', (t) => {
  const storage = fakeStorage('{not json');
  const h = setup(t, { storage, layers: AIR_LAYERS() });
  assert.deepEqual(h.model().readError, { code: 'malformed' });
  assert.equal(h.model().visible, true);
  h.act({ type: 'watch-add-id', match: 'icao24', value: 'abc123' });
  assert.equal(storage.items.get(WATCH_STORAGE_KEY), '{not json');
  assert.equal(h.model().writeError, 'read-error');
  assert.equal(h.model().doc.watchlist.length, 1);
  // Nothing was loaded, so Keep cannot save over the stored text.
  h.act({ type: 'storage-keep' });
  assert.deepEqual(h.model().readError, { code: 'malformed' });
  assert.equal(storage.items.get(WATCH_STORAGE_KEY), '{not json');
  h.act({ type: 'storage-reset' });
  assert.equal(h.model().readError, null);
  assert.equal(h.model().writeError, null);
  assert.deepEqual(storage.read().watchlist, []);
});

test('Keep never overwrites saved data from a newer version or too large', (t) => {
  const newer = JSON.stringify({ v: 2, zones: [{ id: 'z-new' }] });
  for (const text of [newer, `"${'x'.repeat(300_000)}"`]) {
    const storage = fakeStorage(text);
    const h = setup(t, { storage, layers: AIR_LAYERS() });
    assert.notEqual(h.model().readError?.code ?? 'partial', 'partial');
    h.act({ type: 'storage-keep' });
    assert.ok(h.model().readError);
    assert.equal(storage.items.get(WATCH_STORAGE_KEY), text);
    assert.deepEqual(storage.writes, []);
    h.watch.destroy();
  }
});

test('Keep after a partial read saves the entries that were loaded', (t) => {
  const doc = makeDoc({ zones: [zone()] });
  const text = JSON.stringify({
    ...JSON.parse(serializeWatchDocument(doc)),
    watchlist: [{ id: 'bad' }],
  });
  const storage = fakeStorage(text);
  const h = setup(t, { storage, layers: AIR_LAYERS() });
  assert.equal(h.model().readError.code, 'partial');
  h.act({ type: 'storage-keep' });
  assert.equal(h.model().readError, null);
  assert.equal(storage.read().zones.length, 1);
  assert.deepEqual(storage.read().watchlist, []);
});

test('a partial read reports what was dropped; reset clears the saved data', (t) => {
  const doc = makeDoc({ zones: [zone()] });
  const text = JSON.stringify({
    ...JSON.parse(serializeWatchDocument(doc)),
    watchlist: [{ id: 'bad' }],
  });
  const storage = fakeStorage(text);
  const h = setup(t, { storage, layers: AIR_LAYERS() });
  assert.deepEqual(h.model().readError, {
    code: 'partial',
    dropped: { zones: 0, watchlist: 1 },
  });
  assert.equal(h.model().doc.zones.length, 1);
  h.act({ type: 'storage-reset' });
  assert.equal(h.model().readError, null);
  assert.deepEqual(storage.read().zones, []);
  assert.equal(h.model().doc.zones.length, 0);
  // Using the panel keeps it on screen though the document is now empty.
  assert.equal(h.model().visible, true);
});

test('watched assets: add, duplicate, remove; each edit is saved at once', (t) => {
  const h = setup(t, { layers: AIR_LAYERS() });
  h.act({ type: 'watch-add-id', match: 'icao24', value: 'abc123' });
  assert.equal(h.model().notices.watch, null);
  assert.equal(h.storage.read().watchlist.length, 1);
  h.act({ type: 'watch-add-id', match: 'icao24', value: 'abc123' });
  assert.equal(h.model().notices.watch, 'duplicate');
  h.act({ type: 'watch-add-selection' });
  assert.equal(h.model().notices.watch, 'no-selection');
  const [entry] = h.model().doc.watchlist;
  h.act({ type: 'watch-remove', entryId: entry.id });
  assert.equal(h.model().notices.watch, null);
  assert.deepEqual(h.storage.read().watchlist, []);
  // Using the panel keeps Watch in use, so the emergency card still reads
  // aircraft although nothing is watched.
  assert.deepEqual(h.watch.diagnostics().neededLayers.sort(), [
    'flights',
    'military',
  ]);
});

test('selections become watch entries and zones around the live position', (t) => {
  const h = setup(t, {
    layers: {
      flights: {
        rows: [],
        module: {
          findByQuery: (q) =>
            q === 'abc123'
              ? {
                  icao24: 'abc123',
                  callsign: 'RYR12',
                  latitude: 48,
                  longitude: 2,
                }
              : null,
        },
      },
      military: {},
      'ais-live-vessels': {},
    },
  });
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:awareness-subject-selected', {
      detail: {
        layerId: 'flights',
        id: 'ABC123',
        label: 'RYR12',
        position: Cesium.Cartesian3.fromDegrees(1, 47, 3000),
      },
    }),
  );
  h.act({ type: 'inbox-mark-all-read' });
  assert.deepEqual(h.model().selection, {
    kind: 'aircraft',
    match: 'icao24',
    value: 'abc123',
    label: 'RYR12',
    watched: false,
    zoneable: true,
  });
  h.act({ type: 'watch-add-selection' });
  assert.equal(h.model().selection.watched, true);
  assert.equal(h.model().doc.watchlist[0].label, 'RYR12');
  h.act({ type: 'zone-add-selection', radiusKm: 25 });
  const [made] = h.model().doc.zones;
  assert.equal(made.name, 'Around RYR12');
  assert.equal(made.radiusM, 25_000);
  // The live position, not the one at selection time.
  assert.deepEqual(made.center, { lat: 48, lon: 2 });

  // Another layer's clear keeps it; its own clear drops it.
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId: 'ais-live-vessels' },
    }),
  );
  assert.notEqual(h.model().selection, null);
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:awareness-subject-cleared', {
      detail: { layerId: 'flights' },
    }),
  );
  assert.equal(h.model().selection, null);

  // A vessel click selection; a camera selection is not watchable.
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: {
        layerId: 'ais-live-vessels',
        id: 'ais-235012345',
        label: 'NORTH STAR',
        latitude: 50,
        longitude: 0,
        properties: { mmsi: '235012345' },
      },
    }),
  );
  assert.equal(h.model().selection.match, 'mmsi');
  assert.equal(h.model().selection.zoneable, true);
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'cctv', id: 'cam-1', label: 'Camera' },
    }),
  );
  assert.equal(h.model().selection, null);
  h.act({ type: 'zone-add-selection', radiusKm: 5 });
  assert.equal(h.model().notices.zones, 'no-selection');
});

test('zones around the view, from drawn shapes, edits and deletes', (t) => {
  const annotations = {
    list: () => [
      { id: 'anno-1', type: 'pin', label: 'Pier', anchor: { lat: 50, lon: 1 } },
      { id: 'anno-2', type: 'route', label: 'Road', path: [] },
      { id: 'anno-3', type: 'area', label: null, ring: [] },
    ],
  };
  const h = setup(t, { layers: AIR_LAYERS(), annotations });
  h.act({ type: 'inbox-mark-all-read' });
  assert.deepEqual(h.model().annotations, [
    { id: 'anno-1', type: 'pin', label: 'Pier' },
  ]);
  h.act({ type: 'zone-add-view', radiusKm: 25 });
  h.act({ type: 'zone-add-view', radiusKm: 100 });
  let zones = h.model().doc.zones;
  assert.deepEqual(
    zones.map((z) => [z.name, z.radiusM]),
    [
      ['Zone 1', 25_000],
      ['Zone 2', 100_000],
    ],
  );
  assert.ok(Math.abs(zones[0].center.lat - ZLAT) < 1e-9);
  h.act({ type: 'zone-add-annotation', annotationId: 'anno-1' });
  zones = h.model().doc.zones;
  assert.equal(zones[2].name, 'Pier');
  assert.equal(zones[2].radiusM, 10_000);
  h.act({ type: 'zone-add-annotation', annotationId: 'anno-9' });
  assert.equal(h.model().notices.zones, 'not-found');

  const id = zones[0].id;
  h.act({ type: 'zone-update', zoneId: id, patch: { radiusM: 5000 } });
  assert.equal(h.model().notices.zones, null);
  h.act({ type: 'zone-rename', zoneId: id, name: 'North pier' });
  h.act({ type: 'zone-update', zoneId: id, patch: { notify: 'loud' } });
  assert.equal(h.model().notices.zones, 'bad-notify');
  assert.deepEqual(
    [h.storage.read().zones[0].name, h.storage.read().zones[0].radiusM],
    ['North pier', 5000],
  );
  // The next default name skips names in use.
  h.act({ type: 'zone-delete', zoneId: zones[1].id });
  h.act({ type: 'zone-add-view', radiusKm: 25 });
  assert.equal(h.model().doc.zones.at(-1).name, 'Zone 3');
  assert.equal(h.storage.read().zones.length, 3);
});

test('a view that sees no ground falls back to the camera nadir', (t) => {
  const h = setup(t, { layers: AIR_LAYERS(), viewCentre: null });
  h.act({ type: 'zone-add-view', radiusKm: 25 });
  const [made] = h.model().doc.zones;
  assert.ok(Math.abs(made.center.lat - 20) < 1e-9);
  assert.ok(Math.abs(made.center.lon - 10) < 1e-9);
});

test('navigation uses literal nouns and exact identifiers', (t) => {
  const tracked = [];
  const selected = [];
  const doc = makeDoc({
    zones: [zone()],
    watch: [
      { match: 'icao24', value: 'abc123' },
      { match: 'callsign', value: 'RYR12' },
      { match: 'mmsi', value: '235012345' },
      { match: 'norad', value: '25544' },
      { match: 'mmsi', value: '366999999' },
    ],
  });
  const h = setup(t, {
    doc,
    layers: {
      flights: {
        module: {
          hasContact: (id) => id === 'abc123' || id === 'def456',
          trackById: (id, opts) => {
            tracked.push(['flights', id, opts.origin]);
            return true;
          },
          findByQuery: (q) =>
            q === 'RYR12'
              ? {
                  icao24: 'def456',
                  callsign: 'RYR12',
                  latitude: 1,
                  longitude: 1,
                }
              : null,
        },
      },
      military: {
        module: { hasContact: () => false, trackById: () => true },
      },
      'ais-live-vessels': {
        module: {
          findByQuery: (q) =>
            q === '235012345'
              ? {
                  mmsi: '235012345',
                  name: 'NORTH STAR',
                  position: Cesium.Cartesian3.fromDegrees(0, 50),
                  latitude: 50,
                  longitude: 0,
                }
              : // A name substring hit for another vessel.
                { mmsi: '111111111', name: 'OTHER', latitude: 0, longitude: 0 },
          selectById: (mmsi) => selected.push(mmsi),
        },
      },
      satellites: {
        rows: [{}],
        module: {
          findByQuery: (q) =>
            q === '25544'
              ? { noradId: 25544, name: 'ISS', latitude: 1, longitude: 2 }
              : null,
          trackById: (id, opts) => {
            tracked.push(['satellites', id, opts.origin]);
            return true;
          },
        },
      },
    },
  });
  h.flushIdle();
  const entries = h.model().doc.watchlist;
  const focus = (index) =>
    h.act({ type: 'watch-focus', entryId: entries[index].id });
  focus(0);
  focus(1);
  focus(2);
  focus(3);
  assert.deepEqual(tracked, [
    ['flights', 'abc123', 'user'],
    ['flights', 'def456', 'user'],
    ['satellites', '25544', 'user'],
  ]);
  assert.deepEqual(selected, ['235012345']);
  assert.equal(h.focusRequests.length, 1);
  assert.equal(h.focusRequests[0].kind, 'vessel');
  assert.equal(h.focusRequests[0].id, '235012345');
  assert.equal(h.focusRequests[0].label, 'NORTH STAR');
  // An MMSI that only matches by name is not followed, and has no fix.
  focus(4);
  assert.equal(h.model().notices.watch, 'no-position');
  assert.equal(h.focusRequests.length, 1);

  h.act({ type: 'zone-fly', zoneId: h.model().doc.zones[0].id });
  assert.equal(h.flights.length, 1);
  const rect = h.flights[0].destination;
  assert.ok(rect instanceof Cesium.Rectangle);
  // 25 km around 51.5° N, padded by 15% each side.
  const north = Cesium.Math.toDegrees(rect.north);
  assert.ok(north > ZLAT + 25 / KM_PER_DEG && north < ZLAT + 0.4, north);
  assert.deepEqual(h.navigationCalls, [
    'aircraft',
    'aircraft',
    'satellite',
    'location',
  ]);
  for (const noun of h.navigationCalls)
    assert.ok(COCKPIT_REFUSAL_NOUNS.includes(noun));
});

test('every navigation call in the controller names a literal Cockpit noun', () => {
  const source = readFileSync(new URL('./watch.js', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/runImmediateNavigation\(\s*([^,)]*)/g)];
  assert.ok(calls.length >= 3);
  for (const [, arg] of calls) {
    const noun = arg.trim().match(/^'([^']+)'$/)?.[1];
    assert.ok(noun, `literal noun expected, got ${arg}`);
    assert.ok(COCKPIT_REFUSAL_NOUNS.includes(noun), noun);
  }
  // Vessel and fire focus use the world-focus request (its own nouns).
  assert.match(source, /kind: 'vessel'/);
  assert.match(source, /kind: 'fire'/);
  assert.doesNotMatch(source, /WORLD_FOCUS_FRAMING/);
});

test('alert pop-ups: alerts only, at most one per 15 s, behind the preference', (t) => {
  const doc = makeDoc({ zones: [zone({ kinds: ['fire'], name: 'Ridge' })] });
  const known = fire(at(3), T0 - 3 * 60 * MIN, 30);
  const h = setup(t, {
    doc,
    layers: { ...AIR_LAYERS(), 'local-firms': { rows: [known] } },
  });
  // The first answer is the silent baseline.
  h.flushIdle();
  assert.deepEqual(h.model().inbox.rows, []);
  // A new small fire is a notice: listed, no pop-up.
  h.advance(10 * MIN);
  const rows = [known, fire(at(6, 90), T0, 20)];
  h.refresh('local-firms', [...rows]);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.model().inbox.rows[0].type, 'fires-new');
  assert.equal(h.model().inbox.unread, 1);
  // A strong fire is an alert.
  h.advance(10 * MIN);
  rows.push(fire(at(4, 270), h.clock.now - MIN, 150));
  h.refresh('local-firms', [...rows]);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0], /Ridge/);
  // Another alert 5 s later is logged but not popped up.
  h.advance(5 * SEC);
  rows.push(fire(at(8, 200), h.clock.now - MIN, 200));
  h.refresh('local-firms', [...rows]);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.model().inbox.alertRows.length, 2);
  h.advance(WATCH_TOAST_GAP_MS);
  rows.push(fire(at(9, 100), h.clock.now - MIN, 300));
  h.refresh('local-firms', [...rows]);
  assert.equal(h.toasts.length, 2);
  // Pop-ups off: alerts are still logged.
  h.act({ type: 'prefs', patch: { toasts: false } });
  h.advance(WATCH_TOAST_GAP_MS);
  rows.push(fire(at(10, 300), h.clock.now - MIN, 400));
  h.refresh('local-firms', [...rows]);
  assert.equal(h.toasts.length, 2);
  assert.equal(h.model().inbox.alertRows.length, 4);
  assert.equal(h.storage.read().prefs.toasts, false);

  // Focusing a fire event asks for the fire focus; reading it marks it read.
  const row = h.model().inbox.alertRows[0];
  h.act({ type: 'focus-event', eventId: row.id });
  assert.equal(h.focusRequests.at(-1).kind, 'fire');
  assert.equal(h.focusRequests.at(-1).label, 'FIRE');
  assert.ok(h.focusRequests.at(-1).position instanceof Cesium.Cartesian3);
  assert.equal(
    h.model().inbox.rows.find((item) => item.id === row.id).read,
    true,
  );
  h.act({ type: 'inbox-mark-all-read' });
  assert.equal(h.model().inbox.unread, 0);
  h.act({ type: 'inbox-clear' });
  assert.deepEqual(h.model().inbox.rows, []);
});

test('the event history is reported as unsaved work while it has rows', (t) => {
  const doc = makeDoc({ zones: [zone({ kinds: ['fire'] })] });
  const known = fire(at(3), T0 - 3 * 60 * MIN, 30);
  const h = setup(t, {
    doc,
    layers: { ...AIR_LAYERS(), 'local-firms': { rows: [known] } },
  });
  h.flushIdle();
  assert.ok(!describeUnsavedWork().includes('the watch event history'));
  h.advance(10 * MIN);
  h.refresh('local-firms', [known, fire(at(6, 90), T0, 20)]);
  assert.ok(describeUnsavedWork().includes('the watch event history'));
  h.watch.destroy();
  assert.ok(!describeUnsavedWork().includes('the watch event history'));
});

test('the privacy guard declines a civil business jet and drops its fix', (t) => {
  const doc = makeDoc({ watch: [{ match: 'icao24', value: 'b1b1b1' }] });
  const h = setup(t, { doc, layers: AIR_LAYERS() });
  h.flushIdle();
  h.advance(SEC);
  h.refresh('flights', [
    aircraft('b1b1b1', at(5), h.clock.now, { aircraftClass: 'bizjet' }),
  ]);
  h.refresh('military', []);
  const [entry] = h.storage.read().watchlist;
  assert.equal(entry.declined, 'private-aircraft-class');
  assert.equal(entry.lastSeen, null);
  assert.equal(h.model().view.watchlist[0].presence.state, 'declined');
  // A declined entry needs no layer of its own.
  assert.deepEqual(
    h.watch.diagnostics().neededLayers.sort(),
    ['flights', 'military'],
    'only the global emergency card reads aircraft now',
  );
});

test('a watched civil aircraft is followed only once its type is known', (t) => {
  const asked = [];
  const tracked = [];
  const doc = makeDoc({
    watch: [
      { match: 'icao24', value: 'a1b2c3' },
      { match: 'callsign', value: 'N628TS' },
    ],
  });
  const module = {
    hasContact: () => true,
    trackById: (id) => {
      tracked.push(id);
      return true;
    },
    findByQuery: (q) =>
      q === 'N628TS' ? { icao24: 'c3c3c3', callsign: 'N628TS' } : null,
    requestTypeEnrichment: (hex) => {
      asked.push(hex);
      return true;
    },
  };
  const h = setup(t, {
    doc,
    layers: { flights: { rows: [], module }, military: { rows: [] } },
  });
  h.flushIdle();
  h.advance(SEC);
  const rows = () => [
    aircraft('a1b2c3', at(5), h.clock.now, { typeCode: null }),
    aircraft('c3c3c3', at(6), h.clock.now, {
      callsign: 'N628TS',
      typeCode: null,
    }),
  ];
  h.refresh('flights', rows());
  h.refresh('military', []);
  const presence = () =>
    h.model().view.watchlist.map((row) => row.presence.reason);
  assert.deepEqual(presence(), ['class-unknown', 'class-unknown']);
  // Each unjudged aircraft's type is asked for once.
  assert.deepEqual(asked, ['a1b2c3', 'c3c3c3']);
  h.advance(WATCH_TICK_MS);
  h.refresh('flights', rows());
  assert.deepEqual(asked, ['a1b2c3', 'c3c3c3']);
  // Nothing is saved and Focus does not follow it.
  assert.deepEqual(
    h.storage.read().watchlist.map((entry) => entry.lastSeen),
    [null, null],
  );
  const [first] = h.storage.read().watchlist;
  h.act({ type: 'watch-focus', entryId: first.id });
  assert.equal(h.model().notices.watch, 'class-unknown');
  assert.deepEqual(tracked, []);
  // The type arrives: an airliner is followed from then on.
  h.advance(SEC);
  h.refresh('flights', [
    aircraft('a1b2c3', at(5), h.clock.now, { typeCode: 'A320' }),
  ]);
  assert.equal(h.model().view.watchlist[0].presence.state, 'live');
});

test('Focus on a declined entry never locates or follows the asset', (t) => {
  const tracked = [];
  const doc = makeDoc({
    watch: [
      { match: 'icao24', value: 'b1b1b1' },
      { match: 'callsign', value: 'N628TS' },
    ],
  });
  const module = {
    hasContact: () => true,
    trackById: (id) => {
      tracked.push(id);
      return true;
    },
  };
  const h = setup(t, {
    doc,
    layers: { flights: { rows: [], module }, military: { rows: [] } },
  });
  h.flushIdle();
  h.advance(SEC);
  h.refresh('flights', [
    aircraft('b1b1b1', at(5), h.clock.now, { aircraftClass: 'bizjet' }),
    aircraft('c2c2c2', at(6), h.clock.now, {
      callsign: 'N628TS',
      aircraftClass: 'bizjet',
    }),
  ]);
  h.refresh('military', []);
  for (const entry of h.storage.read().watchlist) {
    assert.equal(entry.declined, 'private-aircraft-class');
    h.act({ type: 'watch-focus', entryId: entry.id });
    assert.equal(h.model().notices.watch, 'declined');
  }
  assert.deepEqual(tracked, []);
  assert.deepEqual(h.navigationCalls, []);
  assert.deepEqual(h.focusRequests, []);
  assert.deepEqual(h.flights, []);
});

test('last-seen fixes are saved at most once a minute', (t) => {
  const doc = makeDoc({ watch: [{ match: 'icao24', value: 'abc123' }] });
  const h = setup(t, { doc, layers: AIR_LAYERS() });
  h.flushIdle();
  const writes = () => h.storage.writes.length;
  h.advance(SEC);
  h.refresh('military', []);
  h.refresh('flights', [aircraft('abc123', at(5), h.clock.now)]);
  assert.equal(writes(), 1);
  assert.equal(h.storage.read().watchlist[0].lastSeen.atMs, T0 + SEC);
  h.advance(20 * SEC);
  h.refresh('flights', [aircraft('abc123', at(6), h.clock.now)]);
  assert.equal(writes(), 1);
  // Ticks inside the minute do not save it; the first tick after it does.
  h.advance(T0 + WATCH_LAST_SEEN_WRITE_MS - h.clock.now);
  assert.equal(writes(), 1);
  h.advance(WATCH_TICK_MS);
  assert.equal(writes(), 2);
  assert.equal(h.storage.read().watchlist[0].lastSeen.atMs, T0 + 21 * SEC);
  // A user edit saves at once.
  h.act({ type: 'prefs', patch: { allEmergencies: true } });
  assert.equal(writes(), 3);
});

test('watched satellites resolve only from an exact NORAD match', (t) => {
  const doc = makeDoc({
    watch: [
      { match: 'norad', value: '25544' },
      { match: 'norad', value: '99999' },
    ],
  });
  const queries = [];
  const h = setup(t, {
    doc,
    layers: {
      ...AIR_LAYERS(),
      satellites: {
        rows: [{}],
        module: {
          findByQuery(q) {
            queries.push(q);
            // 99999 is not in the catalog; a name substring finds another.
            return q === '25544'
              ? { noradId: 25544, name: 'ISS', latitude: 10, longitude: 20 }
              : { noradId: 12345, name: 'OTHER 99999', latitude: 0 };
          },
        },
      },
    },
  });
  const presence = () =>
    h.model().view.watchlist.map((row) => row.presence.state);
  assert.deepEqual(presence(), ['computed', 'not-in-catalog']);
  assert.deepEqual(queries, ['25544', '99999']);
  h.advance(WATCH_TICK_MS);
  assert.equal(queries.length, 4);
  // The satellites layer turned off: feed off, no lookups.
  h.manager.state('satellites').enabled = false;
  h.advance(WATCH_TICK_MS);
  assert.equal(queries.length, 4);
  assert.deepEqual(presence(), ['feed-off', 'feed-off']);
});

test('a watched satellite follows the satellites layer turning on and off at once', (t) => {
  const doc = makeDoc({ watch: [{ match: 'norad', value: '25544' }] });
  const h = setup(t, {
    doc,
    layers: {
      ...AIR_LAYERS(),
      satellites: {
        enabled: false,
        rows: [{}],
        module: {
          findByQuery: () => ({
            noradId: 25544,
            name: 'ISS',
            latitude: 10,
            longitude: 20,
          }),
        },
      },
    },
  });
  const state = () => h.model().view.watchlist[0].presence.state;
  assert.equal(state(), 'feed-off');
  h.act({ type: 'layer-enable', layerId: 'satellites' });
  h.flushIdle();
  assert.equal(state(), 'feed-off');
  h.manager.state('satellites').enabled = true;
  h.manager.emit({ type: 'visibility', layerId: 'satellites', enabled: true });
  // A burst of changes queues one lookup.
  h.manager.emit({ type: 'refresh', layerId: 'satellites', enabled: true });
  assert.equal(h.flushIdle(), 1);
  assert.equal(state(), 'computed');
  h.manager.state('satellites').enabled = false;
  h.manager.emit({ type: 'visibility', layerId: 'satellites', enabled: false });
  h.flushIdle();
  assert.equal(state(), 'feed-off');
});

test('a partial, stale or loading satellite catalog never proves absence', (t) => {
  const doc = makeDoc({ watch: [{ match: 'norad', value: '25544' }] });
  const cases = [
    [{ status: 'degraded', error: '1 CelesTrak group unavailable' }, {}],
    [{ status: 'stale', stale: true }, {}],
    [{ status: 'nominal' }, { catalog: 'dense', chip: 'loading' }],
  ];
  for (const [stats, { catalog = 'core', chip = 'idle' }] of cases) {
    const h = setup(t, {
      doc,
      layers: {
        ...AIR_LAYERS(),
        satellites: {
          rows: [{}, {}, {}],
          stats,
          module: {
            findByQuery: () => null,
            getParams: () => ({ catalog }),
            getRowControls: () => ({ chips: [{ id: 'catalog', state: chip }] }),
          },
        },
      },
    });
    assert.deepEqual(
      h.model().view.watchlist[0].presence,
      { state: 'checking', reason: 'catalog-partial' },
      JSON.stringify(stats),
    );
    h.watch.destroy();
  }
  // A failed first load with nothing loaded reads unavailable, not loading.
  const h = setup(t, {
    doc,
    layers: {
      ...AIR_LAYERS(),
      satellites: {
        rows: [],
        stats: { status: 'unavailable', error: 'CelesTrak unreachable' },
        module: { findByQuery: () => null },
      },
    },
  });
  assert.deepEqual(h.model().view.watchlist[0].presence, {
    state: 'feed-unavailable',
    reason: 'feed-unavailable',
  });
});

test('briefs: built on request, copied as shown, dropped with their zone', async (t) => {
  const written = [];
  let fail = false;
  const clipboard = {
    writeText: async (text) => {
      if (fail) throw new Error('denied');
      written.push(text);
    },
  };
  const doc = makeDoc({ zones: [zone()] });
  const h = setup(t, { doc, layers: AIR_LAYERS(), clipboard });
  h.flushIdle();
  const zoneId = h.model().doc.zones[0].id;
  h.act({ type: 'zone-brief', zoneId });
  const brief = h.model().briefs[zoneId];
  assert.equal(brief.zoneId, zoneId);
  assert.ok(Array.isArray(brief.sections));
  h.act({ type: 'zone-brief-copy', zoneId, text: 'Harbour\nAircraft: 0' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(written, ['Harbour\nAircraft: 0']);
  assert.deepEqual(h.toasts, ['Brief copied']);
  fail = true;
  h.act({ type: 'zone-brief-copy', zoneId, text: 'x' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.toasts, ['Brief copied', 'Copy failed']);
  h.act({ type: 'zone-brief-clear', zoneId });
  assert.deepEqual(h.model().briefs, {});
  h.act({ type: 'zone-brief', zoneId });
  h.act({ type: 'zone-delete', zoneId });
  assert.deepEqual(h.model().briefs, {});
});

test('zones on the globe follow the preference', (t) => {
  const doc = makeDoc({ zones: [zone()], prefs: { zonesVisible: false } });
  const h = setup(t, { doc, layers: AIR_LAYERS() });
  assert.equal(h.rendererCalls.visible.at(-1), false);
  assert.equal(h.rendererCalls.syncs.at(-1).length, 1);
  h.act({ type: 'prefs', patch: { zonesVisible: true } });
  assert.equal(h.rendererCalls.visible.at(-1), true);
});

test('destroy is complete and idempotent; late callbacks publish nothing', (t) => {
  const doc = makeDoc({ zones: [zone({ kinds: ['aircraft'] })] });
  const h = setup(t, { doc, layers: AIR_LAYERS() });
  assert.equal(typeof h.windowRef.__gevWatch?.view, 'function');
  assert.equal(h.windowRef.__gevWatch.injectFrame, undefined);
  assert.equal(h.manager.listeners.size, 1);
  const updates = h.models.length;
  // Reads queued, then torn down before they run.
  h.manager.emit({ type: 'refresh', layerId: 'flights' });
  h.watch.destroy();
  h.watch.destroy();
  assert.equal(h.panelCalls.destroyed, 1);
  assert.equal(h.rendererCalls.destroyed, 1);
  assert.equal(h.manager.listeners.size, 0);
  assert.equal(h.windowRef.__gevWatch, undefined);
  assert.equal(h.flushIdle(), 0);
  for (const entry of h.idleQueue) entry.callback();
  for (const timer of h.timers) timer.callback();
  h.windowRef.dispatchEvent(
    new CustomEvent('gev:entity-selected', { detail: { layerId: 'flights' } }),
  );
  h.elements['watch-toggle'].click();
  assert.deepEqual(h.manager.reads, {});
  assert.equal(h.models.length, updates);
  assert.equal(h.watch.diagnostics().destroyed, true);
});

test('the real panel renders the controller model', (t) => {
  const { document, container, find } = railFixture();
  const panel = document.createElement('section');
  panel.hidden = true;
  const count = document.createElement('span');
  const ids = {
    'watch-panel': panel,
    'watch-panel-body': container,
    'watch-panel-count': count,
  };
  const doc = makeDoc({ zones: [zone({ name: 'Harbour approach' })] });
  const watch = installWatch({
    dataManager: fakeManager(AIR_LAYERS()),
    storage: fakeStorage(serializeWatchDocument(doc)),
    windowRef: new EventTarget(),
    documentRef: { getElementById: (id) => ids[id] ?? null },
    schedule: () => () => {},
    now: () => T0,
    createPanel: createWatchPanel,
    createRenderer: () => null,
  });
  t.after(() => watch.destroy());
  assert.equal(panel.hidden, false);
  const title = find(
    (node) =>
      node.className?.includes?.('rail-card-title') &&
      node.textContent === 'Harbour approach',
  );
  assert.ok(title, 'the zone card is rendered');
  watch.destroy();
  assert.equal(panel.hidden, true);
});

test('the real panel and renderer compose on a fake viewer', async (t) => {
  const { document, container } = railFixture();
  const ids = {
    'watch-panel': document.createElement('section'),
    'watch-panel-body': container,
  };
  const viewer = coverageViewer({ lon: ZLON, lat: ZLAT, height: 5000 }, t);
  const entries = [];
  const overlayHost = {
    setEntries: (source, list) => entries.push([source, list]),
    setVisible() {},
    clearSource: (source) => entries.push([source, null]),
  };
  const doc = makeDoc({ zones: [zone({ name: 'Harbour approach' })] });
  const watch = installWatch({
    viewer,
    dataManager: fakeManager(AIR_LAYERS()),
    overlayHost,
    storage: fakeStorage(serializeWatchDocument(doc)),
    windowRef: new EventTarget(),
    documentRef: { getElementById: (id) => ids[id] ?? null },
    schedule: () => () => {},
    now: () => T0,
    createPanel: createWatchPanel,
  });
  t.after(() => watch.destroy());
  await new Promise((resolve) => setImmediate(resolve));
  const drawn = [...viewer.scene.groundPrimitives.items];
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].allowPicking, false);
  assert.equal(entries.at(-1)[0], WATCH_OVERLAY_SOURCE_ID);
  assert.equal(entries.at(-1)[1][0].title, 'Harbour approach');
  watch.destroy();
  assert.equal(viewer.scene.groundPrimitives.items.size, 0);
  assert.deepEqual(entries.at(-1), [WATCH_OVERLAY_SOURCE_ID, null]);
});

test('the application wires Watch after the file import and owns its teardown', () => {
  const tools = readFileSync(new URL('./tools.js', import.meta.url), 'utf8');
  const importAt = tools.indexOf('const geoFileImport = initGeoFileImport({');
  const importDeferAt = tools.indexOf('defer(() => geoFileImport?.destroy());');
  const watchAt = tools.indexOf('const watch = installWatch({');
  assert.ok(importAt >= 0 && importDeferAt > importAt);
  assert.ok(watchAt > importDeferAt, 'Watch is installed after Import');
  const call = tools.slice(watchAt, tools.indexOf('});', watchAt));
  assert.match(call, /navigation: styleManager/);
  assert.match(call, /notify: \(text\) => styleManager\._showToast\(text\)/);
  assert.match(call, /overlayHost/);
  assert.match(call, /requestRender: governorRequestRender/);
  assert.ok(tools.indexOf('defer(() => watch?.destroy());') > watchAt);
  assert.match(tools, /import \{ installWatch \} from '\.\/watch\.js';/);
  assert.match(
    tools,
    /import \{ overlayHost \} from '\.\/layers\/overlayHost\.js';/,
  );
});
