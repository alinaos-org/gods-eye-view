/**
 * Session-only watch inbox: an in-memory log of WatchEvents with dedupe, a
 * per-zone rate cap, unread bookkeeping and oldest-first eviction.
 *
 * Portable and pure: no imports, no clock, no randomness, no storage. The
 * caller passes `nowMs` to `add`; when it is missing, each event's own `atMs`
 * is the clock. Inputs are never mutated: rows are JSON-safe copies, and every
 * read returns fresh copies.
 *
 * Rules:
 * - Dedupe: an event whose `dedupeKey` matches a row last touched at most
 *   `dedupeMs` earlier merges into that row. `repeat` grows by 1; `seq`,
 *   `atMs`, `dataAtMs`, `params` and `caveats` take the new event's values,
 *   and `position` and `assetLabel` do so when the new event carries them;
 *   `severity` keeps the higher rank; `watchlisted` stays true once set; the
 *   row becomes unread again and moves to the newest end. `id`, `firstAtMs`
 *   and the identity fields stay. The window slides: each merge restarts it.
 * - Rate cap: at most `zoneMax` new rows per zone within `zoneWindowMs`.
 *   Further new rows for that zone are suppressed and counted per zone.
 *   Alerts and watchlisted events are exempt from the cap (they neither
 *   consume nor respect it) but not from dedupe. Merges never count against
 *   the cap, and events without a zone are never capped.
 * - `unreadCount` counts unread notice and alert rows only.
 * - Past `capacity` rows, the least recently touched rows are evicted first.
 * - Malformed events (not an object, no string `type`, or no finite `atMs`)
 *   are rejected and counted, never stored.
 */

/**
 * Inbox limits: `capacity` rows in total, a `dedupeMs` merge window, and at
 * most `zoneMax` new rows per zone in any `zoneWindowMs`.
 * @type {Readonly<{capacity: number, dedupeMs: number, zoneWindowMs: number,
 *   zoneMax: number}>}
 */
export const EVENT_LOG_POLICY = Object.freeze({
  capacity: 500,
  dedupeMs: 300_000,
  zoneWindowMs: 600_000,
  zoneMax: 30,
});

/**
 * Severity order used by `list({minSeverity})` and dedupe escalation.
 * @type {Readonly<{info: 0, notice: 1, alert: 2}>}
 */
export const SEVERITY_RANK = Object.freeze({ info: 0, notice: 1, alert: 2 });

/**
 * @typedef {Object} WatchEventLike
 * @property {string} [id]
 * @property {number|null} [seq]
 * @property {string} type
 * @property {'info'|'notice'|'alert'} [severity]
 * @property {number} atMs
 * @property {number|null} [dataAtMs]
 * @property {string|null} [zoneId]
 * @property {string|null} [assetKey]
 * @property {string|null} [kind]
 * @property {string|number|null} [assetId]
 * @property {string|null} [assetLabel]
 * @property {string|null} [layerId]
 * @property {{lat: number, lon: number}|null} [position]
 * @property {Object} [params]
 * @property {string[]} [caveats]
 * @property {boolean} [watchlisted]
 * @property {string|null} [dedupeKey]
 */

/**
 * A stored inbox row: the WatchEvent fields plus log bookkeeping.
 * @typedef {Object} LogRow
 * @property {string} id
 * @property {number|null} seq
 * @property {string} type
 * @property {'info'|'notice'|'alert'} severity
 * @property {number} atMs Time of the latest merged occurrence.
 * @property {number|null} dataAtMs
 * @property {string|null} zoneId
 * @property {string|null} assetKey
 * @property {string|null} kind
 * @property {string|number|null} assetId
 * @property {string|null} assetLabel
 * @property {string|null} layerId
 * @property {{lat: number, lon: number}|null} position
 * @property {Object} params
 * @property {string[]} caveats
 * @property {boolean} watchlisted
 * @property {string|null} dedupeKey
 * @property {number} repeat Occurrences merged into this row (1 when new).
 * @property {number} firstAtMs `atMs` of the first occurrence.
 * @property {boolean} read
 */

/**
 * @typedef {Object} AddResult
 * @property {number} accepted New rows created.
 * @property {number} merged Events merged into an existing row.
 * @property {number} suppressed Events dropped by the per-zone rate cap.
 * @property {number} rejected Malformed events that were not stored.
 * @property {number} evicted Old rows removed to stay within `capacity`.
 */

/**
 * @typedef {Object} WatchEventLog
 * @property {(events: WatchEventLike[]|WatchEventLike,
 *   options?: {nowMs?: number}) => AddResult} add
 * @property {(options?: {minSeverity?: string, zoneId?: string|null,
 *   limit?: number}) => LogRow[]} list Newest first.
 * @property {(id: string) => number} markRead A row id, or 'all'; returns the
 *   number of rows that changed from unread to read.
 * @property {() => number} unreadCount
 * @property {(zoneId?: string|null) => number} suppressedCount One zone, or
 *   every zone when `zoneId` is null or omitted.
 * @property {() => void} clear
 * @property {() => number} size
 */

