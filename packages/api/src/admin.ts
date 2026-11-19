// Staff endpoints under /api/v1/admin: authoring, review workflow, import,
// blueprint versions and question-report triage. Every route needs a staff
// role and a session opened with two-factor sign-in (checked in app.ts).
// Rules about states and authorship are enforced again in the database.

import { generateExam, validateBlueprint } from '../../exam-engine/src/index.ts';
import type { Blueprint, Question } from '../../exam-engine/src/index.ts';
import { AdminError } from './api-store.ts';
import type { ApiStore } from './api-store.ts';
import { hashToken, newAccessCodes, normalizeAccessCode, sniffImage } from './auth.ts';
import { SpreadsheetError, readXlsxSheets } from './xlsx.ts';
import { writeXlsx } from './xlsx-write.ts';
import { HttpError, invalid, invalidMany, notFound } from './http.ts';
import type { Ctx, Handler, RouteOptions } from './http.ts';

export const ROLES = {
  anyStaff: ['content_author', 'content_reviewer', 'administrator'],
  authors: ['content_author', 'administrator'],
  reviewers: ['content_reviewer', 'administrator'],
  admins: ['administrator'],
};

export const CHECKLIST = [
  'technical',
  'outlineMapping',
  'language',
  'ambiguity',
  'singleAnswer',
  'distractors',
  'difficulty',
  'biasFairness',
] as const;

const ADMIN_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  self_review: 403,
  state: 409,
  open_version: 409,
  gates: 409,
  case_size: 409,
  case_not_ready: 409,
  self_demote: 409,
  self_reset: 409,
  blueprint_version_exists: 409,
  product_in_use: 409,
};
const ADMIN_TITLES: Record<string, string> = {
  not_found: 'Not found',
  forbidden: 'You can only change your own drafts',
  self_review: 'Authors cannot review their own questions',
  state: 'This action is not allowed in the current workflow state',
  open_version: 'This question already has a version in progress',
  gates: 'The version has not passed every review gate since its last return',
  originality: 'Confirm that the question is original before submitting',
  key: 'The answer key is not valid for this question type',
  explanation: 'Add an explanation before submitting',
  comment: 'A comment is required when returning a question',
  checklist: 'All eight review checks must pass to approve',
  unknown_task: 'The task code is not in the active blueprint',
  action: 'Unknown action',
  blueprint_version_exists: 'This blueprint version already exists',
  unknown_case: 'The case study does not exist or is no longer a draft',
  case_size: 'A case study needs 2 to 10 questions',
  case_not_ready: 'Every question in the case study must be published first',
  unknown_exhibit: 'One of the exhibits does not exist',
  too_many_exhibits: 'Too many exhibits',
  self_demote: 'You cannot remove your own administrator role',
  self_reset: 'You cannot reset your own two-factor sign-in',
  unknown_role: 'Unknown role',
  unknown_plan: 'Unknown plan',
  product_in_use: 'This store product id is already used by another price',
};

export function toHttp(e: AdminError): HttpError {
  return new HttpError(ADMIN_STATUS[e.code] ?? 422, e.code, ADMIN_TITLES[e.code] ?? e.code);
}

export type FieldError = { field: string; message: string };

/** Same normalisation as existing_stems() in the database. */
export const normalizeStem = (stem: string): string => stem.trim().replace(/\s+/g, ' ').toLowerCase();

