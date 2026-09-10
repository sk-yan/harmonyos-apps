import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { readXlsxRows, decodeSpreadsheetUtf8 } from '../entry/src/main/ets/model/Spreadsheet.ts';

type Part = [string, string];

function zip(parts: Part[], compressed = true): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of parts) {
    const filename = Buffer.from(name);
    const plain = Buffer.from(value);
    const data = compressed ? deflateRawSync(plain) : plain;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(plain), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(plain.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(compressed ? 8 : 0, 10);
    record.writeUInt32LE(crc32(plain), 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(plain.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

const WORKBOOK = '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账单" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELATIONS = '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const SHEET = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>交易单号</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>12.30</v></c></row></sheetData></worksheet>';
const SHARED = '<sst><si><t>000012345678901234567890</t></si></sst>';

function parts(sheet = SHEET): Part[] {
  return [
    ['xl/workbook.xml', WORKBOOK],
    ['xl/_rels/workbook.xml.rels', RELATIONS],
    ['xl/sharedStrings.xml', SHARED],
    ['xl/worksheets/sheet1.xml', sheet]
  ];
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, limit) }));
}

test('reads genuine DEFLATE XLSX parts and preserves long identifiers and decimal strings', async () => {
  assert.deepEqual(await readXlsxRows(zip(parts()), inflate), [
    ['交易单号', '金额'], ['000012345678901234567890', '12.30']
  ]);
});

test('supports stored ZIP entries, rich inline text, XML entities and sparse columns', async () => {
  const sheet = '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><r><t>早餐&amp;</t></r><r><t>咖啡 &#x2615;</t></r></is></c><c r="C1"><v>0012345678901234567890</v></c></row></sheetData></worksheet>';
  assert.deepEqual(await readXlsxRows(zip(parts(sheet), false), inflate), [['早餐&咖啡 ☕', '', '0012345678901234567890']]);
});

test('selects first visible worksheet through relationships instead of assuming sheet1', async () => {
  const data = parts();
  data[0][1] = '<workbook><sheets><sheet r:id="hidden" state="hidden"/><sheet r:id="rId1"/></sheets></workbook>';
  data[1][1] = '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
  data[3][0] = 'xl/worksheets/sheet2.xml';
  assert.equal((await readXlsxRows(zip(data), inflate))[1][0], '000012345678901234567890');
});

test('converts date-styled numbers while leaving ordinary numbers as text', async () => {
  const serial = (Date.UTC(2026, 8, 10, 12, 30) - Date.UTC(1899, 11, 30)) / 86400000;
  const sheet = `<worksheet><sheetData><row><c r="A1" s="1"><v>${serial}</v></c><c r="B1"><v>2500</v></c></row></sheetData></worksheet>`;
  const data = parts(sheet);
  data.push(['xl/styles.xml', '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>']);
  assert.deepEqual(await readXlsxRows(zip(data), inflate), [['2026-09-10 12:30:00', '2500']]);
});

test('honors the workbook 1904 date epoch', async () => {
  const data = parts('<worksheet><sheetData><row><c r="A1" s="1"><v>0</v></c></row></sheetData></worksheet>');
  data[0][1] = WORKBOOK.replace('<sheets>', '<workbookPr date1904="1"/><sheets>');
  data.push(['xl/styles.xml', '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>']);
  assert.deepEqual(await readXlsxRows(zip(data), inflate), [['1904-01-01 00:00:00']]);
});

test('does not evaluate formulas or accept stale cached formula results', async () => {
  await assert.rejects(readXlsxRows(zip(parts('<worksheet><sheetData><row><c r="A1"><f>HYPERLINK("https://example.invalid")</f><v>12</v></c></row></sheetData></worksheet>')), inflate), /公式/);
});

test('rejects DTDs, unknown entities and malformed XML', async () => {
  for (const text of ['<!DOCTYPE x [<!ENTITY a "secret">]>' + SHEET,
    SHEET.replace('交易单号', '&unknown;'), SHEET.replace('交易单号', '&#1;'),
    SHEET.replace('交易单号', '\0'), '<worksheet><sheetData></worksheet>']) {
    await assert.rejects(readXlsxRows(zip(parts(text)), inflate), /实体|DTD|标签|字符/);
  }
});

test('rejects zip traversal, duplicate entries and external worksheet relationships', async () => {
  await assert.rejects(readXlsxRows(zip([...parts(), ['../ledger.json', 'bad']]), inflate), /路径/);
  await assert.rejects(readXlsxRows(zip([...parts(), parts()[0]]), inflate), /重复/);
  const data = parts();
  data[1][1] = RELATIONS.replace('Target="', 'TargetMode="External" Target="');
  await assert.rejects(readXlsxRows(zip(data), inflate), /外部/);
});

test('rejects encrypted archives and over-budget expansion before calling the inflater', async () => {
  for (const kind of ['encrypted', 'expanded']) {
    const bytes = zip(parts());
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 6, true);
    if (kind === 'encrypted') view.setUint16(central + 8, 1, true);
    else view.setUint32(central + 24, 33 * 1024 * 1024, true);
    let called = false;
    await assert.rejects(readXlsxRows(bytes, async () => { called = true; return new Uint8Array(); }));
    assert.equal(called, false);
  }
});

