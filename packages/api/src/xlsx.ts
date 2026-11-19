// Reads the first worksheet of an Excel (.xlsx) file into rows of text.
//
// An .xlsx file is a ZIP archive of XML parts. This reader handles only what
// a question import needs: shared and inline strings, numbers and booleans,
// in the first sheet of the workbook. Files come from staff, but are still
// treated as untrusted: entry count, sizes and the expansion of each part
// are capped so a crafted archive cannot exhaust memory.

import { inflateRawSync } from 'node:zlib';

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

export interface XlsxLimits {
  maxEntries: number;
  /** Largest uncompressed size of any one part, in bytes. */
  maxPartBytes: number;
  maxRows: number;
  maxColumns: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxLimits = { maxEntries: 2000, maxPartBytes: 32 * 1024 * 1024, maxRows: 5000, maxColumns: 80 };

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  flags: number;
}

function readZip(buf: Buffer, limits: XlsxLimits): Map<string, Entry> {
  // The end-of-central-directory record is in the last 64 KiB + 22 bytes.
  const minEocd = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError('This is not an Excel (.xlsx) file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new SpreadsheetError('Very large (ZIP64) workbooks are not supported');
  if (count > limits.maxEntries) throw new SpreadsheetError('The workbook has too many parts');
  const entries = new Map<string, Entry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError('The workbook is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, size, localOffset, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function part(buf: Buffer, entries: Map<string, Entry>, name: string, limits: XlsxLimits): string | null {
  const e = entries.get(name);
  if (!e) return null;
  if (e.flags & 1) throw new SpreadsheetError('Password-protected workbooks are not supported. Remove the password and try again');
  if (e.size > limits.maxPartBytes) throw new SpreadsheetError('The workbook is too large');
  const h = e.localOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new SpreadsheetError('The workbook is damaged');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new SpreadsheetError('The workbook is damaged');
  let out: Buffer;
  if (e.method === 0) out = data;
  else if (e.method === 8) {
    try {
      // maxOutputLength stops a part that expands far beyond its declared size.
      out = inflateRawSync(data, { maxOutputLength: limits.maxPartBytes });
    } catch {
      throw new SpreadsheetError('The workbook is damaged or too large');
    }
  } else throw new SpreadsheetError('The workbook uses an unsupported compression method');
  return out.toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, ent: string) => {
      if (ent[0] !== '#') return ENTITIES[ent]!;
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Text of all <t> runs inside one string item, as Excel shows it. */
const runsText = (xml: string): string =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => decodeXml(m[1] ?? '')).join('');

const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

/** The first worksheet as rows of cell text; blank rows are dropped. */
export function readXlsx(buf: Buffer, limits: XlsxLimits = DEFAULT_XLSX_LIMITS): string[][] {
  return readXlsxSheets(buf, limits, 1)[0]!.rows;
}

/** Every worksheet (up to `maxSheets`), in workbook order, with its name and rows. */
export function readXlsxSheets(buf: Buffer, limits: XlsxLimits = DEFAULT_XLSX_LIMITS, maxSheets = 10): Array<{ name: string; rows: string[][] }> {
  const entries = readZip(buf, limits);
  const workbook = part(buf, entries, 'xl/workbook.xml', limits);
  if (!workbook) throw new SpreadsheetError('This is not an Excel (.xlsx) file');
  const rels = part(buf, entries, 'xl/_rels/workbook.xml.rels', limits) ?? '';
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]!)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1]!)?.[1];
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].slice(0, maxSheets).map((m, i) => ({
    name: decodeXml(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? `Sheet${i + 1}`),
    path: targets.get(/\br:id="([^"]+)"/.exec(m[1]!)?.[1] ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`,
  }));
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });
  const sharedXml = part(buf, entries, 'xl/sharedStrings.xml', limits) ?? '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => runsText(m[1] ?? ''));
  const out = sheets.map((sh) => {
    const sheet = part(buf, entries, sh.path, limits);
    return sheet === null ? null : { name: sh.name, rows: sheetRows(sheet, shared, limits) };
  }).filter((x): x is { name: string; rows: string[][] } => x !== null);
  if (out.length === 0) throw new SpreadsheetError('The workbook has no worksheet');
  return out;
}

function sheetRows(sheet: string, shared: string[], limits: XlsxLimits): string[][] {

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      if (col >= limits.maxColumns) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = v === undefined ? '' : (shared[Number(v)] ?? '');
      else if (type === 'inlineStr') text = runsText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') text = '';
      else text = v === undefined ? '' : decodeXml(v);
      while (row.length < col) row.push('');
      row[col] = text;
    }
    if (row.some((c) => c.trim() !== '')) {
      rows.push(row);
      if (rows.length > limits.maxRows) throw new SpreadsheetError(`The sheet has more than ${limits.maxRows} rows`);
    }
  }
  return rows;
}
