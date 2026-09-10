import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { decodeLedger, encodeLedger, summarize, upsertEntry, validateEntry } from '../entry/src/main/ets/model/Ledger.ts';
import type { LedgerEntry } from '../entry/src/main/ets/model/Ledger.ts';

// Keep the native module's extensionless imports; Node runs the exact module with
// only its Ledger module URL and erased type-only import names adjusted.
const source = await readFile(new URL('../entry/src/main/ets/model/BillImport.ts', import.meta.url), 'utf8');
const coreUrl = new URL('../entry/src/main/ets/model/Ledger.ts', import.meta.url).href;
const executable = stripTypeScriptTypes(source)
  .replace('import { EntryType, LedgerEntry, ', 'import { ')
  .replace("from './Ledger'", `from '${coreUrl}'`);
const module = await import('data:text/javascript;base64,' + Buffer.from(executable).toString('base64')) as
  typeof import('../entry/src/main/ets/model/BillImport.ts');
const { parseCsv, detectBillSource, parseBillRows, applyBillImport, extractScreenshotDraft } = module;

const WECHAT_HEADER = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)',
  '支付方式', '当前状态', '交易单号', '商户单号', '备注'];
const ALIPAY_HEADER = ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支',
  '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号'];
const NOW = 1789012800000;

interface RowOptions {
  time?: string;
  kind?: string;
  merchant?: string;
  description?: string;
  direction?: string;
  amount?: string;
  status?: string;
  tradeId?: string;
}

function row(options: RowOptions = {}): string[] {
  return [options.time ?? '2026-09-10 12:20:00', options.kind ?? '商户消费',
    options.merchant ?? '测试食堂', options.description ?? '午餐', options.direction ?? '支出',
    options.amount ?? '40.20', '零钱', options.status ?? '支付成功',
    options.tradeId ?? '42000000000000000000000000000001', 'merchant-id', '/'];
}

function manual(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return { id: 'manual-1', type: 'expense', amountCents: 4020, categoryId: 'food',
    date: '2026-09-10', note: '午餐', createdAt: 100, ...overrides };
}

test('synthetic WeChat export parses preamble, quoted comma, escaped quotes, multiline notes and long IDs', async () => {
  const text = await readFile(new URL('./fixtures/import/wechat.csv', import.meta.url), 'utf8');
  const rows = parseCsv('\uFEFF' + text.replace(/\n/g, '\r\n'));
  assert.equal(detectBillSource(rows), 'wechat');
  const preview = parseBillRows(rows, 'wechat', []);
  assert.equal(preview.candidates.length, 5);
  assert.equal(preview.readyCount, 2);
  assert.equal(preview.reviewCount, 2);
  assert.equal(preview.ignoredCount, 1);
  assert.equal(preview.monthFrom, '2026-01');
  assert.equal(preview.monthTo, '2026-09');
  assert.equal(preview.candidates[0].description, '双人套餐,含饮料');
  assert.match(preview.candidates[0].note, /午餐\n使用测试数据/);
  assert.equal(preview.candidates[1].description, '咖啡 "大杯"');
  assert.equal(preview.candidates[0].tradeId, '42000000000000000000000000000001');
});

test('Alipay older and newer column sets preserve exact currency and order IDs', async () => {
  const text = await readFile(new URL('./fixtures/import/alipay.csv', import.meta.url), 'utf8');
  const rows = parseCsv(text);
  assert.equal(detectBillSource(rows), 'alipay');
  const preview = parseBillRows(rows, 'alipay', []);
  assert.equal(preview.readyCount, 2);
  assert.equal(preview.candidates[0].amountCents, 123450);
  assert.equal(preview.candidates[0].date, '2026-09-10');
  const newer = parseBillRows([ALIPAY_HEADER, ['2026-09-10 13:15:00', '餐饮美食', '测试店',
    'test-account', '午餐', '支出', '19.99', '余额', '交易成功', "'202609100000000000000000000003", 'merchant']], 'alipay', []);
  assert.equal(newer.candidates[0].tradeId, '202609100000000000000000000003');
  assert.equal(newer.candidates[0].amountCents, 1999);
  assert.equal(newer.candidates[0].categoryId, 'food');
});

