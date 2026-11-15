// Integration tests: exam engine + service + PostgreSQL.
// Need the throwaway database from scripts/pg-temp.sh:
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/exam-store && npm test)
// Tests run in order and build on each other's data.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { domainQuotas, isScorable, validateBlueprint, validateExam } from '../../exam-engine/src/index.ts';
import type { Question } from '../../exam-engine/src/index.ts';
import { ActiveAttemptExistsError } from '../src/ports.ts';
import { PsqlStore, lit } from '../src/psql-store.ts';
import { MockExamError, MockExamService } from '../src/service.ts';

const CANDIDATE = '00000000-0000-4000-8000-000000000004';
const OTHER = '00000000-0000-4000-8000-000000000005';
const ADMIN = '00000000-0000-4000-8000-000000000003';
const AUTHOR = '00000000-0000-4000-8000-000000000001';
const REVIEWER = '00000000-0000-4000-8000-000000000002';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);

const configured = Boolean(process.env.PGDATABASE);
const store = new PsqlStore();
const service = new MockExamService(store);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof MockExamError) return e.code;
    throw e;
  }
  return 'no error';
};
const sqlFails = (sql: string, message: string) =>
  assert.throws(() => store.query(sql), (e: unknown) => String((e as { stderr?: string }).stderr).includes(message));

