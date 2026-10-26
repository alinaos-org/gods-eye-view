/**
 * Emergency onset tracker for Watch.
 *
 * Follows aircraft broadcasting a transponder emergency (7500, 7600, 7700 or
 * the ADS-B emergency field) through observation frames from the flights
 * and military layers, and reports only what repeated, fresh observations
 * back. It reads the frames module's aircraft assets, which carry the
 * analyst emergency fields: `emergency` (true only for emergency severity,
 * so the priority statuses minfuel and lifeguard are never emergencies),
 * `emergencyKind`, `emergencySource` and `squawk`.
 *
 * Rules:
 * - Fresh observations only: an observation counts when it is a fresh fix
 *   for its layer (`isFreshFix`, so a record carried through a missed poll
 *   never counts twice) and a fresh fix against the aircraft's latest
 *   applied fix from any layer: a later receipt time (both layers stamp
 *   fixes with this browser's receipt time) and, when both carry one, a
 *   later upstream contact time, so one upstream message received by both
 *   layers counts once. An observation without a fix time can never be
 *   judged fresh and is ignored.
 * - Start: a candidate opens on the first fresh observation of an emergency
 *   kind. A later fresh observation of the same kind confirms it once there
 *   are `confirmPolls` observations spanning `minSpanMs` to `maxGapMs`
 *   (20 s to 5 min) from the first, measured between contact times when
 *   both observations carry one, else between receipt times; `sinceMs` is
 *   the first observation. A different kind, a span past `maxGapMs`, a
 *   fresh poll without the code or `maxGapMs` passing without confirmation
 *   abandon the candidate (counted as `transientIgnored`); a different kind
 *   or a late observation opens a new candidate at once.
 * - Change: a confirmed track that reports another emergency kind on
 *   `confirmPolls` consecutive fresh polls changes kind.
 * - End: `clearPolls` consecutive fresh polls without an emergency code. A
 *   priority status is not an emergency code.
 * - Unknown: when none of the layers that carried a confirmed track still
 *   reports it (each one is held, unknown or off, does not cover its last
 *   position, or no longer lists it), the track turns 'unknown' silently.
 *   Recovery while still broadcasting continues the track with no second
 *   start; recovery without the code ends it after `clearPolls` fresh polls
 *   with caveat 'unobserved-interval'.
 * - Unresolved: a confirmed track missing from `absentEpochs` new counted
 *   epochs of every layer that carried it, each covering its last position,
 *   gives `emergency-unresolved` and is dropped. Floor answers, uncovered
 *   positions and repeated epochs are never absence evidence.
 * - Forgetting: a track left 'unknown' with no fresh fix for
 *   `forgetUnknownMs` is dropped silently (counted as `forgotten`).
 * - Caveats: 'on-ground' when the fix behind a transition is on the ground
 *   (the caller lowers severity), 'code-may-be-in-error' for unlawful
 *   interference, 'unobserved-interval' as above.
 * - Capacity: at most `capacity` tracks, ended ones included (kept so their
 *   last fixes still judge freshness). Least-recently-used eviction removes
 *   ended and candidate tracks before confirmed ones.
 *
 * Only asset identifiers travel (ICAO24 key, display label, squawk): no
 * owner, operator or registrant fields.
 *
 * Pure module: no platform globals, timers, storage, clocks or randomness.
 * Every time comes in through the frames (`nowMs`, `epochMs`, fix times),
 * and outputs are JSON-safe with null for missing values.
 */
import { KIND_LAYERS, isFreshFix } from './frames.js';
import { coverageContainsPoint } from './geometry.js';

/**
 * Emergency tracker policy.
 *
 * - `confirmPolls`: fresh observations of one kind that confirm a start or
 *   a change.
 * - `minSpanMs` / `maxGapMs`: a start needs its confirming observation this
 *   long after the first (20 s to 5 min).
 * - `clearPolls`: consecutive fresh polls without the code that end a track.
 * - `absentEpochs`: new counted epochs missing from every carrying layer
 *   that make a track unresolved.
 * - `capacity`: most tracks kept, ended ones included.
 * - `forgetUnknownMs`: an 'unknown' track with no fresh fix for this long is
 *   dropped silently.
 *
 * @type {Readonly<{confirmPolls: number, minSpanMs: number,
 *   maxGapMs: number, clearPolls: number, absentEpochs: number,
 *   capacity: number, forgetUnknownMs: number}>}
 */