test('requires exact decompressed length and CRC, even when an injected inflater misbehaves', async () => {
  await assert.rejects(readXlsxRows(zip(parts()), async (data, limit) => {
    const value = await inflate(data, limit);
    value[0] ^= 1;
    return value;
  }), /校验码/);
  await assert.rejects(readXlsxRows(zip(parts()), async (_data, limit) => new Uint8Array(limit + 1)), /长度/);
});

test('rejects missing relationships, truncated ZIP data and files above 8 MiB', async () => {
  await assert.rejects(readXlsxRows(zip(parts().filter(([name]) => !name.endsWith('.rels'))), inflate), /缺少/);
  await assert.rejects(readXlsxRows(zip(parts()).slice(0, -1), inflate), /完整/);
  await assert.rejects(readXlsxRows(new Uint8Array(8 * 1024 * 1024 + 1), inflate), /8 MiB/);
});

test('bounds row count and column addresses without allocating giant sparse arrays', async () => {
  const wide = SHEET.replace('r="B2"', 'r="XFD2"');
  await assert.rejects(readXlsxRows(zip(parts(wide)), inflate), /列/);
  const rows = '<row><c t="inlineStr"><is><t>明细</t></is></c></row>'.repeat(5101);
  await assert.rejects(readXlsxRows(zip(parts('<worksheet><sheetData>' + rows + '</sheetData></worksheet>')), inflate), /行数/);
});

test('strict UTF-8 supports BOM and supplementary characters, rejects invalid byte sequences', () => {
  assert.equal(decodeSpreadsheetUtf8(new Uint8Array(Buffer.from('\uFEFF支付宝🧾'))), '支付宝🧾');
  for (const bytes of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]]) {
    assert.throws(() => decodeSpreadsheetUtf8(new Uint8Array(bytes)));
  }
});

test('native URI adapter reads zlib counters through getZStream and releases streams and file', async () => {
  // This models the behavior observed on the API 23 emulator: output bytes are
  // written in place, but input-object counters remain zero and getters have no nextOut.
  const source = await readFile(new URL('../entry/src/main/ets/services/ImportService.ets', import.meta.url), 'utf8');
  const sharedUrl = new URL('../entry/src/main/ets/model/Spreadsheet.ts', import.meta.url).href;
  const prelude = `
    import { inflateRawSync } from 'node:zlib';
    import { readXlsxRows, decodeSpreadsheetUtf8 } from '${sharedUrl}';
    const input = new Uint8Array(${JSON.stringify(Array.from(zip(parts())))});
    export const probe = { fileClosed: 0, streamReads: 0, streamsEnded: 0, originalCounters: [] };
    let position = 0;
    const fs = {
      OpenMode: { READ_ONLY: 0 },
      async open() { return { fd: 1, name: 'synthetic.xlsx' }; },
      async stat() { return { size: input.length }; },
      async read(fd, buffer) {
        const count = Math.min(buffer.byteLength, input.length - position);
        new Uint8Array(buffer).set(input.subarray(position, position + count));
        position += count;
        return count;
      },
      async close() { probe.fileClosed++; }
    };
    const zlib = {
      ReturnStatus: { OK: 0, STREAM_END: 1 },
      CompressFlushMode: { FINISH: 4 },
      async createZip() {
        let state;
        return {
          async inflateInit2(stream, windowBits) {
            if (windowBits !== -15) throw new Error('Raw DEFLATE required');
            return 0;
          },
          async inflate(stream) {
            const output = inflateRawSync(new Uint8Array(stream.nextIn), { maxOutputLength: stream.availableOut });
            new Uint8Array(stream.nextOut).set(output);
            state = { totalIn: stream.nextIn.byteLength, totalOut: output.length };
            probe.originalCounters.push([stream.totalIn, stream.totalOut]);
            return 1;
          },
          async getZStream() { probe.streamReads++; return state; },
          async inflateEnd() { probe.streamsEnded++; return 0; }
        };
      }
    };
  `;
  const executable = prelude + stripTypeScriptTypes(source).replace(/^import .*;\r?\n/gm, '');
  const native: {
    readBillUri: (uri: string) => Promise<{ name: string; format: string; rows: string[][] }>;
    probe: { fileClosed: number; streamReads: number; streamsEnded: number; originalCounters: number[][] };
  } = await import('data:text/javascript;base64,' + Buffer.from(executable).toString('base64'));
  const file = await native.readBillUri('file://synthetic-test.xlsx');
  assert.deepEqual(file.rows, [['交易单号', '金额'], ['000012345678901234567890', '12.30']]);
  assert.equal(file.format, 'xlsx');
  assert.equal(native.probe.fileClosed, 1);
  assert.equal(native.probe.streamReads, 4);
  assert.equal(native.probe.streamsEnded, 4);
  assert.deepEqual(native.probe.originalCounters, [[0, 0], [0, 0], [0, 0], [0, 0]]);
});