describe('exam engine on PostgreSQL', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  let blueprintId = '';
  let attemptId = '';
  let firstAttemptQuestions: string[] = [];

  it('reads the active blueprint from the database in the shape the engine expects', async () => {
    const active = await store.activeBlueprint('PMP-ECO');
    assert.ok(active);
    blueprintId = active.id;
    assert.deepEqual(validateBlueprint(active.blueprint), []);
    assert.deepEqual(active.blueprint.domains.map((d) => d.tasks.length), [8, 10, 8]);
    const q = domainQuotas(active.blueprint);
    assert.deepEqual([q.get('PEOPLE'), q.get('PROCESS'), q.get('BUSINESS')], [59, 74, 47]);
    assert.equal(active.blueprint.sections.length, 3);
    assert.equal(await store.activeBlueprint('NO-SUCH'), null);
  });

  it('reads the published bank as a scorable pool', async () => {
    const pool = await store.pool(blueprintId);
    assert.equal(pool.length, 1380);
    assert.ok(pool.every((q) => q.status === 'published' && isScorable(q)));
    assert.equal(new Set(pool.filter((q) => q.caseSetId).map((q) => q.caseSetId)).size, 16);
  });

  it('starts a mock: the stored exam passes validation against the database bank', async () => {
    const view = await service.start(CANDIDATE, T0, 20261114);
    attemptId = view.attemptId;
    assert.equal(view.status, 'in_progress');
    assert.equal(view.remainingMs, 240 * MIN);
    assert.deepEqual(view.sections.map((s) => [s.state, s.kind, s.questionCount, s.firstOrdinal]), [
      ['open', 'case', 20, 1],
      ['locked', 'independent', 80, 21],
      ['locked', 'independent', 80, 101],
    ]);
    const loaded = await store.loadAttempt(attemptId, CANDIDATE);
    assert.ok(loaded);
    const pool = new Map((await store.pool(blueprintId)).map((q) => [q.id, q]));
    assert.deepEqual(validateExam(loaded.blueprint, loaded.form, pool), []);
    assert.equal(loaded.pool.length, 180);
    firstAttemptQuestions = loaded.form.items.map((i) => i.questionId);
    assert.equal(store.query(`SELECT count(*) FROM attempt_questions WHERE attempt_id = ${lit.uuid(attemptId)};`), '180');
    assert.equal(store.query(`SELECT state FROM exam_attempts WHERE id = ${lit.uuid(attemptId)};`), 'in_progress');
  });

  it('allows one active attempt per user and hides attempts from other users', async () => {
    await assert.rejects(service.start(CANDIDATE, T0 + MIN, 5), ActiveAttemptExistsError);
    assert.equal(await code(service.status(OTHER, attemptId, T0 + MIN)), 'attempt_not_found');
    assert.equal(
      await code(service.saveAnswer(OTHER, attemptId, { ordinal: 1, selected: [], clientSeq: 1 }, T0 + MIN)),
      'attempt_not_found',
    );
  });

  it('serves the open section without keys, rationales or question ids', async () => {
    const section = await service.questions(CANDIDATE, attemptId, T0 + MIN);
    assert.equal(section.sectionIndex, 0);
    assert.equal(section.questions.length, 20);
    const json = JSON.stringify(section);
    assert.ok(!/isCorrect|rationale|correct/i.test(json));
    assert.ok(!json.includes('caseSetId'));
    const loaded = (await store.loadAttempt(attemptId, CANDIDATE))!;
    for (const item of loaded.form.items) {
      assert.ok(!json.includes(item.questionId) && !json.includes(item.versionId));
    }
    for (const q of loaded.pool) assert.ok(!q.caseSetId || !json.includes(q.caseSetId));
    assert.deepEqual([...new Set(section.questions.map((q) => q.caseKey))], ['case-1', 'case-2', 'case-3', 'case-4']);
    assert.deepEqual(Object.keys(section.caseStudies), ['case-1', 'case-2', 'case-3', 'case-4']);
    assert.match(section.caseStudies['case-1']!.scenario, /^Synthetic scenario/);
    assert.deepEqual([section.caseStudies['case-1']!.firstOrdinal, section.caseStudies['case-1']!.lastOrdinal], [1, 5]);
  });

  it('rejects a stale write instead of overwriting newer state', async () => {
    const loaded = (await store.loadAttempt(attemptId, CANDIDATE))!;
    assert.equal(await store.saveProgress(attemptId, loaded.state, loaded.version - 1), false);
    assert.equal(await store.saveProgress(attemptId, loaded.state, loaded.version + 5), false);
    assert.equal((await store.loadAttempt(attemptId, CANDIDATE))!.version, loaded.version);
  });

  it('runs a full attempt against the database and stores the score', async () => {
    const loaded = (await store.loadAttempt(attemptId, CANDIDATE))!;
    const byId = new Map<string, Question>(loaded.pool.map((q) => [q.id, q]));
    const question = (ordinal: number) => byId.get(loaded.form.items[ordinal - 1]!.questionId)!;
    const key = (ordinal: number) => question(ordinal).options.filter((o) => o.isCorrect).map((o) => o.id);
    const wrong = (ordinal: number) => [question(ordinal).options.find((o) => !o.isCorrect)!.id];

    let t = T0 + MIN;
    let expectedCorrect = 0;
    let expectedAnswered = 0;
    const play = async (from: number, to: number) => {
      for (let o = from; o <= to; o++) {
        t += 45_000;
        if (o % 9 === 0) continue;
        const right = o % 4 !== 0;
        await service.saveAnswer(CANDIDATE, attemptId, { ordinal: o, selected: right ? key(o) : wrong(o), clientSeq: 1 }, t);
        expectedAnswered++;
        if (right) expectedCorrect++;
      }
    };

    await play(1, 20);
    // A repeated save is acknowledged and ignored; a newer one replaces the answer.
    const stale = await service.saveAnswer(CANDIDATE, attemptId, { ordinal: 1, selected: wrong(1), clientSeq: 1 }, t);
    assert.equal(stale.staleIgnored, true);
    await service.setFlag(CANDIDATE, attemptId, 5, true, t);
    assert.deepEqual((await service.review(CANDIDATE, attemptId, 0, t)).unanswered, [9, 18]);
    assert.deepEqual((await service.review(CANDIDATE, attemptId, 0, t)).flagged, [5]);
    assert.equal(await code(service.saveAnswer(CANDIDATE, attemptId, { ordinal: 21, selected: key(21), clientSeq: 1 }, t)), 'section_locked');
    assert.equal(await code(service.submit(CANDIDATE, attemptId, t)), 'not_last_section');

    let view = await service.closeSection(CANDIDATE, attemptId, t);
    assert.equal(view.status, 'on_break');
    assert.equal(view.breakRemainingMs, 10 * MIN);
    assert.equal(await code(service.questions(CANDIDATE, attemptId, t + MIN)), 'on_break');
    assert.equal(await code(service.saveAnswer(CANDIDATE, attemptId, { ordinal: 21, selected: key(21), clientSeq: 1 }, t + MIN)), 'on_break');
    t += 5 * MIN;
    view = await service.resume(CANDIDATE, attemptId, t);
    assert.deepEqual(view.sections.map((s) => s.state), ['closed', 'open', 'locked']);
    assert.equal(await code(service.saveAnswer(CANDIDATE, attemptId, { ordinal: 1, selected: key(1), clientSeq: 9 }, t)), 'section_locked');
    assert.equal((await service.questions(CANDIDATE, attemptId, t)).questions.length, 80);

    await play(21, 100);
    await service.closeSection(CANDIDATE, attemptId, t);
    t += 10 * MIN + 1; // the break runs out by itself
    assert.equal((await service.status(CANDIDATE, attemptId, t)).status, 'in_progress');
    await play(101, 180);

    assert.equal(await code(service.result(CANDIDATE, attemptId, t)), 'not_finished');
    const result = await service.submit(CANDIDATE, attemptId, t);
    assert.equal(result.overall.total, 180);
    assert.equal(result.overall.answered, expectedAnswered);
    assert.equal(result.overall.correct, expectedCorrect);
    assert.ok(!('perQuestion' in result));
    assert.equal(Object.keys(result.byTask).length, 26);
    assert.equal(Object.values(result.byDomain).reduce((s, x) => s + x.total, 0), 180);

    const id = lit.uuid(attemptId);
    assert.equal(store.query(`SELECT state FROM exam_attempts WHERE id = ${id};`), 'submitted');
    assert.equal(Number(store.query(`SELECT score_percent FROM exam_attempts WHERE id = ${id};`)), result.overall.percent);
    assert.equal(store.query(`SELECT count(*) FROM attempt_sections WHERE attempt_id = ${id} AND state = 'closed';`), '3');
    const answers = `FROM answers a JOIN attempt_questions aq ON aq.id = a.attempt_question_id WHERE aq.attempt_id = ${id}`;
    assert.equal(store.query(`SELECT count(*) ${answers};`), String(expectedAnswered));
    assert.equal(store.query(`SELECT count(*) ${answers} AND a.is_correct;`), String(expectedCorrect));
    assert.equal(store.query(`SELECT count(*) ${answers} AND a.is_correct IS NULL;`), '0');
    assert.equal(store.query(`SELECT count(*) FROM attempt_questions WHERE attempt_id = ${id} AND flagged;`), '1');
  });

  it('accepts nothing after submission and returns the same result again', async () => {
    const t = T0 + 300 * MIN;
    assert.equal(await code(service.saveAnswer(CANDIDATE, attemptId, { ordinal: 180, selected: [], clientSeq: 99 }, t)), 'already_finished');
    assert.equal(await code(service.submit(CANDIDATE, attemptId, t)), 'already_finished');
    const again = await service.result(CANDIDATE, attemptId, t);
    assert.equal(again.overall.total, 180);
    assert.equal((await service.status(CANDIDATE, attemptId, t)).status, 'submitted');
  });

  it('builds the next mock for the same user without any question from the previous one', async () => {
    const view = await service.start(CANDIDATE, T0 + 400 * MIN, 77);
    const next = (await store.loadAttempt(view.attemptId, CANDIDATE))!.form.items.map((i) => i.questionId);
    const seen = new Set(firstAttemptQuestions);
    assert.equal(next.filter((id) => seen.has(id)).length, 0);
    assert.equal(next.length, 180);
  });

  it('expires an abandoned attempt on the server and scores what was saved', async () => {
    const start = T0 + 1000 * MIN;
    const view = await service.start(OTHER, start, 31);
    const loaded = (await store.loadAttempt(view.attemptId, OTHER))!;
    const q = loaded.pool.find((x) => x.id === loaded.form.items[0]!.questionId)!;
    const key = q.options.filter((o) => o.isCorrect).map((o) => o.id);
    await service.saveAnswer(OTHER, view.attemptId, { ordinal: 1, selected: key, clientSeq: 1 }, start + MIN);

    const later = start + 300 * MIN;
    assert.equal(await code(service.saveAnswer(OTHER, view.attemptId, { ordinal: 2, selected: [], clientSeq: 1 }, later)), 'not_active');
    const status = await service.status(OTHER, view.attemptId, later);
    assert.equal(status.status, 'expired');
    assert.equal(status.remainingMs, 0);
    const result = await service.result(OTHER, view.attemptId, later);
    assert.equal(result.overall.answered, 1);
    assert.equal(result.overall.correct, 1);
    assert.equal(store.query(`SELECT state FROM exam_attempts WHERE id = ${lit.uuid(view.attemptId)};`), 'expired');
    // The expired attempt no longer blocks a new one.
    const fresh = await service.start(OTHER, later + MIN, 32);
    assert.equal(fresh.status, 'in_progress');
  });

  it('refuses to publish a question that has not passed every gate', () => {
    const make = (state: string) => {
      const q = store.query(`INSERT INTO questions (public_code) VALUES ('T-' || gen_random_uuid()) RETURNING id;`);
      const task = store.query(`SELECT t.id FROM tasks t JOIN domains d ON d.id = t.domain_id WHERE d.blueprint_id = ${lit.uuid(blueprintId)} LIMIT 1;`);
      const v = store.query(
        `INSERT INTO question_versions (question_id, version_no, task_id, approach_code, difficulty_code, type_code, stem, author_id, workflow_state, originality_declared_at)
         VALUES (${lit.uuid(q)}, 1, ${lit.uuid(task)}, 'hybrid', 'hard', 'single', 'Gate test', ${lit.uuid(AUTHOR)}, '${state}', now()) RETURNING id;`,
      );
      store.query(`INSERT INTO options (question_version_id, ordinal, text, is_correct) VALUES (${lit.uuid(v)}, 1, 'A', true), (${lit.uuid(v)}, 2, 'B', false);`);
      return { q, v };
    };
    const publish = (v: string) => `SELECT publish_question_version(${lit.uuid(v)}, ${lit.uuid(ADMIN)});`;
    const review = (v: string, gate: string, who: string) =>
      `INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist) VALUES (${lit.uuid(v)}, ${lit.uuid(who)}, '${gate}', 'approved', '{}');`;

    const draft = make('draft');
    sqlFails(publish(draft.v), 'only an approved version can be published');

    const oneGate = make('approved');
    store.query(review(oneGate.v, 'expert_review', REVIEWER));
    sqlFails(publish(oneGate.v), 'has not passed every review gate');
    sqlFails(review(oneGate.v, 'language_qa', AUTHOR), 'authors cannot review their own');

    store.query(review(oneGate.v, 'language_qa', REVIEWER));
    store.query(publish(oneGate.v));
    assert.equal(store.query(`SELECT status FROM questions WHERE id = ${lit.uuid(oneGate.q)};`), 'published');
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action = 'question.publish' AND entity_id = '${oneGate.v}';`), '1');
  });

  it('refuses to store an exam that contains an unpublished question version', async () => {
    const loaded = (await store.loadAttempt(attemptId, CANDIDATE))!;
    const victim = loaded.form.items[30]!;
    store.query(`SELECT withdraw_question(${lit.uuid(victim.questionId)}, ${lit.uuid(ADMIN)});`);
    const stranger = store.query(`INSERT INTO users (email, password_hash) VALUES ('third@example.test', 'x') RETURNING id;`);
    await assert.rejects(
      store.createAttempt(stranger, blueprintId, loaded.form, loaded.state),
      (e: unknown) => String((e as { stderr?: string }).stderr).includes('unpublished question versions'),
    );
    // The withdrawn question has left the pool; the finished attempt that used it can still be read.
    const pool = await store.pool(blueprintId);
    assert.ok(!pool.some((q) => q.id === victim.questionId));
    assert.equal((await service.result(CANDIDATE, attemptId, T0 + 2000 * MIN)).overall.total, 180);
  });

  it('skips a whole case set once one of its questions is withdrawn', async () => {
    const pool = await store.pool(blueprintId);
    const member = pool.find((q) => q.caseSetId)!;
    store.query(`SELECT withdraw_question(${lit.uuid(member.id)}, ${lit.uuid(ADMIN)});`);
    const after = await store.pool(blueprintId);
    assert.equal(after.find((q) => q.id === member.id)!.status, 'draft');
    const stranger = store.query(`SELECT id FROM users WHERE email = 'third@example.test';`);
    const view = await service.start(stranger, T0 + 3000 * MIN, 9);
    const form = (await store.loadAttempt(view.attemptId, stranger))!;
    assert.ok(form.pool.every((q) => q.caseSetId !== member.caseSetId));
    assert.deepEqual(validateExam(form.blueprint, form.form, new Map(after.map((q) => [q.id, q]))), []);
  });
});
