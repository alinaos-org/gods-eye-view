import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createQueries } from './queries.js';
import { createRendering } from './rendering.js';

function fixture() {
  const info = {
    callsign: ' TEST123 ',
    registration: ' N123 ',
    altitude: 1000,
  };
  const bb = { show: true, position: new Cesium.Cartesian3(1, 2, 3) };
  const flightState = {
    feed: {},
    _billboardCollection: { show: true },
    _billboards: new Map([['abc123', bb]]),
    _models: new Map(),
    _detectionObjects: new Map(),
    records: { data: new Map([['abc123', info]]) },
  };
  let formats = 0;
  const services = {
    aircraftPresentation: {},
    militaryRegistry: {},
    camera: {},
    focus: {},
    recession: {},
    labels: {
      formatFlightLevel: (altitude) => {
        formats++;
        return String(altitude);
      },
    },
  };
  const parts = {
    testing: {},
    tracking: { _trackedModelRegimeActive: () => true },
    motion: { _trackedVisualCached: () => null },
  };
  parts.rendering = createRendering({ flightState, services, parts });
  const queries = createQueries({ flightState, services, parts }).methods;
  return { flightState, info, bb, parts, queries, formats: () => formats };
}

test('candidate text follows in-place enrichment without freezing identity or positions', () => {
  const f = fixture();
  const [first] = f.queries.getDetectableObjects();
  assert.equal(first.id, 'TEST123');
  assert.equal(first.sourceId, 'abc123');
  f.bb.position = new Cesium.Cartesian3(4, 5, 6);
  assert.equal(f.queries.getDetectableObjects()[0], first);
  assert.equal(first.position, f.bb.position);
  assert.equal(f.formats(), 1);
  f.info.callsign = ' NEW456 ';
  assert.equal(f.queries.getDetectableObjects()[0].id, 'NEW456');
  f.info.callsign = '   ';
  assert.equal(f.queries.getDetectableObjects()[0].id, 'N123');
  f.info.registration = ' N456 ';
  f.info.altitude = 2000;
  assert.equal(f.queries.getDetectableObjects()[0].id, 'N456');
  assert.equal(first.metric, '2000');
  assert.equal(f.formats(), 2);
  f.flightState.records.data.set('abc123', { ...f.info });
  assert.equal(f.queries.getDetectableObjects()[0], first);
  f.flightState.records.data.delete('abc123');
  assert.equal(f.queries.getDetectableObjects()[0].id, 'abc123');
  assert.equal(first.sourceId, 'abc123');
});

test('unchanged candidate text is normalized once across paints', (t) => {
  const f = fixture();
  const trim = String.prototype.trim;
  let calls = 0;
  t.mock.method(String.prototype, 'trim', function () {
    if (String(this) === ' TEST123 ') calls++;
    return trim.call(this);
  });
  for (let i = 0; i < 20; i++) f.queries.getDetectableObjects();
  assert.equal(calls, 1);
});

test('candidate collection resolves models once and keeps handoffs live', (t) => {
  const f = fixture();
  const get = t.mock.method(f.flightState._models, 'get');
  const [candidate] = f.queries.getDetectableObjects();
  assert.equal(get.mock.callCount(), 1);
  const model = {
    ready: false,
    show: true,
    modelMatrix: Cesium.Matrix4.fromTranslation(
      new Cesium.Cartesian3(10, 20, 30),
    ),
  };
  f.parts.rendering._modelSpec = () => ({
    visualCenterNative: Cesium.Cartesian3.ZERO,
    scale: 1,
  });
  f.flightState._models.set('abc123', model);
  f.bb.show = false;
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  model.ready = true;
  assert.equal(f.queries.getDetectableObjects()[0], candidate);
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(10, 20, 30));
  Cesium.Matrix4.setTranslation(
    model.modelMatrix,
    new Cesium.Cartesian3(40, 50, 60),
    model.modelMatrix,
  );
  f.queries.getDetectableObjects();
  assert.deepEqual(candidate.position, new Cesium.Cartesian3(40, 50, 60));
  model.show = false;
  assert.deepEqual(f.queries.getDetectableObjects(), []);
  f.bb.show = true;
  assert.equal(f.queries.getDetectableObjects()[0].position, f.bb.position);
  assert.equal(get.mock.callCount(), 6);
  model.show = true;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123'), true);
  assert.equal(get.mock.callCount(), 7);
});

