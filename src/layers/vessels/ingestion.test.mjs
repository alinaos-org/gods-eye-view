import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createVesselFeed } from './ingestion.js';
function setup(source) {
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const applied = [];
  const labels = [];
  let count = 0;
  const ingestion = createIngestion({
    feed,
    readSource: () => source,
    readViewer: () => ({}),
    getRowLimit: () => 500,
    readCount: () => count,
    now: () => 9999,
    setSourceLabel: (value) => labels.push(value),
    applyRows: (_, rows) => {
      applied.push(rows);
      count = rows.length;
    },
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: payload.lastMessageAt,
      error: payload.rows.length ? null : 'No accepted positions',
    }),
    isDefinitiveTransportFailure: () => false,
    isGraceEligibleTransport: () => false,
    markUnavailable: (error) => {
      feed.error = error;
    },
    settleFirstConnect: (phase) => {
      feed.firstConnectPhase = phase;
    },
  });
  return { feed, applied, labels, ...ingestion };
}

test('an old vessel request cannot publish or clear the loading state of a newer enable session', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.methods.update();
  const old = probe.feed.abort;
  probe.feed.sessionId++;
  probe.feed.abort = new AbortController();
  probe.feed.loading = true;
  release({ records: [], source: 'Old session' });
  await request;
  assert.equal(probe.applied.length, 0);
  assert.equal(probe.labels.length, 0);
  assert.equal(probe.feed.loading, true);
  assert.notEqual(probe.feed.abort, old);
});

test('vessel ingestion converts source units once and retains warm records on a zero-row snapshot', async () => {
  let snapshot = {
    records: [
      {
        id: '111',
        reference: '111',
        latitude: 51.93,
        longitude: 4.05,
        speedMps: 5.14444,
        courseDeg: 90,
        headingDeg: 100,
        observedAtMs: 1700000000000,
      },
    ],
    source: 'Fixture',
    observedAtMs: null,
    freshness: 'unknown',
    complete: false,
    transportStatus: 'live',
  };
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.maxRows, 500);
      return snapshot;
    },
  });
  await probe.methods.update();
  const record = probe.applied[0][0];
  assert.equal(record.speed, 5.14444 / 0.514444);
  assert.equal(record.last_position_epoch, 1700000000);
  assert.equal(record.last_position_UTC, new Date(1700000000000).toISOString());
  assert.equal(probe.feed.lastUpdate, null);
  assert.equal(probe.feed.stale, true);
  assert.equal(probe.feed.count, 1);
  snapshot = { ...snapshot, records: [] };
  await probe.methods.update();
  assert.equal(probe.applied.length, 1);
  assert.equal(probe.feed.count, 1);
  assert.equal(probe.feed.stale, true);
  assert.equal(probe.feed.error, 'No accepted positions');
  assert.equal(probe.feed.loading, false);
  assert.equal(probe.feed.abort, null);
});

test('vessels are asked for by the area in view, and again only when the view moves away', async () => {
  const asked = [];
  let area = { lat: 37.8, lon: -122.4, radiusKm: 40 };
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const ingestion = createIngestion({
    feed,
    readSource: () => ({
      getSnapshot: async (query) => {
        asked.push(query);
        return { records: [], source: 'Feed' };
      },
    }),
    readViewer: () => ({}),
    readArea: () => area,
    getRowLimit: () => 500,
    readCount: () => 0,
    now: () => 0,
    setSourceLabel: () => {},
    applyRows: () => {},
    classifySnapshot: () => ({
      acceptedRows: [],
      acceptedRowCount: 0,
      rawRowCount: 0,
    }),
    isDefinitiveTransportFailure: () => false,
    isGraceEligibleTransport: () => false,
    markUnavailable: () => {},
    settleFirstConnect: () => {},
  });
  await ingestion.methods.update();
  assert.deepEqual(asked, [{ maxRows: 500, area }]);
  await ingestion.refreshIfMoved();
  assert.equal(asked.length, 1);
  area = { ...area, lat: 38.2 };
  await ingestion.refreshIfMoved();
  assert.deepEqual(asked.at(-1), { maxRows: 500, area });
  area = null;
  await ingestion.refreshIfMoved();
  assert.deepEqual(asked.at(-1), { maxRows: 500 });
});

