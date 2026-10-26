/**
 * The Watch controller: zones, watched assets and the session inbox for one
 * application lifetime.
 *
 * It owns the saved Watch document (`gev:watch:v1`), the pure engine
 * (src/watch), the session-only event log, the rail panel
 * (src/ui/watchPanel.js) and the globe outlines (./watchZones.js). Layers
 * are read only while Watch is in use (the document has zones or watched
 * assets, or the person opened the panel), and then only the layers some
 * zone or watched asset needs, plus the aircraft layers for the global
 * Active emergencies card. Each read runs in an idle callback after the
 * layer's refresh, failed refresh or visibility change, at most once per
 * burst; a turned-off layer gives an off frame without reading anything.
 *
 * Privacy (README "The line"): only asset identifiers are kept. Watched
 * assets keep one last-seen fix each, the privacy guard's declines are
 * written back at once (which also drops that fix), the event log never
 * leaves this tab, and nothing here is shared.
 *
 * Navigation uses the shell's explicit-navigation policy with literal nouns
 * ('aircraft', 'satellite', 'location'), and vessel and fire focus go
 * through the world-focus request ('vessel', 'fire'), so the Cockpit
 * refusals stay complete.
 */
import * as Cesium from 'cesium';
import { layerSnapshot } from '../data/layerSnapshot.js';
import { msg, registerUnsavedWork, t } from '../i18n/index.js';
import { UiLifetime } from '../ui/uiLifetime.js';
import { createWatchPanel } from '../ui/watchPanel.js';
import { defaultZoneName, describeWatchEvent } from '../ui/watchWording.js';
import {
  addWatchEntry,
  addZone,
  createCircleZone,
  emptyWatchDocument,
  isEmptyWatchDocument,
  markDeclined,
  readStoredWatchDocument,
  removeWatchEntry,
  removeZone,
  replaceZone,
  setLastSeen,
  setPrefs,
  updateZone,
  watchEntryFromSelection,
  writeStoredWatchDocument,
  zoneFromAnnotation,
} from '../watch/document.js';
import { createWatchEngine } from '../watch/engine.js';
import { createWatchEventLog } from '../watch/eventLog.js';
import { KIND_LAYERS, WATCH_SOURCES, buildFrame } from '../watch/frames.js';
import { compileZone } from '../watch/geometry.js';
import { WATCH_LAYERS } from '../watch/watchlist.js';
import { requestWorldFocus as requestWorldFocusDefault } from '../worldFocus.js';
import { createWatchZoneRenderer } from './watchZones.js';

/** Engine tick, satellite lookups and relative-time refresh. */
export const WATCH_TICK_MS = 30_000;
/** At most one alert pop-up in this window. */
export const WATCH_TOAST_GAP_MS = 15_000;
/** Last-seen fixes are saved at most this often; edits save at once. */
export const WATCH_LAST_SEEN_WRITE_MS = 60_000;

const IDLE_TIMEOUT_MS = 2000;
const INBOX_ROWS = 50;
const BRIEF_EVENTS = 50;
const SATELLITE_LAYER = 'satellites';
const VESSEL_LAYER = 'ais-live-vessels';
/** Military first, so a military contact is followed in its own layer. */
const AIRCRAFT_LAYERS = Object.freeze(['military', 'flights']);
/** Layers whose "Turn on" a card may offer. */
const ENABLEABLE_LAYERS = Object.freeze([
  ...Object.keys(WATCH_SOURCES),
  SATELLITE_LAYER,
]);
const SELECT_EVENTS = Object.freeze([
  'gev:awareness-subject-selected',
  'gev:entity-selected',
]);
const CLEAR_EVENTS = Object.freeze([
  'gev:awareness-subject-cleared',
  'gev:entity-selection-cleared',
]);
const WATCH_ACTIONS = new Set([
  'watch-add-selection',
  'watch-add-id',
  'watch-focus',
  'watch-remove',
]);
const ZONE_ACTIONS = new Set([
  'zone-add-view',
  'zone-add-selection',
  'zone-add-annotation',
  'zone-update',
  'zone-rename',
  'zone-delete',
]);
/** Zone fly-to padding, as a share of the zone's box on each side. */
const ZONE_PAD = 0.15;
/** Half-size of the box flown to around a point, in km. */
const POINT_VIEW_KM = Object.freeze({ quake: 60, asset: 25 });
const KM_PER_DEG_LAT = 111.32;
const DEG = Math.PI / 180;

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const clampLat = (lat) => Math.max(-89, Math.min(89, lat));

/** Best-effort localStorage handle; absent in tests and locked-down browsers. */
function watchStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // privacy modes throw on mere access
  }
}

/** A short random id suffix for new zones and entries. */
function randomId() {
  return Math.random().toString(36).slice(2, 12).padEnd(6, '0');
}

function point(lat, lon) {
  const la = finite(Number(lat));
  const lo = finite(Number(lon));
  if (la === null || lo === null || Math.abs(la) > 90 || Math.abs(lo) > 180) {
    return null;
  }
  return { lat: la, lon: lo };
}

function fromCartographic(carto) {
  if (!carto) return null;
  return point(
    Cesium.Math.toDegrees(carto.latitude),
    Cesium.Math.toDegrees(carto.longitude),
  );
}

