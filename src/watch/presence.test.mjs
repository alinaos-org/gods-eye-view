// src/watch/presence.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DESCENDING_VRATE_MPS,
  FIX_REGION,
  MEMBER_STATE,
  PRESENCE_POLICY,
  PRESENCE_TRANSITION,
  baselineMember,
  classifyFix,
  expireMember,
  initialMember,
  stepMember,
} from './presence.js';

const T0 = 1_760_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
const MARGIN = 300;
const CORE_IN = -400;
const CORE_OUT = 400;
const BAND_IN = -100;
const BAND_OUT = 100;

// ---------------------------------------------------------------- helpers

function fixAt(atMs, extra = {}) {
  return {
    lat: 51.47,
    lon: -0.45,
    fixAtMs: atMs,
    altM: 1_200,
    onGround: false,
    vRateMps: 0,
    ...extra,
  };
}

function obs(overrides = {}) {
  const nowMs = overrides.nowMs ?? T0;
  return {
    kind: 'aircraft',
    answer: 'counted',
    nowMs,
    layerId: 'flights',
    fix: fixAt(nowMs),
    fresh: true,
    distanceM: CORE_IN,
    marginM: MARGIN,
    seenOutsideBefore: true,
    absentEvidence: false,
    ...overrides,
  };
}

/** A key missing from an answering frame. */
function absent(overrides = {}) {
  return obs({ fix: null, fresh: false, distanceM: null, ...overrides });
}

/** A frame that cannot answer: no assets at all. */
function silent(answer, overrides = {}) {
  return obs({
    answer,
    fix: null,
    fresh: false,
    distanceM: null,
    ...overrides,
  });
}

function normalizedFix(atMs, extra = {}) {
  return {
    lat: 51.47,
    lon: -0.45,
    atMs,
    altM: 1_200,
    onGround: false,
    vRateMps: 0,
    ...extra,
  };
}