/** Validates a question draft. Returns the clean document, or field errors. */
export function validateDraft(input: unknown, taskCodes: ReadonlySet<string>, prefix = ''): { doc?: Record<string, unknown>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const err = (field: string, message: string) => errors.push({ field: prefix + field, message });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    err('', 'must be an object');
    return { errors };
  }
  const b = input as Record<string, unknown>;
  const text = (field: string, min: number, max: number): string | undefined => {
    const v = b[field];
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) {
      err(field, `must be text of ${min} to ${max} characters`);
      return undefined;
    }
    return v.trim();
  };
  const oneOf = (field: string, values: string[], fallback?: string): string | undefined => {
    const v = b[field] ?? fallback;
    if (typeof v !== 'string' || !values.includes(v)) {
      err(field, `must be one of ${values.join(', ')}`);
      return undefined;
    }
    return v;
  };

  const taskCode = typeof b.taskCode === 'string' && taskCodes.has(b.taskCode) ? b.taskCode : undefined;
  if (!taskCode) err('taskCode', 'must be a task code of the active blueprint');
  const approach = oneOf('approach', ['predictive', 'agile', 'hybrid']);
  const difficulty = oneOf('difficulty', ['easy', 'medium', 'hard']);
  const type = oneOf('type', ['single', 'multiple']);
  const language = oneOf('language', ['en', 'ar'], 'en');
  const stem = text('stem', 20, 4000);
  // Optional Arabic translations
  const stemAr = (typeof b.stemAr === 'string' && b.stemAr.trim().length > 0) ? b.stemAr.trim() : undefined;
  if (b.graphic !== undefined && typeof b.graphic !== 'boolean') err('graphic', 'must be true or false');
  if (b.aiAssisted !== undefined && typeof b.aiAssisted !== 'boolean') err('aiAssisted', 'must be true or false');
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (b.caseStudyId !== undefined && b.caseStudyId !== null && (typeof b.caseStudyId !== 'string' || !UUID_RE.test(b.caseStudyId))) {
    err('caseStudyId', 'must be the id of a case study');
  }

  let exhibitIds: string[] = [];
  if (b.exhibitIds !== undefined && b.exhibitIds !== null) {
    if (!Array.isArray(b.exhibitIds) || b.exhibitIds.length > 3 || b.exhibitIds.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
      err('exhibitIds', 'must be a list of at most 3 exhibit ids');
    } else if (new Set(b.exhibitIds).size !== b.exhibitIds.length) {
      err('exhibitIds', 'must not repeat an exhibit');
    } else {
      exhibitIds = b.exhibitIds as string[];
    }
  }

  const options: Array<{ text: string; textAr?: string; isCorrect: boolean; rationale: string; rationaleAr?: string }> = [];
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 6) {
    err('options', 'must hold 2 to 6 options');
  } else {
    b.options.forEach((o: unknown, i: number) => {
      const opt = (o ?? {}) as Record<string, unknown>;
      if (typeof opt.text !== 'string' || opt.text.trim().length === 0 || opt.text.length > 1000) {
        err(`options[${i}].text`, 'must be text of 1 to 1000 characters');
      }
      if (typeof opt.isCorrect !== 'boolean') err(`options[${i}].isCorrect`, 'must be true or false');
      if (opt.rationale !== undefined && (typeof opt.rationale !== 'string' || opt.rationale.length > 2000)) {
        err(`options[${i}].rationale`, 'must be text of at most 2000 characters');
      }
      if (opt.rationaleAr !== undefined && opt.rationaleAr !== null && opt.rationaleAr !== '' &&
          (typeof opt.rationaleAr !== 'string' || opt.rationaleAr.length > 2000)) {
        err(`options[${i}].rationaleAr`, 'must be text of at most 2000 characters');
      }
      const item: { text: string; textAr?: string; isCorrect: boolean; rationale: string; rationaleAr?: string } = {
        text: typeof opt.text === 'string' ? opt.text.trim() : '',
        isCorrect: opt.isCorrect === true,
        rationale: typeof opt.rationale === 'string' ? opt.rationale.trim() : '',
      };
      if (typeof opt.textAr === 'string' && opt.textAr.trim().length > 0) item.textAr = opt.textAr.trim();
      if (typeof opt.rationaleAr === 'string' && opt.rationaleAr.trim().length > 0) item.rationaleAr = opt.rationaleAr.trim();
      options.push(item);
    });
    const correct = options.filter((o) => o.isCorrect).length;
    if (type === 'single' && correct !== 1) err('options', 'a single-choice question needs exactly one correct option');
    if (type === 'multiple' && (correct < 2 || correct >= options.length)) {
      err('options', 'a multiple-response question needs at least two correct options and at least one wrong one');
    }
    const seen = new Set(options.map((o) => o.text.toLowerCase()));
    if (seen.size !== options.length) err('options', 'options must all be different');
  }

  let explanation: Record<string, string> | undefined;
  if (b.explanation !== undefined && b.explanation !== null) {
    const e = b.explanation as Record<string, unknown>;
    if (typeof e !== 'object' || typeof e.whyCorrect !== 'string' || e.whyCorrect.trim().length === 0 || e.whyCorrect.length > 4000) {
      err('explanation.whyCorrect', 'must be text of 1 to 4000 characters');
    } else {
      explanation = { whyCorrect: e.whyCorrect.trim() };
      for (const key of ['mindset', 'keyConcept', 'learningObjective']) {
        const v = e[key];
        if (v === undefined || v === null) continue;
        if (typeof v !== 'string' || v.length > 2000) err(`explanation.${key}`, 'must be text of at most 2000 characters');
        else explanation[key] = v.trim();
      }
    }
  }
  // Optional Arabic explanation (parallel to English)
  let explanationAr: Record<string, string> | undefined;
  if (b.explanationAr !== undefined && b.explanationAr !== null) {
    const ea = b.explanationAr as Record<string, unknown>;
    if (typeof ea.whyCorrect === 'string' && ea.whyCorrect.trim().length > 0) {
      explanationAr = { whyCorrect: ea.whyCorrect.trim() };
      for (const key of ['mindset', 'keyConcept', 'learningObjective']) {
        const v = ea[key];
        if (typeof v === 'string' && v.trim().length > 0) explanationAr[key] = v.trim();
      }
    }
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    doc: {
      taskCode,
      approach,
      difficulty,
      type,
      language,
      stem,
      ...(stemAr ? { stemAr } : {}),
      graphic: b.graphic === true,
      aiAssisted: b.aiAssisted === true,
      ...(typeof b.caseStudyId === 'string' ? { caseStudyId: b.caseStudyId } : {}),
      exhibitIds,
      options,
      ...(explanation ? { explanation } : {}),
      ...(explanationAr ? { explanationAr } : {}),
    },
  };
}

/** Checks the whole exam tips document sent from the admin panel. */
export function validateTips(input: unknown): { sections?: Array<Record<string, unknown>>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!Array.isArray(input)) return { errors: [{ field: 'sections', message: 'must be a list of sections' }] };
  if (input.length > 30) errors.push({ field: 'sections', message: 'at most 30 sections' });
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim() : '');
  const sections = input.map((raw, i) => {
    const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const titleEn = text(s.titleEn, 200), titleAr = text(s.titleAr, 200);
    if (!titleEn || titleEn.length > 200) errors.push({ field: `sections[${i}].titleEn`, message: 'is required, up to 200 characters' });
    if (!titleAr || titleAr.length > 200) errors.push({ field: `sections[${i}].titleAr`, message: 'is required, up to 200 characters' });
    const rawItems = Array.isArray(s.items) ? s.items : [];
    if (!Array.isArray(s.items)) errors.push({ field: `sections[${i}].items`, message: 'must be a list' });
    if (rawItems.length > 50) errors.push({ field: `sections[${i}].items`, message: 'at most 50 tips per section' });
    const items = rawItems.map((it, j) => {
      const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
      const en = text(o.en, 1000), ar = text(o.ar, 1000);
      if (!en || en.length > 1000) errors.push({ field: `sections[${i}].items[${j}].en`, message: 'is required, up to 1000 characters' });
      if (!ar || ar.length > 1000) errors.push({ field: `sections[${i}].items[${j}].ar`, message: 'is required, up to 1000 characters' });
      return { en, ar };
    });
    return { titleEn, titleAr, items, published: s.published !== false };
  });
  return errors.length ? { errors } : { sections, errors };
}