export const EMERGENCY_POLICY = Object.freeze({
  confirmPolls: 2,
  minSpanMs: 20_000,
  maxGapMs: 300_000,
  clearPolls: 2,
  absentEpochs: 3,
  capacity: 100,
  forgetUnknownMs: 3_600_000,
});

/** Transition types an emergency tracker reports. */
export const EMERGENCY_TRANSITION = Object.freeze({
  START: 'emergency-start',
  CHANGE: 'emergency-change',
  END: 'emergency-end',
  UNRESOLVED: 'emergency-unresolved',
});

/** Phases of a tracked emergency, as `active()` reports them. */
export const EMERGENCY_PHASE = Object.freeze({
  CANDIDATE: 'candidate',
  ACTIVE: 'active',
  CLEARING: 'clearing',
  UNKNOWN: 'unknown',
});

/**
 * Emergency kinds (severity 'emergency' in src/data/aircraftEmergency.js).
 */
export const EMERGENCY_KINDS = Object.freeze([
  'general',
  'unlawful',
  'nordo',
  'downed',
]);

/**
 * Priority kinds (severity 'priority'): never an emergency, so a poll that
 * reports one counts as a poll without the code.
 */
export const PRIORITY_KINDS = Object.freeze(['minfuel', 'lifeguard']);

/** The emergency kind each ICAO emergency squawk names. */
export const SQUAWK_EMERGENCY_KINDS = Object.freeze({
  7500: 'unlawful',
  7600: 'nordo',
  7700: 'general',
});

/** Caveat codes a transition can carry, in the order they are listed. */
export const EMERGENCY_CAVEATS = Object.freeze([
  'on-ground',
  'code-may-be-in-error',
  'unobserved-interval',
]);

/**
 * @typedef {{type: 'emergency-start'|'emergency-change'|'emergency-end'
 *   |'emergency-unresolved', key: string, icao24: string,
 *   label: string|null, kind: string, fromKind: string|null,
 *   squawk: string|null, source: string|null, sinceMs: number,
 *   durationMs: number|null, lastFixAtMs: number|null,
 *   onGround: boolean|null, position: {lat: number, lon: number}|null,
 *   layerId: string|null, caveats: string[]}} EmergencyTransition
 *   `kind` is the emergency kind (the new kind for a change, the ended kind
 *   for an end or unresolved); `fromKind` is set only for a change.
 *   `squawk` and `source` are those of the latest emergency observation.
 *   `sinceMs` is the fix time of the track's first observation;
 *   `durationMs` (end and unresolved only) is the observed broadcast span,
 *   from the first to the latest fresh observation with an emergency code,
 *   a lower bound. `lastFixAtMs`, `onGround`, `position` and `layerId`
 *   describe the fix behind the transition (for unresolved, the last fix).
 */

/**
 * @typedef {{key: string, icao24: string, label: string|null, kind: string,
 *   squawk: string|null, source: string|null,
 *   phase: 'candidate'|'active'|'clearing'|'unknown',
 *   firstSeenAtMs: number, confirmedAtMs: number|null,
 *   lastSeenAtMs: number|null, onGround: boolean|null, altM: number|null,
 *   lat: number|null, lon: number|null, layerId: string|null}}
 *   ActiveEmergency
 *   `lastSeenAtMs` is the latest applied fresh fix, with or without the
 *   code.
 */