function areaSetup() {
  let area = { lat: 51.93, lon: 4.05, radiusKm: 40 };
  let respond = async () => areaSnapshot(['111']);
  let count = 0;
  const asked = [];
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const ingestion = createIngestion({
    feed,
    readSource: () => ({
      getSnapshot: (query, options) => {
        asked.push(query);
        return respond(query, options);
      },
    }),
    readViewer: () => ({}),
    readArea: () => area,
    getRowLimit: () => 500,
    readCount: () => count,
    now: () => 9999,
    setSourceLabel: () => {},
    applyRows: (_, rows) => {
      count = rows.length;
    },
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: payload.lastMessageAt,
      emptyCoverage: payload.rows.length === 0 && payload.complete === true,
      error: payload.rows.length ? null : 'No accepted positions',
    }),
    isDefinitiveTransportFailure: (status) => status === 'down',
    isGraceEligibleTransport: () => false,
    markUnavailable: (error) => {
      feed.error = error;
    },
    settleFirstConnect: (phase) => {
      feed.firstConnectPhase = phase;
    },
  });
  return {
    feed,
    asked,
    ...ingestion,
    moveTo: (next) => {
      area = next;
    },
    respondWith: (fn) => {
      respond = fn;
    },
  };
}

function areaSnapshot(ids, extra = {}) {
  return {
    records: ids.map((id) => ({
      id,
      reference: id,
      latitude: 51.93,
      longitude: 4.05,
      observedAtMs: 1_700_000_000_000,
    })),
    source: 'Fixture',
    observedAtMs: 1_700_000_000_000,
    freshness: 'current',
    complete: false,
    transportStatus: 'live',
    ...extra,
  };
}

test('a new vessel feed has no applied area until a snapshot is reconciled', () => {
  const feed = createVesselFeed();
  assert.equal(feed.appliedArea, null);
  assert.equal(feed.appliedAreaKnown, false);
});

test('the applied area is the reconciled snapshot area, never only the area asked for', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const probe = areaSetup();
  await probe.methods.update();
  assert.deepEqual(probe.feed.appliedArea, {
    lat: 51.93,
    lon: 4.05,
    radiusKm: 40,
  });
  assert.equal(probe.feed.appliedAreaKnown, true);
  // A copy, so moving the asked-for area object cannot move it.
  assert.notEqual(probe.feed.appliedArea, probe.feed.lastArea);

  // A failed request in a new area: lastArea moves, the applied area stays.
  probe.moveTo({ lat: 1.26, lon: 103.8, radiusKm: 60 });
  probe.respondWith(async () => {
    throw new Error('Vessels unavailable');
  });
  await probe.methods.update();
  assert.equal(probe.feed.lastArea.lat, 1.26);
  assert.equal(probe.feed.error, 'Vessels unavailable');
  assert.deepEqual(probe.feed.appliedArea, {
    lat: 51.93,
    lon: 4.05,
    radiusKm: 40,
  });
  assert.equal(probe.feed.appliedAreaKnown, true);

  // Zero accepted rows keep the warm records, so they keep their area too.
  probe.respondWith(async () => areaSnapshot([]));
  await probe.methods.update();
  assert.equal(probe.feed.count, 1);
  assert.equal(probe.feed.error, 'No accepted positions');
  assert.equal(probe.feed.appliedArea.lat, 51.93);

  // A definitive transport failure with no rows is not reconciled either.
  probe.respondWith(async () => areaSnapshot([], { transportStatus: 'down' }));
  await probe.methods.update();
  assert.equal(probe.feed.appliedArea.lat, 51.93);

  // An authoritative empty answer for the new area does reconcile it.
  probe.respondWith(async () => areaSnapshot([], { complete: true }));
  await probe.methods.update();
  assert.deepEqual(probe.feed.appliedArea, {
    lat: 1.26,
    lon: 103.8,
    radiusKm: 60,
  });

  // A wide view asks for every vessel and applies null (global).
  probe.moveTo(null);
  probe.respondWith(async () => areaSnapshot(['222']));
  await probe.methods.update();
  assert.deepEqual(probe.asked.at(-1), { maxRows: 500 });
  assert.equal(probe.feed.appliedArea, null);
  assert.equal(probe.feed.appliedAreaKnown, true);
});

test('a vessel answer that lost ownership of the layer applies no area', async () => {
  const probe = areaSetup();
  let release;
  probe.respondWith(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = probe.methods.update();
  probe.feed.sessionId++;
  release(areaSnapshot(['111']));
  await pending;
  assert.equal(probe.feed.appliedArea, null);
  assert.equal(probe.feed.appliedAreaKnown, false);
});

test('refreshIfMoved reconciles the applied area like any other load', async () => {
  const probe = areaSetup();
  await probe.methods.update();
  probe.moveTo({ lat: 52.4, lon: 4.9, radiusKm: 40 });
  await probe.refreshIfMoved();
  assert.equal(probe.asked.length, 2);
  assert.deepEqual(probe.feed.appliedArea, {
    lat: 52.4,
    lon: 4.9,
    radiusKm: 40,
  });
});
