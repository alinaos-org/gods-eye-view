/**
 * Zone presence for one asset in one zone: a hysteresis state machine that
 * turns fresh position fixes into enter, exit and dwell facts, and refuses to
 * guess when the feed cannot answer.
 *
 * Portable and pure: no imports, no clock, no randomness. Every time comes in
 * through the observation (`nowMs`, fix times). Inputs are never mutated; when
 * nothing changes the previous record is returned as is.
 *
 * Signed distance d is negative inside the zone; m is the zone margin for the
 * asset kind. A fix is in the core inside when d <= -m, in the core outside
 * when d >= +m, and in the band otherwise. Only fresh fixes under a counted or
 * floor answer move a member through this table (a band fix never changes
 * the state or a streak):
 *
 * | State     | Core-inside fix (d <= -m)       | Core-outside fix (d >= +m)        |
 * |-----------|---------------------------------|-----------------------------------|
 * | outside   | candidate, streak 1             | stay outside                      |
 * | candidate | streak + 1; at enterFixes:      | drop to outside                   |
 * |           | inside, `enter` when seen       |                                   |
 * |           | outside before the streak, else |                                   |
 * |           | `first-seen` (lower-bound       |                                   |
 * |           | dwell); enteredAtMs =           |                                   |
 * |           | streakStartAtMs                 |                                   |
 * | inside    | stay inside                     | exiting, streak 1                 |
 * | exiting   | back to inside, streak 0        | streak + 1; at exitFixes:         |
 * |           |                                 | outside, `exit` (exitAtMs =       |
 * |           |                                 | streakStartAtMs)                  |
 * | unknown   | inside, `resume` (dwell kept)   | outside, `exit-window` from       |
 * |           |                                 | lastInsideFixAtMs to the fix time |
 *
 * - Every fresh fix with a usable distance updates `lastFix`; band fixes never
 *   change a streak.
 * - A carried (not fresh) fix, or a fresh fix whose distance is not finite,
 *   changes nothing except the presence bookkeeping below.
 * - An absent key (no fix), or a held, unknown or off answer: candidates drop
 *   to outside, inside and exiting members become unknown (`unknown`), and
 *   outside and unknown members stay where they are.
 * - Presence bookkeeping: whenever the key is reported in an answering frame
 *   (fresh or carried), its layer joins `sources` and `absentEpochs` returns to
 *   0, so absence evidence must be consecutive.
 * - `absentEpochs` grows only when the observation sets `absentEvidence` and
 *   the answer is counted (absence under a floor answer is no evidence).
 * - Whether the asset was seen outside is latched at the first fix of an entry
 *   streak, because the frame before the confirming fix is the streak's own
 *   first fix: without the latch every take-off would confirm as an entry.
 * - Expiry (`expireMember`): an unknown member past `unknownExpireMs` gives
 *   `no-longer-reported` when `absentEpochs >= lostAfterEpochs`, otherwise
 *   `expired-silent` (no event).
 * - `reentry` is set on entry when the previous exit was at most
 *   `reentryQuietMs` before the entry time.
 */

/**
 * Presence thresholds. Fix counts confirm an entry or an exit; absence needs
 * `lostAfterEpochs` counted epochs and `unknownExpireMs` of silence; the
 * engine re-baselines a zone after `rebaselineGapMs` without an answer.
 * @type {Readonly<{enterFixes: number, exitFixes: number,
 *   lostAfterEpochs: Readonly<{aircraft: number, vessel: number}>,
 *   unknownExpireMs: Readonly<{aircraft: number, vessel: number}>,
 *   rebaselineGapMs: Readonly<{aircraft: number, vessel: number}>,
 *   reentryQuietMs: number}>}
 */
export const PRESENCE_POLICY = Object.freeze({
  enterFixes: 2,
  exitFixes: 2,
  lostAfterEpochs: Object.freeze({ aircraft: 3, vessel: 1 }),
  unknownExpireMs: Object.freeze({ aircraft: 600_000, vessel: 3_600_000 }),
  rebaselineGapMs: Object.freeze({ aircraft: 300_000, vessel: 1_800_000 }),
  reentryQuietMs: 300_000,
});

/**
 * Member states.
 * @type {Readonly<{OUTSIDE: 'outside', CANDIDATE: 'candidate',
 *   INSIDE: 'inside', EXITING: 'exiting', UNKNOWN: 'unknown'}>}
 */
