import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { coverageViewer } from '../testSupport/streetLevelFakes.mjs';
import {
  addZone,
  createCircleZone,
  emptyWatchDocument,
} from '../watch/document.js';
import { createWatchEngine } from '../watch/engine.js';
import {
  WATCH_OVERLAY_SOURCE_ID,
  WATCH_ZONE_STATE_COLORS,
  createWatchZoneRenderer,
  zoneOutlineState,
} from './watchZones.js';

const T0 = Date.UTC(2026, 9, 26, 12, 0, 0);

/** Real engine zone views for `count` circle zones. */
function zoneViews(count = 1) {
  let doc = emptyWatchDocument();
  for (let i = 0; i < count; i += 1) {
    const made = createCircleZone(
      {
        name: `Zone ${i + 1}`,
        center: { lat: 10 + i, lon: 20 + i },
        radiusM: 25_000,
      },
      { nowMs: T0, makeId: () => `z-test${String(i).padStart(4, '0')}` },
    );
    assert.ok(made.ok, made.code);
    const added = addZone(doc, made.zone);
    assert.ok(added.ok, added.code);
    doc = added.doc;
  }
  const engine = createWatchEngine();
  engine.setDocument(doc);
  return engine.view(T0).zones;
}

function answers(view, perKind) {
  return {
    ...view,
    perKind: Object.fromEntries(
      Object.entries(perKind).map(([kind, answer]) => [
        kind,
        { ...view.perKind[kind], answer, count: answer === 'off' ? null : 3 },
      ]),
    ),
  };
}

function fakeOverlay() {
  const calls = [];
  return {
    calls,
    setEntries: (source, entries, options) =>
      calls.push({ type: 'entries', source, entries, options }),
    setVisible: (source, visible) =>
      calls.push({ type: 'visible', source, visible }),
    clearSource: (source) => calls.push({ type: 'clear', source }),
  };
}

/** A renderer on the street-level fake viewer, with its terrain stub. */
function setup(t, options = {}) {
  const viewer = coverageViewer({ lon: 20, lat: 10, height: 1000 }, t);
  const overlay = fakeOverlay();
  const renders = [];
  const renderer = createWatchZoneRenderer({
    viewer,
    overlayHost: overlay,
    requestRender: (reason) => renders.push(reason),
    ...options,
  });
  t.after(() => renderer.destroy());
  const drawn = () => [...viewer.scene.groundPrimitives.items];
  return { viewer, overlay, renders, renderer, drawn };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('outline state precedence: alert, unknown or off, floor or held, counted', () => {
  const [view] = zoneViews();
  const both = (aircraft, vessel) => answers(view, { aircraft, vessel });
  assert.equal(zoneOutlineState(both('counted', 'counted')), 'counted');
  assert.equal(zoneOutlineState(both('counted', 'floor')), 'partial');
  assert.equal(zoneOutlineState(both('held', 'counted')), 'partial');
  assert.equal(zoneOutlineState(both('floor', 'off')), 'unknown');
  assert.equal(zoneOutlineState(both('unknown', 'counted')), 'unknown');
  assert.equal(
    zoneOutlineState({ ...both('off', 'off'), alert: true }),
    'alert',
  );
  assert.equal(zoneOutlineState({ ...view, kinds: [] }), 'unknown');
  assert.equal(zoneOutlineState(null), 'unknown');
  // The fresh engine view has never answered.
  assert.equal(zoneOutlineState(view), 'unknown');
});

test('one primitive per signature, built once the terrain table is ready', async (t) => {
  const { renderer, drawn, overlay } = setup(t);
  const views = zoneViews(2).map((view) =>
    answers(view, { aircraft: 'counted', vessel: 'counted' }),
  );
  renderer.sync(views);
  // Labels do not wait for the terrain table; outlines do.
  assert.equal(drawn().length, 0);
  assert.equal(overlay.calls.filter((c) => c.type === 'entries').length, 1);
  await settle();
  assert.equal(drawn().length, 1);
  const [primitive] = drawn();
  assert.ok(primitive instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(primitive.allowPicking, false);
  assert.equal(primitive.asynchronous, false);
  assert.equal(primitive.classificationType, Cesium.ClassificationType.BOTH);
  assert.ok(primitive.appearance instanceof Cesium.PolylineColorAppearance);
  assert.deepEqual(
    primitive.geometryInstances.map((instance) => instance.id),
    views.map((view) => `watch-zone:${view.id}`),
  );
  const expected = Cesium.Color.fromCssColorString(
    WATCH_ZONE_STATE_COLORS.counted,
  );
  assert.deepEqual(
    [...primitive.geometryInstances[0].attributes.color.value],
    [...Cesium.ColorGeometryInstanceAttribute.toValue(expected)],
  );
  assert.equal(renderer.diagnostics().builds, 1);

  // An identical sync rebuilds nothing and republishes nothing.
  renderer.sync(views.map((view) => ({ ...view })));
  await settle();
  assert.equal(renderer.diagnostics().builds, 1);
  assert.equal(drawn()[0], primitive);
  assert.equal(overlay.calls.filter((c) => c.type === 'entries').length, 1);

  // A state change swaps the primitive: the old one leaves the globe.
  renderer.sync([{ ...views[0], alert: true }, views[1]]);
  assert.equal(drawn().length, 1);
  assert.notEqual(drawn()[0], primitive);
  assert.equal(renderer.diagnostics().builds, 2);
  const alertColor = Cesium.ColorGeometryInstanceAttribute.toValue(
    Cesium.Color.fromCssColorString(WATCH_ZONE_STATE_COLORS.alert),
  );
  assert.deepEqual(
    [...drawn()[0].geometryInstances[0].attributes.color.value],
    [...alertColor],
  );

  // No zones: nothing drawn.
  renderer.sync([]);
  assert.equal(drawn().length, 0);
});

test('labels: display-only overlay entries, republished only when text changes', async (t) => {
  const { renderer, overlay } = setup(t);
  const [view] = zoneViews();
  const counted = answers(view, { aircraft: 'counted', vessel: 'floor' });
  renderer.sync([counted]);
  const published = overlay.calls.filter((c) => c.type === 'entries');
  assert.equal(published.length, 1);
  const [{ source, entries, options }] = published;
  assert.equal(source, WATCH_OVERLAY_SOURCE_ID);
  assert.deepEqual(options, {
    cohortLimit: 24,
    collisionCapacity: 24,
    moving: false,
  });
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.id, `watch-zone:${view.id}`);
  // The label variant paints only its title; a card shows the count line.
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, 'Zone 1');
  assert.equal(entry.interactive, false);
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.paintLane, 'ambient-card');
  assert.equal(entry.priority, 20_000);
  assert.equal(entry.accent, WATCH_ZONE_STATE_COLORS.partial);
  assert.deepEqual(entry.details, ['3 aircraft · ≥ 3 vessels']);
  assert.ok(entry.position instanceof Cesium.Cartesian3);
  const anchor = Cesium.Cartographic.fromCartesian(entry.position);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(anchor.latitude) - view.labelAnchor.lat) <
      1e-6,
  );

  renderer.sync([{ ...counted }]);
  assert.equal(overlay.calls.filter((c) => c.type === 'entries').length, 1);
  // Removing the last zone clears its label.
  renderer.sync([]);
  assert.deepEqual(overlay.calls.at(-1).entries, []);
  renderer.sync([counted]);
  assert.equal(overlay.calls.filter((c) => c.type === 'entries').length, 3);
  // A new count is new text.
  renderer.sync([answers(view, { aircraft: 'counted', vessel: 'counted' })]);
  assert.equal(overlay.calls.filter((c) => c.type === 'entries').length, 4);
  await settle();
});

