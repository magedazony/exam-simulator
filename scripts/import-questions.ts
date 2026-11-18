/**
 * Import questions from an xlsx file into the exam simulator via the admin API.
 *
 * Usage:
 *   node scripts/import-questions.ts <xlsx-file> [--dry-run] [--url <api-url>] [--token <admin-token>]
 *
 * Environment variables (alternative to flags):
 *   PUBLIC_URL   Base URL of the API (e.g. https://exam.example.com)
 *   ADMIN_TOKEN  Bearer token for the admin API
 *
 * The xlsx must have columns matching the starter-drafts-docx2.xlsx schema:
 *   stem, stemAr, optionA, optionAAr, optionB, optionBAr, optionC, optionCAr,
 *   optionD, optionDAr, correct, whyCorrect, whyCorrectAr, difficulty, taskCode,
 *   mindset, keyConcept, keyConceptAr, learningObjective, approach, type, language
 *
 * OR the simpler PDF-extracted schema:
 *   stem, optionA, optionB, optionC, optionD, correct, whyCorrect,
 *   difficulty, taskCode, mindset, keyConcept, learningObjective, lang, source
 *
 * Rows with empty stem are skipped.
 * Rows with empty correct are flagged as requiring review (skipped unless --include-incomplete).
 *
 * Rate: 2 requests/second to avoid overloading the API.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// We need openpyxl equivalent — but we're in TypeScript/Node.
// Since openpyxl is Python, we use the xlsx npm package if available,
// or fall back to parsing a JSON export.
// For now, output a JSON template the operator can POST manually.

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`
Usage: node scripts/import-questions.ts <xlsx-file> [options]

Options:
  --dry-run              Print what would be imported without calling the API
  --url <url>            API base URL (or PUBLIC_URL env var)
  --token <token>        Admin bearer token (or ADMIN_TOKEN env var)
  --include-incomplete   Include rows where the correct answer is missing (for AR review)
  --limit <n>            Import only the first N rows (useful for testing)

Examples:
  node scripts/import-questions.ts content/pmp-questions-all.xlsx --dry-run
  node scripts/import-questions.ts content/starter-drafts-docx2.xlsx \\
    --url https://exam.example.com --token eyJhbG...

The script reads the xlsx using the Python openpyxl library via a child process
(Python 3 must be available). It then POSTs each question to POST /api/v1/admin/questions/drafts.

Admin API endpoint: POST /api/v1/admin/questions/drafts
  Body: { taskCode, approach, difficulty, type, stem, stemAr?, optionA, optionAAr?,
          optionB, optionBAr?, optionC, optionCAr?, optionD, optionDAr?,
          correct, whyCorrect, whyCorrectAr?, mindset?, keyConcept?, keyConceptAr?,
          learningObjective? }

A draft must then be reviewed and published via the admin panel before it
appears in practice sessions or mock exams.
`);
  process.exit(0);
}

const xlsxFile = args.find((a) => !a.startsWith('--') && !['--url', '--token', '--limit'].includes(a));
if (!xlsxFile) { console.error('Error: xlsx file argument required'); process.exit(1); }

const dryRun = args.includes('--dry-run');
const includeIncomplete = args.includes('--include-incomplete');
const apiUrl = (args[args.indexOf('--url') + 1] ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const token = args[args.indexOf('--token') + 1] ?? process.env.ADMIN_TOKEN ?? '';
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;

if (!dryRun && !apiUrl) { console.error('Error: --url or PUBLIC_URL required'); process.exit(1); }
if (!dryRun && !token) { console.error('Error: --token or ADMIN_TOKEN required'); process.exit(1); }

// Use Python + openpyxl to parse the xlsx (already installed in this project)
import { execFileSync } from 'node:child_process';

const pyScript = `
import json, sys
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb.active
headers = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
rows = []
for r in range(2, ws.max_row + 1):
    row = {}
    for ci, h in enumerate(headers, 1):
        v = ws.cell(r, ci).value
        if v is not None:
            row[h] = str(v).strip() if isinstance(v, str) else v
    rows.append(row)
print(json.dumps(rows))
`;

console.log(`Reading ${xlsxFile}...`);
let rows: Record<string, string>[];
try {
  const output = execFileSync('python3', ['-c', pyScript, xlsxFile], { encoding: 'utf8' });
  rows = JSON.parse(output);
} catch (e: any) {
  console.error('Failed to read xlsx (is Python 3 + openpyxl installed?):', e.message);
  process.exit(1);
}

console.log(`Found ${rows.length} rows.`);

// Normalize a row to the API draft format
function normalize(row: Record<string, string>): Record<string, unknown> | null {
  // Support both schemas
  const stem = row['stem'] ?? '';
  if (!stem.trim()) return null;  // skip empty

  const correct = (row['correct'] ?? '').toUpperCase().trim();
  if (!correct && !includeIncomplete) return null;  // skip rows without correct answer

  // Map difficulty: easy/medium/hard or 1/2/3
  let difficulty = (row['difficulty'] ?? 'medium').toLowerCase();
  if (difficulty === '1') difficulty = 'easy';
  else if (difficulty === '2') difficulty = 'medium';
  else if (difficulty === '3') difficulty = 'hard';
  if (!['easy', 'medium', 'hard'].includes(difficulty)) difficulty = 'medium';

  // Map approach/mindset
  const mindsetRaw = (row['mindset'] ?? row['approach'] ?? 'hybrid').toLowerCase();
  let approach = 'hybrid';
  if (mindsetRaw.includes('agile') || mindsetRaw.includes('رشيق')) approach = 'agile';
  else if (mindsetRaw.includes('pred') || mindsetRaw.includes('waterfall') || mindsetRaw.includes('تنبؤي')) approach = 'predictive';

  // Question type
  let type = (row['type'] ?? 'single').toLowerCase();
  if (!['single', 'multi', 'matching', 'hotspot', 'fill'].includes(type)) type = 'single';

  const doc: Record<string, unknown> = {
    taskCode: row['taskCode'] ?? 'PROCESS-2',
    approach,
    difficulty,
    type,
    stem: stem.trim(),
    optionA: (row['optionA'] ?? '').trim(),
    optionB: (row['optionB'] ?? '').trim(),
    optionC: (row['optionC'] ?? '').trim(),
    optionD: (row['optionD'] ?? '').trim(),
    correct: correct || 'A',
    whyCorrect: (row['whyCorrect'] ?? '').trim() || `[Explanation needed] Correct answer: ${row['correct'] ?? ''}`,
  };

  // Optional bilingual fields
  if (row['stemAr']) doc['stemAr'] = row['stemAr'].trim();
  if (row['optionAAr']) doc['optionAAr'] = row['optionAAr'].trim();
  if (row['optionBAr']) doc['optionBAr'] = row['optionBAr'].trim();
  if (row['optionCAr']) doc['optionCAr'] = row['optionCAr'].trim();
  if (row['optionDAr']) doc['optionDAr'] = row['optionDAr'].trim();
  if (row['whyCorrectAr']) doc['whyCorrectAr'] = row['whyCorrectAr'].trim();
  if (row['mindsetAr']) doc['mindsetAr'] = row['mindsetAr'].trim();
  if (row['keyConcept']) doc['keyConcept'] = row['keyConcept'].trim();
  if (row['keyConceptAr']) doc['keyConceptAr'] = row['keyConceptAr'].trim();
  if (row['learningObjective']) doc['learningObjective'] = row['learningObjective'].trim();

  return doc;
}

const drafts = rows.slice(0, limit).map(normalize).filter(Boolean) as Record<string, unknown>[];
console.log(`Valid drafts: ${drafts.length} (skipped ${rows.length - drafts.length} rows)`);

if (dryRun) {
  console.log('\n--- DRY RUN: first 3 drafts ---');
  for (const d of drafts.slice(0, 3)) {
    console.log(JSON.stringify(d, null, 2));
    console.log('---');
  }
  console.log(`\nWould POST ${drafts.length} drafts to ${apiUrl || '<url not set>'}/api/v1/admin/questions/drafts`);
  process.exit(0);
}

// Import with rate limiting: 2 req/sec
let ok = 0, failed = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log(`\nImporting ${drafts.length} drafts to ${apiUrl}...`);
for (let i = 0; i < drafts.length; i++) {
  const draft = drafts[i];
  try {
    const res = await fetch(`${apiUrl}/api/v1/admin/questions/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(draft),
    });
    if (res.ok) {
      ok++;
      if (ok % 10 === 0) process.stdout.write(`  ${ok}/${drafts.length}\r`);
    } else {
      const body = await res.text();
      console.error(`\n  Row ${i + 2}: HTTP ${res.status} — ${body.slice(0, 120)}`);
      failed++;
    }
  } catch (e: any) {
    console.error(`\n  Row ${i + 2}: Network error — ${e.message}`);
    failed++;
  }
  // 2 req/sec = 500ms between requests
  if (i < drafts.length - 1) await sleep(500);
}

console.log(`\nDone. ${ok} imported, ${failed} failed.`);
if (failed > 0) {
  console.log('Note: Check /api/v1/admin/questions/drafts for partial results.');
  process.exit(1);
}