export const MEMBER_STATE = Object.freeze({
  OUTSIDE: 'outside',
  CANDIDATE: 'candidate',
  INSIDE: 'inside',
  EXITING: 'exiting',
  UNKNOWN: 'unknown',
});

/**
 * Transition codes. `stepMember` returns the first six, `expireMember` the
 * last two.
 * @type {Readonly<{ENTER: 'enter', FIRST_SEEN: 'first-seen', EXIT: 'exit',
 *   EXIT_WINDOW: 'exit-window', UNKNOWN: 'unknown', RESUME: 'resume',
 *   NO_LONGER_REPORTED: 'no-longer-reported',
 *   EXPIRED_SILENT: 'expired-silent'}>}
 */
export const PRESENCE_TRANSITION = Object.freeze({
  ENTER: 'enter',
  FIRST_SEEN: 'first-seen',
  EXIT: 'exit',
  EXIT_WINDOW: 'exit-window',
  UNKNOWN: 'unknown',
  RESUME: 'resume',
  NO_LONGER_REPORTED: 'no-longer-reported',
  EXPIRED_SILENT: 'expired-silent',
});

/**
 * Where a fix falls relative to the zone edge and its margin.
 * @type {Readonly<{CORE_INSIDE: 'core-inside', BAND: 'band',
 *   CORE_OUTSIDE: 'core-outside'}>}
 */
export const FIX_REGION = Object.freeze({
  CORE_INSIDE: 'core-inside',
  BAND: 'band',
  CORE_OUTSIDE: 'core-outside',
});

/**
 * Vertical rate (m/s, about -300 ft/min) at or below which the last fix of a
 * member that is no longer reported counts as descending. ADS-B rates come in
 * 64 ft/min steps, so a level aircraft can read one step either side of 0.
 * @type {number}
 */
export const DESCENDING_VRATE_MPS = -1.5;

/**
 * @typedef {Object} PresenceFix
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {number|null} atMs Fix time.
 * @property {number|null} altM
 * @property {boolean|null} onGround
 * @property {number|null} vRateMps
 */

/**
 * @typedef {Object} MemberRecord
 * @property {'outside'|'candidate'|'inside'|'exiting'|'unknown'} state
 * @property {number} streak Core fixes counted toward the pending entry
 *   (candidate) or exit (exiting); 0 otherwise.
 * @property {number|null} streakStartAtMs Time of the streak's first fix.
 * @property {boolean} seenOutsideBefore Latched at the first fix of an entry
 *   streak; false outside a candidate streak.
 * @property {number|null} enteredAtMs
 * @property {boolean} enteredLowerBound True when the entry was not observed
 *   (first-seen or baseline), so the dwell is a lower bound.
 * @property {number|null} lastInsideFixAtMs Time of the last core-inside fix.
 * @property {PresenceFix|null} lastFix
 * @property {number|null} unknownSinceMs
 * @property {number} absentEpochs Consecutive counted epochs with absence
 *   evidence.
 * @property {number|null} lastExitAtMs Time the asset was first observed
 *   outside after its last visit.
 * @property {boolean} reentry The current visit began within
 *   `reentryQuietMs` of the previous exit.
 * @property {string[]} sources Layer ids that reported the member.
 */

/**
 * @typedef {Object} PresenceObservation
 * @property {string} [kind] 'aircraft' or 'vessel'.
 * @property {string|{state: string}|null} answer Answer state ('counted',
 *   'floor', 'held', 'unknown' or 'off'), or an answer object carrying it.
 * @property {number} nowMs
 * @property {string|null} [layerId]
 * @property {Object|null} fix The asset's fix in this frame, or null when its
 *   key is absent. Accepts `atMs` or an asset's `fixAtMs` for the fix time.
 * @property {boolean} fresh True when the fix is newer than the last one.
 * @property {number|null} distanceM Signed distance to the zone edge,
 *   negative inside.
 * @property {number} marginM Hysteresis margin for this zone and kind.
 * @property {boolean} seenOutsideBefore The asset was present outside the
 *   zone in its layer's previous answering epoch.
 * @property {boolean} absentEvidence The engine's counted, new-epoch
 *   absence evidence from every source layer.
 */

/**
 * @typedef {Object} PresenceStep
 * @property {MemberRecord} next The new record (the previous one when
 *   nothing changed).
 * @property {string|null} transition A `PRESENCE_TRANSITION` code or null.
 * @property {Object|null} detail Event parameters for the transition
 *   (numbers, booleans or null), or null with no transition.
 */