/** Where a selection event says the asset is, or null. */
function selectionPosition(detail) {
  const direct = point(detail?.latitude, detail?.longitude);
  if (direct) return direct;
  const position = detail?.position;
  if (!position || !Number.isFinite(position.x)) return null;
  try {
    return fromCartographic(Cesium.Cartographic.fromCartesian(position));
  } catch {
    return null;
  }
}

const normalizeCallsign = (value) =>
  typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : null;

/** A degree box around a point, `halfKm` from the centre each way. */
function boxAround({ lat, lon }, halfKm) {
  const dLat = halfKm / KM_PER_DEG_LAT;
  const dLon = Math.min(
    179,
    halfKm / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos(lat * DEG))),
  );
  return {
    south: clampLat(lat - dLat),
    north: clampLat(lat + dLat),
    west: wrapLon(lon - dLon),
    east: wrapLon(lon + dLon),
  };
}

/** A zone's box padded by {@link ZONE_PAD}, or null for an invalid zone. */
function zoneBox(zone) {
  const compiled = compileZone(zone);
  if (!compiled) return null;
  const { south, north, west, east, wraps } = compiled.bbox;
  const width = wraps ? east + 360 - west : east - west;
  const padLat = (north - south) * ZONE_PAD;
  const padLon = width * ZONE_PAD;
  const box = {
    south: clampLat(south - padLat),
    north: clampLat(north + padLat),
  };
  if (width + 2 * padLon >= 360) return { ...box, west: -180, east: 180 };
  return { ...box, west: wrapLon(west - padLon), east: wrapLon(east + padLon) };
}

/**
 * Installs Watch.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium viewer (camera flights, the view
 *   centre and the zone outlines).
 * @param {object} options.dataManager The layer lifecycle: `layers`,
 *   `getAll()`, `isEnabled()`, `subscribe()` and `setEnabled()`.
 * @param {{list: () => object[]}|null} [options.annotations] Drawn shapes
 *   that can become zones.
 * @param {{runImmediateNavigation: (noun: string, fly: Function) => unknown}|null}
 *   [options.navigation] The shell's explicit-navigation policy.
 * @param {(text: string) => void} [options.notify] Shows a toast.
 * @param {object|null} [options.overlayHost] World-overlay facade for the
 *   zone labels.
 * @param {(reason: string) => void} [options.requestRender]
 * @param {Storage|null} [options.storage] Defaults to localStorage.
 * @param {() => number} [options.now] Wall clock.
 * @param {(callback: () => void, ms: number) => unknown} [options.schedule]
 *   Timer (returning a cancel function, or anything); defaults to a
 *   UiLifetime timeout. Idle reads use `windowRef.requestIdleCallback`,
 *   or this timer at 0 ms.
 * @param {(detail: object, target?: EventTarget) => boolean} [options.requestWorldFocus]
 * @param {Window} [options.windowRef]
 * @param {Document} [options.documentRef]
 * @param {() => number|null} [options.measureMs] Monotonic clock timing each
 *   ingest for the engine diagnostics.
 * @param {(prefix: string) => string} [options.makeId] Id suffixes for new
 *   zones and entries.
 * @param {{writeText: (text: string) => Promise<void>}|null} [options.clipboard]
 *   Defaults to `navigator.clipboard`.
 * @param {typeof createWatchPanel} [options.createPanel] Test seam.
 * @param {typeof createWatchZoneRenderer} [options.createRenderer] Test seam.
 * @returns {{destroy: () => void, diagnostics: () => object}|null} null when
 *   #watch-panel or #watch-panel-body is missing.
 */