const AIRCRAFT_LAYERS = KIND_LAYERS.aircraft;
const ANSWERING_STATES = Object.freeze(['counted', 'floor']);
const ENDED = 'ended';
const CONFIRMED_PHASES = Object.freeze([
  EMERGENCY_PHASE.ACTIVE,
  EMERGENCY_PHASE.CLEARING,
  EMERGENCY_PHASE.UNKNOWN,
]);
/** How each layer last saw a track, from that layer's latest frame. */
const LAYER = Object.freeze({
  FRESH: 'fresh',
  CARRIED: 'carried',
  MISSING: 'missing',
  BLIND: 'blind',
});
const CODE = Object.freeze({
  EMERGENCY: 'emergency',
  CLEAR: 'clear',
  UNREADABLE: 'unreadable',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Epoch milliseconds, or null unless finite and > 0. */
function timeOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function boolOrNull(value) {
  return value === true || value === false ? value : null;
}

/** A Mode A code as its four octal digits, else null. */
function normalizeSquawk(value) {
  const code =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value).padStart(4, '0')
      : textOrNull(value);
  return code && /^[0-7]{4}$/.test(code) ? code : null;
}

function wholeAtLeast(value, min, fallback) {
  return Number.isInteger(value) && value >= min ? value : fallback;
}

function msAtLeastZero(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** The policy with every missing or invalid value set to its default. */
function normalizePolicy(policy) {
  const p = isRecord(policy) ? policy : {};
  const d = EMERGENCY_POLICY;
  const minSpanMs = msAtLeastZero(p.minSpanMs, d.minSpanMs);
  return Object.freeze({
    confirmPolls: wholeAtLeast(p.confirmPolls, 1, d.confirmPolls),
    minSpanMs,
    maxGapMs: Math.max(msAtLeastZero(p.maxGapMs, d.maxGapMs), minSpanMs),
    clearPolls: wholeAtLeast(p.clearPolls, 1, d.clearPolls),
    absentEpochs: wholeAtLeast(p.absentEpochs, 1, d.absentEpochs),
    capacity: wholeAtLeast(p.capacity, 1, d.capacity),
    forgetUnknownMs: msAtLeastZero(p.forgetUnknownMs, d.forgetUnknownMs),
  });
}

/**
 * What one aircraft asset says about an emergency: an emergency code with
 * its kind, no code (including a priority status), or unreadable (flagged
 * an emergency with no recognisable kind).
 */
function codeOf(asset) {
  const squawk = normalizeSquawk(asset.squawk);
  if (asset.emergency !== true) return { state: CODE.CLEAR, squawk };
  const reported = textOrNull(asset.emergencyKind)?.toLowerCase() ?? null;
  if (reported && PRIORITY_KINDS.includes(reported)) {
    return { state: CODE.CLEAR, squawk };
  }
  const kind = EMERGENCY_KINDS.includes(reported)
    ? reported
    : squawk && Object.hasOwn(SQUAWK_EMERGENCY_KINDS, squawk)
      ? SQUAWK_EMERGENCY_KINDS[squawk]
      : null;
  if (!kind) return { state: CODE.UNREADABLE, squawk };
  const source = textOrNull(asset.emergencySource)?.toLowerCase() ?? null;
  return { state: CODE.EMERGENCY, kind, squawk, source };
}

function isConfirmed(track) {
  return CONFIRMED_PHASES.includes(track.phase);
}

function isLive(track) {
  return track.phase !== ENDED;
}

/**
 * Creates an emergency tracker.
 *
 * `observe(frame)` takes one observation frame (frames.js `buildFrame`);
 * frames from layers other than flights and military are ignored. It
 * returns the transitions that frame caused, in asset order, then any
 * unresolved tracks. `active()` lists live tracks (candidates included),
 * newest first. `diagnostics()` reports `tracked` (live tracks),
 * `transientIgnored` (abandoned candidates), `candidates`, `confirmed`,
 * `retained` (live and ended), `evicted`, `forgotten` and `untimedIgnored`
 * (observations without a fix time). `reset()` forgets everything.
 *
 * @param {Partial<typeof EMERGENCY_POLICY>} [policy] Overrides; missing or
 *   invalid values use {@link EMERGENCY_POLICY}.
 * @returns {{observe: (frame: object) => EmergencyTransition[],
 *   active: () => ActiveEmergency[],
 *   diagnostics: () => {tracked: number, transientIgnored: number,
 *     candidates: number, confirmed: number, retained: number,
 *     evicted: number, forgotten: number, untimedIgnored: number},
 *   reset: () => void}}
 */
export function createEmergencyTracker(policy) {
  const limits = normalizePolicy(policy);
  /** @type {Map<string, object>} */
  const tracks = new Map();
  /** Latest epoch seen per layer, to tell new epochs from repeats. */
  const lastEpochs = new Map();
  let touchSeq = 0;
  let transientIgnored = 0;
  let evicted = 0;
  let forgotten = 0;
  let untimedIgnored = 0;

  function touch(track) {
    touchSeq += 1;
    track.touch = touchSeq;
  }

  function newTrack(key) {
    return {
      key,
      label: null,
      phase: ENDED,
      kind: null,
      squawk: null,
      source: null,
      firstSeenAtMs: null,
      firstContactAtMs: null,
      confirmedAtMs: null,
      lastCodeAtMs: null,
      lastFixAtMs: null,
      lastApplied: null,
      count: 0,
      clearCount: 0,
      change: null,
      unobserved: false,
      onGround: null,
      altM: null,
      lat: null,
      lon: null,
      layerId: null,
      fixes: new Map(),
      layers: new Map(),
      touch: 0,
    };
  }

  /** Least recently used track, ended and candidate tracks first. */
  function evictOne() {
    let victim = null;
    for (const track of tracks.values()) {
      if (!victim) {
        victim = track;
        continue;
      }
      const soft = !isConfirmed(track);
      const victimSoft = !isConfirmed(victim);
      if (soft !== victimSoft) {
        if (soft) victim = track;
      } else if (track.touch < victim.touch) {
        victim = track;
      }
    }
    if (victim) {
      tracks.delete(victim.key);
      evicted += 1;
    }
  }

  function addTrack(key) {
    while (tracks.size >= limits.capacity) evictOne();
    const track = newTrack(key);
    tracks.set(key, track);
    return track;
  }

  function endTrack(track) {
    track.phase = ENDED;
    track.count = 0;
    track.clearCount = 0;
    track.change = null;
    track.unobserved = false;
    track.confirmedAtMs = null;
  }

  function abandonCandidate(track) {
    transientIgnored += 1;
    endTrack(track);
  }

  function startCandidate(track, code, fix, layerId) {
    const { fixAtMs } = fix;
    track.phase = EMERGENCY_PHASE.CANDIDATE;
    track.kind = code.kind;
    track.squawk = code.squawk;
    track.source = code.source;
    track.firstSeenAtMs = fixAtMs;
    track.firstContactAtMs = fix.contactAtMs;
    track.confirmedAtMs = null;
    track.lastCodeAtMs = fixAtMs;
    track.count = 1;
    track.clearCount = 0;
    track.change = null;
    track.unobserved = false;
    track.layers = new Map([[layerId, { seen: LAYER.FRESH, missed: 0 }]]);
  }

  function caveatsFor(track, { unobserved = false } = {}) {
    const caveats = [];
    if (track.onGround === true) caveats.push(EMERGENCY_CAVEATS[0]);
    if (track.kind === 'unlawful') caveats.push(EMERGENCY_CAVEATS[1]);
    if (unobserved) caveats.push(EMERGENCY_CAVEATS[2]);
    return caveats;
  }

  function transition(type, track, { fromKind = null, ended = false } = {}) {
    const durationMs =
      ended && track.lastCodeAtMs !== null && track.firstSeenAtMs !== null
        ? Math.max(0, track.lastCodeAtMs - track.firstSeenAtMs)
        : null;
    return {
      type,
      key: track.key,
      icao24: track.key,
      label: track.label,
      kind: track.kind,
      fromKind,
      squawk: track.squawk,
      source: track.source,
      sinceMs: track.firstSeenAtMs,
      durationMs,
      lastFixAtMs: track.lastFixAtMs,
      onGround: track.onGround,
      position:
        track.lat !== null && track.lon !== null
          ? { lat: track.lat, lon: track.lon }
          : null,
      layerId: track.layerId,
      caveats: caveatsFor(track, {
        unobserved: type === EMERGENCY_TRANSITION.END && track.unobserved,
      }),
    };
  }

  /** Copies the fix fields of an applied observation onto the track. */
  function takeFix(track, asset, fixAtMs, layerId) {
    track.lastFixAtMs = fixAtMs;
    track.label =
      textOrNull(asset.label) ?? textOrNull(asset.callsign) ?? track.label;
    track.onGround = boolOrNull(asset.onGround);
    track.altM = finiteOrNull(asset.altM);
    const lat = finiteOrNull(asset.lat);
    const lon = finiteOrNull(asset.lon);
    track.lat = lat !== null && lon !== null ? lat : null;
    track.lon = lat !== null && lon !== null ? lon : null;
    track.layerId = layerId;
  }

  /**
   * How long after a candidate's first observation `fix` was broadcast:
   * between contact times when both carry one (receipt order across two
   * upstreams says little about message order), else between receipts.
   */
  function spanSinceFirst(track, fix) {
    return track.firstContactAtMs !== null && fix.contactAtMs !== null
      ? fix.contactAtMs - track.firstContactAtMs
      : fix.fixAtMs - track.firstSeenAtMs;
  }

  /** Applies one fresh, newest observation to a track. */
  function apply(track, code, fix, layerId, out) {
    const { fixAtMs } = fix;
    if (track.phase === ENDED) {
      if (code.state === CODE.EMERGENCY) {
        startCandidate(track, code, fix, layerId);
      }
      return;
    }
    if (track.phase === EMERGENCY_PHASE.CANDIDATE) {
      if (code.state === CODE.CLEAR) {
        abandonCandidate(track);
        return;
      }
      if (code.state !== CODE.EMERGENCY) return;
      const spanMs = spanSinceFirst(track, fix);
      if (code.kind !== track.kind || spanMs > limits.maxGapMs) {
        transientIgnored += 1;
        startCandidate(track, code, fix, layerId);
        return;
      }
      track.count += 1;
      track.squawk = code.squawk;
      track.source = code.source;
      track.lastCodeAtMs = fixAtMs;
      if (track.count >= limits.confirmPolls && spanMs >= limits.minSpanMs) {
        track.phase = EMERGENCY_PHASE.ACTIVE;
        track.confirmedAtMs = fixAtMs;
        out.push(transition(EMERGENCY_TRANSITION.START, track));
      }
      return;
    }
    if (code.state === CODE.EMERGENCY) {
      track.clearCount = 0;
      track.lastCodeAtMs = fixAtMs;
      track.unobserved = false;
      if (code.kind === track.kind) {
        track.phase = EMERGENCY_PHASE.ACTIVE;
        track.change = null;
        track.squawk = code.squawk;
        track.source = code.source;
        return;
      }
      track.phase = EMERGENCY_PHASE.ACTIVE;
      track.change =
        track.change && track.change.kind === code.kind
          ? { kind: code.kind, count: track.change.count + 1 }
          : { kind: code.kind, count: 1 };
      if (track.change.count >= limits.confirmPolls) {
        const fromKind = track.kind;
        track.kind = code.kind;
        track.squawk = code.squawk;
        track.source = code.source;
        track.change = null;
        out.push(transition(EMERGENCY_TRANSITION.CHANGE, track, { fromKind }));
      }
      return;
    }
    if (code.state === CODE.CLEAR) {
      track.change = null;
      track.clearCount += 1;
      track.phase = EMERGENCY_PHASE.CLEARING;
      if (track.clearCount >= limits.clearPolls) {
        out.push(transition(EMERGENCY_TRANSITION.END, track, { ended: true }));
        endTrack(track);
      }
    }
  }

  /** Marks a confirmed track unknown, or unresolved, from its layers. */
  function evaluate(track, out) {
    if (!isConfirmed(track)) return;
    const layers = [...track.layers.values()];
    if (
      layers.length > 0 &&
      layers.every(
        (layer) =>
          layer.seen === LAYER.MISSING && layer.missed >= limits.absentEpochs,
      )
    ) {
      out.push(
        transition(EMERGENCY_TRANSITION.UNRESOLVED, track, { ended: true }),
      );
      endTrack(track);
      touch(track);
      return;
    }
    if (
      track.phase !== EMERGENCY_PHASE.UNKNOWN &&
      !layers.some(
        (layer) => layer.seen === LAYER.FRESH || layer.seen === LAYER.CARRIED,
      )
    ) {
      track.phase = EMERGENCY_PHASE.UNKNOWN;
      track.clearCount = 0;
      track.change = null;
      track.unobserved = true;
    }
  }

  /**
   * Feeds one observation frame.
   *
   * @param {object} frame An ObservationFrame from frames.js `buildFrame`.
   * @returns {EmergencyTransition[]}
   */
  function observe(frame) {
    if (!isRecord(frame) || !AIRCRAFT_LAYERS.includes(frame.layerId)) {
      return [];
    }
    const layerId = frame.layerId;
    const out = [];
    const state = isRecord(frame.answer) ? frame.answer.state : null;
    const answering = ANSWERING_STATES.includes(state);
    const counted = state === 'counted' && frame.complete !== false;
    const epochMs = timeOrNull(frame.epochMs);
    const newEpoch =
      answering &&
      frame.newEpoch !== false &&
      epochMs !== null &&
      epochMs !== (lastEpochs.get(layerId) ?? null);
    if (epochMs !== null) lastEpochs.set(layerId, epochMs);
    const nowMs = timeOrNull(frame.nowMs) ?? epochMs;

    const present = new Set();
    const fresh = new Set();
    const assets = answering && Array.isArray(frame.assets) ? frame.assets : [];
    for (const asset of assets) {
      if (!isRecord(asset) || asset.kind !== 'aircraft') continue;
      const key = typeof asset.key === 'string' ? asset.key : null;
      if (!key) continue;
      let track = tracks.get(key) ?? null;
      const code = codeOf(asset);
      if (!track && code.state !== CODE.EMERGENCY) continue;
      if (track) present.add(key);
      const fixAtMs = timeOrNull(asset.fixAtMs);
      if (fixAtMs === null) {
        untimedIgnored += 1;
        continue;
      }
      if (!track) {
        track = addTrack(key);
        present.add(key);
      }
      const fix = { fixAtMs, contactAtMs: timeOrNull(asset.contactAtMs) };
      if (!isFreshFix(track.fixes.get(layerId) ?? null, fix)) continue;
      track.fixes.set(layerId, fix);
      fresh.add(key);
      touch(track);
      if (isLive(track)) {
        track.layers.set(layerId, { seen: LAYER.FRESH, missed: 0 });
      }
      // Across layers too: a later receipt and, when both carry one, a
      // later upstream contact (a lagging copy is not a new observation).
      if (!isFreshFix(track.lastApplied, fix)) continue;
      track.lastApplied = fix;
      takeFix(track, asset, fixAtMs, layerId);
      apply(track, code, fix, layerId, out);
    }

    const affected = [];
    for (const track of tracks.values()) {
      if (!isLive(track)) continue;
      const layer = track.layers.get(layerId);
      if (!layer) continue;
      if (!answering) {
        layer.seen = LAYER.BLIND;
      } else if (fresh.has(track.key)) {
        // Set when the observation was taken.
      } else if (present.has(track.key)) {
        if (newEpoch) layer.seen = LAYER.CARRIED;
      } else if (newEpoch) {
        if (
          counted &&
          coverageContainsPoint(frame.coverage, track.lat, track.lon) === true
        ) {
          layer.seen = LAYER.MISSING;
          layer.missed += 1;
        } else {
          layer.seen = LAYER.BLIND;
        }
      }
      affected.push(track);
    }
    affected.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const track of affected) evaluate(track, out);

    if (nowMs !== null) {
      for (const track of tracks.values()) {
        if (
          track.phase === EMERGENCY_PHASE.CANDIDATE &&
          nowMs - track.firstSeenAtMs > limits.maxGapMs
        ) {
          abandonCandidate(track);
        } else if (
          track.phase === EMERGENCY_PHASE.UNKNOWN &&
          track.lastFixAtMs !== null &&
          nowMs - track.lastFixAtMs > limits.forgetUnknownMs
        ) {
          forgotten += 1;
          endTrack(track);
        }
      }
    }
    return out;
  }

  /**
   * Live tracks (candidate, active, clearing or unknown), newest first.
   *
   * @returns {ActiveEmergency[]}
   */
  function active() {
    const list = [];
    for (const track of tracks.values()) {
      if (!isLive(track)) continue;
      list.push({
        key: track.key,
        icao24: track.key,
        label: track.label,
        kind: track.kind,
        squawk: track.squawk,
        source: track.source,
        phase: track.phase,
        firstSeenAtMs: track.firstSeenAtMs,
        confirmedAtMs: track.confirmedAtMs,
        lastSeenAtMs: track.lastFixAtMs,
        onGround: track.onGround,
        altM: track.altM,
        lat: track.lat,
        lon: track.lon,
        layerId: track.layerId,
      });
    }
    return list.sort(
      (a, b) =>
        b.firstSeenAtMs - a.firstSeenAtMs ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }

  /**
   * Counters for diagnostics.
   *
   * @returns {{tracked: number, transientIgnored: number, candidates: number,
   *   confirmed: number, retained: number, evicted: number,
   *   forgotten: number, untimedIgnored: number}}
   */
  function diagnostics() {
    let candidates = 0;
    let confirmed = 0;
    for (const track of tracks.values()) {
      if (track.phase === EMERGENCY_PHASE.CANDIDATE) candidates += 1;
      else if (isConfirmed(track)) confirmed += 1;
    }
    return {
      tracked: candidates + confirmed,
      transientIgnored,
      candidates,
      confirmed,
      retained: tracks.size,
      evicted,
      forgotten,
      untimedIgnored,
    };
  }

  /** Forgets every track, epoch and counter. */
  function reset() {
    tracks.clear();
    lastEpochs.clear();
    touchSeq = 0;
    transientIgnored = 0;
    evicted = 0;
    forgotten = 0;
    untimedIgnored = 0;
  }

  return { observe, active, diagnostics, reset };
}