const ANSWERING = Object.freeze(['counted', 'floor']);
const STATES = Object.freeze(Object.values(MEMBER_STATE));

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function countOrZero(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function atLeastOne(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function nonNegativeOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function mergeKindTable(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const merged = { ...base };
  for (const [kind, value] of Object.entries(patch)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      merged[kind] = value;
    }
  }
  return merged;
}

function resolvePolicy(policy) {
  if (policy === PRESENCE_POLICY || !policy || typeof policy !== 'object') {
    return PRESENCE_POLICY;
  }
  return {
    enterFixes: atLeastOne(policy.enterFixes, PRESENCE_POLICY.enterFixes),
    exitFixes: atLeastOne(policy.exitFixes, PRESENCE_POLICY.exitFixes),
    lostAfterEpochs: mergeKindTable(
      PRESENCE_POLICY.lostAfterEpochs,
      policy.lostAfterEpochs,
    ),
    unknownExpireMs: mergeKindTable(
      PRESENCE_POLICY.unknownExpireMs,
      policy.unknownExpireMs,
    ),
    rebaselineGapMs: mergeKindTable(
      PRESENCE_POLICY.rebaselineGapMs,
      policy.rebaselineGapMs,
    ),
    reentryQuietMs: nonNegativeOr(
      policy.reentryQuietMs,
      PRESENCE_POLICY.reentryQuietMs,
    ),
  };
}

/** The kind's value, else the largest configured value (the cautious one). */
function perKind(table, kind) {
  if (typeof kind === 'string' && Object.hasOwn(table, kind)) {
    const value = finiteOrNull(table[kind]);
    if (value !== null) return value;
  }
  let largest = null;
  for (const value of Object.values(table)) {
    const finite = finiteOrNull(value);
    if (finite !== null && (largest === null || finite > largest)) {
      largest = finite;
    }
  }
  return largest;
}

function answerState(answer) {
  if (typeof answer === 'string') return answer;
  if (answer && typeof answer === 'object' && typeof answer.state === 'string')
    return answer.state;
  return null;
}

function isMember(value) {
  return (
    value !== null && typeof value === 'object' && STATES.includes(value.state)
  );
}

function toFix(raw, fallbackAtMs) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    lat: finiteOrNull(raw.lat),
    lon: finiteOrNull(raw.lon),
    atMs:
      finiteOrNull(raw.atMs) ??
      finiteOrNull(raw.fixAtMs) ??
      finiteOrNull(fallbackAtMs),
    altM: finiteOrNull(raw.altM),
    onGround: boolOrNull(raw.onGround),
    vRateMps: finiteOrNull(raw.vRateMps),
  };
}

function sourcesOf(member) {
  return Array.isArray(member.sources)
    ? member.sources.filter((id) => typeof id === 'string' && id !== '')
    : [];
}

function step(next, transition = null, detail = null) {
  return { next, transition, detail };
}

/** The key is reported in an answering frame: note the layer, reset absence. */
function markReported(member, layerId) {
  const sources = sourcesOf(member);
  const addLayer =
    typeof layerId === 'string' && layerId !== '' && !sources.includes(layerId);
  const listChanged =
    addLayer ||
    !Array.isArray(member.sources) ||
    sources.length !== member.sources.length;
  if (!listChanged && countOrZero(member.absentEpochs) === 0) return member;
  return {
    ...member,
    absentEpochs: 0,
    sources: addLayer ? [...sources, layerId] : sources,
  };
}

function toOutside(member, overrides) {
  return {
    ...member,
    state: MEMBER_STATE.OUTSIDE,
    streak: 0,
    streakStartAtMs: null,
    seenOutsideBefore: false,
    enteredAtMs: null,
    enteredLowerBound: false,
    lastInsideFixAtMs: null,
    unknownSinceMs: null,
    absentEpochs: 0,
    reentry: false,
    ...overrides,
  };
}