const SEVERITIES = Object.freeze(Object.keys(SEVERITY_RANK));
const DEFAULT_LIST_LIMIT = 50;
const MAX_CLONE_DEPTH = 8;

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function idOrNull(value) {
  if (typeof value === 'string' && value !== '') return value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function severityOf(value) {
  return SEVERITIES.includes(value) ? value : 'info';
}

function rankOf(severity) {
  return SEVERITY_RANK[severityOf(severity)];
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** JSON-safe deep copy: non-finite numbers and other values become null. */
function cloneJson(value, depth = 0) {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= MAX_CLONE_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = cloneJson(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

function positionOrNull(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = finiteOrNull(value.lat);
  const lon = finiteOrNull(value.lon);
  return lat === null || lon === null ? null : { lat, lon };
}

function caveatsOf(value) {
  return Array.isArray(value)
    ? value.filter((c) => typeof c === 'string' && c !== '')
    : [];
}

function paramsOf(value) {
  return isPlainObject(value) ? cloneJson(value) : {};
}

function isValidEvent(event) {
  return (
    event !== null &&
    typeof event === 'object' &&
    typeof event.type === 'string' &&
    event.type !== '' &&
    finiteOrNull(event.atMs) !== null
  );
}

function nonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function resolvePolicy(policy) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const capacity = nonNegative(p.capacity, EVENT_LOG_POLICY.capacity);
  const zoneMax = nonNegative(p.zoneMax, EVENT_LOG_POLICY.zoneMax);
  return Object.freeze({
    capacity: Math.max(1, Math.floor(capacity)),
    dedupeMs: nonNegative(p.dedupeMs, EVENT_LOG_POLICY.dedupeMs),
    zoneWindowMs: nonNegative(p.zoneWindowMs, EVENT_LOG_POLICY.zoneWindowMs),
    zoneMax: Math.floor(zoneMax),
  });
}

function copyRow(row) {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    severity: row.severity,
    atMs: row.atMs,
    dataAtMs: row.dataAtMs,
    zoneId: row.zoneId,
    assetKey: row.assetKey,
    kind: row.kind,
    assetId: row.assetId,
    assetLabel: row.assetLabel,
    layerId: row.layerId,
    position: row.position
      ? { lat: row.position.lat, lon: row.position.lon }
      : null,
    params: cloneJson(row.params),
    caveats: row.caveats.slice(),
    watchlisted: row.watchlisted,
    dedupeKey: row.dedupeKey,
    repeat: row.repeat,
    firstAtMs: row.firstAtMs,
    read: row.read,
  };
}

/**
 * Create a session-only watch event log.
 * @param {Partial<typeof EVENT_LOG_POLICY>} [policy] Overrides for
 *   `EVENT_LOG_POLICY`; invalid or missing values keep the defaults.
 * @returns {WatchEventLog}
 */
export function createWatchEventLog(policy) {
  const limits = resolvePolicy(policy);
  /** Rows ordered from least to most recently touched. */
  let rows = [];
  /** dedupeKey → row. */
  let byKey = new Map();
  /** row id → row. */
  let byId = new Map();
  /** zoneId → clock times of capped (non-exempt) new rows. */
  let zoneTimes = new Map();
  /** zoneId → suppressed event count. */
  let suppressedByZone = new Map();
  let idCounter = 0;

  function uniqueId(preferred) {
    let base = stringOrNull(preferred);
    if (base === null) {
      idCounter += 1;
      base = `log-${idCounter}`;
    }
    let id = base;
    while (byId.has(id)) {
      idCounter += 1;
      id = `${base}.${idCounter}`;
    }
    return id;
  }

  function touch(row) {
    const index = rows.indexOf(row);
    if (index >= 0) rows.splice(index, 1);
    rows.push(row);
  }

  function removeRow(row) {
    byId.delete(row.id);
    if (row.dedupeKey !== null && byKey.get(row.dedupeKey) === row) {
      byKey.delete(row.dedupeKey);
    }
  }

  function zoneCapped(zoneId, clockMs) {
    const times = (zoneTimes.get(zoneId) || []).filter(
      (t) => clockMs - t < limits.zoneWindowMs,
    );
    zoneTimes.set(zoneId, times);
    return times.length >= limits.zoneMax;
  }

  function mergeInto(row, event, clockMs) {
    row.repeat += 1;
    row.seq = finiteOrNull(event.seq);
    row.atMs = event.atMs;
    row.dataAtMs = finiteOrNull(event.dataAtMs);
    row.params = paramsOf(event.params);
    row.caveats = caveatsOf(event.caveats);
    const position = positionOrNull(event.position);
    if (position) row.position = position;
    const assetLabel = stringOrNull(event.assetLabel);
    if (assetLabel !== null) row.assetLabel = assetLabel;
    if (rankOf(event.severity) > rankOf(row.severity)) {
      row.severity = severityOf(event.severity);
    }
    row.watchlisted = row.watchlisted || event.watchlisted === true;
    row.read = false;
    row.touchedMs = clockMs;
    touch(row);
  }

  function createRow(event, clockMs) {
    const row = {
      id: uniqueId(event.id),
      seq: finiteOrNull(event.seq),
      type: event.type,
      severity: severityOf(event.severity),
      atMs: event.atMs,
      dataAtMs: finiteOrNull(event.dataAtMs),
      zoneId: stringOrNull(event.zoneId),
      assetKey: stringOrNull(event.assetKey),
      kind: stringOrNull(event.kind),
      assetId: idOrNull(event.assetId),
      assetLabel: stringOrNull(event.assetLabel),
      layerId: stringOrNull(event.layerId),
      position: positionOrNull(event.position),
      params: paramsOf(event.params),
      caveats: caveatsOf(event.caveats),
      watchlisted: event.watchlisted === true,
      dedupeKey: stringOrNull(event.dedupeKey),
      repeat: 1,
      firstAtMs: event.atMs,
      read: false,
      touchedMs: clockMs,
    };
    rows.push(row);
    byId.set(row.id, row);
    if (row.dedupeKey !== null) byKey.set(row.dedupeKey, row);
    return row;
  }

  function add(events, options = {}) {
    const result = {
      accepted: 0,
      merged: 0,
      suppressed: 0,
      rejected: 0,
      evicted: 0,
    };
    let list;
    if (Array.isArray(events)) list = events;
    else if (events && typeof events === 'object') list = [events];
    else list = [];
    const nowMs = finiteOrNull(options?.nowMs);
    for (const event of list) {
      if (!isValidEvent(event)) {
        result.rejected += 1;
        continue;
      }
      const clockMs = nowMs === null ? event.atMs : nowMs;
      const key = stringOrNull(event.dedupeKey);
      const existing = key === null ? null : byKey.get(key) || null;
      if (existing && clockMs - existing.touchedMs <= limits.dedupeMs) {
        mergeInto(existing, event, clockMs);
        result.merged += 1;
        continue;
      }
      const zoneId = stringOrNull(event.zoneId);
      const exempt =
        severityOf(event.severity) === 'alert' || event.watchlisted === true;
      if (zoneId !== null && !exempt) {
        if (zoneCapped(zoneId, clockMs)) {
          suppressedByZone.set(zoneId, (suppressedByZone.get(zoneId) || 0) + 1);
          result.suppressed += 1;
          continue;
        }
        zoneTimes.get(zoneId).push(clockMs);
      }
      createRow(event, clockMs);
      result.accepted += 1;
    }
    while (rows.length > limits.capacity) {
      removeRow(rows.shift());
      result.evicted += 1;
    }
    return result;
  }

  function list(options = {}) {
    const minRank = rankOf(options?.minSeverity);
    const zoneId = stringOrNull(options?.zoneId);
    const rawLimit = options?.limit;
    let limit = DEFAULT_LIST_LIMIT;
    if (rawLimit === Infinity) limit = rows.length;
    else if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
      limit = Math.max(0, Math.floor(rawLimit));
    }
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const row = rows[i];
      if (SEVERITY_RANK[row.severity] < minRank) continue;
      if (zoneId !== null && row.zoneId !== zoneId) continue;
      out.push(copyRow(row));
    }
    return out;
  }

  function markRead(id) {
    let changed = 0;
    const targets = id === 'all' ? rows : [byId.get(id)].filter(Boolean);
    for (const row of targets) {
      if (!row.read) {
        row.read = true;
        changed += 1;
      }
    }
    return changed;
  }

  function unreadCount() {
    let count = 0;
    for (const row of rows) {
      if (!row.read && SEVERITY_RANK[row.severity] >= SEVERITY_RANK.notice) {
        count += 1;
      }
    }
    return count;
  }

  function suppressedCount(zoneId = null) {
    const id = stringOrNull(zoneId);
    if (id !== null) return suppressedByZone.get(id) || 0;
    let total = 0;
    for (const count of suppressedByZone.values()) total += count;
    return total;
  }

  function clear() {
    rows = [];
    byKey = new Map();
    byId = new Map();
    zoneTimes = new Map();
    suppressedByZone = new Map();
  }

  function size() {
    return rows.length;
  }

  return { add, list, markRead, unreadCount, suppressedCount, clear, size };
}
