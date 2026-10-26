/**
 * Watch zones on the globe: one draped outline per zone, coloured by what
 * the zone can answer right now, and a display-only overlay label with the
 * zone's name and a short count per kind.
 *
 * Every outline lives in one GroundPolylinePrimitive (no fill, no picking),
 * rebuilt only when a zone's outline or colour changes and swapped
 * synchronously, so the globe never shows a gap between the old and the new
 * set. Labels go through the world-overlay host (Cesium labels are not
 * used) and are republished only when their text changes. Clicking a label
 * does nothing in v1: the overlay host's `interactive` flag only feeds the
 * assistive mirror.
 */
import * as Cesium from 'cesium';
import { zoneLabelDetails } from '../ui/watchWording.js';

/** World-overlay source that owns the zone labels. */
export const WATCH_OVERLAY_SOURCE_ID = 'watch-zones';

/**
 * Outline and label colour per zone state: counted (every kind answers
 * fully), partial (a floor or held answer), unknown (an unknown or off
 * answer) and alert (a recent alert, or a confirmed emergency inside).
 */
export const WATCH_ZONE_STATE_COLORS = Object.freeze({
  counted: '#00d4ff',
  partial: '#f0b23e',
  unknown: '#8a96a3',
  alert: '#FF4444',
});

const LINE_WIDTH_PX = 2;
const LABEL_LIMIT = 24;
const LABEL_PRIORITY_TOP = 20_000;
const RENDER_REASON = 'watch-zones';

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A zone's outline state, in this precedence: alert, then unknown or off,
 * then floor or held, then counted. A zone that watches nothing (or an
 * answer the renderer does not know) reads unknown.
 *
 * @param {object} zoneView A WatchView zone.
 * @returns {'alert'|'unknown'|'partial'|'counted'}
 */
export function zoneOutlineState(zoneView) {
  const zone = isRecord(zoneView) ? zoneView : {};
  if (zone.alert === true) return 'alert';
  const kinds = Array.isArray(zone.kinds) ? zone.kinds : [];
  const perKind = isRecord(zone.perKind) ? zone.perKind : {};
  const answers = kinds.map((kind) => perKind[kind]?.answer ?? 'unknown');
  if (
    !answers.length ||
    answers.some((a) => !['counted', 'floor', 'held'].includes(a))
  ) {
    return 'unknown';
  }
  if (answers.some((a) => a === 'floor' || a === 'held')) return 'partial';
  return 'counted';
}

/** The closed `[lon, lat]` ring as a flat degree array, or null. */
function outlineDegrees(outline) {
  if (!Array.isArray(outline) || outline.length < 3) return null;
  const flat = [];
  for (const point of outline) {
    const lon = finite(point?.[0]);
    const lat = finite(point?.[1]);
    if (lon === null || lat === null) return null;
    flat.push(lon, lat);
  }
  return flat;
}

/**
 * Creates the zone renderer.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium viewer; outlines go into
 *   `viewer.scene.groundPrimitives`.
 * @param {{setEntries: Function, setVisible: Function,
 *   clearSource: Function}|null} [options.overlayHost] The app's world-overlay
 *   facade (src/app/layers/overlayHost.js).
 * @param {(reason: string) => void} [options.requestRender]
 * @param {() => Promise<unknown>} [options.terrainReady] Resolves once
 *   synchronous ground polylines can be built (Cesium's one-time terrain
 *   height table). Outlines wait for it; labels do not.
 * @returns {{sync: (zoneViews: object[]) => void,
 *   setVisible: (visible: boolean) => void, destroy: () => void,
 *   diagnostics: () => object}}
 */