/** No fix, or an answer that cannot answer. */
function loseSight(member, nowMs, evidence) {
  switch (member.state) {
    case MEMBER_STATE.CANDIDATE:
      return step(toOutside(member, {}));
    case MEMBER_STATE.INSIDE:
    case MEMBER_STATE.EXITING: {
      const unknownSinceMs =
        nowMs ?? finiteOrNull(member.lastFix?.atMs) ?? null;
      const next = {
        ...member,
        state: MEMBER_STATE.UNKNOWN,
        streak: 0,
        streakStartAtMs: null,
        seenOutsideBefore: false,
        unknownSinceMs,
        absentEpochs: countOrZero(member.absentEpochs) + (evidence ? 1 : 0),
      };
      return step(next, PRESENCE_TRANSITION.UNKNOWN, {
        sinceMs: unknownSinceMs,
        lastInsideFixAtMs: finiteOrNull(member.lastInsideFixAtMs),
      });
    }
    case MEMBER_STATE.UNKNOWN:
      if (!evidence) return step(member);
      return step({
        ...member,
        absentEpochs: countOrZero(member.absentEpochs) + 1,
      });
    default:
      return step(member);
  }
}

function confirmEntry(member, fix, enteredAtMs, seenOutside, rules) {
  const lastExitAtMs = finiteOrNull(member.lastExitAtMs);
  const reentry =
    lastExitAtMs !== null &&
    enteredAtMs !== null &&
    enteredAtMs - lastExitAtMs <= rules.reentryQuietMs;
  const next = {
    ...member,
    state: MEMBER_STATE.INSIDE,
    streak: 0,
    streakStartAtMs: null,
    seenOutsideBefore: false,
    enteredAtMs,
    enteredLowerBound: !seenOutside,
    lastInsideFixAtMs: fix.atMs,
    lastFix: fix,
    unknownSinceMs: null,
    absentEpochs: 0,
    reentry,
  };
  return step(
    next,
    seenOutside ? PRESENCE_TRANSITION.ENTER : PRESENCE_TRANSITION.FIRST_SEEN,
    { sinceMs: enteredAtMs, reentry, lowerBound: !seenOutside },
  );
}

function confirmExit(member, fix, exitAtMs) {
  const enteredAtMs = finiteOrNull(member.enteredAtMs);
  const dwellMs =
    exitAtMs !== null && enteredAtMs !== null && exitAtMs >= enteredAtMs
      ? exitAtMs - enteredAtMs
      : null;
  const next = toOutside(member, { lastFix: fix, lastExitAtMs: exitAtMs });
  return step(next, PRESENCE_TRANSITION.EXIT, {
    exitAtMs,
    enteredAtMs,
    dwellMs,
    dwellLowerBound: member.enteredLowerBound === true,
  });
}

/** One fresh fix with a usable distance, applied through the table. */
function applyFreshFix(member, region, fix, obs, rules) {
  const inCore = region === FIX_REGION.CORE_INSIDE;
  const outCore = region === FIX_REGION.CORE_OUTSIDE;
  const streak = countOrZero(member.streak);
  switch (member.state) {
    case MEMBER_STATE.OUTSIDE: {
      if (!inCore) return step({ ...member, lastFix: fix });
      const seenOutside = obs.seenOutsideBefore === true;
      if (rules.enterFixes <= 1) {
        return confirmEntry(member, fix, fix.atMs, seenOutside, rules);
      }
      return step({
        ...member,
        state: MEMBER_STATE.CANDIDATE,
        streak: 1,
        streakStartAtMs: fix.atMs,
        seenOutsideBefore: seenOutside,
        lastInsideFixAtMs: fix.atMs,
        lastFix: fix,
      });
    }
    case MEMBER_STATE.CANDIDATE: {
      if (outCore) return step(toOutside(member, { lastFix: fix }));
      if (!inCore) return step({ ...member, lastFix: fix });
      const startAtMs = finiteOrNull(member.streakStartAtMs) ?? fix.atMs;
      if (streak + 1 >= rules.enterFixes) {
        return confirmEntry(
          member,
          fix,
          startAtMs,
          member.seenOutsideBefore === true,
          rules,
        );
      }
      return step({
        ...member,
        streak: streak + 1,
        streakStartAtMs: startAtMs,
        lastInsideFixAtMs: fix.atMs,
        lastFix: fix,
      });
    }
    case MEMBER_STATE.INSIDE: {
      if (inCore) {
        return step({ ...member, lastInsideFixAtMs: fix.atMs, lastFix: fix });
      }
      if (!outCore) return step({ ...member, lastFix: fix });
      if (rules.exitFixes <= 1) return confirmExit(member, fix, fix.atMs);
      return step({
        ...member,
        state: MEMBER_STATE.EXITING,
        streak: 1,
        streakStartAtMs: fix.atMs,
        lastFix: fix,
      });
    }
    case MEMBER_STATE.EXITING: {
      if (inCore) {
        return step({
          ...member,
          state: MEMBER_STATE.INSIDE,
          streak: 0,
          streakStartAtMs: null,
          lastInsideFixAtMs: fix.atMs,
          lastFix: fix,
        });
      }
      if (!outCore) return step({ ...member, lastFix: fix });
      const startAtMs = finiteOrNull(member.streakStartAtMs) ?? fix.atMs;
      if (streak + 1 >= rules.exitFixes) {
        return confirmExit(member, fix, startAtMs);
      }
      return step({
        ...member,
        streak: streak + 1,
        streakStartAtMs: startAtMs,
        lastFix: fix,
      });
    }
    case MEMBER_STATE.UNKNOWN: {
      if (inCore) {
        const next = {
          ...member,
          state: MEMBER_STATE.INSIDE,
          streak: 0,
          streakStartAtMs: null,
          seenOutsideBefore: false,
          lastInsideFixAtMs: fix.atMs,
          lastFix: fix,
          unknownSinceMs: null,
          absentEpochs: 0,
        };
        return step(next, PRESENCE_TRANSITION.RESUME, {
          sinceMs: finiteOrNull(member.enteredAtMs),
          lowerBound: member.enteredLowerBound === true,
          unknownSinceMs: finiteOrNull(member.unknownSinceMs),
        });
      }
      if (!outCore) return step({ ...member, lastFix: fix });
      const fromMs = finiteOrNull(member.lastInsideFixAtMs);
      const next = toOutside(member, { lastFix: fix, lastExitAtMs: fix.atMs });
      return step(next, PRESENCE_TRANSITION.EXIT_WINDOW, {
        fromMs,
        toMs: fix.atMs,
        enteredAtMs: finiteOrNull(member.enteredAtMs),
        dwellLowerBound: member.enteredLowerBound === true,
      });
    }
    default:
      return step(member);
  }
}