test('tracked ownership and live anchors remain independent of fleet models', () => {
  const f = fixture();
  f.flightState._trackedIcao = 'abc123';
  f.flightState._trackedModel = { ready: true, show: true };
  f.parts.rendering._modelSpec = () => ({});
  let anchor = new Cesium.Cartesian3(10, 20, 30);
  f.parts.motion._trackedVisualCached = () => anchor;
  const [candidate] = f.queries.getDetectableObjects();
  assert.equal(candidate.position, anchor);
  assert.equal(candidate.skipLabel, true);
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), true);
  anchor = new Cesium.Cartesian3(40, 50, 60);
  assert.equal(f.queries.getDetectableObjects()[0].position, anchor);
  for (const tracked of [
    null,
    { ready: false, show: true },
    { ready: true, show: false },
  ]) {
    f.flightState._trackedModel = tracked;
    assert.equal(
      f.parts.rendering._modelOwnsVisual('abc123', { ready: true, show: true }),
      false,
    );
  }
  f.flightState._trackedModel = { ready: true, show: true };
  f.parts.tracking._trackedModelRegimeActive = () => false;
  assert.equal(f.parts.rendering._modelOwnsVisual('abc123', null), false);
});

test('flights coverage is global for the worldwide snapshot and unqualified text', () => {
  const f = fixture();
  for (const coverage of [
    'worldwide upstream snapshot',
    'worldwide',
    'military upstream snapshot',
    '  Worldwide OpenSky states  ',
  ]) {
    f.flightState.feed._lastCoverage = coverage;
    // An anchor never narrows a worldwide answer.
    f.flightState.feed._lastCoverageQuery = { latitude: 30, longitude: -97 };
    assert.deepEqual(f.queries.getCoverageArea(), { kind: 'global' }, coverage);
  }
});

test('a regional fallback is a disc around the accepted anchor, 438 km for 250 nm', () => {
  const f = fixture();
  f.flightState.feed._lastCoverage = '250nm regional fallback';
  f.flightState.feed._lastCoverageQuery = {
    latitude: 30.2672,
    longitude: -97.7431,
  };
  const area = f.queries.getCoverageArea();
  assert.deepEqual(area, {
    kind: 'circle',
    lat: 30.2672,
    lon: -97.7431,
    radiusKm: 438,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(area)), area);
  // A fresh object each call, so a caller cannot edit the layer's answer.
  assert.notEqual(f.queries.getCoverageArea(), area);
  area.radiusKm = 1;
  assert.equal(f.queries.getCoverageArea().radiusKm, 438);
  for (const [coverage, radiusKm] of [
    ['250 nm regional', 438],
    ['100 NM fallback', 160.2],
  ]) {
    f.flightState.feed._lastCoverage = coverage;
    assert.equal(f.queries.getCoverageArea().radiusKm, radiusKm, coverage);
  }
});

test('flights coverage is unknown without text, anchor, distance or a usable disc', () => {
  const f = fixture();
  const cases = [
    [undefined, { latitude: 30, longitude: -97 }],
    ['', { latitude: 30, longitude: -97 }],
    ['   ', { latitude: 30, longitude: -97 }],
    [null, { latitude: 30, longitude: -97 }],
    ['250nm regional fallback', null],
    ['250nm regional fallback', undefined],
    ['250nm regional fallback', {}],
    ['250nm regional fallback', { latitude: 30 }],
    ['250nm regional fallback', { latitude: NaN, longitude: -97 }],
    ['250nm regional fallback', { latitude: 91, longitude: -97 }],
    ['250nm regional fallback', { latitude: 30, longitude: 181 }],
    ['250nm regional fallback', { latitude: '30', longitude: '-97' }],
    ['regional fallback', { latitude: 30, longitude: -97 }],
    ['250 km regional fallback', { latitude: 30, longitude: -97 }],
    ['250nmi regional fallback', { latitude: 30, longitude: -97 }],
    // 10 nm is 18.5 km, less than the anchor margin: no honest disc is left.
    ['10nm regional fallback', { latitude: 30, longitude: -97 }],
  ];
  for (const [coverage, anchor] of cases) {
    f.flightState.feed._lastCoverage = coverage;
    f.flightState.feed._lastCoverageQuery = anchor;
    assert.deepEqual(
      f.queries.getCoverageArea(),
      { kind: 'unknown' },
      JSON.stringify([coverage, anchor]),
    );
  }
});

test('a type lookup is asked for, ahead of the backlog, only for a known aircraft', () => {
  const f = fixture();
  const asked = [];
  f.parts.enrichment = {
    _requestTypeEnrichment: (icao24, priority) =>
      asked.push([icao24, priority]),
  };
  assert.equal(f.queries.requestTypeEnrichment(' ABC123 '), true);
  assert.deepEqual(asked, [['abc123', true]]);
  for (const id of ['def456', 'abc12', '~abc123', null, undefined]) {
    assert.equal(f.queries.requestTypeEnrichment(id), false, String(id));
  }
  assert.equal(asked.length, 1);
});