export interface AdminRoute {
  method: string;
  path: string;
  options: RouteOptions;
  handler: Handler;
}

export interface AdminDeps {
  store: ApiStore;
  blueprintCode: string;
  /** Signed, expiring address of an image exhibit. */
  exhibitUrl: (exhibitId: string) => string;
  /** The server clock, as an ISO timestamp. */
  now: () => string;
}

export function adminRoutes({ store, blueprintCode, exhibitUrl, now }: AdminDeps): AdminRoute[] {
  const routes: AdminRoute[] = [];
  const add = (method: string, path: string, staff: string[], handler: Handler) =>
    routes.push({ method, path, options: { staff }, handler });
  const isAdmin = (c: Ctx) => c.roles.includes('administrator');
  // Image exhibits get a short-lived signed address so the panel can show them.
  const withUrls = (obj: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!obj || !Array.isArray(obj.exhibits)) return obj;
    return { ...obj, exhibits: (obj.exhibits as Array<Record<string, unknown>>).map((e) => (e.kind === 'image' ? { ...e, url: exhibitUrl(String(e.id)) } : e)) };
  };
  const aq = async (id: string) => withUrls(await store.adminQuestion(id));
  const cs = async (id: string) => withUrls(await store.caseStudy(id));
  const has = (c: Ctx, allowed: string[]) => allowed.some((r) => c.roles.includes(r));
  const uuid = (v: string | undefined) => {
    if (!v || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw notFound();
    return v;
  };
  const run = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AdminError) throw toHttp(e);
      throw e;
    }
  };

  const active = async () => {
    const a = await store.activeBlueprint(blueprintCode);
    if (!a) throw new HttpError(503, 'no_active_blueprint', 'No exam blueprint is active');
    return a;
  };
  const taskCodes = (bp: Blueprint) => new Set(bp.domains.flatMap((d) => d.tasks.map((t) => t.id)));

  // ------------------------------------------------------------ questions

  add('GET', '/admin/questions', ROLES.anyStaff, async (c) => {
    const state = c.query.get('workflowState');
    const states = ['draft', 'submitted', 'expert_review', 'language_qa', 'approved', 'published', 'withdrawn'];
    if (state !== null && !states.includes(state)) throw invalid('workflowState', 'is not a workflow state');
    const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100);
    const items = await store.listQuestions(state, c.query.get('taskCode'), c.query.get('cursor'), limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items, nextCursor: items.length === limit && last ? String(last.publicCode) : null } };
  });

  add('POST', '/admin/questions', ROLES.authors, async (c) => {
    const a = await active();
    const { doc, errors } = validateDraft(c.body, taskCodes(a.blueprint));
    if (!doc) throw invalidMany(errors);
    const id = await run(async () => await store.createDraft(c.claims.sub, a.id, doc));
    return { status: 201, body: await aq(id) };
  });

  add('GET', '/admin/question-versions/:versionId', ROLES.anyStaff, async (c) => {
    const q = await aq(uuid(c.params.versionId));
    if (!q) throw notFound();
    return { status: 200, body: q };
  });

  add('PUT', '/admin/question-versions/:versionId', ROLES.authors, async (c) => {
    const id = uuid(c.params.versionId);
    const a = await active();
    const { doc, errors } = validateDraft(c.body, taskCodes(a.blueprint));
    if (!doc) throw invalidMany(errors);
    await run(async () => await store.updateDraft(id, c.claims.sub, isAdmin(c), a.id, doc));
    return { status: 200, body: await aq(id) };
  });

  add('POST', '/admin/questions/:questionId/versions', ROLES.authors, async (c) => {
    const id = await run(async () => await store.newVersion(uuid(c.params.questionId), c.claims.sub));
    return { status: 201, body: await aq(id) };
  });

  add('POST', '/admin/question-versions/:versionId/transitions', ROLES.anyStaff, async (c) => {
    const id = uuid(c.params.versionId);
    const action = c.body.action;
    const needs: Record<string, string[]> = {
      submit: ROLES.authors,
      approve: ROLES.reviewers,
      return: ROLES.reviewers,
      publish: ROLES.admins,
      withdraw: ROLES.admins,
    };
    if (typeof action !== 'string' || !needs[action]) throw invalid('action', `must be one of ${Object.keys(needs).join(', ')}`);
    if (!has(c, needs[action]!)) throw new HttpError(403, 'forbidden', 'Your role cannot perform this action');
    const comment = typeof c.body.comment === 'string' ? c.body.comment.slice(0, 4000) : null;
    const checklist =
      c.body.checklist && typeof c.body.checklist === 'object' && !Array.isArray(c.body.checklist)
        ? (c.body.checklist as Record<string, unknown>)
        : null;
    await run(async () => await store.transition(id, c.claims.sub, action, comment, checklist, c.body.originalityDeclared === true, isAdmin(c)));
    return { status: 200, body: await aq(id) };
  });

  // One owner, nobody else to review: administrators approve and publish many at once.
  add('POST', '/admin/questions/bulk-approve', ROLES.admins, async (c) => {
    if (c.body.reviewedConfirmed !== true) throw invalid('reviewedConfirmed', 'confirm that you reviewed these questions');
    if (c.body.originalityDeclared !== true) throw invalid('originalityDeclared', 'confirm that these questions are original');
    const ids = c.body.versionIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw invalid('versionIds', 'must list 1 to 500 version ids');
    const clean = ids.map((v) => uuid(String(v)));
    const result = await store.bulkApprovePublish(clean, c.claims.sub);
    return { status: 200, body: result };
  });

  // ------------------------------------------------------------ import

  // Excel files are turned into rows here; the panel then maps the columns
  // exactly as it does for CSV and sends them to /admin/imports.
  // The whole bank in one Excel file, in the same columns the import reads, so it can be
  // completed (translations, explanations) and imported again with "update existing".
  add('GET', '/admin/exports/questions', ROLES.admins, async () => {
    const qs = await store.exportQuestions();
    const L = 'ABCDEF';
    const head = ['publicCode', 'workflowState', 'taskCode', 'approach', 'difficulty', 'type', 'language', 'aiAssisted', 'stem', 'stemAr',
      ...[...L].map((x) => 'option' + x), ...[...L].map((x) => 'option' + x + 'Ar'), 'correct',
      ...[...L].map((x) => 'rationale' + x), ...[...L].map((x) => 'rationale' + x + 'Ar'),
      'whyCorrect', 'mindset', 'keyConcept', 'learningObjective', 'whyCorrectAr', 'mindsetAr', 'keyConceptAr', 'learningObjectiveAr', 'missing'];
    const rows = qs.map((q) => {
      const opts: Array<Record<string, any>> = q.options ?? [];
      const at = (i: number, k: string) => (opts[i] ? opts[i]![k] ?? '' : '');
      const ex = q.explanation ?? {}, ar = q.explanationAr ?? {};
      const missing: string[] = [];
      if (!q.stemAr) missing.push('Arabic stem');
      if (opts.some((o) => !o.textAr)) missing.push('Arabic options');
      if (!ex.whyCorrect) missing.push('explanation');
      if (!ar.whyCorrect) missing.push('Arabic explanation');
      if (opts.some((o) => !o.rationale)) missing.push('option rationales');
      if (opts.some((o) => !o.rationaleAr)) missing.push('Arabic option rationales');
      return [q.publicCode, q.workflowState, q.taskCode, q.approach, q.difficulty, q.type, q.language, q.aiAssisted ? 'TRUE' : 'FALSE', q.stem, q.stemAr,
        ...[...L].map((_, i) => at(i, 'text')), ...[...L].map((_, i) => at(i, 'textAr')),
        opts.map((o, i) => (o.isCorrect ? L[i] : '')).join(''),
        ...[...L].map((_, i) => at(i, 'rationale')), ...[...L].map((_, i) => at(i, 'rationaleAr')),
        ex.whyCorrect ?? '', ex.mindset ?? '', ex.keyConcept ?? '', ex.learningObjective ?? '',
        ar.whyCorrect ?? '', ar.mindset ?? '', ar.keyConcept ?? '', ar.learningObjective ?? '', missing.join('; ')];
    });
    const count = (f: (r: any[]) => boolean) => rows.filter(f).length;
    const miss = (k: string) => count((r) => String(r[r.length - 1]).split('; ').includes(k));
    const summary = [['Item', 'Count'],
      ['Questions', rows.length],
      ['Published', count((r) => r[1] === 'published')],
      ['Not published yet', count((r) => r[1] !== 'published')],
      ['Missing Arabic stem', miss('Arabic stem')],
      ['Missing Arabic options', miss('Arabic options')],
      ['Missing explanation', miss('explanation')],
      ['Missing Arabic explanation', miss('Arabic explanation')],
      ['Missing option rationales', miss('option rationales')],
      ['Missing Arabic option rationales', miss('Arabic option rationales')],
      ['Complete', count((r) => !r[r.length - 1])],
      [],
      ['How to use', 'Fill the empty cells, keep the stem column unchanged, then import this file with "Update questions that already exist". The publicCode, workflowState and missing columns are ignored on import.']];
    const widths = head.map((h) => (/^(stem|why|rationale|option|mindset|key|learning)/i.test(h) ? 40 : 14));
    const file = writeXlsx([{ name: 'Questions', rows: [head, ...rows], widths }, { name: 'Summary', rows: summary, widths: [34, 90] }]);
    const day = new Date().toISOString().slice(0, 10);
    return { status: 200, body: { fileName: `question-bank-${day}.xlsx`, dataBase64: file.toString('base64'), count: rows.length } };
  });

  add('POST', '/admin/imports/spreadsheet', ROLES.authors, async (c) => {
    const data = c.body.dataBase64;
    if (typeof data !== 'string' || data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw invalid('dataBase64', 'must be the file in base64');
    try {
      const sheets = readXlsxSheets(Buffer.from(data, 'base64'));
      return { status: 200, body: { rows: sheets[0]!.rows, sheets } };
    } catch (e) {
      if (e instanceof SpreadsheetError) throw invalid('dataBase64', e.message);
      throw e;
    }
  });

  add('POST', '/admin/imports', ROLES.authors, async (c) => {
    const rows = c.body.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) throw invalid('rows', 'must hold 1 to 500 rows');
    const commit = c.body.commit === true;
    if (commit && c.body.publishNow === true) {
      if (!isAdmin(c)) throw new HttpError(403, 'forbidden', 'Only administrators can publish while importing');
      if (c.body.reviewedConfirmed !== true || c.body.originalityDeclared !== true) throw invalid('reviewedConfirmed', 'confirm that you reviewed the questions and that they are original');
    }
    const a = await active();
    const codes = taskCodes(a.blueprint);

    const checked = rows.map((row: unknown, i: number) => ({ row: i + 1, ...validateDraft(row, codes) }));
    const norms = checked.map((r) => (r.doc ? normalizeStem(String(r.doc.stem)) : ''));
    const inBank = new Set(await store.existingStems(norms.filter(Boolean)));
    const translateOnly = c.body.translateOnly === true;
    const updateExisting = c.body.updateExisting === true || translateOnly;
    const stemNorms = checked.map((r) => {
      if (!r.doc) return [] as string[];
      const list = [normalizeStem(String(r.doc.stem))];
      if (typeof r.doc.stemAr === 'string' && r.doc.stemAr) list.push(normalizeStem(r.doc.stemAr));
      return list;
    });
    const firstSeen = new Map<string, number>();

    const report: Array<{ row: number; status: string; errors: Array<{ field: string; message: string }> }> = [];
    for (const [i, r] of checked.entries()) {
      if (!r.doc) { report.push({ row: r.row, status: 'invalid', errors: r.errors }); continue; }
      const norm = norms[i]!;
      const earlier = firstSeen.get(norm);
      if (earlier !== undefined) {
        report.push({ row: r.row, status: 'duplicate', errors: [{ field: 'stem', message: `same stem as row ${earlier}` }] });
        continue;
      }
      firstSeen.set(norm, r.row);
      if (updateExisting && await store.questionIdByStem(stemNorms[i]!) !== null) {
        report.push({ row: r.row, status: 'update', errors: [] });
        continue;
      }
      if (inBank.has(norm)) {
        report.push({ row: r.row, status: 'duplicate', errors: [{ field: 'stem', message: 'the same stem already exists in the bank' }] });
        continue;
      }
      report.push({ row: r.row, status: 'valid', errors: [] });
    }

    const committed: Array<{ row: number; versionId: string; publicCode: unknown }> = [];
    let updated = 0;
    const toPublish: string[] = [];
    if (commit) {
      for (const [i, r] of report.entries()) {
        if (r.status === 'update' && translateOnly) {
          const res = await run(async () => await store.translateByStem(c.claims.sub, stemNorms[i]!, checked[i]!.doc!));
          if (res.versions.length === 0) r.status = 'skipped';
          updated += res.versions.length;
          toPublish.push(...res.versions);
          continue;
        }
        if (r.status === 'update') {
          const res = await run(async () => await store.updateQuestionByStem(c.claims.sub, a.id, stemNorms[i]!, checked[i]!.doc!));
          if (res.action === 'skipped') r.status = 'skipped';
          else { updated++; if (res.versionId) toPublish.push(res.versionId); }
          continue;
        }
        if (r.status !== 'valid') continue;
        const id = await run(async () => await store.createDraft(c.claims.sub, a.id, checked[i]!.doc!));
        committed.push({ row: r.row, versionId: id, publicCode: (await aq(id))?.publicCode });
      }
    }
    // Administrators can publish what this import changed in the same step, after confirming the review.
    let published: { published: string[]; failed: Array<Record<string, unknown>> } | null = null;
    if (commit && c.body.publishNow === true) {
      const ids = [...toPublish, ...committed.map((x) => x.versionId)];
      published = { published: [], failed: [] };
      for (let i = 0; i < ids.length; i += 200) {
        const part = await run(async () => await store.bulkApprovePublish(ids.slice(i, i + 200), c.claims.sub));
        published.published.push(...part.published);
        published.failed.push(...part.failed);
      }
    }
    const count = (s: string) => report.filter((r) => r.status === s).length;
    return {
      status: 200,
      body: {
        summary: { rows: rows.length, valid: count('valid'), invalid: count('invalid'), duplicates: count('duplicate'), update: count('update'), skipped: count('skipped'), updated, committed: committed.length, published: published ? published.published.length : 0, publishFailed: published ? published.failed.length : 0 },
        rows: report,
        committed,
        publishFailed: published ? published.failed : [],
      },
    };
  });

  // ------------------------------------------------------------ blueprints

  const loadBlueprint = async (id: string): Promise<{ blueprint: Blueprint; status: string }> => {
    const raw = await store.engineBlueprintById(id);
    if (!raw) throw notFound();
    const { status, ...rest } = raw;
    return { blueprint: rest as unknown as Blueprint, status: String(status) };
  };

  const dryRun = async (id: string, count: number) => {
    const { blueprint } = await loadBlueprint(id);
    const problems = validateBlueprint(blueprint);
    if (problems.length > 0) return { attempted: 0, valid: 0, violations: problems };
    const pool = new Map<string, Question>((await store.pool(id)).map((q) => [q.id, q]));
    const violations = new Set<string>();
    let valid = 0;
    for (let i = 1; i <= count; i++) {
      const r = generateExam(blueprint, pool, { seed: i * 7919, maxAttempts: 5 });
      if (r.ok) valid++;
      else r.violations.forEach((v) => violations.add(v));
    }
    return { attempted: count, valid, violations: [...violations].slice(0, 50) };
  };

  add('POST', '/admin/blueprints', ROLES.admins, async (c) => {
    const b = c.body;
    const shapeOk =
      typeof b.code === 'string' &&
      Number.isInteger(b.version) &&
      typeof b.effectiveFrom === 'string' &&
      Array.isArray(b.domains) &&
      Array.isArray(b.sections) &&
      Array.isArray(b.mixRules) &&
      b.domains.every((d: any) => d && typeof d.id === 'string' && Array.isArray(d.tasks));
    if (!shapeOk) throw invalid('', 'is not a blueprint document');
    if (b.code !== blueprintCode) throw invalid('code', `must be ${blueprintCode}`);
    const problems = validateBlueprint(b as unknown as Blueprint);
    if (problems.length > 0) throw invalidMany(problems.map((message) => ({ field: 'blueprint', message })));
    const id = await run(async () => await store.importBlueprint(b));
    return { status: 201, body: { id, status: 'draft' } };
  });

  add('POST', '/admin/blueprints/:blueprintId/dry-run', ROLES.admins, async (c) => {
    const count = Math.min(Math.max(Number(c.query.get('count') ?? 20) || 20, 1), 200);
    return { status: 200, body: await dryRun(uuid(c.params.blueprintId), count) };
  });

  add('POST', '/admin/blueprints/:blueprintId/activate', ROLES.admins, async (c) => {
    const id = uuid(c.params.blueprintId);
    if ((await loadBlueprint(id)).status !== 'draft') throw new HttpError(409, 'state', 'Only a draft blueprint can be activated');
    // Activation requires every sample exam to be valid against the current bank.
    const report = await dryRun(id, 20);
    if (report.valid !== report.attempted || report.attempted === 0) {
      throw new HttpError(409, 'dry_run_failed', 'The current question bank cannot satisfy this blueprint', [
        ...report.violations.slice(0, 10).map((message) => ({ field: 'blueprint', message })),
      ]);
    }
    await run(async () => await store.activateBlueprint(id, c.claims.sub));
    return { status: 200, body: { id, status: 'active', dryRun: report } };
  });

  // ------------------------------------------------------------ case studies

  const caseDoc = (b: Record<string, unknown>) => {
    const errors: FieldError[] = [];
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const scenario = typeof b.scenario === 'string' ? b.scenario.trim() : '';
    const language = b.language === undefined ? 'en' : b.language;
    if (title.length < 3 || title.length > 200) errors.push({ field: 'title', message: 'must be text of 3 to 200 characters' });
    if (scenario.length < 100 || scenario.length > 6000) errors.push({ field: 'scenario', message: 'must be text of 100 to 6000 characters' });
    if (language !== 'en' && language !== 'ar') errors.push({ field: 'language', message: 'must be en or ar' });
    const ids = b.exhibitIds ?? [];
    const idsOk = Array.isArray(ids) && ids.length <= 5 && new Set(ids).size === ids.length &&
      ids.every((x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x));
    if (!idsOk) errors.push({ field: 'exhibitIds', message: 'must be a list of at most 5 different exhibit ids' });
    if (errors.length) throw invalidMany(errors);
    return { title, scenario, language, exhibitIds: ids as string[] };
  };

  add('GET', '/admin/case-studies', ROLES.anyStaff, async (c) => {
    const status = c.query.get('status');
    if (status !== null && !['draft', 'published', 'withdrawn'].includes(status)) throw invalid('status', 'is not valid');
    return { status: 200, body: { items: await store.listCaseStudies(status) } };
  });

  add('POST', '/admin/case-studies', ROLES.authors, async (c) => {
    const id = await store.createCaseStudy(c.claims.sub, caseDoc(c.body));
    return { status: 201, body: await cs(id) };
  });

  add('GET', '/admin/case-studies/:caseId', ROLES.anyStaff, async (c) => {
    const found = await cs(uuid(c.params.caseId));
    if (!found) throw notFound();
    return { status: 200, body: found };
  });

  add('PUT', '/admin/case-studies/:caseId', ROLES.authors, async (c) => {
    const id = uuid(c.params.caseId);
    await run(async () => await store.updateCaseStudy(id, c.claims.sub, isAdmin(c), caseDoc(c.body)));
    return { status: 200, body: await cs(id) };
  });

  add('POST', '/admin/case-studies/:caseId/publish', ROLES.admins, async (c) => {
    const id = uuid(c.params.caseId);
    await run(async () => await store.publishCaseStudy(id, c.claims.sub));
    return { status: 200, body: await cs(id) };
  });

  add('POST', '/admin/case-studies/:caseId/withdraw', ROLES.admins, async (c) => {
    const id = uuid(c.params.caseId);
    await run(async () => await store.withdrawCaseStudy(id, c.claims.sub));
    return { status: 200, body: await cs(id) };
  });

  add('GET', '/admin/blueprints', ROLES.admins, async () => ({ status: 200, body: { items: await store.listBlueprints() } }));

  // ------------------------------------------------------------ exhibits

  add('POST', '/admin/exhibits', ROLES.authors, async (c) => {
    const b = c.body;
    const errors: FieldError[] = [];
    const altText = typeof b.altText === 'string' ? b.altText.trim() : '';
    if (altText.length < 3 || altText.length > 500) errors.push({ field: 'altText', message: 'describe the exhibit in 3 to 500 characters' });
    if (b.kind === 'image') {
      const bytes = typeof b.dataBase64 === 'string' ? Buffer.from(b.dataBase64, 'base64') : Buffer.alloc(0);
      const detected = sniffImage(bytes);
      if (bytes.length === 0 || bytes.length > 1024 * 1024) errors.push({ field: 'dataBase64', message: 'must be an image of at most 1 MiB' });
      else if (!detected) errors.push({ field: 'dataBase64', message: 'must be a PNG, JPEG or WebP image' });
      else if (b.mimeType !== detected) errors.push({ field: 'mimeType', message: `the file is ${detected}` });
      if (errors.length) throw invalidMany(errors);
      const id = await store.createExhibit(c.claims.sub, { kind: 'image', altText, mimeType: detected!, base64: bytes.toString('base64') });
      return { status: 201, body: { id, kind: 'image', altText, url: exhibitUrl(id) } };
    }
    if (b.kind === 'table') {
      const t = (b.table ?? {}) as { header?: unknown; rows?: unknown };
      const cell = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
      const header = Array.isArray(t.header) ? t.header : [];
      const rows = Array.isArray(t.rows) ? t.rows : [];
      if (header.length < 1 || header.length > 12 || !header.every((h) => cell(h, 100))) errors.push({ field: 'table.header', message: 'must hold 1 to 12 text headings' });
      if (rows.length < 1 || rows.length > 30 || !rows.every((r) => Array.isArray(r) && r.length === header.length && r.every((v) => cell(v, 200)))) {
        errors.push({ field: 'table.rows', message: 'must hold 1 to 30 rows, each with one text cell per heading' });
      }
      if (errors.length) throw invalidMany(errors);
      const table = { header, rows };
      const id = await store.createExhibit(c.claims.sub, { kind: 'table', altText, table });
      return { status: 201, body: { id, kind: 'table', altText, table } };
    }
    throw invalid('kind', 'must be image or table');
  });

  // ------------------------------------------------------------ users

  add('GET', '/admin/users', ROLES.admins, async (c) => ({
    status: 200,
    body: { items: await store.findUsers((c.query.get('q') ?? '').slice(0, 100)) },
  }));

  add('PUT', '/admin/users/:userId/roles', ROLES.admins, async (c) => {
    const roles = c.body.roles;
    const known = ['student', 'content_author', 'content_reviewer', 'administrator'];
    if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => !known.includes(r as string)) || new Set(roles).size !== roles.length) {
      throw invalid('roles', `must be a list drawn from ${known.join(', ')}`);
    }
    const id = uuid(c.params.userId);
    await run(async () => await store.setRoles(id, c.claims.sub, roles as string[]));
    return { status: 200, body: (await store.findUsers('')).find((u) => u.id === id) ?? { id } };
  });

  add('POST', '/admin/users/:userId/mfa-reset', ROLES.admins, async (c) => {
    await run(async () => await store.resetMfa(uuid(c.params.userId), c.claims.sub));
    return { status: 204 };
  });

  // ------------------------------------------------------------ exam tips

  add('GET', '/admin/tips', ROLES.anyStaff, async () => ({ status: 200, body: { items: await store.tips(true) } }));

  // Replaces the whole document: sections and their tips, in the order sent.
  add('PUT', '/admin/tips', ROLES.authors, async (c) => {
    const { sections, errors } = validateTips(c.body.sections);
    if (errors.length) throw invalidMany(errors);
    await run(async () => await store.replaceTips(c.claims.sub, sections!));
    return { status: 200, body: { items: await store.tips(true) } };
  });

  // ------------------------------------------------------------ plans and access

  add('GET', '/admin/plans', ROLES.admins, async () => ({ status: 200, body: { items: await store.adminPlans() } }));

  add('PUT', '/admin/plans/:planCode/prices/:region', ROLES.admins, async (c) => {
    const region = c.params.region ?? '';
    if (!['EG', 'GULF', 'INTL'].includes(region)) throw notFound();
    const currency = typeof c.body.currency === 'string' ? c.body.currency.toUpperCase() : '';
    const amount = c.body.amountMinor;
    const product = c.body.storeProductId;
    const errors: FieldError[] = [];
    if (!/^[A-Z]{3}$/.test(currency)) errors.push({ field: 'currency', message: 'must be a three-letter currency code' });
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || amount > 100_000_000) {
      errors.push({ field: 'amountMinor', message: 'must be a whole amount in the smallest unit, such as piastres or cents' });
    }
    if (product !== undefined && product !== null && (typeof product !== 'string' || !/^[A-Za-z0-9._-]{3,100}$/.test(product))) {
      errors.push({ field: 'storeProductId', message: 'must be a store product id' });
    }
    if (errors.length) throw invalidMany(errors);
    await run(async () => await store.setPlanPrice(c.claims.sub, c.params.planCode ?? '', region, currency, amount as number, (product as string | undefined) ?? null));
    return { status: 200, body: { items: await store.adminPlans() } };
  });

  add('POST', '/admin/access-codes', ROLES.admins, async (c) => {
    const b = c.body;
    const errors: FieldError[] = [];
    const count = b.count, days = b.days;
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (typeof b.planCode !== 'string') errors.push({ field: 'planCode', message: 'is required' });
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 500) errors.push({ field: 'count', message: 'must be 1 to 500' });
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) errors.push({ field: 'days', message: 'must be 1 to 365' });
    if (label.length < 3 || label.length > 100) errors.push({ field: 'label', message: 'name the batch in 3 to 100 characters, such as a course and date' });
    let expires: string | null = null;
    if (b.expiresAt !== undefined && b.expiresAt !== null) {
      if (typeof b.expiresAt !== 'string' || Number.isNaN(Date.parse(b.expiresAt))) errors.push({ field: 'expiresAt', message: 'must be a date' });
      else expires = new Date(b.expiresAt).toISOString();
    }
    if (errors.length) throw invalidMany(errors);
    const codes = newAccessCodes(count as number);
    await run(async () => await store.createAccessCodes(c.claims.sub, b.planCode as string, days as number, codes.map((x) => hashToken(normalizeAccessCode(x))), label, expires));
    // Shown once; only hashes are kept.
    return { status: 201, body: { label, planCode: b.planCode, days, codes } };
  });

  add('POST', '/admin/users/:userId/grant', ROLES.admins, async (c) => {
    const days = c.body.days;
    if (typeof c.body.planCode !== 'string') throw invalid('planCode', 'is required');
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw invalid('days', 'must be 1 to 365');
    const note = typeof c.body.note === 'string' ? c.body.note.slice(0, 500) : null;
    const id = uuid(c.params.userId);
    await run(async () => await store.grantEntitlement(id, c.body.planCode as string, 'admin_grant', null, days, now(), c.claims.sub, note));
    return { status: 200, body: await store.userAccess(id, now()) };
  });

  // ------------------------------------------------------------ audit trail

  add('GET', '/admin/audit', ROLES.admins, async (c) => {
    const action = c.query.get('action');
    const actor = c.query.get('actor');
    const cursor = c.query.get('cursor');
    const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 50) || 50, 1), 200);
    if (action !== null && !/^[a-z_.]{1,60}$/.test(action)) throw invalid('action', 'is not valid');
    if (actor !== null && (actor.length > 254 || !actor.includes('@'))) throw invalid('actor', 'must be an email address');
    if (cursor !== null && !/^\d{1,18}$/.test(cursor)) throw invalid('cursor', 'is not valid');
    const items = await store.auditPage(action || null, actor || null, cursor === null ? null : Number(cursor), limit);
    const last = items[items.length - 1];
    return { status: 200, body: { items, nextCursor: items.length === limit && last ? String(last.id) : null } };
  });

  // ------------------------------------------------------------ certificates

  add('GET', '/admin/certificates', ROLES.admins, async (c) => {
    const userId = c.query.get('user_id');
    const passed = c.query.get('passed');
    const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(c.query.get('offset') ?? 0) || 0, 0);
    let where = 'WHERE 1=1';
    const params: (string | number | boolean | null)[] = [];
    if (userId) { params.push(userId); where += ` AND c.user_id = $${params.length}::uuid`; }
    if (passed !== null && passed !== undefined) { params.push(passed === 'true'); where += ` AND c.passed = $${params.length}`; }
    params.push(limit); const limitP = `$${params.length}`;
    params.push(offset); const offsetP = `$${params.length}`;
    const items = await store.rows<{
      id: string; token: string; user_id: string; score_percent: number;
      passed: boolean; issued_at: string; revoked_at: string | null; attempt_id: string;
    }>(
      `SELECT c.id, c.token, c.user_id, c.score_percent, c.passed, c.issued_at, c.revoked_at, c.attempt_id
         FROM certificates c ${where} ORDER BY c.issued_at DESC LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );
    return { status: 200, body: { items } };
  });

  add('POST', '/admin/certificates/:certId/revoke', ROLES.admins, async (c) => {
    const certId = uuid(c.params.certId);
    const reason = typeof c.body?.reason === 'string' ? c.body.reason.slice(0, 500) : 'admin_revoke';
    const result = await store.rows<{ id: string }>(
      `UPDATE certificates SET revoked_at = NOW(), revoke_reason = $1
         WHERE id = $2 AND revoked_at IS NULL RETURNING id`,
      [reason, certId],
    );
    if (!result.length) throw new HttpError(404, 'not_found', 'Certificate not found or already revoked');
    return { status: 200, body: { ok: true, id: certId } };
  });

  add('DELETE', '/admin/certificates/:certId/revoke', ROLES.admins, async (c) => {
    const certId = uuid(c.params.certId);
    const result = await store.rows<{ id: string }>(
      `UPDATE certificates SET revoked_at = NULL, revoke_reason = NULL
         WHERE id = $1 AND revoked_at IS NOT NULL RETURNING id`,
      [certId],
    );
    if (!result.length) throw new HttpError(404, 'not_found', 'Certificate not found or not revoked');
    return { status: 200, body: { ok: true, id: certId } };
  });

  // ------------------------------------------------------------ reports

  add('GET', '/admin/question-reports', ROLES.anyStaff, async (c) => {
    const status = c.query.get('status') ?? 'open';
    if (!['open', 'triaged', 'resolved'].includes(status)) throw invalid('status', 'must be open, triaged or resolved');
    return { status: 200, body: { items: await store.questionReports(status) } };
  });

  // GET /admin/question-difficulty — questions ranked by difficulty (most failed first)
  add('GET', '/admin/question-difficulty', ROLES.anyStaff, async (c) => {
    const limit = Math.min(200, parseInt(c.query.get('limit') ?? '50', 10) || 50);
    const minAttempts = parseInt(c.query.get('min_attempts') ?? '5', 10) || 5;
    const rows = await store.rows<{
      question_id: string; public_code: string; latest_version_id: string; task_code: string; domain_code: string;
      total_attempts: number; correct_attempts: number; difficulty_score: number;
    }>(
      `SELECT qd.question_id, qd.public_code, qd.latest_version_id, t.code AS task_code, d.code AS domain_code,
              qd.total_attempts, qd.correct_attempts, qd.difficulty_score
         FROM question_difficulty qd
         JOIN question_versions qv ON qv.id = qd.latest_version_id
         JOIN tasks t ON t.id = qv.task_id
         JOIN domains d ON d.id = t.domain_id
        WHERE qd.total_attempts >= $2
        ORDER BY qd.difficulty_score DESC, qd.total_attempts DESC
        LIMIT $1`,
      [limit, minAttempts],
    );
    return { status: 200, body: { items: rows } };
  });

  return routes;
}