/**
 * A member that has never been placed: outside, no fix, no history.
 * @returns {MemberRecord}
 */
export function initialMember() {
  return {
    state: MEMBER_STATE.OUTSIDE,
    streak: 0,
    streakStartAtMs: null,
    seenOutsideBefore: false,
    enteredAtMs: null,
    enteredLowerBound: false,
    lastInsideFixAtMs: null,
    lastFix: null,
    unknownSinceMs: null,
    absentEpochs: 0,
    lastExitAtMs: null,
    reentry: false,
    sources: [],
  };
}

/**
 * A member found inside when a zone is (re)baselined: inside, with its entry
 * unobserved, so `enteredLowerBound` is true and its dwell counts from the
 * fix time. No transition and no event.
 * @param {Object|null} fix The asset or fix (`atMs` or `fixAtMs` for time).
 * @param {string|null} layerId The layer that reported it.
 * @param {number|null} [nowMs] Fallback time when the fix carries none.
 * @returns {MemberRecord}
 */
export function baselineMember(fix, layerId, nowMs = null) {
  const lastFix = toFix(fix, nowMs);
  const atMs = lastFix ? lastFix.atMs : finiteOrNull(nowMs);
  return {
    ...initialMember(),
    state: MEMBER_STATE.INSIDE,
    enteredAtMs: atMs,
    enteredLowerBound: true,
    lastInsideFixAtMs: atMs,
    lastFix,
    sources: typeof layerId === 'string' && layerId !== '' ? [layerId] : [],
  };
}

/**
 * Classify a signed distance against the margin: core inside when
 * d <= -m, core outside when d >= +m, band otherwise. A missing or negative
 * margin counts as 0.
 * @param {number|null} distanceM Signed distance, negative inside.
 * @param {number} marginM
 * @returns {'core-inside'|'band'|'core-outside'|null} null when the distance
 *   is not a finite number.
 */
export function classifyFix(distanceM, marginM) {
  const d = finiteOrNull(distanceM);
  if (d === null) return null;
  const m = nonNegativeOr(marginM, 0);
  if (d <= -m) return FIX_REGION.CORE_INSIDE;
  if (d >= m) return FIX_REGION.CORE_OUTSIDE;
  return FIX_REGION.BAND;
}