test('no zones yet: no overlay source is registered', (t) => {
  const { renderer, overlay } = setup(t);
  renderer.sync([]);
  renderer.sync(null);
  assert.deepEqual(overlay.calls, []);
});

test('no zones yet: the terrain table is not requested', async (t) => {
  let attempts = 0;
  const { renderer, drawn } = setup(t, {
    terrainReady: () => {
      attempts += 1;
      return Promise.resolve();
    },
  });
  renderer.sync([]);
  renderer.sync(null);
  await settle();
  assert.equal(attempts, 0);
  assert.equal(renderer.diagnostics().builds, 0);
  // The first outline asks for it.
  renderer.sync(zoneViews());
  await settle();
  assert.equal(attempts, 1);
  assert.equal(drawn().length, 1);
});

test('at most 24 labels, ordered by priority', (t) => {
  const { renderer, overlay } = setup(t);
  const [view] = zoneViews();
  const many = Array.from({ length: 30 }, (_, i) => ({
    ...view,
    id: `z-many${String(i).padStart(4, '0')}`,
  }));
  renderer.sync(many);
  const [{ entries }] = overlay.calls.filter((c) => c.type === 'entries');
  assert.equal(entries.length, 24);
  assert.deepEqual(
    entries.slice(0, 3).map((entry) => entry.priority),
    [20_000, 19_999, 19_998],
  );
});

test('setVisible hides outlines and labels; destroy removes both', async (t) => {
  const { renderer, overlay, drawn } = setup(t);
  renderer.sync(zoneViews());
  await settle();
  const [primitive] = drawn();
  renderer.setVisible(false);
  assert.equal(primitive.show, false);
  assert.deepEqual(overlay.calls.at(-1), {
    type: 'visible',
    source: WATCH_OVERLAY_SOURCE_ID,
    visible: false,
  });
  // Hidden outlines are rebuilt hidden.
  renderer.sync([{ ...zoneViews()[0], alert: true }]);
  assert.equal(drawn()[0].show, false);
  renderer.setVisible(true);
  assert.equal(drawn()[0].show, true);

  renderer.destroy();
  assert.equal(drawn().length, 0);
  assert.deepEqual(overlay.calls.at(-1), {
    type: 'clear',
    source: WATCH_OVERLAY_SOURCE_ID,
  });
  const calls = overlay.calls.length;
  renderer.sync(zoneViews(2));
  renderer.setVisible(false);
  renderer.destroy();
  assert.equal(overlay.calls.length, calls);
  assert.equal(drawn().length, 0);
});

test('a terrain table that resolves after destroy draws nothing', async (t) => {
  let resolve;
  const { renderer, drawn } = setup(t, {
    terrainReady: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  renderer.sync(zoneViews());
  await settle();
  renderer.destroy();
  resolve();
  await settle();
  assert.equal(drawn().length, 0);
});

test('a failed terrain table is retried on the next sync', async (t) => {
  let attempts = 0;
  const { renderer, drawn } = setup(t, {
    terrainReady: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve();
    },
  });
  renderer.sync(zoneViews());
  await settle();
  assert.equal(drawn().length, 0);
  renderer.sync(zoneViews());
  await settle();
  assert.equal(attempts, 2);
  assert.equal(drawn().length, 1);
});

test('the renderer uses the overlay host, never Cesium labels or picking', () => {
  const source = readFileSync(new URL('./watchZones.js', import.meta.url), {
    encoding: 'utf8',
  });
  assert.doesNotMatch(source, /LabelCollection|LabelGraphics|\blabel:\s*\{/);
  assert.doesNotMatch(source, /allowPicking:\s*true/);
  assert.match(source, /scene\?\.groundPrimitives/);
});