test('tab separated exports and already GBK-decoded Chinese text parse without transcoding the strings', () => {
  const text = WECHAT_HEADER.join('\t') + '\r\n' + row({ merchant: '武汉测试面馆' }).join('\t');
  const decodedText = new TextDecoder('gbk').decode(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal(decodedText, '中文');
  const preview = parseBillRows(parseCsv(text.replace('武汉测试面馆', decodedText)), 'wechat', []);
  assert.equal(preview.candidates[0].merchant, '中文');
});

test('empty, unknown, malformed CSV and wrong platform are explicit errors', () => {
  for (const text of ['', ' ', '"unterminated', 'a,"b"x']) {
    assert.throws(() => parseCsv(text));
  }
  assert.equal(detectBillSource([['hello', 'world']]), undefined);
  assert.throws(() => parseBillRows([['hello', 'world']], 'wechat', []), /表头/);
  assert.throws(() => parseBillRows([WECHAT_HEADER], 'wechat', []), /没有账单/);
  assert.throws(() => parseBillRows([WECHAT_HEADER, row()], 'alipay', []), /来源不一致/);
  assert.throws(() => parseBillRows([[10] as unknown as string[]], 'wechat', []), /必须是文本/);
});

test('5000 detail rows are supported and 5001 are rejected without truncation', () => {
  const data = Array.from({ length: 5000 }, (_, index) => row({ tradeId: 'test-' + String(index).padStart(6, '0') }));
  const preview = parseBillRows([WECHAT_HEADER, ...data], 'wechat', []);
  assert.equal(preview.candidates.length, 5000);
  assert.equal(preview.readyCount, 5000);
  assert.equal(applyBillImport([], preview.candidates, NOW).addedEntries.length, 5000);
  assert.throws(() => parseBillRows([WECHAT_HEADER, ...data, row()], 'wechat', []), /最多导入 5000/);
});

test('invalid amount, precision, dates, time, numeric formatting and damaged IDs cannot be selected', () => {
  for (const changes of [{ amount: '0' }, { amount: '1.001' }, { amount: '12,34' },
    { amount: '10000000' }, { time: '2026-02-29 12:20:00' }, { time: '2026-09-10 25:00:00' },
    { tradeId: '4.2E+31' }, { tradeId: '1E20' }, { tradeId: '4'.repeat(129) }]) {
    const candidate = parseBillRows([WECHAT_HEADER, row(changes)], 'wechat', []).candidates[0];
    assert.equal(candidate.state, 'invalid', JSON.stringify(changes));
    assert.equal(candidate.canSelect, false);
    assert.equal(candidate.selected, false);
  }
});

test('refunds, transfers, topups, cash withdrawal, repayment and wealth transactions require explicit review', () => {
  for (const kind of ['退款', '转账', '零钱充值', '零钱提现', '信用卡还款', '基金购买', '余额宝']) {
    const candidate = parseBillRows([WECHAT_HEADER, row({ kind })], 'wechat', []).candidates[0];
    assert.equal(candidate.state, 'review', kind);
    assert.equal(candidate.canSelect, true);
    assert.equal(candidate.selected, false);
    assert.match(candidate.reason, /支出/);
  }
  const refund = parseBillRows([WECHAT_HEADER, row({ kind: '退款', direction: '收入', status: '退款成功' })], 'wechat', []).candidates[0];
  assert.match(refund.reason, /按收入计入，不会自动冲减/);
  refund.selected = true;
  const result = applyBillImport([], [refund], NOW);
  assert.equal(summarize(result.entries).incomeCents, 4020);
  assert.equal(summarize(result.entries).expenseCents, 0);
});

test('a successful Alipay payment with a positive refund column is never silently counted at its gross amount', async () => {
  const text = await readFile(new URL('./fixtures/import/alipay.csv', import.meta.url), 'utf8');
  const rows = parseCsv(text);
  rows[3][13] = '20.00';
  const candidate = parseBillRows(rows, 'alipay', []).candidates[0];
  assert.equal(candidate.state, 'review');
  assert.equal(candidate.selected, false);
  assert.equal(candidate.amountCents, 123450);
  assert.match(candidate.reason, /成功退款 20.00 元/);
  assert.match(candidate.reason, /不会自动冲减/);
});

test('category suggestions use explicit labels or unambiguous keywords without changing accounting direction', () => {
  const explicit = parseBillRows([WECHAT_HEADER, row({ kind: '交通出行' })], 'wechat', []).candidates[0];
  assert.equal(explicit.categoryId, 'transport');
  assert.equal(explicit.type, 'expense');
  const known = parseBillRows([WECHAT_HEADER, row({ merchant: '测试药房', description: '药品' })], 'wechat', []).candidates[0];
  assert.equal(known.categoryId, 'health');
  const ambiguous = parseBillRows([WECHAT_HEADER, row({ merchant: '地铁咖啡店', description: '测试商品' })], 'wechat', []).candidates[0];
  assert.equal(ambiguous.categoryId, 'other');
  const unknown = parseBillRows([WECHAT_HEADER, row({ merchant: '某店', description: '某物' })], 'wechat', []).candidates[0];
  assert.equal(unknown.categoryId, 'other');
});

test('failed transactions are ignored and no-direction transactions cannot be selected', () => {
  for (const status of ['交易关闭', '支付失败', '已取消', '待付款']) {
    const candidate = parseBillRows([WECHAT_HEADER, row({ status })], 'wechat', []).candidates[0];
    assert.equal(candidate.state, 'ignored');
    assert.equal(candidate.canSelect, false);
  }
  const candidate = parseBillRows([WECHAT_HEADER, row({ direction: '不计收支' })], 'wechat', []).candidates[0];
  assert.equal(candidate.type, 'unknown');
  assert.equal(candidate.canSelect, false);
});

test('overlapping imports hard-dedupe only the same platform and transaction ID', () => {
  const first = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const committed = applyBillImport([], first.candidates, NOW);
  const repeated = parseBillRows([WECHAT_HEADER, row()], 'wechat', committed.entries);
  assert.equal(repeated.duplicateCount, 1);
  assert.equal(repeated.candidates[0].canSelect, false);
  const distinct = parseBillRows([WECHAT_HEADER, row({ tradeId: '42000000000000000000000000000002' })], 'wechat', committed.entries);
  assert.equal(distinct.readyCount, 1, 'same day and amount with distinct IDs are distinct transactions');
  const otherPlatform = committed.entries.map((entry) => ({ ...entry, source: 'alipay' as const }));
  assert.equal(parseBillRows([WECHAT_HEADER, row()], 'wechat', otherPlatform).readyCount, 1);
});

test('an explicitly confirmed transfer or refund reimported unchanged is a definite duplicate', () => {
  for (const kind of ['转账', '退款']) {
    const originalRows = [WECHAT_HEADER, row({ kind, direction: '收入', status: kind === '退款' ? '退款成功' : '已收钱' })];
    const preview = parseBillRows(originalRows, 'wechat', []);
    assert.equal(preview.candidates[0].state, 'review');
    preview.candidates[0].selected = true;
    const committed = applyBillImport([], preview.candidates, NOW);
    const repeated = parseBillRows(originalRows, 'wechat', committed.entries);
    assert.equal(repeated.duplicateCount, 1);
    assert.equal(repeated.reviewCount, 0);
    assert.equal(repeated.candidates[0].selected, false);
  }
});

test('the full source file and an overlapping slice retain identical transfer identities', async () => {
  const text = await readFile(new URL('./fixtures/import/wechat.csv', import.meta.url), 'utf8');
  const rows = parseCsv(text);
  const preview = parseBillRows(rows, 'wechat', []);
  preview.candidates.find((candidate) => candidate.description === '转账')!.selected = true;
  const committed = applyBillImport([], preview.candidates, NOW);
  assert.equal(committed.addedEntries.length, 3);
  const again = parseBillRows(rows, 'wechat', committed.entries);
  assert.equal(again.duplicateCount, 3);
  const overlap = parseBillRows([WECHAT_HEADER, rows[5], rows[7]], 'wechat', committed.entries);
  assert.equal(overlap.duplicateCount, 2);
});

test('refund or state changes after an earlier import are blocked, including at commit time', () => {
  const original = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const committed = applyBillImport([], original.candidates, NOW);
  const changed = parseBillRows([WECHAT_HEADER, row({ status: '已全额退款' })], 'wechat', committed.entries).candidates[0];
  assert.equal(changed.state, 'review');
  assert.equal(changed.canSelect, false);
  assert.match(changed.reason, /状态或退款金额/);
  changed.selected = true;
  assert.throws(() => applyBillImport(committed.entries, [changed], NOW + 1), /尚不能导入/);
  const stale = parseBillRows([WECHAT_HEADER, row({ status: '已全额退款' })], 'wechat', []);
  stale.candidates[0].selected = true;
  assert.throws(() => applyBillImport(committed.entries, stale.candidates, NOW + 2), /原始状态不一致/);
});

test('older imported records without complete state fingerprints are conservatively blocked', () => {
  const parsed = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const committed = applyBillImport([], parsed.candidates, NOW).entries[0];
  for (const fingerprint of [undefined, JSON.stringify(JSON.parse(committed.importFingerprint!).slice(0, 6))]) {
    const legacy: LedgerEntry = { ...committed, importFingerprint: fingerprint };
    const candidate = parseBillRows([WECHAT_HEADER, row()], 'wechat', [legacy]).candidates[0];
    assert.equal(candidate.state, 'review');
    assert.equal(candidate.canSelect, false);
    assert.match(candidate.reason, /旧记录没有完整/);
  }
});

test('duplicate rows inside a file are skipped while conflicting same IDs disable all affected rows', () => {
  const duplicates = parseBillRows([WECHAT_HEADER, row(), row()], 'wechat', []);
  assert.equal(duplicates.readyCount, 1);
  assert.equal(duplicates.duplicateCount, 1);
  assert.equal(applyBillImport([], duplicates.candidates, NOW).duplicateCount, 1);
  const conflict = parseBillRows([WECHAT_HEADER, row(), row({ amount: '50.00' })], 'wechat', []);
  assert.equal(conflict.reviewCount, 2);
  assert.ok(conflict.candidates.every((candidate) => !candidate.canSelect && !candidate.selected));
  assert.match(conflict.candidates[0].reason, /冲突/);
});

test('same-ID success and refunded or cancelled rows never hide the status conflict as a duplicate', () => {
  for (const status of ['已全额退款', '交易关闭']) {
    for (const rows of [[row(), row({ status })], [row({ status }), row()]]) {
      const preview = parseBillRows([WECHAT_HEADER, ...rows], 'wechat', []);
      assert.equal(preview.readyCount, 0);
      assert.equal(preview.reviewCount, 2);
      assert.ok(preview.candidates.every((candidate) => !candidate.selected && !candidate.canSelect));
      assert.match(preview.candidates[0].reason, /交易状态冲突/);
    }
  }
  const differentKind = parseBillRows([WECHAT_HEADER, row(), row({ kind: '退款' })], 'wechat', []);
  assert.equal(differentKind.readyCount, 0);
  assert.equal(differentKind.reviewCount, 2);
});

test('manual records and missing-ID rows are only suggested duplicates and are never silently discarded', () => {
  const near = parseBillRows([WECHAT_HEADER, row()], 'wechat', [manual()]);
  assert.equal(near.reviewCount, 1);
  assert.equal(near.candidates[0].canSelect, true);
  assert.equal(near.candidates[0].selected, false);
  near.candidates[0].selected = true;
  assert.equal(applyBillImport([manual()], near.candidates, NOW).entries.length, 2);
  const missing = parseBillRows([WECHAT_HEADER, row({ tradeId: '' }), row({ tradeId: '' })], 'wechat', []);
  assert.equal(missing.reviewCount, 2);
  assert.equal(missing.duplicateCount, 0);
  missing.candidates.forEach((candidate) => { candidate.selected = true; });
  const stored = applyBillImport([], missing.candidates, NOW).entries;
  assert.equal(stored.length, 2);
  const again = parseBillRows([WECHAT_HEADER, row({ tradeId: '' })], 'wechat', stored);
  assert.equal(again.reviewCount, 1);
  assert.equal(again.duplicateCount, 0);
  const edited = upsertEntry([stored[0]], { ...stored[0], amountCents: 5000, date: '2026-08-01' });
  const afterEdit = parseBillRows([WECHAT_HEADER, row({ tradeId: '' })], 'wechat', edited).candidates[0];
  assert.equal(afterEdit.state, 'review');
  assert.match(afterEdit.reason, /原始导入信息相同/);
});

test('v1 optional metadata survives serialization, snapshots, edits, and reimport after editing', () => {
  const old = manual();
  assert.deepEqual(decodeLedger(encodeLedger([old])), [old]);
  const preview = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const first = applyBillImport([], preview.candidates, NOW).entries;
  const edited = upsertEntry(first, { id: first[0].id, type: 'expense', amountCents: 5000,
    categoryId: 'food', date: first[0].date, note: '修正金额', createdAt: first[0].createdAt });
  assert.equal(edited[0].source, 'wechat');
  assert.equal(edited[0].tradeId, first[0].tradeId);
  assert.equal(edited[0].importFingerprint, first[0].importFingerprint);
  assert.equal(first[0].amountCents, 4020);
  assert.deepEqual(decodeLedger(encodeLedger(edited)), edited);
  assert.equal(JSON.parse(encodeLedger(edited)).version, 1);
  const repeat = parseBillRows([WECHAT_HEADER, row()], 'wechat', edited).candidates[0];
  assert.equal(repeat.state, 'review');
  assert.equal(repeat.canSelect, false);
  assert.match(repeat.reason, /金额、日期或收支方向不同/);
});

test('corrupt optional metadata is rejected instead of silently erased', () => {
  for (const changes of [{ source: 'other' }, { source: 'wechat', tradeId: '4'.repeat(129) },
    { source: 'wechat', tradeId: '1234E20' },
    { tradeId: 'test-001' }, { source: 'screenshot', tradeId: 'test-001' },
    { source: 'wechat', importFingerprint: '' }, { importFingerprint: 'text' }]) {
    assert.throws(() => validateEntry(manual(changes as Partial<LedgerEntry>)));
  }
});

test('commit preflight is atomic and rechecks data changed since preview', () => {
  const initial = [manual({ date: '2026-08-01' })];
  const preview = parseBillRows([WECHAT_HEADER, row(), row({ tradeId: 'test-002' })], 'wechat', initial);
  const before = JSON.stringify(initial);
  preview.candidates[1].amountCents = 0;
  assert.throws(() => applyBillImport(initial, preview.candidates, NOW));
  assert.equal(JSON.stringify(initial), before);
  assert.equal(preview.candidates[0].selected, true);
  const valid = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const first = applyBillImport([], valid.candidates, NOW);
  const repeated = applyBillImport(first.entries, valid.candidates, NOW + 1);
  assert.equal(repeated.addedEntries.length, 0);
  assert.equal(repeated.duplicateCount, 1);
  valid.candidates[0].amountCents = 1;
  assert.throws(() => applyBillImport(first.entries, valid.candidates, NOW + 2), /冲突/);
});

test('commit rejects ignored selections and returns independent snapshots with collision-free IDs', () => {
  const ignored = parseBillRows([WECHAT_HEADER, row({ status: '交易关闭' })], 'wechat', []);
  ignored.candidates[0].selected = true;
  assert.throws(() => applyBillImport([], ignored.candidates, NOW), /不能导入/);
  const preview = parseBillRows([WECHAT_HEADER, row()], 'wechat', []);
  const result = applyBillImport([manual({ id: 'import-' + NOW + '-0', date: '2026-08-01' })], preview.candidates, NOW);
  assert.equal(result.entries.length, 2);
  assert.notEqual(result.addedEntries[0].id, 'import-' + NOW + '-0');
  result.addedEntries[0].note = 'outside mutation';
  assert.notEqual(result.entries.find((entry) => entry.tradeId)?.note, 'outside mutation');
  assert.throws(() => applyBillImport([], [], NOW), /选择/);
  assert.throws(() => applyBillImport([], preview.candidates, NaN), /时间/);
});

test('screenshot extraction creates a draft from labeled paid amount and never uses balance or discount', () => {
  const text = '支付成功\n商户名称：测试咖啡店\n实付金额\n-¥38.50\n优惠金额\n10.00\n余额\n888.88\n交易时间：2026-09-10 12:20:00';
  const draft = extractScreenshotDraft(text);
  assert.equal(draft.amount, '38.50');
  assert.equal(draft.date, '2026-09-10');
  assert.equal(draft.type, 'expense');
  assert.equal(draft.merchant, '测试咖啡店');
  assert.equal(draft.rawText, text);
  assert.ok(draft.warnings.length > 0);
  assert.equal('id' in draft, false);
});

test('screenshot missing or ambiguous amounts, dates, and direction stay blank or unknown', () => {
  const missing = extractScreenshotDraft('余额\n888.88\n优惠金额：10.00');
  assert.equal(missing.amount, '');
  assert.equal(missing.date, '');
  assert.equal(missing.type, 'unknown');
  assert.equal(extractScreenshotDraft('余额\n¥\n888.88\n订单尾号\n123456').amount, '');
  const ambiguous = extractScreenshotDraft('收入\n支出\n金额：10.00\n金额：20.00\n2026-09-09\n2026-09-10');
  assert.equal(ambiguous.amount, '');
  assert.equal(ambiguous.date, '');
  assert.equal(ambiguous.type, 'unknown');
  const refund = extractScreenshotDraft('退款成功\n金额：20.00\n2026-09-10');
  assert.equal(refund.type, 'unknown');
  assert.match(refund.warnings.join(' '), /退款/);
  assert.throws(() => extractScreenshotDraft(' '), /没有识别/);
});