/**
 * Advance one member by one observation, following the module's transition
 * table. Never mutates `prev`.
 * @param {MemberRecord|null} prev The current record (null starts fresh).
 * @param {PresenceObservation} obs
 * @param {typeof PRESENCE_POLICY} [policy]
 * @returns {PresenceStep} `transition` is null or one of 'enter',
 *   'first-seen', 'exit', 'exit-window', 'unknown', 'resume'. `detail` holds
 *   the event parameters: enter and first-seen {sinceMs, reentry,
 *   lowerBound}; exit {exitAtMs, enteredAtMs, dwellMs, dwellLowerBound};
 *   exit-window {fromMs, toMs, enteredAtMs, dwellLowerBound}; unknown
 *   {sinceMs, lastInsideFixAtMs}; resume {sinceMs, lowerBound,
 *   unknownSinceMs}.
 */
export function stepMember(prev, obs, policy = PRESENCE_POLICY) {
  const member = isMember(prev) ? prev : initialMember();
  const o = obs && typeof obs === 'object' ? obs : {};
  const rules = resolvePolicy(policy);
  const nowMs = finiteOrNull(o.nowMs);
  const answer = answerState(o.answer);
  if (!ANSWERING.includes(answer)) return loseSight(member, nowMs, false);
  if (!o.fix || typeof o.fix !== 'object') {
    return loseSight(
      member,
      nowMs,
      o.absentEvidence === true && answer === 'counted',
    );
  }
  const reported = markReported(member, o.layerId);
  if (o.fresh !== true) return step(reported);
  const region = classifyFix(o.distanceM, o.marginM);
  if (region === null) return step(reported);
  return applyFreshFix(reported, region, toFix(o.fix, nowMs), o, rules);
}

/**
 * Expire an unknown member once it has been unknown for `unknownExpireMs`
 * of its kind. Members in any other state, or not yet due, are returned
 * unchanged with a null transition. An expired member comes back outside,
 * keeping only its last fix and last exit time.
 * @param {MemberRecord|null} prev
 * @param {{nowMs: number, kind: string}} context
 * @param {typeof PRESENCE_POLICY} [policy]
 * @returns {PresenceStep} `transition` is null, 'no-longer-reported' (with
 *   counted absence for `lostAfterEpochs` epochs; detail {lastFixAtMs,
 *   lastAltM, lastOnGround, lastVRateMps, descending, absentEpochs,
 *   unknownSinceMs}) or 'expired-silent' (no event; detail {lastFixAtMs,
 *   absentEpochs, unknownSinceMs}).
 */
export function expireMember(prev, context, policy = PRESENCE_POLICY) {
  if (!isMember(prev)) return step(initialMember());
  if (prev.state !== MEMBER_STATE.UNKNOWN) return step(prev);
  const { nowMs: rawNowMs = null, kind = null } =
    context && typeof context === 'object' ? context : {};
  const nowMs = finiteOrNull(rawNowMs);
  if (nowMs === null) return step(prev);
  const rules = resolvePolicy(policy);
  const lastFix =
    prev.lastFix && typeof prev.lastFix === 'object' ? prev.lastFix : null;
  const lastFixAtMs = finiteOrNull(lastFix?.atMs);
  const sinceMs = finiteOrNull(prev.unknownSinceMs) ?? lastFixAtMs;
  const absentEpochs = countOrZero(prev.absentEpochs);
  const next = {
    ...initialMember(),
    lastFix: lastFix ? toFix(lastFix, null) : null,
    lastExitAtMs: finiteOrNull(prev.lastExitAtMs),
  };
  const silent = () =>
    step(next, PRESENCE_TRANSITION.EXPIRED_SILENT, {
      lastFixAtMs,
      absentEpochs,
      unknownSinceMs: sinceMs,
    });
  // Unknown with no time to measure from: it cannot be placed, so it goes
  // without an event.
  if (sinceMs === null) return silent();
  const expireMs = perKind(rules.unknownExpireMs, kind);
  if (expireMs === null || nowMs - sinceMs < expireMs) return step(prev);
  const lostAfter = Math.max(1, perKind(rules.lostAfterEpochs, kind) ?? 1);
  if (absentEpochs < lostAfter) return silent();
  const vRateMps = finiteOrNull(lastFix?.vRateMps);
  return step(next, PRESENCE_TRANSITION.NO_LONGER_REPORTED, {
    lastFixAtMs,
    lastAltM: finiteOrNull(lastFix?.altM),
    lastOnGround: boolOrNull(lastFix?.onGround),
    lastVRateMps: vRateMps,
    descending: vRateMps === null ? null : vRateMps <= DESCENDING_VRATE_MPS,
    absentEpochs,
    unknownSinceMs: sinceMs,
  });
}
