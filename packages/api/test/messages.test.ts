// Every message the API can send has Arabic, and Arabic requests get it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { toArabic } from '../src/messages-ar.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

/** Message texts written in the source: error titles, field messages, admin titles, password rules, Excel errors. */
function messagesInSource(): string[] {
  const found = new Set<string>();
  const add = (t: string) => { if (!t.includes('${')) found.add(t); };
  for (const f of ['app.ts', 'admin.ts', 'http.ts']) {
    const s = src(f);
    for (const m of s.matchAll(/new HttpError\(\s*\d+,\s*'[a-z_]+',\s*(['`])((?:(?!\1).)*)\1/g)) add(m[2]!);
    for (const m of s.matchAll(/\b(?:invalid|err)\(\s*(?:'[^']*'|`[^`]*`|[a-zA-Z.]+)\s*,\s*(['`])((?:(?!\1).)*)\1/g)) add(m[2]!);
    for (const m of s.matchAll(/message:\s*(['`])((?:(?!\1).)*)\1/g)) add(m[2]!);
    for (const m of s.matchAll(/titles: Record<string, string> = \{([^}]*)\}/g)) for (const k of m[1]!.matchAll(/:\s*'([^']+)'/g)) add(k[1]!);
  }
  const admin = src('admin.ts');
  const block = admin.slice(admin.indexOf('const ADMIN_TITLES'), admin.indexOf('};', admin.indexOf('const ADMIN_TITLES')));
  for (const k of block.matchAll(/:\s*'([^']+)'/g)) add(k[1]!);
  for (const m of src('auth.ts').matchAll(/return '([^']+)';/g)) add(m[1]!);
  for (const m of src('xlsx.ts').matchAll(/SpreadsheetError\('([^']+)'\)/g)) add(m[1]!);
  for (const m of readFileSync(new URL('../../exam-store/src/service.ts', import.meta.url), 'utf8').matchAll(/MockExamError\('([a-z_]+)'/g)) add(m[1]!.replaceAll('_', ' '));
  for (const m of readFileSync(new URL('../../exam-engine/src/session.ts', import.meta.url), 'utf8').matchAll(/code: '([a-z_]+)'/g)) add(m[1]!.replaceAll('_', ' '));
  // Not messages: MIME types listed in the same objects.
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) found.delete(t);
  return [...found];
}

describe('Arabic error messages', () => {
  it('has an Arabic translation for every message in the source', () => {
    const all = messagesInSource();
    assert.ok(all.length > 100, `found only ${all.length} messages; the extraction is broken`);
    assert.deepEqual(all.filter((t) => toArabic(t) === t), []);
  });

  it('translates messages with a changing part', () => {
    assert.equal(toArabic('must be one of quick, focused'), 'يجب أن تكون إحدى القيم: quick, focused');
    assert.equal(toArabic('same stem as row 3'), 'نص السؤال نفسه موجود في الصف 3');
    assert.equal(toArabic('must be text of 10 to 4000 characters'), 'يجب أن يكون نصاً من 10 إلى 4000 حرف');
    assert.equal(toArabic('The sheet has more than 1000 rows'), 'الورقة تحتوي على أكثر من 1000 صف');
    assert.equal(toArabic('an unknown message'), 'an unknown message');
  });
});
