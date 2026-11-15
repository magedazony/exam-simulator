import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateExam, scoreAttempt } from '../src/index.ts';
import {
  advance,
  closeSection,
  remainingMs,
  resumeFromBreak,
  saveAnswer,
  sectionReview,
  setFlag,
  startAttempt,
  submit,
  toResponses,
  visibleOrdinals,
} from '../src/session.ts';
import type { AttemptState, SessionResult } from '../src/session.ts';
import { buildPool, loadBlueprint } from './helpers.ts';

const bp = loadBlueprint(); // sections 20 / 80 / 80, breaks 10 / 10 / none, 240 minutes
const pool = buildPool(bp, { perTask: 50, caseSets: 16 });
const gen = generateExam(bp, pool, { seed: 2026 });
assert.ok(gen.ok);
const form = gen.form;

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const ok = (r: SessionResult): AttemptState => {
  assert.ok(r.ok, r.ok ? '' : r.code);
  return r.state;
};
const fail = (r: SessionResult): string => {
  assert.equal(r.ok, false);
  return r.ok ? '' : r.code;
};
const keyOf = (ordinal: number): string[] =>
  pool.get(form.items[ordinal - 1]!.questionId)!.options.filter((o) => o.isCorrect).map((o) => o.id);
const answer = (s: AttemptState, ordinal: number, selected: string[], at: number, seq = 1) =>
  saveAnswer(s, form, pool, { ordinal, selected, clientSeq: seq }, at);