function member(state, overrides = {}) {
  const base = initialMember();
  const inside = {
    ...base,
    state: MEMBER_STATE.INSIDE,
    enteredAtMs: T0 - 10 * MIN,
    lastInsideFixAtMs: T0 - MIN,
    lastFix: normalizedFix(T0 - MIN),
    sources: ['flights'],
  };
  const byState = {
    outside: base,
    candidate: {
      ...base,
      state: MEMBER_STATE.CANDIDATE,
      streak: 1,
      streakStartAtMs: T0 - MIN,
      seenOutsideBefore: true,
      lastInsideFixAtMs: T0 - MIN,
      lastFix: normalizedFix(T0 - MIN),
      sources: ['flights'],
    },
    inside,
    exiting: {
      ...inside,
      state: MEMBER_STATE.EXITING,
      streak: 1,
      streakStartAtMs: T0 - MIN,
      lastInsideFixAtMs: T0 - 2 * MIN,
    },
    unknown: {
      ...inside,
      state: MEMBER_STATE.UNKNOWN,
      lastInsideFixAtMs: T0 - 3 * MIN,
      lastFix: normalizedFix(T0 - 3 * MIN),
      unknownSinceMs: T0 - 2 * MIN,
    },
  };
  return { ...byState[state], ...overrides };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertJsonSafe(value, path = 'value') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} is not finite: ${value}`);
    return;
  }
  assert.equal(type, 'object', `${path} is ${type}`);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertJsonSafe(item, `${path}[${i}]`));
    return;
  }
  assert.equal(
    Object.getPrototypeOf(value),
    Object.prototype,
    `${path} is not a plain object`,
  );
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(child, undefined, `${path}.${key} is undefined`);
    assertJsonSafe(child, `${path}.${key}`);
  }
}

/** Step with a frozen input and check the output contract. */
function stepChecked(prev, observation, policy) {
  const frozen = prev === null ? null : deepFreeze(structuredClone(prev));
  const result =
    policy === undefined
      ? stepMember(frozen, observation)
      : stepMember(frozen, observation, policy);
  assert.deepEqual(Object.keys(result).sort(), [
    'detail',
    'next',
    'transition',
  ]);
  assertJsonSafe(result.next, 'next');
  assertJsonSafe(result.detail, 'detail');
  assert.equal(result.transition === null, result.detail === null);
  if (frozen !== null) assert.deepEqual(frozen, prev, 'prev was mutated');
  return result;
}

/** Run a sequence of observations; collect every transition. */
function run(start, observations, policy) {
  let current = start;
  const transitions = [];
  const steps = [];
  for (const observation of observations) {
    const result = stepChecked(current, observation, policy);
    steps.push(result);
    if (result.transition !== null) transitions.push(result.transition);
    current = result.next;
  }
  return { member: current, transitions, steps };
}

function expireChecked(prev, context, policy) {
  const frozen = prev === null ? null : deepFreeze(structuredClone(prev));
  const result =
    policy === undefined
      ? expireMember(frozen, context)
      : expireMember(frozen, context, policy);
  assertJsonSafe(result.next, 'next');
  assertJsonSafe(result.detail, 'detail');
  assert.equal(result.transition === null, result.detail === null);
  return result;
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

// --------------------------------------------------------------- constants

test('policy, states and codes match the plan and are deeply frozen', () => {
  assert.deepEqual(PRESENCE_POLICY, {
    enterFixes: 2,
    exitFixes: 2,
    lostAfterEpochs: { aircraft: 3, vessel: 1 },
    unknownExpireMs: { aircraft: 600_000, vessel: 3_600_000 },
    rebaselineGapMs: { aircraft: 300_000, vessel: 1_800_000 },
    reentryQuietMs: 300_000,
  });
  assert.deepEqual(MEMBER_STATE, {
    OUTSIDE: 'outside',
    CANDIDATE: 'candidate',
    INSIDE: 'inside',
    EXITING: 'exiting',
    UNKNOWN: 'unknown',
  });
  assert.deepEqual(Object.values(PRESENCE_TRANSITION), [
    'enter',
    'first-seen',
    'exit',
    'exit-window',
    'unknown',
    'resume',
    'no-longer-reported',
    'expired-silent',
  ]);
  assert.deepEqual(Object.values(FIX_REGION), [
    'core-inside',
    'band',
    'core-outside',
  ]);
  assert.ok(DESCENDING_VRATE_MPS < 0);
  for (const value of [
    PRESENCE_POLICY,
    PRESENCE_POLICY.lostAfterEpochs,
    PRESENCE_POLICY.unknownExpireMs,
    PRESENCE_POLICY.rebaselineGapMs,
    MEMBER_STATE,
    PRESENCE_TRANSITION,
    FIX_REGION,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
});

test('initialMember is outside, JSON-safe, identifier-free and unshared', () => {
  const a = initialMember();
  const b = initialMember();
  assert.deepEqual(a, {
    state: 'outside',
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
  });
  assertJsonSafe(a);
  assert.notEqual(a, b);
  assert.notEqual(a.sources, b.sources);
  a.sources.push('flights');
  assert.deepEqual(b.sources, []);
});

// ------------------------------------------------------------- classifyFix

const CLASSIFY_CASES = [
  [CORE_IN, MARGIN, 'core-inside'],
  [-MARGIN, MARGIN, 'core-inside'],
  [-MARGIN + 0.001, MARGIN, 'band'],
  [BAND_IN, MARGIN, 'band'],
  [0, MARGIN, 'band'],
  [BAND_OUT, MARGIN, 'band'],
  [MARGIN - 0.001, MARGIN, 'band'],
  [MARGIN, MARGIN, 'core-outside'],
  [CORE_OUT, MARGIN, 'core-outside'],
  [-1, 0, 'core-inside'],
  [0, 0, 'core-inside'],
  [1, 0, 'core-outside'],
  [-1, Number.NaN, 'core-inside'],
  [1, -50, 'core-outside'],
  [null, MARGIN, null],
  [undefined, MARGIN, null],
  [Number.NaN, MARGIN, null],
  [Infinity, MARGIN, null],
  [-Infinity, MARGIN, null],
  ['-400', MARGIN, null],
];

test('classifyFix splits core inside, band and core outside', () => {
  for (const [distanceM, marginM, expected] of CLASSIFY_CASES) {
    assert.equal(
      classifyFix(distanceM, marginM),
      expected,
      `classifyFix(${distanceM}, ${marginM})`,
    );
  }
});

// ------------------------------------------- the transition table, cell by cell

/**
 * Each case: a starting state (with overrides), one observation, and the
 * expected transition plus the fields of `next` that must match.
 */
const STEP_CASES = [
  // outside
  {
    name: 'outside + core-inside fix starts a candidate streak',
    prev: ['outside'],
    obs: { distanceM: CORE_IN },
    transition: null,
    next: {
      state: 'candidate',
      streak: 1,
      streakStartAtMs: T0,
      seenOutsideBefore: true,
      lastInsideFixAtMs: T0,
      lastFix: normalizedFix(T0),
      sources: ['flights'],
    },
  },
  {
    name: 'outside + core-inside fix latches an unseen asset',
    prev: ['outside'],
    obs: { distanceM: CORE_IN, seenOutsideBefore: false },
    transition: null,
    next: { state: 'candidate', streak: 1, seenOutsideBefore: false },
  },
  {
    name: 'outside + fix exactly at -margin is core inside',
    prev: ['outside'],
    obs: { distanceM: -MARGIN },
    transition: null,
    next: { state: 'candidate', streak: 1 },
  },
  {
    name: 'outside + band fix (inside the edge) changes no streak',
    prev: ['outside'],
    obs: { distanceM: BAND_IN },
    transition: null,
    next: { state: 'outside', streak: 0, lastFix: normalizedFix(T0) },
  },
  {
    name: 'outside + core-outside fix stays outside',
    prev: ['outside'],
    obs: { distanceM: CORE_OUT },
    transition: null,
    next: { state: 'outside', streak: 0, streakStartAtMs: null },
  },
  {
    name: 'outside + absent key changes nothing',
    prev: ['outside'],
    obs: absent({ absentEvidence: true }),
    transition: null,
    same: true,
  },
  {
    name: 'outside + held answer changes nothing',
    prev: ['outside'],
    obs: silent('held'),
    transition: null,
    same: true,
  },

  // candidate
  {
    name: 'candidate + second core-inside fix seen outside gives enter',
    prev: ['candidate'],
    obs: { distanceM: CORE_IN },
    transition: 'enter',
    detail: { sinceMs: T0 - MIN, reentry: false, lowerBound: false },
    next: {
      state: 'inside',
      streak: 0,
      streakStartAtMs: null,
      seenOutsideBefore: false,
      enteredAtMs: T0 - MIN,
      enteredLowerBound: false,
      lastInsideFixAtMs: T0,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'candidate never seen outside confirms as first-seen',
    prev: ['candidate', { seenOutsideBefore: false }],
    obs: { distanceM: CORE_IN, seenOutsideBefore: true },
    transition: 'first-seen',
    detail: { sinceMs: T0 - MIN, reentry: false, lowerBound: true },
    next: {
      state: 'inside',
      enteredAtMs: T0 - MIN,
      enteredLowerBound: true,
    },
  },
  {
    name: 'candidate seen outside stays an enter if the confirming obs says not',
    prev: ['candidate'],
    obs: { distanceM: CORE_IN, seenOutsideBefore: false },
    transition: 'enter',
    next: { state: 'inside', enteredLowerBound: false },
  },
  {
    name: 'candidate + band fix holds the streak',
    prev: ['candidate'],
    obs: { distanceM: BAND_IN },
    transition: null,
    next: {
      state: 'candidate',
      streak: 1,
      streakStartAtMs: T0 - MIN,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'candidate + core-outside fix drops to outside',
    prev: ['candidate'],
    obs: { distanceM: CORE_OUT },
    transition: null,
    next: {
      state: 'outside',
      streak: 0,
      streakStartAtMs: null,
      seenOutsideBefore: false,
      lastInsideFixAtMs: null,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'candidate + carried core-inside fix does not advance',
    prev: ['candidate'],
    obs: { distanceM: CORE_IN, fresh: false, fix: fixAt(T0 - MIN) },
    transition: null,
    same: true,
  },
  {
    name: 'candidate + absent key drops to outside',
    prev: ['candidate'],
    obs: absent(),
    transition: null,
    next: { state: 'outside', streak: 0, streakStartAtMs: null },
  },
  {
    name: 'candidate + held answer drops to outside',
    prev: ['candidate'],
    obs: silent('held'),
    transition: null,
    next: { state: 'outside', streak: 0 },
  },
  {
    name: 'candidate + off answer drops to outside',
    prev: ['candidate'],
    obs: silent('off'),
    transition: null,
    next: { state: 'outside', streak: 0 },
  },

  // inside
  {
    name: 'inside + core-inside fix stays inside',
    prev: ['inside'],
    obs: { distanceM: CORE_IN },
    transition: null,
    next: {
      state: 'inside',
      enteredAtMs: T0 - 10 * MIN,
      lastInsideFixAtMs: T0,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'inside + band fix updates lastFix only',
    prev: ['inside'],
    obs: { distanceM: BAND_OUT },
    transition: null,
    next: {
      state: 'inside',
      streak: 0,
      lastInsideFixAtMs: T0 - MIN,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'inside + core-outside fix starts an exit streak',
    prev: ['inside'],
    obs: { distanceM: CORE_OUT },
    transition: null,
    next: {
      state: 'exiting',
      streak: 1,
      streakStartAtMs: T0,
      enteredAtMs: T0 - 10 * MIN,
      lastInsideFixAtMs: T0 - MIN,
    },
  },
  {
    name: 'inside + carried core-outside fix changes nothing',
    prev: ['inside'],
    obs: { distanceM: CORE_OUT, fresh: false, fix: fixAt(T0 - MIN) },
    transition: null,
    same: true,
  },
  {
    name: 'inside + absent key becomes unknown',
    prev: ['inside'],
    obs: absent(),
    transition: 'unknown',
    detail: { sinceMs: T0, lastInsideFixAtMs: T0 - MIN },
    next: {
      state: 'unknown',
      unknownSinceMs: T0,
      absentEpochs: 0,
      enteredAtMs: T0 - 10 * MIN,
    },
  },
  {
    name: 'inside + counted absence evidence counts one epoch',
    prev: ['inside'],
    obs: absent({ absentEvidence: true }),
    transition: 'unknown',
    next: { state: 'unknown', absentEpochs: 1 },
  },
  {
    name: 'inside + floor absence evidence is no evidence',
    prev: ['inside'],
    obs: absent({ answer: 'floor', absentEvidence: true }),
    transition: 'unknown',
    next: { state: 'unknown', absentEpochs: 0 },
  },
  {
    name: 'inside + held answer becomes unknown',
    prev: ['inside'],
    obs: silent('held'),
    transition: 'unknown',
    next: { state: 'unknown', unknownSinceMs: T0 },
  },
  {
    name: 'inside + unknown answer becomes unknown',
    prev: ['inside'],
    obs: silent('unknown'),
    transition: 'unknown',
    next: { state: 'unknown' },
  },
  {
    name: 'inside + off answer becomes unknown',
    prev: ['inside'],
    obs: silent('off'),
    transition: 'unknown',
    next: { state: 'unknown' },
  },
  {
    name: 'inside + held answer that still carries a fix becomes unknown',
    prev: ['inside'],
    obs: { answer: 'held', distanceM: CORE_IN },
    transition: 'unknown',
    next: { state: 'unknown' },
  },

  // exiting
  {
    name: 'exiting + second core-outside fix gives exit at the streak start',
    prev: ['exiting'],
    obs: { distanceM: CORE_OUT },
    transition: 'exit',
    detail: {
      exitAtMs: T0 - MIN,
      enteredAtMs: T0 - 10 * MIN,
      dwellMs: 9 * MIN,
      dwellLowerBound: false,
    },
    next: {
      state: 'outside',
      streak: 0,
      streakStartAtMs: null,
      enteredAtMs: null,
      enteredLowerBound: false,
      lastInsideFixAtMs: null,
      lastExitAtMs: T0 - MIN,
      reentry: false,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'exiting with a lower-bound entry reports a lower-bound dwell',
    prev: ['exiting', { enteredLowerBound: true }],
    obs: { distanceM: CORE_OUT },
    transition: 'exit',
    detail: {
      exitAtMs: T0 - MIN,
      enteredAtMs: T0 - 10 * MIN,
      dwellMs: 9 * MIN,
      dwellLowerBound: true,
    },
  },
  {
    name: 'exiting + core-inside fix goes back inside',
    prev: ['exiting'],
    obs: { distanceM: CORE_IN },
    transition: null,
    next: {
      state: 'inside',
      streak: 0,
      streakStartAtMs: null,
      enteredAtMs: T0 - 10 * MIN,
      lastInsideFixAtMs: T0,
    },
  },
  {
    name: 'exiting + band fix holds the streak',
    prev: ['exiting'],
    obs: { distanceM: BAND_IN },
    transition: null,
    next: {
      state: 'exiting',
      streak: 1,
      streakStartAtMs: T0 - MIN,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'exiting + carried core-outside fix does not advance',
    prev: ['exiting'],
    obs: { distanceM: CORE_OUT, fresh: false, fix: fixAt(T0 - MIN) },
    transition: null,
    same: true,
  },
  {
    name: 'exiting + absent key becomes unknown',
    prev: ['exiting'],
    obs: absent(),
    transition: 'unknown',
    detail: { sinceMs: T0, lastInsideFixAtMs: T0 - 2 * MIN },
    next: { state: 'unknown', streak: 0, streakStartAtMs: null },
  },
  {
    name: 'exiting + held answer becomes unknown',
    prev: ['exiting'],
    obs: silent('held'),
    transition: 'unknown',
    next: { state: 'unknown', streak: 0 },
  },

  // unknown
  {
    name: 'unknown + core-inside fix resumes with the dwell kept',
    prev: ['unknown'],
    obs: { distanceM: CORE_IN },
    transition: 'resume',
    detail: {
      sinceMs: T0 - 10 * MIN,
      lowerBound: false,
      unknownSinceMs: T0 - 2 * MIN,
    },
    next: {
      state: 'inside',
      enteredAtMs: T0 - 10 * MIN,
      enteredLowerBound: false,
      unknownSinceMs: null,
      absentEpochs: 0,
      lastInsideFixAtMs: T0,
    },
  },
  {
    name: 'unknown + core-outside fix gives an exit window',
    prev: ['unknown'],
    obs: { distanceM: CORE_OUT },
    transition: 'exit-window',
    detail: {
      fromMs: T0 - 3 * MIN,
      toMs: T0,
      enteredAtMs: T0 - 10 * MIN,
      dwellLowerBound: false,
    },
    next: {
      state: 'outside',
      enteredAtMs: null,
      unknownSinceMs: null,
      lastExitAtMs: T0,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'unknown + band fix stays unknown',
    prev: ['unknown'],
    obs: { distanceM: BAND_IN },
    transition: null,
    next: {
      state: 'unknown',
      unknownSinceMs: T0 - 2 * MIN,
      lastInsideFixAtMs: T0 - 3 * MIN,
      lastFix: normalizedFix(T0),
    },
  },
  {
    name: 'unknown + carried core-inside fix stays unknown',
    prev: ['unknown'],
    obs: { distanceM: CORE_IN, fresh: false, fix: fixAt(T0 - 3 * MIN) },
    transition: null,
    same: true,
  },
  {
    name: 'unknown + counted absence evidence adds an epoch',
    prev: ['unknown', { absentEpochs: 2 }],
    obs: absent({ absentEvidence: true }),
    transition: null,
    next: { state: 'unknown', absentEpochs: 3, unknownSinceMs: T0 - 2 * MIN },
  },
  {
    name: 'unknown + absence without evidence changes nothing',
    prev: ['unknown', { absentEpochs: 2 }],
    obs: absent(),
    transition: null,
    same: true,
  },
  {
    name: 'unknown + floor absence evidence changes nothing',
    prev: ['unknown', { absentEpochs: 2 }],
    obs: absent({ answer: 'floor', absentEvidence: true }),
    transition: null,
    same: true,
  },
  {
    name: 'unknown + held answer changes nothing',
    prev: ['unknown', { absentEpochs: 2 }],
    obs: silent('held', { absentEvidence: true }),
    transition: null,
    same: true,
  },
  {
    name: 'unknown + carried presence resets the absence count',
    prev: ['unknown', { absentEpochs: 2 }],
    obs: { distanceM: CORE_IN, fresh: false, fix: fixAt(T0 - 3 * MIN) },
    transition: null,
    next: { state: 'unknown', absentEpochs: 0, unknownSinceMs: T0 - 2 * MIN },
  },

  // inputs the table does not cover
  {
    name: 'a fresh fix with no finite distance changes nothing',
    prev: ['candidate'],
    obs: { distanceM: null },
    transition: null,
    same: true,
  },
  {
    name: 'an Infinity distance (invalid geometry) changes nothing',
    prev: ['inside'],
    obs: { distanceM: Infinity },
    transition: null,
    same: true,
  },
  {
    name: 'a carried fix from a new layer only records the layer',
    prev: ['inside'],
    obs: {
      distanceM: CORE_OUT,
      fresh: false,
      layerId: 'military',
      fix: fixAt(T0 - MIN),
    },
    transition: null,
    next: {
      state: 'inside',
      streak: 0,
      lastFix: normalizedFix(T0 - MIN),
      sources: ['flights', 'military'],
    },
  },
  {
    name: 'an answer object is read by its state',
    prev: ['candidate'],
    obs: { answer: { state: 'floor', reason: 'partial-snapshot' } },
    transition: 'enter',
  },
  {
    name: 'an unrecognised answer cannot answer',
    prev: ['inside'],
    obs: { answer: 'fallback' },
    transition: 'unknown',
  },
];

for (const c of STEP_CASES) {
  test(`table: ${c.name}`, () => {
    const [state, overrides] = c.prev;
    const prev = member(state, overrides);
    const observation = 'kind' in c.obs ? c.obs : obs(c.obs);
    const result = stepChecked(prev, observation);
    assert.equal(result.transition, c.transition);
    if (c.detail !== undefined) assert.deepEqual(result.detail, c.detail);
    if (c.same) assert.deepEqual(result.next, prev);
    for (const [key, value] of Object.entries(c.next ?? {})) {
      assert.deepEqual(result.next[key], value, `next.${key}`);
    }
  });
}

test('unchanged steps hand back the same record', () => {
  const prev = deepFreeze(member('inside'));
  const carried = stepMember(
    prev,
    obs({ distanceM: CORE_OUT, fresh: false, fix: fixAt(T0 - MIN) }),
  );
  assert.equal(carried.next, prev);
  const held = stepMember(deepFreeze(member('outside')), silent('held'));
  assert.equal(held.transition, null);
  const unknown = deepFreeze(member('unknown'));
  assert.equal(stepMember(unknown, silent('off')).next, unknown);
});

// ------------------------------------------------------------- sequences

test('±50 m jitter with a 300 m margin over 20 frames gives 0 transitions', () => {
  const starts = {
    outside: initialMember(),
    inside: baselineMember(fixAt(T0 - MIN), 'flights'),
  };
  for (let seed = 1; seed <= 50; seed += 1) {
    for (const [name, start] of Object.entries(starts)) {
      // Centres keep centre ± 50 m strictly inside the ±300 m band.
      for (const centreM of [-240, 0, 240]) {
        const rand = lcg(seed * 31 + centreM);
        const frames = Array.from({ length: 20 }, (_, i) => {
          const nowMs = T0 + i * 10 * SEC;
          const jitterM = (rand() * 2 - 1) * 50;
          return obs({ nowMs, distanceM: centreM + jitterM });
        });
        const { member: end, transitions } = run(start, frames);
        assert.deepEqual(transitions, [], `${name} seed ${seed} at ${centreM}`);
        assert.equal(end.state, start.state, `${name} seed ${seed}`);
        assert.equal(end.streak, 0);
      }
    }
  }
});

test('the margin is what absorbs the jitter', () => {
  const pattern = [-50, -50, 50, 50, -50, -50, 50, 50];
  const frames = (marginM) =>
    pattern.map((distanceM, i) =>
      obs({ nowMs: T0 + i * 10 * SEC, distanceM, marginM }),
    );
  assert.deepEqual(run(initialMember(), frames(MARGIN)).transitions, []);
  assert.deepEqual(run(initialMember(), frames(0)).transitions, [
    'enter',
    'exit',
    'enter',
    'exit',
  ]);
});

test('two fixes confirm an entry seen from outside', () => {
  const frames = [
    obs({ nowMs: T0, distanceM: 2_000, seenOutsideBefore: false }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: CORE_IN, seenOutsideBefore: true }),
    obs({ nowMs: T0 + 20 * SEC, distanceM: CORE_IN, seenOutsideBefore: true }),
  ];
  const { member: end, transitions, steps } = run(initialMember(), frames);
  assert.deepEqual(transitions, ['enter']);
  assert.equal(steps[1].next.state, 'candidate');
  assert.equal(steps[1].transition, null);
  assert.equal(end.state, 'inside');
  assert.equal(end.enteredAtMs, T0 + 10 * SEC);
  assert.equal(end.enteredLowerBound, false);
  assert.deepEqual(steps[2].detail, {
    sinceMs: T0 + 10 * SEC,
    reentry: false,
    lowerBound: false,
  });
});

test('a single core-inside spike never confirms', () => {
  const frames = [
    obs({ nowMs: T0, distanceM: CORE_IN }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: CORE_OUT }),
    obs({ nowMs: T0 + 20 * SEC, distanceM: CORE_IN }),
    obs({ nowMs: T0 + 30 * SEC, distanceM: BAND_OUT }),
    obs({ nowMs: T0 + 40 * SEC, distanceM: CORE_OUT }),
  ];
  const { member: end, transitions } = run(initialMember(), frames);
  assert.deepEqual(transitions, []);
  assert.equal(end.state, 'outside');
});

test('a take-off inside the zone is first-seen, not an enter', () => {
  // The engine reports key presence in the previous epoch: false for the
  // first fix, true from the second fix on (it was present, inside).
  const frames = [
    obs({ nowMs: T0, distanceM: -5_000, seenOutsideBefore: false }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: -5_100, seenOutsideBefore: true }),
    obs({ nowMs: T0 + 20 * SEC, distanceM: -5_200, seenOutsideBefore: true }),
  ];
  const { member: end, transitions, steps } = run(initialMember(), frames);
  assert.deepEqual(transitions, ['first-seen']);
  assert.equal(end.enteredAtMs, T0);
  assert.equal(end.enteredLowerBound, true);
  assert.deepEqual(steps[1].detail, {
    sinceMs: T0,
    reentry: false,
    lowerBound: true,
  });
  // Leaving later reports the dwell as a lower bound.
  const exit = run(end, [
    obs({ nowMs: T0 + 5 * MIN, distanceM: CORE_OUT }),
    obs({ nowMs: T0 + 5 * MIN + 10 * SEC, distanceM: CORE_OUT }),
  ]);
  assert.deepEqual(exit.transitions, ['exit']);
  assert.deepEqual(exit.steps[1].detail, {
    exitAtMs: T0 + 5 * MIN,
    enteredAtMs: T0,
    dwellMs: 5 * MIN,
    dwellLowerBound: true,
  });
});

test('a carried fix never advances a streak', () => {
  const carried = (state, distanceM, fixMs) =>
    Array.from({ length: 6 }, (_, i) =>
      obs({
        nowMs: T0 + i * 10 * SEC,
        distanceM,
        fresh: false,
        fix: fixAt(fixMs),
      }),
    );
  const cases = [
    ['candidate', CORE_IN, T0 - MIN],
    ['inside', CORE_OUT, T0 - MIN],
    ['exiting', CORE_OUT, T0 - MIN],
    ['unknown', CORE_IN, T0 - 3 * MIN],
    ['unknown', CORE_OUT, T0 - 3 * MIN],
    ['outside', CORE_IN, T0 - MIN],
  ];
  for (const [state, distanceM, fixMs] of cases) {
    const start = member(state, { sources: ['flights'] });
    const { member: end, transitions } = run(
      start,
      carried(state, distanceM, fixMs),
    );
    assert.deepEqual(transitions, [], state);
    assert.deepEqual(end, start, state);
  }
  // One real repeat after a carried run advances exactly once.
  const { member: end, transitions } = run(member('candidate'), [
    ...carried('candidate', CORE_IN, T0 - MIN),
    obs({ nowMs: T0 + MIN, distanceM: CORE_IN }),
  ]);
  assert.deepEqual(transitions, ['enter']);
  assert.equal(end.enteredAtMs, T0 - MIN);
});

test('a stale feed mid-dwell gives unknown, and recovery inside resumes', () => {
  const entered = run(initialMember(), [
    obs({ nowMs: T0, distanceM: CORE_IN }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: CORE_IN }),
    obs({ nowMs: T0 + 2 * MIN, distanceM: -1_000 }),
  ]);
  assert.deepEqual(entered.transitions, ['enter']);
  const stale = run(entered.member, [
    silent('held', { nowMs: T0 + 3 * MIN }),
    silent('held', { nowMs: T0 + 4 * MIN }),
    silent('unknown', { nowMs: T0 + 5 * MIN }),
  ]);
  assert.deepEqual(stale.transitions, ['unknown']);
  assert.equal(stale.member.state, 'unknown');
  assert.equal(stale.member.unknownSinceMs, T0 + 3 * MIN);
  assert.equal(stale.member.lastInsideFixAtMs, T0 + 2 * MIN);
  const recovered = run(stale.member, [
    obs({ nowMs: T0 + 6 * MIN, distanceM: -900 }),
  ]);
  assert.deepEqual(recovered.transitions, ['resume']);
  assert.equal(recovered.member.state, 'inside');
  assert.equal(recovered.member.enteredAtMs, T0);
  assert.equal(recovered.member.enteredLowerBound, false);
  assert.deepEqual(recovered.steps[0].detail, {
    sinceMs: T0,
    lowerBound: false,
    unknownSinceMs: T0 + 3 * MIN,
  });
  // The dwell runs from the original entry.
  const exit = run(recovered.member, [
    obs({ nowMs: T0 + 8 * MIN, distanceM: CORE_OUT }),
    obs({ nowMs: T0 + 8 * MIN + 10 * SEC, distanceM: CORE_OUT }),
  ]);
  assert.deepEqual(exit.transitions, ['exit']);
  assert.equal(exit.steps[1].detail.dwellMs, 8 * MIN);
});

test('a stale feed mid-dwell, recovering outside, gives an exit window', () => {
  const inside = run(initialMember(), [
    obs({ nowMs: T0, distanceM: CORE_IN }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: CORE_IN }),
    obs({ nowMs: T0 + MIN, distanceM: BAND_IN }),
  ]).member;
  const result = run(inside, [
    silent('held', { nowMs: T0 + 2 * MIN }),
    obs({ nowMs: T0 + 7 * MIN, distanceM: 3_000 }),
  ]);
  assert.deepEqual(result.transitions, ['unknown', 'exit-window']);
  // From the last core-inside fix (the band fix at T0+1min is not core).
  assert.deepEqual(result.steps[1].detail, {
    fromMs: T0 + 10 * SEC,
    toMs: T0 + 7 * MIN,
    enteredAtMs: T0,
    dwellLowerBound: false,
  });
  assert.equal(result.member.state, 'outside');
  assert.equal(result.member.lastExitAtMs, T0 + 7 * MIN);
});

test('unknown in the band waits for a core fix', () => {
  const result = run(member('unknown'), [
    obs({ nowMs: T0, distanceM: BAND_IN }),
    obs({ nowMs: T0 + 10 * SEC, distanceM: BAND_OUT }),
    obs({ nowMs: T0 + 20 * SEC, distanceM: CORE_OUT }),
  ]);
  assert.deepEqual(result.transitions, ['exit-window']);
  assert.equal(result.steps[2].detail.fromMs, T0 - 3 * MIN);
});

// ------------------------------------------------------------- expiry

function goneInside(kind, observations) {
  const start = member('inside', {
    lastFix: normalizedFix(T0 - MIN, { altM: 150, onGround: false }),
  });
  return run(start, observations).member;
}

test('absence under a floor answer expires silently', () => {
  const unknown = goneInside('aircraft', [
    absent({ nowMs: T0, answer: 'floor', absentEvidence: true }),
    absent({ nowMs: T0 + MIN, answer: 'floor', absentEvidence: true }),
    absent({ nowMs: T0 + 2 * MIN, answer: 'floor', absentEvidence: true }),
    absent({ nowMs: T0 + 3 * MIN, answer: 'floor', absentEvidence: true }),
  ]);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.absentEpochs, 0);
  const early = expireChecked(unknown, {
    nowMs: T0 + 10 * MIN - 1,
    kind: 'aircraft',
  });
  assert.equal(early.transition, null);
  assert.deepEqual(early.next, unknown);
  const due = expireChecked(unknown, {
    nowMs: T0 + 10 * MIN,
    kind: 'aircraft',
  });
  assert.equal(due.transition, 'expired-silent');
  assert.deepEqual(due.detail, {
    lastFixAtMs: T0 - MIN,
    absentEpochs: 0,
    unknownSinceMs: T0,
  });
  assert.equal(due.next.state, 'outside');
});

test('a held feed past expiry is silent too', () => {
  const unknown = goneInside('aircraft', [
    silent('held', { nowMs: T0 }),
    silent('held', { nowMs: T0 + 5 * MIN }),
  ]);
  const due = expireChecked(unknown, {
    nowMs: T0 + 30 * MIN,
    kind: 'aircraft',
  });
  assert.equal(due.transition, 'expired-silent');
});

test('counted absence for 3 aircraft epochs plus 10 min is no-longer-reported', () => {
  const frames = [0, 1, 2].map((i) =>
    absent({ nowMs: T0 + i * 10 * SEC, absentEvidence: true }),
  );
  const unknown = goneInside('aircraft', frames);
  assert.equal(unknown.absentEpochs, 3);
  assert.equal(unknown.unknownSinceMs, T0);
  assert.equal(
    expireChecked(unknown, { nowMs: T0 + 10 * MIN - 1, kind: 'aircraft' })
      .transition,
    null,
  );
  const due = expireChecked(unknown, {
    nowMs: T0 + 10 * MIN,
    kind: 'aircraft',
  });
  assert.equal(due.transition, 'no-longer-reported');
  assert.deepEqual(due.detail, {
    lastFixAtMs: T0 - MIN,
    lastAltM: 150,
    lastOnGround: false,
    lastVRateMps: 0,
    descending: false,
    absentEpochs: 3,
    unknownSinceMs: T0,
  });
  assert.equal(due.next.state, 'outside');
  assert.deepEqual(due.next.lastFix, unknown.lastFix);
  assert.equal(due.next.absentEpochs, 0);
  assert.deepEqual(due.next.sources, []);
});

test('two counted aircraft epochs are not enough', () => {
  const frames = [0, 1].map((i) =>
    absent({ nowMs: T0 + i * 10 * SEC, absentEvidence: true }),
  );
  const unknown = goneInside('aircraft', frames);
  const due = expireChecked(unknown, {
    nowMs: T0 + 20 * MIN,
    kind: 'aircraft',
  });
  assert.equal(due.transition, 'expired-silent');
  assert.equal(due.detail.absentEpochs, 2);
});

test('a vessel needs 1 counted epoch plus 60 min', () => {
  const unknown = goneInside('vessel', [
    absent({
      kind: 'vessel',
      layerId: 'ais-live-vessels',
      absentEvidence: true,
    }),
  ]);
  assert.equal(unknown.absentEpochs, 1);
  const context = (nowMs) => ({ nowMs, kind: 'vessel' });
  assert.equal(expireChecked(unknown, context(T0 + 10 * MIN)).transition, null);
  assert.equal(
    expireChecked(unknown, context(T0 + 60 * MIN - 1)).transition,
    null,
  );
  const due = expireChecked(unknown, context(T0 + 60 * MIN));
  assert.equal(due.transition, 'no-longer-reported');
  assert.equal(due.detail.absentEpochs, 1);
  const unseen = goneInside('vessel', [
    silent('held', { kind: 'vessel', layerId: 'ais-live-vessels' }),
  ]);
  assert.equal(
    expireChecked(unseen, context(T0 + 60 * MIN)).transition,
    'expired-silent',
  );
});

test('absence evidence must be consecutive', () => {
  const unknown = goneInside('aircraft', [
    absent({ nowMs: T0, absentEvidence: true }),
    absent({ nowMs: T0 + 10 * SEC, absentEvidence: true }),
    obs({
      nowMs: T0 + 20 * SEC,
      distanceM: CORE_IN,
      fresh: false,
      fix: fixAt(T0 - MIN),
    }),
    absent({ nowMs: T0 + 30 * SEC, absentEvidence: true }),
  ]);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.absentEpochs, 1);
  const due = expireChecked(unknown, {
    nowMs: T0 + 11 * MIN,
    kind: 'aircraft',
  });
  assert.equal(due.transition, 'expired-silent');
});

test('the last report says whether the aircraft was descending or on the ground', () => {
  const cases = [
    [{ vRateMps: -6, onGround: false }, true, false],
    [{ vRateMps: DESCENDING_VRATE_MPS, onGround: false }, true, false],
    [{ vRateMps: -0.3, onGround: false }, false, false],
    [{ vRateMps: 4, onGround: false }, false, false],
    [{ vRateMps: null, onGround: true }, null, true],
    [{ vRateMps: null, onGround: null }, null, null],
  ];
  for (const [fixExtra, descending, onGround] of cases) {
    const unknown = member('unknown', {
      absentEpochs: 3,
      lastFix: normalizedFix(T0 - 3 * MIN, fixExtra),
    });
    const due = expireChecked(unknown, {
      nowMs: T0 + MIN * 30,
      kind: 'aircraft',
    });
    assert.equal(due.transition, 'no-longer-reported');
    assert.equal(due.detail.descending, descending, JSON.stringify(fixExtra));
    assert.equal(due.detail.lastOnGround, onGround);
  }
});

test('expireMember leaves members that are not unknown alone', () => {
  for (const state of ['outside', 'candidate', 'inside', 'exiting']) {
    const prev = member(state, { absentEpochs: 5 });
    const result = expireChecked(prev, {
      nowMs: T0 + 24 * 60 * MIN,
      kind: 'aircraft',
    });
    assert.equal(result.transition, null, state);
    assert.deepEqual(result.next, prev);
  }
});

test('expireMember tolerates odd input without guessing', () => {
  const unknown = member('unknown', { absentEpochs: 3 });
  // No usable clock: nothing happens.
  for (const nowMs of [null, Number.NaN, '1']) {
    assert.equal(
      expireChecked(unknown, { nowMs, kind: 'aircraft' }).transition,
      null,
    );
  }
  assert.equal(expireChecked(unknown, null).transition, null);
  // An unknown kind takes the most cautious configured values.
  const context = (nowMs) => ({ nowMs, kind: 'satellite' });
  assert.equal(
    expireChecked(unknown, context(T0 - 2 * MIN + 30 * MIN)).transition,
    null,
  );
  assert.equal(
    expireChecked(unknown, context(T0 - 2 * MIN + 60 * MIN)).transition,
    'no-longer-reported',
  );
  // No record at all.
  const none = expireChecked(null, { nowMs: T0, kind: 'aircraft' });
  assert.equal(none.transition, null);
  assert.deepEqual(none.next, initialMember());
  // Unknown with no time reference cannot be placed: it goes silently.
  const untimed = member('unknown', {
    unknownSinceMs: null,
    lastFix: null,
    absentEpochs: 9,
  });
  assert.equal(
    expireChecked(untimed, { nowMs: T0, kind: 'aircraft' }).transition,
    'expired-silent',
  );
  // Without unknownSinceMs the last fix time is the reference.
  const fromFix = member('unknown', { unknownSinceMs: null, absentEpochs: 3 });
  assert.equal(
    expireChecked(fromFix, { nowMs: T0 - 3 * MIN + 10 * MIN, kind: 'aircraft' })
      .transition,
    'no-longer-reported',
  );
});

// ------------------------------------------------------------- re-entry

function exitAt(exitMs) {
  return run(member('inside'), [
    obs({ nowMs: exitMs, distanceM: CORE_OUT }),
    obs({ nowMs: exitMs + 10 * SEC, distanceM: CORE_OUT }),
  ]);
}

function reenterAt(start, entryMs, seenOutsideBefore = true) {
  return run(start, [
    obs({ nowMs: entryMs, distanceM: CORE_IN, seenOutsideBefore }),
    obs({ nowMs: entryMs + 10 * SEC, distanceM: CORE_IN }),
  ]);
}

test('re-entry within 5 min sets the flag', () => {
  const exited = exitAt(T0);
  assert.deepEqual(exited.transitions, ['exit']);
  assert.equal(exited.member.lastExitAtMs, T0);
  const cases = [
    [4 * MIN, true],
    [5 * MIN, true],
    [5 * MIN + 1, false],
    [6 * MIN, false],
  ];
  for (const [afterMs, reentry] of cases) {
    const result = reenterAt(exited.member, T0 + afterMs);
    assert.deepEqual(result.transitions, ['enter']);
    assert.equal(result.member.reentry, reentry, `after ${afterMs} ms`);
    assert.equal(result.steps[1].detail.reentry, reentry);
  }
  const firstSeen = reenterAt(exited.member, T0 + 2 * MIN, false);
  assert.deepEqual(firstSeen.transitions, ['first-seen']);
  assert.equal(firstSeen.member.reentry, true);
});

test('the flag clears when the member leaves again', () => {
  const back = reenterAt(exitAt(T0).member, T0 + MIN).member;
  assert.equal(back.reentry, true);
  const again = run(back, [
    obs({ nowMs: T0 + 3 * MIN, distanceM: CORE_OUT }),
    obs({ nowMs: T0 + 3 * MIN + 10 * SEC, distanceM: CORE_OUT }),
  ]);
  assert.deepEqual(again.transitions, ['exit']);
  assert.equal(again.member.reentry, false);
});

test('an exit window also starts the re-entry clock', () => {
  const windowed = run(member('unknown'), [
    obs({ nowMs: T0, distanceM: CORE_OUT }),
  ]);
  assert.deepEqual(windowed.transitions, ['exit-window']);
  const result = reenterAt(windowed.member, T0 + 3 * MIN);
  assert.equal(result.member.reentry, true);
});

// ------------------------------------------------------------- baseline

test('baselineMember is inside with a lower-bound entry', () => {
  const asset = {
    key: 'abc123',
    kind: 'aircraft',
    id: 'abc123',
    lat: 51.47,
    lon: -0.45,
    altM: 900,
    onGround: false,
    vRateMps: -3,
    fixAtMs: T0,
    layerId: 'flights',
  };
  const baseline = baselineMember(asset, 'flights');
  assertJsonSafe(baseline);
  assert.deepEqual(baseline, {
    ...initialMember(),
    state: 'inside',
    enteredAtMs: T0,
    enteredLowerBound: true,
    lastInsideFixAtMs: T0,
    lastFix: {
      lat: 51.47,
      lon: -0.45,
      atMs: T0,
      altM: 900,
      onGround: false,
      vRateMps: -3,
    },
    sources: ['flights'],
  });
  // A vessel fix has no altitude, ground flag or vertical rate.
  const vessel = baselineMember(
    { lat: 1, lon: 103.8, fixAtMs: T0, speedKts: 0.2 },
    'ais-live-vessels',
  );
  assert.deepEqual(vessel.lastFix, {
    lat: 1,
    lon: 103.8,
    atMs: T0,
    altM: null,
    onGround: null,
    vRateMps: null,
  });
  assert.deepEqual(baselineMember(fixAt(T0), null).sources, []);
  const fallback = baselineMember({ lat: 1, lon: 2 }, 'flights', T0 + 5);
  assert.equal(fallback.enteredAtMs, T0 + 5);
  assert.equal(baselineMember(null, 'flights', T0).enteredAtMs, T0);
  assertJsonSafe(baselineMember(null, 'flights'));
});

test('assets present at the baseline produce no events until they move', () => {
  const start = baselineMember(fixAt(T0), 'flights');
  const frames = Array.from({ length: 10 }, (_, i) =>
    obs({ nowMs: T0 + (i + 1) * 10 * SEC, distanceM: -2_000 + i * 10 }),
  );
  const { member: end, transitions } = run(start, frames);
  assert.deepEqual(transitions, []);
  assert.equal(end.state, 'inside');
  assert.equal(end.enteredAtMs, T0);
  assert.equal(end.enteredLowerBound, true);
});

// ------------------------------------------------------------- policy

test('a custom policy changes the fix counts', () => {
  const three = { ...PRESENCE_POLICY, enterFixes: 3 };
  const entry = run(
    initialMember(),
    [0, 1, 2].map((i) => obs({ nowMs: T0 + i * 10 * SEC, distanceM: CORE_IN })),
    three,
  );
  assert.deepEqual(entry.transitions, ['enter']);
  assert.equal(entry.steps[1].next.state, 'candidate');
  assert.equal(entry.steps[1].next.streak, 2);
  assert.equal(entry.member.enteredAtMs, T0);

  const instant = run(member('inside'), [obs({ distanceM: CORE_OUT })], {
    exitFixes: 1,
  });
  assert.deepEqual(instant.transitions, ['exit']);
  assert.equal(instant.steps[0].detail.exitAtMs, T0);

  const instantEntry = run(
    initialMember(),
    [obs({ distanceM: CORE_IN, seenOutsideBefore: false })],
    { enterFixes: 1 },
  );
  assert.deepEqual(instantEntry.transitions, ['first-seen']);
});

test('a partial or malformed policy falls back to the defaults', () => {
  const policies = [
    {},
    null,
    'strict',
    { enterFixes: 0, exitFixes: -2, reentryQuietMs: Number.NaN },
    { enterFixes: 1.5, lostAfterEpochs: { aircraft: 'many' } },
  ];
  for (const policy of policies) {
    const entry = run(
      initialMember(),
      [obs({ nowMs: T0 }), obs({ nowMs: T0 + 10 * SEC })],
      policy,
    );
    assert.deepEqual(entry.transitions, ['enter'], JSON.stringify(policy));
    assert.equal(entry.steps[0].transition, null);
  }
  const unknown = member('unknown', { absentEpochs: 2 });
  const lenient = { lostAfterEpochs: { aircraft: 2 } };
  assert.equal(
    expireChecked(unknown, { nowMs: T0 + 9 * MIN, kind: 'aircraft' }, lenient)
      .transition,
    'no-longer-reported',
  );
  const quick = { unknownExpireMs: { aircraft: MIN } };
  assert.equal(
    expireChecked(unknown, { nowMs: T0, kind: 'aircraft' }, quick).transition,
    'expired-silent',
  );
  // lostAfterEpochs never drops below one epoch of evidence.
  const none = member('unknown', { absentEpochs: 0 });
  const zero = { lostAfterEpochs: { aircraft: 0 } };
  assert.equal(
    expireChecked(none, { nowMs: T0 + 9 * MIN, kind: 'aircraft' }, zero)
      .transition,
    'expired-silent',
  );
});

// ------------------------------------------------------------- robustness

test('missing or malformed records and observations', () => {
  const fresh = stepChecked(null, obs({ distanceM: CORE_IN }));
  assert.equal(fresh.next.state, 'candidate');
  const bogus = stepChecked({ state: 'floating' }, obs({ distanceM: CORE_IN }));
  assert.equal(bogus.next.state, 'candidate');
  assert.equal(stepChecked(member('inside'), null).transition, 'unknown');
  assert.equal(stepChecked(member('inside'), {}).transition, 'unknown');
  // A fix with no time takes the observation time.
  const untimed = stepChecked(
    member('outside'),
    obs({ fix: { lat: 1, lon: 2 }, distanceM: CORE_IN }),
  );
  assert.equal(untimed.next.streakStartAtMs, T0);
  assert.equal(untimed.next.lastFix.atMs, T0);
  // An explicit atMs wins over fixAtMs.
  const timed = stepChecked(
    member('outside'),
    obs({ fix: { lat: 1, lon: 2, atMs: T0 - 5, fixAtMs: T0 - 9 } }),
  );
  assert.equal(timed.next.lastFix.atMs, T0 - 5);
  // Unknown with no clock keeps the last fix time as its start.
  const clockless = stepChecked(
    member('inside'),
    absent({ nowMs: Number.NaN }),
  );
  assert.equal(clockless.next.unknownSinceMs, T0 - MIN);
});

test('property: frames that cannot answer never move a member out or in', () => {
  const rand = lcg(20_261_026);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  for (let seq = 0; seq < 300; seq += 1) {
    let current = initialMember();
    for (let i = 0; i < 40; i += 1) {
      const nowMs = T0 + i * 10 * SEC;
      const kind = pick([
        'answering',
        'answering',
        'silent',
        'absent',
        'carried',
      ]);
      const distanceM = (rand() * 2 - 1) * 1_500;
      let observation;
      if (kind === 'silent') {
        observation = silent(pick(['held', 'unknown', 'off']), {
          nowMs,
          absentEvidence: rand() < 0.5,
        });
      } else if (kind === 'absent') {
        observation = absent({
          nowMs,
          answer: pick(['counted', 'floor']),
          absentEvidence: rand() < 0.5,
        });
      } else {
        observation = obs({
          nowMs,
          answer: pick(['counted', 'floor']),
          distanceM,
          fresh: kind === 'answering',
          fix: fixAt(kind === 'answering' ? nowMs : T0 - MIN),
          seenOutsideBefore: rand() < 0.5,
        });
      }
      const result = stepChecked(current, observation);
      if (kind === 'silent' || kind === 'absent') {
        assert.ok(
          result.transition === null || result.transition === 'unknown',
          `${kind} gave ${result.transition}`,
        );
        if (kind === 'silent') {
          assert.equal(result.next.absentEpochs, current.absentEpochs);
        }
      }
      if (kind === 'carried') {
        assert.equal(result.transition, null);
        assert.equal(result.next.state, current.state);
        assert.equal(result.next.streak, current.streak);
      }
      const { next } = result;
      assert.ok(Object.values(MEMBER_STATE).includes(next.state));
      if (next.state === 'candidate' || next.state === 'exiting') {
        assert.ok(next.streak >= 1 && next.streak < 2);
        assert.notEqual(next.streakStartAtMs, null);
      } else {
        assert.equal(next.streak, 0);
        assert.equal(next.streakStartAtMs, null);
      }
      if (next.state === 'unknown') assert.notEqual(next.unknownSinceMs, null);
      else assert.equal(next.unknownSinceMs, null);
      if (next.state === 'outside' || next.state === 'candidate') {
        assert.equal(next.enteredAtMs, null);
      } else {
        assert.notEqual(next.enteredAtMs, null);
      }
      current = next;
    }
  }
});

// ------------------------------------------------------------- portability

test('the module is portable: no imports, clocks, randomness or globals', () => {
  const source = readFileSync(
    new URL('./presence.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  for (const banned of [
    'Date.now',
    'new Date',
    'Math.random',
    'setTimeout',
    'setInterval',
    'localStorage',
    'sessionStorage',
    'window.',
    'document.',
    'globalThis',
    'Cesium',
  ]) {
    assert.ok(!source.includes(banned), `presence.js mentions ${banned}`);
  }
  assert.doesNotMatch(source, /\b(label|title|status|hint)\s*:\s*['"`]/);
  assert.doesNotMatch(source, /owner|registrant/i);
});
