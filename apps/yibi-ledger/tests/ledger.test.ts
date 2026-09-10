import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoryById, categoryTotals, currentMonth, decodeLedger, encodeLedger,
  entriesForMonth, formatAmount, getCategories, parseAmount, removeEntry,
  shiftMonth, summarize, todayString, upsertEntry, validateEntry
} from '../entry/src/main/ets/model/Ledger.ts';
import type { LedgerEntry } from '../entry/src/main/ets/model/Ledger.ts';

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'entry-1', type: 'expense', amountCents: 1234, categoryId: 'food',
    date: '2026-09-10', note: '', createdAt: 1789012800000, ...overrides
  };
}

test('decimal input is converted to exact cents without floating point rounding', () => {
  for (const [input, cents] of [['0.01', 1], ['0.29', 29], ['1.1', 110], ['2.55', 255],
    ['19.99', 1999], [' 1234.50 ', 123450], ['0001.01', 101], ['9999999.99', 999999999]] as const) {
    assert.equal(parseAmount(input), cents);
  }
  assert.equal(parseAmount('0.1') + parseAmount('0.2'), 30);
});

test('invalid amounts, excessive precision and amounts outside range are rejected', () => {
  for (const input of ['', ' ', '0', '0.00', '-1', '+1', 'NaN', 'Infinity', '1e2',
    '0x10', '1.001', '1.234', '1,000', '1 000', '.5', '1.', '10000000', '９', '1\n2']) {
    assert.throws(() => parseAmount(input), input);
  }
  assert.throws(() => parseAmount(100 as unknown as string));
});

test('formatting supports signed balances and exact fractional cents', () => {
  assert.equal(formatAmount(0), '0.00');
  assert.equal(formatAmount(1), '0.01');
  assert.equal(formatAmount(29), '0.29');
  assert.equal(formatAmount(1234567), '12,345.67');
  assert.equal(formatAmount(-10001), '-100.01');
  assert.equal(formatAmount(Number.MAX_SAFE_INTEGER), '90,071,992,547,409.91');
  for (const value of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatAmount(value));
  }
});

test('default categories are separated by type and returned as detached copies', () => {
  assert.deepEqual(getCategories('expense').map((category) => category.label),
    ['餐饮', '交通', '购物', '居家', '娱乐', '健康', '学习', '其他']);
  assert.equal(getCategories('income').length, 4);
  const categories = getCategories('expense');
  categories[0].label = 'changed';
  const category = categoryById('food');
  assert.equal(category.label, '餐饮');
  category.label = 'changed again';
  assert.equal(categoryById('food').label, '餐饮');
  assert.throws(() => categoryById('missing'));
});

test('dates validate actual calendar dates including century leap years', () => {
  for (const date of ['2024-02-29', '2000-02-29', '2026-09-30', '0001-01-01', '9999-12-31']) {
    assert.doesNotThrow(() => validateEntry(entry({ date })));
  }
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-09-31',
    '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '0000-01-01',
    '2026-09-10T00:00:00Z', '2026-09-10 ']) {
    assert.throws(() => validateEntry(entry({ date })), date);
  }
});

test('local today and current month use local calendar components', () => {
  const now = new Date();
  const expected = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
  assert.equal(todayString(), expected);
  assert.equal(currentMonth(), expected.slice(0, 7));
});

test('month navigation crosses years and rejects malformed or out-of-range months', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-09', -21), '2024-12');
  assert.equal(shiftMonth('0001-01', 0), '0001-01');
  assert.throws(() => shiftMonth('0001-01', -1));
  assert.throws(() => shiftMonth('9999-12', 1));
  assert.throws(() => shiftMonth('2026-9', 0));
  assert.throws(() => shiftMonth('2026-13', 0));
  assert.throws(() => shiftMonth('2026-01', 0.5));
  assert.throws(() => shiftMonth('2026-01', NaN));
});

test('month entries are filtered and sorted by date then creation time without mutation', () => {
  const original = [entry({ id: 'older', date: '2026-09-09' }),
    entry({ id: 'outside', date: '2026-08-31' }),
    entry({ id: 'first', createdAt: 100 }), entry({ id: 'latest', createdAt: 200 })];
  const filtered = entriesForMonth(original, '2026-09');
  assert.deepEqual(filtered.map((item) => item.id), ['latest', 'first', 'older']);
  filtered[0].note = 'changed';
  assert.equal(original[3].note, '');
  assert.deepEqual(original.map((item) => item.id), ['older', 'outside', 'first', 'latest']);
});