describe('starting an attempt', () => {
  it('opens only the first section and sets a 240-minute deadline', () => {
    const s = startAttempt(bp, form, T0);
    assert.equal(s.status, 'in_progress');
    assert.deepEqual(s.sections.map((x) => x.state), ['open', 'locked', 'locked']);
    assert.equal(s.deadlineMs - T0, 240 * MIN);
    assert.equal(remainingMs(s, T0 + 30 * MIN), 210 * MIN);
    assert.deepEqual(visibleOrdinals(s, form), Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('saving answers', () => {
  const s0 = startAttempt(bp, form, T0);

  it('saves, changes and clears an answer in the open section', () => {
    let s = ok(answer(s0, 1, ['a'], T0 + 1000, 1));
    assert.deepEqual(s.answers[1]!.selected, ['a']);
    s = ok(answer(s, 1, ['b'], T0 + 2000, 2));
    assert.deepEqual(s.answers[1]!.selected, ['b']);
    s = ok(answer(s, 1, [], T0 + 3000, 3));
    assert.deepEqual(s.answers[1]!.selected, []);
    assert.equal(sectionReview(s, form, 0).answered, 0);
  });

  it('ignores a repeated or late save instead of overwriting newer data', () => {
    let s = ok(answer(s0, 2, ['a'], T0 + 1000, 5));
    const r = answer(s, 2, ['d'], T0 + 2000, 4);
    assert.ok(r.ok && r.note === 'stale_ignored');
    s = r.state;
    assert.deepEqual(s.answers[2]!.selected, ['a']);
    const again = answer(s, 2, ['a'], T0 + 3000, 5);
    assert.ok(again.ok && again.note === 'stale_ignored');
  });

  it('does not mutate the state it was given', () => {
    const before = structuredClone(s0);
    ok(answer(s0, 3, ['a'], T0 + 1000));
    assert.deepEqual(s0, before);
  });

  it('rejects questions outside the open section', () => {
    assert.equal(fail(answer(s0, 21, ['a'], T0 + 1000)), 'section_locked');
    assert.equal(fail(answer(s0, 181, ['a'], T0 + 1000)), 'unknown_ordinal');
    assert.equal(fail(answer(s0, 0, ['a'], T0 + 1000)), 'unknown_ordinal');
  });

  it('rejects option ids that do not belong to the question, and too many selections', () => {
    assert.equal(fail(answer(s0, 1, ['zzz'], T0 + 1000)), 'invalid_option');
    const single = form.items.find((i) => i.sectionIndex === 0 && pool.get(i.questionId)!.type === 'single')!;
    assert.equal(fail(answer(s0, single.ordinal, ['a', 'b'], T0 + 1000)), 'too_many_selections');
  });

  it('flags and unflags without touching the answer', () => {
    let s = ok(answer(s0, 4, ['a'], T0 + 1000));
    s = ok(setFlag(s, form, 4, true, T0 + 2000));
    s = ok(setFlag(s, form, 7, true, T0 + 2000));
    assert.deepEqual(sectionReview(s, form, 0).flagged, [4, 7]);
    s = ok(setFlag(s, form, 4, false, T0 + 3000));
    assert.deepEqual(s.flags, [7]);
    assert.deepEqual(s.answers[4]!.selected, ['a']);
    assert.equal(fail(setFlag(s, form, 50, true, T0 + 3000)), 'section_locked');
  });
});

describe('sections, breaks and locking', () => {
  const s0 = ok(answer(startAttempt(bp, form, T0), 1, ['a'], T0 + MIN));
  const onBreak = ok(closeSection(s0, bp, T0 + 30 * MIN));

  it('closing the case section starts a 10-minute break and locks the section', () => {
    assert.equal(onBreak.status, 'on_break');
    assert.equal(onBreak.sections[0]!.state, 'closed');
    assert.equal(onBreak.breakEndsAtMs! - onBreak.breakStartedAtMs!, 10 * MIN);
    assert.deepEqual(visibleOrdinals(onBreak, form), []);
    assert.equal(fail(answer(onBreak, 1, ['b'], T0 + 31 * MIN, 9)), 'on_break');
    assert.equal(fail(answer(onBreak, 21, ['a'], T0 + 31 * MIN)), 'on_break');
  });

  it('the exam clock is frozen during the break', () => {
    assert.equal(remainingMs(onBreak, T0 + 30 * MIN), 210 * MIN);
    assert.equal(remainingMs(onBreak, T0 + 36 * MIN), 210 * MIN);
  });

  it('resuming early opens the next section and adds back only the break time used', () => {
    const s = ok(resumeFromBreak(onBreak, T0 + 34 * MIN));
    assert.equal(s.status, 'in_progress');
    assert.deepEqual(s.sections.map((x) => x.state), ['closed', 'open', 'locked']);
    assert.equal(s.deadlineMs, T0 + 244 * MIN);
    assert.equal(remainingMs(s, T0 + 34 * MIN), 210 * MIN);
    assert.equal(visibleOrdinals(s, form).length, 80);
  });

  it('a break that runs out ends by itself; extra time away costs exam time', () => {
    const s = advance(onBreak, T0 + 55 * MIN);
    assert.equal(s.status, 'in_progress');
    assert.equal(s.sections[1]!.openedAtMs, T0 + 40 * MIN);
    assert.equal(s.deadlineMs, T0 + 250 * MIN);
    assert.equal(remainingMs(s, T0 + 55 * MIN), 195 * MIN);
  });

  it('a closed section can never be answered again', () => {
    const s = ok(resumeFromBreak(onBreak, T0 + 34 * MIN));
    assert.equal(fail(answer(s, 1, ['b'], T0 + 35 * MIN, 9)), 'section_locked');
    assert.deepEqual(s.answers[1]!.selected, ['a']);
    assert.equal(fail(setFlag(s, form, 1, true, T0 + 35 * MIN)), 'section_locked');
  });

  it('resume is refused when there is no break, and is harmless after an automatic resume', () => {
    assert.equal(fail(resumeFromBreak(s0, T0 + 5 * MIN)), 'not_on_break');
    const late = ok(resumeFromBreak(onBreak, T0 + 45 * MIN));
    assert.equal(late.sections[1]!.openedAtMs, T0 + 40 * MIN);
  });

  it('the last section cannot be closed, only submitted; earlier sections cannot be submitted', () => {
    assert.equal(fail(submit(s0, T0 + 5 * MIN)), 'not_last_section');
    assert.equal(fail(submit(onBreak, T0 + 31 * MIN)), 'on_break');
    let s = ok(resumeFromBreak(onBreak, T0 + 34 * MIN));
    s = ok(closeSection(s, bp, T0 + 120 * MIN));
    s = ok(resumeFromBreak(s, T0 + 125 * MIN));
    assert.equal(s.currentSection, 2);
    assert.equal(fail(closeSection(s, bp, T0 + 130 * MIN)), 'last_section');
  });

  it('with the pause switched off, break time counts against the exam', () => {
    const opts = { breakPausesClock: false };
    const b = ok(closeSection(s0, bp, T0 + 30 * MIN, opts));
    const s = ok(resumeFromBreak(b, T0 + 34 * MIN, opts));
    assert.equal(s.deadlineMs, T0 + 240 * MIN);
    assert.equal(advance(b, T0 + 241 * MIN, opts).status, 'expired');
  });
});

describe('expiry and submission', () => {
  it('expires at the deadline and keeps every answer saved before it', () => {
    let s = startAttempt(bp, form, T0);
    s = ok(answer(s, 1, keyOf(1), T0 + 239 * MIN));
    assert.equal(fail(answer(s, 2, ['a'], T0 + 240 * MIN)), 'not_active');
    const expired = advance(s, T0 + 300 * MIN);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.finishedAtMs, T0 + 240 * MIN);
    assert.equal(remainingMs(expired, T0 + 300 * MIN), 0);
    assert.deepEqual(toResponses(expired).get(1), keyOf(1));
    assert.equal(fail(submit(expired, T0 + 301 * MIN)), 'already_finished');
  });

  it('refuses to hand answers to scoring before the attempt is finished', () => {
    assert.throws(() => toResponses(startAttempt(bp, form, T0)));
  });

  it('survives a round trip through JSON storage', () => {
    let s = ok(answer(startAttempt(bp, form, T0), 5, ['a'], T0 + MIN));
    s = ok(setFlag(s, form, 6, true, T0 + MIN));
    const restored = JSON.parse(JSON.stringify(s)) as AttemptState;
    assert.deepEqual(restored, s);
    assert.deepEqual(ok(answer(restored, 6, ['a'], T0 + 2 * MIN)).answers[5]!.selected, ['a']);
  });

  it('runs a full attempt end to end and scores it', () => {
    let t = T0;
    let s = startAttempt(bp, form, t);
    let expectedCorrect = 0;
    const play = (from: number, to: number) => {
      for (let o = from; o <= to; o++) {
        t += 60_000;
        if (o % 9 === 0) continue; // left unanswered
        const right = o % 4 !== 0;
        s = ok(answer(s, o, right ? keyOf(o) : ['b'], t));
        if (right) expectedCorrect++;
      }
    };
    play(1, 20);
    assert.deepEqual(sectionReview(s, form, 0).unanswered, [9, 18]);
    s = ok(closeSection(s, bp, t));
    t += 6 * MIN;
    s = ok(resumeFromBreak(s, t));
    play(21, 100);
    s = ok(closeSection(s, bp, t));
    t += 25 * MIN; // overstays the 10-minute break
    play(101, 180);
    assert.equal(s.status, 'in_progress');
    s = ok(submit(s, t));
    assert.equal(s.status, 'submitted');
    assert.deepEqual(s.sections.map((x) => x.state), ['closed', 'closed', 'closed']);
    assert.equal(fail(answer(s, 180, ['a'], t + 1, 99)), 'not_active');
    assert.equal(fail(submit(s, t + 1)), 'already_finished');

    const result = scoreAttempt(bp, form, pool, toResponses(s));
    assert.equal(result.overall.total, 180);
    assert.equal(result.overall.answered, 160);
    assert.equal(result.overall.correct, expectedCorrect);
    // 180 answering minutes + 6 + 25 minutes away; only 6 + 10 were paused.
    assert.equal(s.finishedAtMs! - T0, 211 * MIN);
    assert.equal(s.deadlineMs - T0, 256 * MIN);
  });
});