export function createWatchZoneRenderer({
  viewer,
  overlayHost = null,
  requestRender = null,
  terrainReady = () =>
    Cesium.GroundPolylinePrimitive.initializeTerrainHeights(),
} = {}) {
  let destroyed = false;
  let visible = true;
  let views = [];
  let primitive = null;
  let shownSignature = null;
  let labelKey = null;
  let terrain = null;
  let terrainOk = false;
  let builds = 0;
  let labelPublishes = 0;

  const render = () => {
    try {
      requestRender?.(RENDER_REASON);
    } catch {
      // Rendering is best effort.
    }
  };
  const groundPrimitives = () => viewer?.scene?.groundPrimitives ?? null;

  function ensureTerrain() {
    if (terrainOk) return true;
    if (!terrain) {
      terrain = Promise.resolve()
        .then(() => terrainReady())
        .then(
          () => {
            terrainOk = true;
            if (!destroyed) syncOutlines();
          },
          () => {
            // Try again on the next sync.
            terrain = null;
          },
        );
    }
    return false;
  }

  function outlineItems() {
    const items = [];
    for (const view of views) {
      const degrees = outlineDegrees(view?.outline);
      if (!degrees) continue;
      const state = zoneOutlineState(view);
      items.push({ id: String(view.id), state, degrees });
    }
    return items;
  }

  function signatureOf(items) {
    return items
      .map(
        ({ id, state, degrees }) =>
          `${id}|${state}|${degrees.map((v) => v.toFixed(6)).join(',')}`,
      )
      .join(';');
  }

  function buildPrimitive(items) {
    const instances = [];
    for (const { id, state, degrees } of items) {
      let positions;
      try {
        positions = Cesium.Cartesian3.fromDegreesArray(degrees);
      } catch {
        continue;
      }
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions,
            width: LINE_WIDTH_PX,
          }),
          id: `watch-zone:${id}`,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(WATCH_ZONE_STATE_COLORS[state]),
            ),
          },
        }),
      );
    }
    if (!instances.length) return null;
    return new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance(),
      classificationType: Cesium.ClassificationType.BOTH,
      asynchronous: false,
      allowPicking: false,
    });
  }

  function syncOutlines() {
    const collection = groundPrimitives();
    if (destroyed || !collection) return;
    const items = outlineItems();
    const signature = signatureOf(items);
    if (signature === shownSignature) return;
    if (!ensureTerrain()) return;
    // Build and add the new set before removing the old one.
    const next = items.length ? buildPrimitive(items) : null;
    if (next) {
      next.show = visible;
      collection.add(next);
    }
    if (primitive) {
      try {
        collection.remove(primitive);
      } catch {
        // Already gone with the scene.
      }
    }
    primitive = next;
    shownSignature = signature;
    builds += 1;
    render();
  }

  function syncLabels() {
    if (destroyed || !overlayHost) return;
    const entries = [];
    const keyParts = [];
    for (const [index, view] of views.slice(0, LABEL_LIMIT).entries()) {
      const lat = finite(view?.labelAnchor?.lat);
      const lon = finite(view?.labelAnchor?.lon);
      if (lat === null || lon === null) continue;
      const id = `watch-zone:${view.id}`;
      // Zone names are the person's own text: never translated.
      const title = typeof view.name === 'string' ? view.name : '';
      const details = zoneLabelDetails(view);
      const accent = WATCH_ZONE_STATE_COLORS[zoneOutlineState(view)];
      keyParts.push([id, title, details, accent, lat, lon]);
      entries.push({
        id,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        // A card, not a label: the label variant paints its title only, so
        // the count line would leave an empty box.
        variant: 'card',
        title,
        details,
        accent,
        priority: LABEL_PRIORITY_TOP - index,
        collisionGroup: 'ambient-card',
        paintLane: 'ambient-card',
        interactive: false,
      });
    }
    const key = JSON.stringify(keyParts);
    // Nothing to show and nothing shown yet: leave the source unregistered.
    if (key === labelKey || (labelKey === null && !entries.length)) return;
    labelKey = key;
    labelPublishes += 1;
    overlayHost.setEntries?.(WATCH_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      collisionCapacity: LABEL_LIMIT,
      moving: false,
    });
    render();
  }

  return {
    /** @param {object[]} zoneViews WatchView `zones`. */
    sync(zoneViews) {
      if (destroyed) return;
      views = Array.isArray(zoneViews) ? zoneViews.filter(isRecord) : [];
      syncOutlines();
      syncLabels();
    },
    /** Shows or hides every outline and label (prefs.zonesVisible). */
    setVisible(next) {
      if (destroyed) return;
      const value = next !== false;
      if (value === visible) return;
      visible = value;
      if (primitive) primitive.show = visible;
      overlayHost?.setVisible?.(WATCH_OVERLAY_SOURCE_ID, visible);
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (primitive) {
        try {
          groundPrimitives()?.remove(primitive);
        } catch {
          // Already gone with the scene.
        }
      }
      primitive = null;
      overlayHost?.clearSource?.(WATCH_OVERLAY_SOURCE_ID);
      render();
    },
    diagnostics() {
      return {
        zones: views.length,
        drawn: primitive ? 1 : 0,
        builds,
        labelPublishes,
        terrainReady: terrainOk,
        visible,
      };
    },
  };
}
