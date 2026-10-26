import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion, createFlightFeed } from './ingestion.js';

function setup(source) {
  const feed = {
    _source: source,
    _activeUpdateControllers: new Set(),
    _trackingRefreshEpoch: 0,
    _lastSource: 'Fixture',
    _lastCoverage: 'local',
    _retryAt: 0,
  };
  const accepted = [];
  const labels = [];
  const restores = [];
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({ latitude: 39 }),
    applySnapshot: (snapshot) => {
      accepted.push(snapshot);
      return { count: 2, ids: new Set(['abc123']) };
    },
    setSourceLabel: (label) => labels.push(label),
    applyPendingTrackingRestore: () => restores.push(true),
  });
  return { feed, accepted, labels, restores, update: methods.update };
}

test('civil acquisition rejects late completion after cancellation without publishing records', async () => {
  let release;
  const probe = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const request = probe.update(null);
  assert.equal(probe.feed._activeUpdateControllers.size, 1);
  for (const controller of probe.feed._activeUpdateControllers)
    controller.abort();
  release({ records: [] });
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(probe.accepted.length, 0);
  assert.equal(probe.restores.length, 0);
  assert.equal(probe.feed._activeUpdateControllers.size, 0);
});

test('civil acquisition publishes source time and uses a replaced source on the next request', async () => {
  let calls = 0;
  const probe = setup({
    async getSnapshot(query) {
      assert.equal(query.latitude, 39);
      calls += 1;
      return {
        records: [],
        source: 'First',
        observedAtMs: 1234,
        freshness: 'fresh',
        coverage: 'worldwide',
      };
    },
  });
  await probe.update(null);
  assert.equal(probe.feed._lastUpdate, 1234);
  assert.equal(probe.feed._count, 2);
  assert.deepEqual([...probe.feed._lastTrackingRefreshOutcome.ids], ['abc123']);
  probe.feed._source = {
    async getSnapshot() {
      return {
        records: [],
        source: 'Second',
        observedAtMs: 1250,
        freshness: 'unknown',
      };
    },
  };
  await probe.update(null);
  assert.equal(calls, 1);
  assert.equal(probe.feed._lastUpdate, 1250);
  assert.equal(probe.feed._backoff, true);
  assert.equal(probe.feed._lastError, 'Source snapshot time unavailable');
  assert.deepEqual(probe.labels, ['First', 'Second']);
  assert.equal(probe.restores.length, 2);
});

function anchorSetup() {
  let respond = async () => ({ records: [], observedAtMs: 1 });
  let applyThrows = false;
  let query = { latitude: 30.25, longitude: -97.75 };
  const feed = createFlightFeed({
    label: 'Fixture',
    getSnapshot: (asked, options) => respond(asked, options),
  });
  const { methods } = createIngestion({
    feed,
    getQuery: () => query,
    applySnapshot: () => {
      if (applyThrows) throw new Error('render failed');
      return { count: 1, ids: new Set(['abc123']) };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
  });
  return {
    feed,
    update: methods.update,
    respondWith: (fn) => {
      respond = fn;
    },
    moveTo: (next) => {
      query = next;
    },
    failApply: (value) => {
      applyThrows = value;
    },
  };
}

const regional = (extra = {}) => ({
  records: [],
  source: 'adsb.lol',
  coverage: '250nm regional fallback',
  observedAtMs: 1000,
  freshness: 'fresh',
  ...extra,
});

test('a new flight feed has no coverage anchor until a snapshot is accepted', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const probe = anchorSetup();
  assert.equal(probe.feed._lastCoverageQuery, null);
  probe.respondWith(async () => {
    throw new Error('offline');
  });
  await probe.update(null);
  assert.equal(probe.feed._lastCoverageQuery, null);
  assert.equal(probe.feed._lastError, 'Live data unavailable');
});

test('the coverage anchor is recorded only on accept and kept on every failure', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const probe = anchorSetup();
  const asked = [];
  probe.respondWith(async (query) => {
    asked.push(query);
    return regional();
  });
  await probe.update(null);
  assert.deepEqual(probe.feed._lastCoverageQuery, {
    latitude: 30.25,
    longitude: -97.75,
  });
  // A copy: later changes to the query object cannot move the anchor.
  assert.notEqual(probe.feed._lastCoverageQuery, asked[0]);
  asked[0].latitude = 0;
  assert.equal(probe.feed._lastCoverageQuery.latitude, 30.25);

  // A failed request from a new view keeps the anchor of the records in memory.
  probe.moveTo({ latitude: 51.5, longitude: -0.12 });
  probe.respondWith(async (query) => {
    asked.push(query);
    const error = new Error('rate limited');
    error.retryAfterMs = 60_000;
    throw error;
  });
  await probe.update(null);
  assert.equal(asked.at(-1).latitude, 51.5);
  assert.equal(probe.feed._lastCoverageQuery.latitude, 30.25);

  // Backoff returns before asking at all.
  const calls = asked.length;
  await probe.update(null);
  assert.equal(asked.length, calls);
  assert.equal(probe.feed._backoff, true);
  assert.equal(probe.feed._lastCoverageQuery.latitude, 30.25);

  // A cancelled request keeps it too.
  probe.feed._retryAt = 0;
  probe.respondWith(
    (_query, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  const pending = probe.update(null);
  for (const controller of probe.feed._activeUpdateControllers)
    controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(probe.feed._lastCoverageQuery.latitude, 30.25);

  // A snapshot the renderer did not accept is not an accepted snapshot.
  probe.failApply(true);
  probe.respondWith(async () => regional());
  await probe.update(null);
  assert.equal(probe.feed._lastCoverageQuery.latitude, 30.25);

  // The next accepted snapshot moves the anchor to its own query.
  probe.failApply(false);
  probe.feed._retryAt = 0;
  await probe.update(null);
  assert.deepEqual(probe.feed._lastCoverageQuery, {
    latitude: 51.5,
    longitude: -0.12,
  });
});

test('a stale accepted snapshot still records the anchor it answered', async () => {
  const probe = anchorSetup();
  probe.moveTo({ latitude: -33.9, longitude: 151.2 });
  probe.respondWith(async () =>
    regional({ stale: true, ageMs: 600_000, freshness: 'stale' }),
  );
  await probe.update(null);
  assert.equal(probe.feed._backoff, true);
  assert.deepEqual(probe.feed._lastCoverageQuery, {
    latitude: -33.9,
    longitude: 151.2,
  });
});