test('income, expense, balance and expense-only category shares agree', () => {
  const entries = [entry({ id: 'food-a', amountCents: 10 }), entry({ id: 'food-b', amountCents: 20 }),
    entry({ id: 'transport', categoryId: 'transport', amountCents: 70 }),
    entry({ id: 'salary', categoryId: 'salary', type: 'income', amountCents: 50000 })];
  assert.deepEqual(summarize(entries), { incomeCents: 50000, expenseCents: 100, balanceCents: 49900, count: 4 });
  const totals = categoryTotals(entries);
  assert.deepEqual(totals.map((total) => [total.categoryId, total.amountCents, total.percent]),
    [['transport', 70, 70], ['food', 30, 30]]);
  assert.deepEqual(categoryTotals([]), []);
  assert.deepEqual(summarize([]), { incomeCents: 0, expenseCents: 0, balanceCents: 0, count: 0 });
  assert.equal(summarize([entry()]).balanceCents, -1234);
});

test('entry validation rejects corrupt data and permits 100 Unicode code points', () => {
  for (const changes of [{ amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.1 },
    { amountCents: NaN }, { amountCents: Infinity }, { amountCents: 1000000000 },
    { type: 'income' }, { categoryId: 'unknown' }, { id: '' }, { id: '../x' },
    { createdAt: NaN }, { createdAt: -1 }, { createdAt: 0.1 }, { note: '字'.repeat(101) }]) {
    assert.throws(() => validateEntry(entry(changes as Partial<LedgerEntry>)));
  }
  assert.doesNotThrow(() => validateEntry(entry({ note: '💰'.repeat(100) })));
  assert.throws(() => validateEntry(entry({ note: '💰'.repeat(101) })));
  assert.throws(() => validateEntry(null as unknown as LedgerEntry));
  assert.throws(() => validateEntry({} as LedgerEntry));
});

test('create, edit and remove preserve prior snapshots and unique identities', () => {
  const first = entry();
  const added = upsertEntry([], first);
  first.note = 'external mutation';
  assert.equal(added[0].note, '');
  const edited = upsertEntry(added, entry({ amountCents: 200, note: '修改', date: '2026-08-31' }));
  assert.equal(edited.length, 1);
  assert.equal(edited[0].amountCents, 200);
  assert.equal(added[0].amountCents, 1234);
  assert.equal(entriesForMonth(edited, '2026-09').length, 0);
  assert.equal(entriesForMonth(edited, '2026-08').length, 1);
  assert.deepEqual(removeEntry(edited, first.id), []);
  assert.equal(edited.length, 1);
  assert.deepEqual(removeEntry(edited, 'not-present'), edited);
  assert.throws(() => upsertEntry([entry(), entry()], entry()));
});

test('ledger encoding round-trips Chinese notes, escapes and exact amounts', () => {
  const entries = [entry({ id: 'a', note: '午餐\n"两人份" 💰', amountCents: 29 }),
    entry({ id: 'b', type: 'income', categoryId: 'salary', amountCents: 999999999 })];
  assert.deepEqual(decodeLedger(encodeLedger(entries)), entries);
  assert.deepEqual(decodeLedger(encodeLedger([])), []);
  const document = JSON.parse(encodeLedger(entries));
  assert.equal(document.version, 1);
});

test('corrupt, unsupported and duplicate ledger data is never treated as an empty ledger', () => {
  for (const raw of ['', ' ', '{', 'null', '[]', '{}', '{"version":2,"entries":[]}',
    '{"version":1,"entries":null}', '{"version":1,"entries":[{}]}',
    '{"version":1,"entries":[null]}']) {
    assert.throws(() => decodeLedger(raw), raw);
  }
  assert.throws(() => decodeLedger(JSON.stringify({ version: 1, entries: [entry(), entry()] })));
  assert.throws(() => decodeLedger(JSON.stringify({ version: 1, entries: [entry({ amountCents: 1.01 })] })));
  assert.throws(() => encodeLedger([entry({ amountCents: NaN })]));
});