export function installWatch({
  viewer,
  dataManager,
  annotations = null,
  navigation = null,
  notify = null,
  overlayHost = null,
  requestRender = null,
  storage,
  now = () => Date.now(),
  schedule = null,
  requestWorldFocus = requestWorldFocusDefault,
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  measureMs = () => globalThis.performance?.now?.() ?? null,
  makeId = randomId,
  clipboard = null,
  createPanel = createWatchPanel,
  createRenderer = createWatchZoneRenderer,
} = {}) {
  const panelElement = documentRef?.getElementById?.('watch-panel');
  const body = documentRef?.getElementById?.('watch-panel-body');
  if (!panelElement || !body) return null;
  const toggle = documentRef.getElementById('watch-toggle');
  const store = watchStorage(storage);
  const lifetime = new UiLifetime();
  /** Cancel functions of every pending timer and idle callback. */
  const cancels = new Set();
  let destroyed = false;

  const engine = createWatchEngine({
    measureMs: typeof measureMs === 'function' ? measureMs : undefined,
  });
  const log = createWatchEventLog();

  const stored = readStoredWatchDocument(store);
  let doc = stored.doc;
  /** The read error awaiting the person's choice; writes wait for it. */
  let readError = stored.readError
    ? {
        code: stored.readError,
        ...(stored.readError === 'partial'
          ? { dropped: { ...stored.dropped } }
          : {}),
      }
    : null;
  let writeError = null;
  engine.setDocument(doc);

  const notices = { watch: null, zones: null };
  /** zoneId → the place brief the person last asked for. */
  const briefs = new Map();
  /** The person opened Watch (or used it) in this session. */
  let opened = false;
  /** {kind, match, value, label, layerId, position} of the map selection. */
  let selection = null;
  /** layerId → cancel of its queued read. */
  const pending = new Map();
  /** layerId → epoch of its latest frame. */
  const epochs = new Map();
  let needed = new Set();
  let lastToastAtMs = null;
  let lastWriteAtMs = null;
  let lastSeenDirty = false;
  let tickCancel = null;
  const counters = {
    reads: {},
    frames: {},
    toasts: 0,
    writes: 0,
    errors: 0,
  };
  const bump = (bucket, key) => {
    bucket[key] = (bucket[key] ?? 0) + 1;
  };

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /** Runs `callback` once after `ms`, unless cancelled or destroyed first. */
  function later(callback, ms) {
    if (destroyed) return () => {};
    let live = true;
    let handle = null;
    const cancel = () => {
      if (!live) return;
      live = false;
      cancels.delete(cancel);
      if (typeof handle === 'function') handle();
      else if (!schedule) lifetime.cancelTimeout(handle);
    };
    const run = () => {
      if (!live || destroyed) return;
      live = false;
      cancels.delete(cancel);
      callback();
    };
    cancels.add(cancel);
    handle = schedule ? schedule(run, ms) : lifetime.timeout(run, ms);
    return cancel;
  }

  /** Runs `callback` when the main thread is idle (within 2 s). */
  function idle(callback) {
    const request = windowRef?.requestIdleCallback;
    if (typeof request !== 'function') return later(callback, 0);
    if (destroyed) return () => {};
    let live = true;
    let handle = null;
    const cancel = () => {
      if (!live) return;
      live = false;
      cancels.delete(cancel);
      try {
        windowRef.cancelIdleCallback?.(handle);
      } catch {
        // The callback below checks `live` anyway.
      }
    };
    cancels.add(cancel);
    handle = request.call(
      windowRef,
      () => {
        if (!live || destroyed) return;
        live = false;
        cancels.delete(cancel);
        callback();
      },
      { timeout: IDLE_TIMEOUT_MS },
    );
    return cancel;
  }

  // -------------------------------------------------------------------------
  // Panel visibility and the DISPLAY toggle
  // -------------------------------------------------------------------------

  const collapseButton = () =>
    panelElement.querySelector?.('[data-collapse-target="watch-panel"]') ??
    null;
  const expanded = () =>
    !panelElement.hidden && !panelElement.classList?.contains('collapsed');
  const isVisible = () =>
    !isEmptyWatchDocument(doc) ||
    opened ||
    (readError !== null && readError.code !== 'unavailable');
  const isActive = () =>
    !destroyed && (!isEmptyWatchDocument(doc) || opened || expanded());

  function syncToggle() {
    if (!toggle) return;
    const pressed = !destroyed && expanded();
    toggle.classList?.toggle('active', pressed);
    const value = pressed ? 'true' : 'false';
    if (toggle.getAttribute?.('aria-pressed') !== value) {
      toggle.setAttribute?.('aria-pressed', value);
    }
  }

  // -------------------------------------------------------------------------
  // Layers and frames
  // -------------------------------------------------------------------------

  function layerModule(layerId) {
    try {
      return dataManager?.layers?.get?.(layerId)?.module ?? null;
    } catch {
      return null;
    }
  }
  /** A layer's module while its layer is on, else null. */
  function liveModule(layerId) {
    try {
      return dataManager?.isEnabled?.(layerId) === true
        ? layerModule(layerId)
        : null;
    } catch {
      return null;
    }
  }
  function layerRow(layerId) {
    try {
      const rows = dataManager?.getAll?.();
      return Array.isArray(rows)
        ? (rows.find((row) => row?.id === layerId) ?? null)
        : null;
    } catch {
      return null;
    }
  }

  /** The layers Watch reads now: none while inactive. */
  function computeNeeded() {
    const next = new Set();
    if (!isActive()) return next;
    // Active emergencies are tracked worldwide while Watch is in use.
    for (const layerId of KIND_LAYERS.aircraft) next.add(layerId);
    for (const zone of doc.zones) {
      for (const kind of zone.kinds ?? []) {
        for (const layerId of KIND_LAYERS[kind] ?? []) next.add(layerId);
      }
    }
    for (const entry of doc.watchlist) {
      if (entry.declined) continue;
      for (const layerId of WATCH_LAYERS[entry.kind] ?? []) {
        if (Object.hasOwn(WATCH_SOURCES, layerId)) next.add(layerId);
      }
    }
    return next;
  }

  /** Queues a read for every newly needed layer; drops unneeded reads. */
  function refreshNeeds() {
    if (destroyed) return;
    const next = computeNeeded();
    const added = [...next].filter((layerId) => !needed.has(layerId));
    for (const [layerId, cancel] of pending) {
      if (!next.has(layerId)) {
        cancel();
        pending.delete(layerId);
      }
    }
    needed = next;
    for (const layerId of added) queue(layerId);
  }

  function queue(layerId) {
    if (destroyed || pending.has(layerId) || !needed.has(layerId)) return;
    pending.set(
      layerId,
      idle(() => {
        pending.delete(layerId);
        evaluate(layerId);
      }),
    );
  }

  /** Builds one layer's frame from its current records and ingests it. */
  function evaluate(layerId) {
    if (destroyed || !needed.has(layerId)) return;
    try {
      const nowMs = now();
      const row = layerRow(layerId);
      const enabled = row?.enabled === true;
      const module = enabled ? layerModule(layerId) : null;
      let coverage = null;
      if (module) {
        try {
          coverage = module.getCoverageArea?.() ?? null;
        } catch {
          coverage = null;
        }
      }
      const readRows =
        typeof module?.getAnalystRecords === 'function'
          ? (cap) => {
              bump(counters.reads, layerId);
              return module.getAnalystRecords(cap) || [];
            }
          : undefined;
      const frame = buildFrame({
        layerId,
        nowMs,
        enabled,
        snapshot: row ? layerSnapshot(row, { now: nowMs }) : null,
        stats: row?.stats ?? null,
        coverage,
        readRows,
        previousEpochMs: epochs.get(layerId) ?? null,
      });
      if (frame.epochMs !== null) epochs.set(layerId, frame.epochMs);
      bump(counters.frames, layerId);
      afterEngine(engine.ingest(frame), nowMs);
    } catch (error) {
      counters.errors += 1;
      console.warn(`[Watch] ${layerId} evaluation failed:`, error);
    }
  }

  /** Satellite lookups for watched satellites (exact NORAD id only). */
  function pollSatellites(nowMs) {
    const entries = doc.watchlist.filter(
      (entry) => entry.kind === 'satellite' && !entry.declined,
    );
    if (!entries.length) return;
    const enabled = dataManager?.isEnabled?.(SATELLITE_LAYER) === true;
    const module = enabled ? layerModule(SATELLITE_LAYER) : null;
    const ready = Boolean(
      module && Number(layerRow(SATELLITE_LAYER)?.stats?.count) > 0,
    );
    const rows = entries.map((entry) => {
      let result = null;
      if (ready && typeof module.findByQuery === 'function') {
        bump(counters.reads, SATELLITE_LAYER);
        let found = null;
        try {
          found = module.findByQuery(String(entry.value));
        } catch {
          found = null;
        }
        // findByQuery falls back to a name substring: only the exact id counts.
        if (found && String(found.noradId) === entry.value) {
          result = {
            noradId: found.noradId,
            name: typeof found.name === 'string' ? found.name : null,
            latitude: found.latitude,
            longitude: found.longitude,
            altitudeM: finite(found.altitudeM),
          };
        }
      }
      return { norad: entry.value, enabled, ready, result, atMs: nowMs };
    });
    afterEngine(engine.setSatellites(rows, nowMs), nowMs, { render: false });
  }

  // -------------------------------------------------------------------------
  // Document
  // -------------------------------------------------------------------------

  function persist(nowMs) {
    const result = writeStoredWatchDocument(doc, store, {
      readError: readError?.code ?? null,
    });
    counters.writes += 1;
    lastWriteAtMs = nowMs;
    lastSeenDirty = false;
    writeError = result.ok ? null : result.reason;
  }

  /** Adopts a new document, saves it (unless told not to) and re-plans reads. */
  function commit(next, { save = true } = {}) {
    doc = next;
    engine.setDocument(doc);
    for (const zoneId of [...briefs.keys()]) {
      if (!doc.zones.some((zone) => zone.id === zoneId)) briefs.delete(zoneId);
    }
    if (save) persist(now());
    refreshNeeds();
  }

  /** Logs events, shows one alert pop-up and writes engine-side changes back. */
  function afterEngine(events, nowMs, { render: draw = true } = {}) {
    if (destroyed) return;
    const list = Array.isArray(events) ? events : [];
    if (list.length) {
      log.add(list, { nowMs });
      toastFor(list, nowMs);
    }
    let next = doc;
    for (const { entryId, code } of engine.declinedUpdates()) {
      const result = markDeclined(next, entryId, code);
      if (result.ok) next = result.doc;
    }
    if (next !== doc) commit(next);
    let seen = doc;
    for (const { entryId, lastSeen } of engine.lastSeenUpdates()) {
      const result = setLastSeen(seen, entryId, lastSeen);
      if (result.ok) seen = result.doc;
    }
    if (seen !== doc) {
      // The engine already holds these fixes; only storage lags behind.
      doc = seen;
      lastSeenDirty = true;
    }
    if (
      lastSeenDirty &&
      (lastWriteAtMs === null ||
        nowMs - lastWriteAtMs >= WATCH_LAST_SEEN_WRITE_MS)
    ) {
      persist(nowMs);
    }
    if (draw) render(nowMs);
  }

  function zoneName(zoneId) {
    return doc.zones.find((zone) => zone.id === zoneId)?.name ?? null;
  }

  function showText(text) {
    if (destroyed || typeof notify !== 'function' || !text) return;
    try {
      notify(text);
    } catch {
      // A toast is best effort.
    }
  }

  function toastFor(events, nowMs) {
    if (doc.prefs?.toasts === false) return;
    const alert = events.find((event) => event?.severity === 'alert');
    if (!alert) return;
    if (lastToastAtMs !== null && nowMs - lastToastAtMs < WATCH_TOAST_GAP_MS) {
      return;
    }
    lastToastAtMs = nowMs;
    counters.toasts += 1;
    showText(
      describeWatchEvent(alert, { zoneName: zoneName(alert.zoneId), nowMs })
        .text,
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function annotationRecords() {
    try {
      const records = annotations?.list?.();
      return Array.isArray(records) ? records.filter(isRecord) : [];
    } catch {
      return [];
    }
  }

  function annotationModel() {
    return annotationRecords()
      .filter(
        (record) =>
          record.id !== null &&
          record.id !== undefined &&
          (record.type === 'pin' ||
            (record.type === 'area' &&
              Array.isArray(record.ring) &&
              record.ring.length >= 3)),
      )
      .map((record) => ({
        id: String(record.id),
        type: record.type,
        label:
          typeof record.label === 'string' && record.label.trim()
            ? record.label
            : null,
      }));
  }

  function selectionModel() {
    if (!selection) return null;
    const { kind, match, value, label } = selection;
    return {
      kind,
      match,
      value,
      label,
      watched: doc.watchlist.some(
        (entry) => entry.match === match && entry.value === value,
      ),
      zoneable:
        (kind === 'aircraft' || kind === 'vessel') &&
        selection.position !== null,
    };
  }

  function render(nowMs = now()) {
    if (destroyed) return;
    const view = engine.view(nowMs);
    panel?.update({
      visible: isVisible(),
      nowMs,
      view,
      doc,
      inbox: {
        rows: log.list({ limit: INBOX_ROWS }),
        alertRows: log.list({ minSeverity: 'alert', limit: INBOX_ROWS }),
        unread: log.unreadCount(),
      },
      selection: selectionModel(),
      annotations: annotationModel(),
      briefs: Object.fromEntries(briefs),
      readError: readError ? { ...readError } : null,
      writeError,
      notices: { ...notices },
    });
    renderer?.sync(view.zones);
    renderer?.setVisible(doc.prefs?.zonesVisible !== false);
    syncToggle();
  }

  // -------------------------------------------------------------------------
  // Navigation (literal nouns only: see navigationPolicyFrame.test.mjs)
  // -------------------------------------------------------------------------

  const canNavigate = () =>
    typeof navigation?.runImmediateNavigation === 'function';

  /**
   * Follows a live aircraft (military first). null when no aircraft layer
   * holds it, else whether the navigation ran.
   */
  function focusAircraft(icao24) {
    if (typeof icao24 !== 'string' || !icao24 || !canNavigate()) return null;
    const id = icao24.toLowerCase();
    for (const layerId of AIRCRAFT_LAYERS) {
      const module = liveModule(layerId);
      if (typeof module?.trackById !== 'function') continue;
      if (module.hasContact?.(id) !== true) continue;
      return (
        navigation.runImmediateNavigation('aircraft', () =>
          module.trackById(id, { origin: 'user' }),
        ) === true
      );
    }
    return null;
  }

  /** The live ICAO24 that reports exactly this callsign, or null. */
  function aircraftByCallsign(callsign) {
    for (const layerId of AIRCRAFT_LAYERS) {
      let found = null;
      try {
        found = liveModule(layerId)?.findByQuery?.(callsign) ?? null;
      } catch {
        found = null;
      }
      // findByQuery also matches prefixes and registrations.
      if (found && normalizeCallsign(found.callsign) === callsign) {
        return typeof found.icao24 === 'string' ? found.icao24 : null;
      }
    }
    return null;
  }

  /** The live vessel record with exactly this MMSI, or null. */
  function vesselByMmsi(mmsi) {
    let found = null;
    try {
      found = liveModule(VESSEL_LAYER)?.findByQuery?.(mmsi) ?? null;
    } catch {
      found = null;
    }
    // findByQuery falls back to a vessel-name substring.
    return found && String(found.mmsi) === mmsi ? found : null;
  }

  function focusVessel(mmsi) {
    if (typeof mmsi !== 'string' || !mmsi) return null;
    const found = vesselByMmsi(mmsi);
    if (!found?.position) return null;
    try {
      liveModule(VESSEL_LAYER)?.selectById?.(mmsi);
    } catch {
      // Selection is a highlight; the focus below still runs.
    }
    return (
      requestWorldFocus(
        {
          kind: 'vessel',
          id: mmsi,
          label: found.name || mmsi,
          position: found.position,
        },
        windowRef,
      ) === true
    );
  }

  function focusSatellite(norad) {
    if (!canNavigate()) return null;
    const module = liveModule(SATELLITE_LAYER);
    let found = null;
    try {
      found = module?.findByQuery?.(norad) ?? null;
    } catch {
      found = null;
    }
    if (!found || String(found.noradId) !== norad) return null;
    return (
      navigation.runImmediateNavigation('satellite', () =>
        module.trackById(norad, { origin: 'user' }),
      ) === true
    );
  }

  function focusFire(row) {
    const at = point(row.position?.lat, row.position?.lon);
    if (!at) return null;
    return (
      requestWorldFocus(
        {
          kind: 'fire',
          id: row.assetKey ?? row.id,
          label: t('FIRE'),
          position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat),
        },
        windowRef,
      ) === true
    );
  }

  function flyToBox(box) {
    if (!box || !canNavigate() || typeof viewer?.camera?.flyTo !== 'function') {
      return null;
    }
    const destination = Cesium.Rectangle.fromDegrees(
      box.west,
      box.south,
      box.east,
      box.north,
    );
    return (
      navigation.runImmediateNavigation('location', () => {
        viewer.camera.flyTo({ destination });
        return true;
      }) === true
    );
  }

  function flyToPoint(at, halfKm) {
    const target = point(at?.lat, at?.lon);
    return target ? flyToBox(boxAround(target, halfKm)) : null;
  }

  function flyToZone(zoneId) {
    const zone = doc.zones.find((item) => item.id === zoneId);
    return zone ? flyToBox(zoneBox(zone)) : null;
  }

  /** The live asset first, then where the event happened, then its zone. */
  function focusEvent(row) {
    let result = null;
    if (row.kind === 'aircraft') result = focusAircraft(row.assetKey);
    else if (row.kind === 'vessel') result = focusVessel(row.assetKey);
    else if (row.kind === 'fire') result = focusFire(row);
    if (result !== null) return result;
    if (row.position) {
      result = flyToPoint(
        row.position,
        row.kind === 'quake' ? POINT_VIEW_KM.quake : POINT_VIEW_KM.asset,
      );
      if (result !== null) return result;
    }
    return row.zoneId ? flyToZone(row.zoneId) : null;
  }

  function focusEntry(entryId) {
    const entry = doc.watchlist.find((item) => item.id === entryId);
    if (!entry) return 'not-found';
    let result = null;
    if (entry.match === 'icao24') result = focusAircraft(entry.value);
    else if (entry.match === 'callsign') {
      result = focusAircraft(aircraftByCallsign(entry.value));
    } else if (entry.match === 'mmsi') result = focusVessel(entry.value);
    else if (entry.match === 'norad') result = focusSatellite(entry.value);
    if (result === null) {
      const row = engine
        .view(now())
        .watchlist.find((item) => item.entryId === entryId);
      result = flyToPoint(row?.fix ?? row?.lastSeen, POINT_VIEW_KM.asset);
    }
    return result === null ? 'no-position' : null;
  }

  function focusEmergency(key) {
    const item = engine
      .view(now())
      .emergencies.find((emergency) => emergency.key === key);
    if (!item) return;
    if (focusAircraft(item.icao24 ?? item.key) !== null) return;
    flyToPoint(item, POINT_VIEW_KM.asset);
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  function onSelected(event) {
    const detail = event?.detail;
    const entry = watchEntryFromSelection(detail);
    selection = entry
      ? {
          ...entry,
          layerId: detail.layerId,
          position: selectionPosition(detail),
        }
      : null;
    if (isVisible()) render();
  }

  function onCleared(event) {
    if (!selection) return;
    const layerId = event?.detail?.layerId;
    if (layerId && layerId !== selection.layerId) return;
    selection = null;
    if (isVisible()) render();
  }

  /** The selected asset's current position (re-read live), else its last. */
  function selectionNow() {
    if (!selection) return null;
    if (selection.kind === 'vessel') {
      const found = vesselByMmsi(selection.value);
      const live = found ? point(found.latitude, found.longitude) : null;
      if (live) return live;
    } else if (selection.kind === 'aircraft') {
      for (const layerId of AIRCRAFT_LAYERS) {
        let found = null;
        try {
          found = liveModule(layerId)?.findByQuery?.(selection.value) ?? null;
        } catch {
          found = null;
        }
        if (String(found?.icao24 ?? '').toLowerCase() === selection.value) {
          const live = point(found.latitude, found.longitude);
          if (live) return live;
        }
      }
    }
    return selection.position;
  }

  /** The point under the middle of the view, else the camera's nadir. */
  function viewCentre() {
    const camera = viewer?.camera;
    try {
      const canvas = viewer?.scene?.canvas;
      const width = canvas?.clientWidth;
      const height = canvas?.clientHeight;
      if (width > 0 && height > 0 && camera?.pickEllipsoid) {
        const hit = camera.pickEllipsoid(
          new Cesium.Cartesian2(width / 2, height / 2),
          viewer.scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
        );
        if (hit) {
          const centre = fromCartographic(
            Cesium.Cartographic.fromCartesian(hit),
          );
          if (centre) return centre;
        }
      }
      return fromCartographic(camera?.positionCartographic);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function nextZoneName() {
    const names = new Set(doc.zones.map((zone) => zone.name));
    let index = doc.zones.length + 1;
    while (names.has(defaultZoneName({ index }))) index += 1;
    return defaultZoneName({ index });
  }

  function addBuiltZone(built) {
    if (!built.ok) return built.code;
    const added = addZone(doc, built.zone);
    if (!added.ok) return added.code;
    commit(added.doc);
    return null;
  }

  function addCircle(centre, radiusKm, defaultName) {
    if (!centre) return 'no-position';
    const radius = finite(radiusKm);
    if (radius === null) return 'bad-radius';
    return addBuiltZone(
      createCircleZone(
        { center: centre, radiusM: radius * 1000 },
        { nowMs: now(), makeId, defaultName },
      ),
    );
  }

  function addWatch(input) {
    const result = addWatchEntry(doc, input, { nowMs: now(), makeId });
    if (!result.ok) return result.code;
    commit(result.doc);
    if (result.entry.kind === 'satellite') pollSatellites(now());
    return null;
  }

  function changeZone(zoneId, patch) {
    const zone = doc.zones.find((item) => item.id === zoneId);
    if (!zone) return 'not-found';
    const updated = updateZone(zone, patch, { nowMs: now() });
    if (!updated.ok) return updated.code;
    if (updated.zone === zone) return null;
    const replaced = replaceZone(doc, updated.zone);
    if (!replaced.ok) return replaced.code;
    if (updated.geometryChanged) briefs.delete(zoneId);
    commit(replaced.doc);
    return null;
  }

  function copyText(text) {
    const target = clipboard ?? windowRef?.navigator?.clipboard ?? null;
    if (typeof text !== 'string' || !text) return;
    if (typeof target?.writeText !== 'function') {
      showText(t('Copy failed'));
      return;
    }
    Promise.resolve()
      .then(() => target.writeText(text))
      .then(
        () => showText(t('Brief copied')),
        () => showText(t('Copy failed')),
      );
  }

  /** Runs one panel action; returns an error code for the notices, or null. */
  function run(action) {
    switch (action.type) {
      case 'inbox-mark-all-read':
        log.markRead('all');
        return null;
      case 'inbox-clear':
        log.clear();
        return null;
      case 'focus-event': {
        const row = log
          .list({ limit: Infinity })
          .find((item) => item.id === action.eventId);
        if (!row) return null;
        log.markRead(row.id);
        focusEvent(row);
        return null;
      }
      case 'focus-emergency':
        focusEmergency(action.key);
        return null;
      case 'watch-add-selection':
        if (!selection) return 'no-selection';
        return addWatch({
          match: selection.match,
          value: selection.value,
          label: selection.label,
        });
      case 'watch-add-id':
        return addWatch({ match: action.match, value: action.value });
      case 'watch-focus':
        return focusEntry(action.entryId);
      case 'watch-remove': {
        const removed = removeWatchEntry(doc, action.entryId);
        if (!removed.ok) return removed.code;
        commit(removed.doc);
        return null;
      }
      case 'zone-add-view':
        return addCircle(viewCentre(), action.radiusKm, nextZoneName());
      case 'zone-add-selection': {
        if (!selection) return 'no-selection';
        if (selection.kind !== 'aircraft' && selection.kind !== 'vessel') {
          return 'no-position';
        }
        return addCircle(
          selectionNow(),
          action.radiusKm,
          defaultZoneName({ label: selection.label ?? selection.value }),
        );
      }
      case 'zone-add-annotation': {
        const record = annotationRecords().find(
          (item) => String(item.id) === action.annotationId,
        );
        if (!record) return 'not-found';
        return addBuiltZone(
          zoneFromAnnotation(record, {
            nowMs: now(),
            makeId,
            defaultName: nextZoneName(),
          }),
        );
      }
      case 'zone-update':
        return changeZone(action.zoneId, action.patch);
      case 'zone-rename':
        return changeZone(action.zoneId, { name: action.name });
      case 'zone-fly':
        flyToZone(action.zoneId);
        return null;
      case 'zone-brief': {
        const brief = engine.brief(action.zoneId, {
          nowMs: now(),
          recentEvents: log.list({
            zoneId: action.zoneId,
            limit: BRIEF_EVENTS,
          }),
        });
        if (brief) briefs.set(action.zoneId, brief);
        return null;
      }
      case 'zone-brief-clear':
        briefs.delete(action.zoneId);
        return null;
      case 'zone-brief-copy':
        copyText(action.text);
        return null;
      case 'zone-delete': {
        const removed = removeZone(doc, action.zoneId);
        if (!removed.ok) return removed.code;
        briefs.delete(action.zoneId);
        commit(removed.doc);
        return null;
      }
      case 'layer-enable':
        if (ENABLEABLE_LAYERS.includes(action.layerId)) {
          Promise.resolve()
            .then(() =>
              dataManager?.setEnabled?.(action.layerId, true, {
                origin: 'user',
              }),
            )
            .catch(() => {});
        }
        return null;
      case 'prefs': {
        const result = setPrefs(doc, action.patch);
        if (result.ok && result.doc !== doc) commit(result.doc);
        return null;
      }
      case 'storage-keep':
        readError = null;
        persist(now());
        return null;
      case 'storage-reset':
        readError = null;
        briefs.clear();
        commit(emptyWatchDocument());
        return null;
      default:
        return null;
    }
  }

  function handleAction(action) {
    if (destroyed || !isRecord(action) || typeof action.type !== 'string') {
      return;
    }
    // Using the panel keeps it on screen even once the document is empty.
    opened = true;
    const isWatch = WATCH_ACTIONS.has(action.type);
    const isZone = ZONE_ACTIONS.has(action.type);
    if (isWatch) notices.watch = null;
    if (isZone) notices.zones = null;
    let code = null;
    try {
      code = run(action);
    } catch (error) {
      counters.errors += 1;
      console.warn(`[Watch] ${action.type} failed:`, error);
    }
    if (code && isWatch) notices.watch = code;
    if (code && isZone) notices.zones = code;
    refreshNeeds();
    render();
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  function tick() {
    tickCancel = null;
    if (destroyed) return;
    const nowMs = now();
    if (isActive()) {
      pollSatellites(nowMs);
      afterEngine(engine.tick(nowMs), nowMs);
    } else if (isVisible()) {
      render(nowMs);
    }
    tickCancel = later(tick, WATCH_TICK_MS);
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  const panel = createPanel({
    container: body,
    panel: panelElement,
    countBadge: documentRef.getElementById('watch-panel-count'),
    onAction: handleAction,
    now,
    schedule: schedule ? (callback, ms) => later(callback, ms) : undefined,
  });
  const renderer = viewer?.scene
    ? createRenderer({ viewer, overlayHost, requestRender })
    : null;

  lifetime.listen(toggle, 'click', () => {
    if (destroyed) return;
    if (expanded()) {
      collapseButton()?.click();
      if (isEmptyWatchDocument(doc)) opened = false;
    } else {
      opened = true;
      // Unhide first; the panel chrome then expands it (weatherPanel.js).
      render();
      if (panelElement.classList?.contains('collapsed')) {
        collapseButton()?.click();
      }
    }
    refreshNeeds();
    render();
  });
  // Drawn shapes have no change event: refresh them when the panel is used.
  for (const type of ['pointerenter', 'focusin']) {
    lifetime.listen(panelElement, type, () => {
      if (isVisible()) render();
    });
  }
  for (const type of SELECT_EVENTS)
    lifetime.listen(windowRef, type, onSelected);
  for (const type of CLEAR_EVENTS) lifetime.listen(windowRef, type, onCleared);

  const Observer = windowRef?.MutationObserver;
  let observer = null;
  if (typeof Observer === 'function') {
    // The panel chrome collapses and expands the panel on its own (header
    // button, Escape, Cockpit entry): keep the toggle and the reads in step.
    observer = new Observer(() => {
      if (destroyed) return;
      syncToggle();
      refreshNeeds();
    });
    observer.observe(panelElement, {
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
  }

  let unsubscribe = null;
  try {
    unsubscribe =
      dataManager?.subscribe?.((change) => {
        if (destroyed || !isRecord(change)) return;
        if (!Object.hasOwn(WATCH_SOURCES, change.layerId)) return;
        if (
          change.type !== 'refresh' &&
          change.type !== 'refresh-failed' &&
          change.type !== 'visibility'
        ) {
          return;
        }
        queue(change.layerId);
      }) ?? null;
  } catch {
    unsubscribe = null;
  }

  const unregisterUnsavedWork = registerUnsavedWork(() =>
    !destroyed && log.size() ? msg('the watch event history') : null,
  );

  function diagnostics() {
    return {
      destroyed,
      active: isActive(),
      visible: isVisible(),
      opened,
      neededLayers: [...needed],
      pending: [...pending.keys()],
      reads: { ...counters.reads },
      frames: { ...counters.frames },
      toasts: counters.toasts,
      writes: counters.writes,
      errors: counters.errors,
      readError: readError?.code ?? null,
      writeError,
      log: {
        size: log.size(),
        unread: log.unreadCount(),
        suppressed: log.suppressedCount(),
      },
      renderer: renderer?.diagnostics?.() ?? null,
      engine: engine.diagnostics(),
    };
  }

  // The live gate's handle (scripts/qa-watch.mjs). `injectFrame` takes
  // buildFrame input with plain `rows` and exists in development builds only.
  const handle = {
    view: () => engine.view(now()),
    diagnostics,
  };
  if (import.meta.env?.DEV === true) {
    handle.injectFrame = (input) => {
      if (destroyed || !isRecord(input)) return [];
      const nowMs = finite(input.nowMs) ?? now();
      const rows = Array.isArray(input.rows) ? input.rows : [];
      const events = engine.ingest(
        buildFrame({ ...input, nowMs, readRows: () => rows }),
      );
      afterEngine(events, nowMs);
      return events;
    };
  }
  if (windowRef) windowRef.__gevWatch = handle;

  refreshNeeds();
  if (isActive()) pollSatellites(now());
  render();
  tickCancel = later(tick, WATCH_TICK_MS);

  return {
    destroy() {
      if (destroyed) return;
      // Keep the latest last-seen fixes that were waiting for the throttle.
      if (lastSeenDirty) persist(now());
      destroyed = true;
      tickCancel?.();
      for (const cancel of [...cancels]) cancel();
      cancels.clear();
      pending.clear();
      try {
        unsubscribe?.();
      } catch {
        // The manager may already be gone.
      }
      observer?.disconnect?.();
      lifetime.destroy();
      unregisterUnsavedWork();
      panel?.destroy();
      renderer?.destroy();
      syncToggle();
      if (windowRef?.__gevWatch === handle) delete windowRef.__gevWatch;
    },
    diagnostics,
  };
}
