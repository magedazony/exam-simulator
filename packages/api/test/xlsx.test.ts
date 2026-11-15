// Unit tests of the Excel reader. No database needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { SpreadsheetError, readXlsx, readXlsxSheets } from '../src/xlsx.ts';

/** A minimal ZIP writer, to build crafted archives. */
function zip(parts: Array<{ name: string; data: Buffer; method?: 0 | 8; declaredSize?: number; flags?: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const method = p.method ?? 8;
    const body = method === 8 ? deflateRawSync(p.data) : p.data;
    const name = Buffer.from(p.name);
    const size = p.declaredSize ?? p.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(p.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(p.flags ?? 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const workbook = Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>');
const rels = Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/data.xml"/></Relationships>');

describe('Excel reader', () => {
  it('reads the first sheet of a real workbook: shared, rich and Arabic text, numbers, booleans; skips blank rows', () => {
    const rows = readXlsx(readFileSync(new URL('./fixtures/questions.xlsx', import.meta.url)));
    assert.equal(rows.length, 4);
    assert.equal(rows[0]![0], 'taskCode');
    assert.equal(rows[1]![0], 'PEOPLE-4');
    assert.equal(rows[1]![12], '42');
    assert.equal(rows[1]![13], 'TRUE');
    assert.equal(rows[2]![4], 'The sponsor asks for a fixed date & budget <now>. What should the project manager do?');
    assert.equal(rows[2]![10], 'Shows options with "trade-offs".');
    assert.equal(rows[3]![4], 'سؤال تجريبي بالعربي لاختبار قراءة النص');
    assert.equal(rows[3]![9], 'A;C');
  });

  it('reads every sheet with its name, in workbook order', () => {
    const sheets = readXlsxSheets(readFileSync(new URL('./fixtures/questions.xlsx', import.meta.url)));
    assert.deepEqual(sheets.map((s) => s.name), ['Questions', 'Notes']);
    assert.deepEqual(sheets[1]!.rows, [['not imported']]);
  });

  it('reads inline strings, stored parts and gaps between cells, through the workbook relationships', () => {
    const sheet = Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve"> x &amp; y </t></is></c><c r="C1"><v>3.5</v></c></row></sheetData></worksheet>');
    const rows = readXlsx(zip([{ name: 'xl/workbook.xml', data: workbook }, { name: 'xl/_rels/workbook.xml.rels', data: rels }, { name: 'xl/worksheets/data.xml', data: sheet, method: 0 }]));
    assert.deepEqual(rows, [[' x & y ', '', '3.5']]);
  });

  it('refuses files that are not workbooks, damaged, encrypted, or expand too far', () => {
    assert.throws(() => readXlsx(Buffer.from('taskCode,stem\nA,B')), SpreadsheetError);
    assert.throws(() => readXlsx(zip([{ name: 'other.txt', data: Buffer.from('x') }])), /not an Excel/);
    assert.throws(() => readXlsx(zip([{ name: 'xl/workbook.xml', data: workbook, flags: 1 }])), /Password/);
    // A part that claims to be small but inflates to 64 MiB.
    const bomb = Buffer.alloc(64 * 1024 * 1024, 0x20);
    assert.throws(
      () => readXlsx(zip([{ name: 'xl/workbook.xml', data: workbook }, { name: 'xl/worksheets/sheet1.xml', data: bomb, declaredSize: 100 }]), { maxEntries: 10, maxPartBytes: 1024 * 1024, maxRows: 10, maxColumns: 10 }),
      /damaged or too large/,
    );
    const many = '<worksheet><sheetData>' + Array.from({ length: 12 }, (_, i) => `<row><c t="inlineStr"><is><t>r${i}</t></is></c></row>`).join('') + '</sheetData></worksheet>';
    assert.throws(
      () => readXlsx(zip([{ name: 'xl/workbook.xml', data: workbook }, { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(many) }]), { maxEntries: 10, maxPartBytes: 1024 * 1024, maxRows: 10, maxColumns: 10 }),
      /more than 10 rows/,
    );
  });
});
