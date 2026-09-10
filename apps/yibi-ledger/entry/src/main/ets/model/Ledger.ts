/** All monetary values are integer CNY cents; no arithmetic uses decimal yuan. */
export type EntryType = 'expense' | 'income';

export interface LedgerEntry {
  id: string;
  type: EntryType;
  amountCents: number;
  categoryId: string;
  date: string;
  note: string;
  createdAt: number;
}

export interface Category {
  id: string;
  label: string;
  glyph: string;
  color: string;
  type: EntryType;
}

export interface LedgerSummary {
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  count: number;
}

export interface CategoryTotal {
  categoryId: string;
  label: string;
  color: string;
  amountCents: number;
  /** Percentage on a 0–100 scale, without rounding. */
  percent: number;
}

interface LedgerDocument {
  version: number;
  entries: LedgerEntry[];
}

const MAX_ENTRY_CENTS = 999999999;
const CATEGORIES: Category[] = [
  { id: 'food', label: '餐饮', glyph: '食', color: '#C6814B', type: 'expense' },
  { id: 'transport', label: '交通', glyph: '行', color: '#6A879A', type: 'expense' },
  { id: 'shopping', label: '购物', glyph: '购', color: '#B98891', type: 'expense' },
  { id: 'home', label: '居家', glyph: '家', color: '#8A9470', type: 'expense' },
  { id: 'entertainment', label: '娱乐', glyph: '乐', color: '#9982AB', type: 'expense' },
  { id: 'health', label: '健康', glyph: '健', color: '#649A8D', type: 'expense' },
  { id: 'study', label: '学习', glyph: '学', color: '#AD995D', type: 'expense' },
  { id: 'other', label: '其他', glyph: '其', color: '#93918C', type: 'expense' },
  { id: 'salary', label: '工资', glyph: '薪', color: '#4E8474', type: 'income' },
  { id: 'bonus', label: '奖金', glyph: '奖', color: '#A88B48', type: 'income' },
  { id: 'parttime', label: '兼职', glyph: '兼', color: '#6A879A', type: 'income' },
  { id: 'other_income', label: '其他收入', glyph: '入', color: '#93918C', type: 'income' }
];

function cloneCategory(category: Category): Category {
  return {
    id: category.id, label: category.label, glyph: category.glyph,
    color: category.color, type: category.type
  };
}

function cloneEntry(entry: LedgerEntry): LedgerEntry {
  return {
    id: entry.id, type: entry.type, amountCents: entry.amountCents,
    categoryId: entry.categoryId, date: entry.date, note: entry.note,
    createdAt: entry.createdAt
  };
}

export function getCategories(type: EntryType): Category[] {
  if (type !== 'expense' && type !== 'income') {
    throw new Error('请选择收入或支出');
  }
  return CATEGORIES.filter((category: Category) => category.type === type)
    .map((category: Category) => cloneCategory(category));
}

export function categoryById(id: string): Category {
  const category = CATEGORIES.find((item: Category) => item.id === id);
  if (category === undefined) {
    throw new Error('账目分类不存在');
  }
  return cloneCategory(category);
}

export function parseAmount(input: string): number {
  if (typeof input !== 'string') {
    throw new Error('请输入正确的金额');
  }
  const value = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('金额应为正数，最多保留两位小数');
  }
  const parts = value.split('.');
  const whole = Number(parts[0]);
  const fraction = parts.length === 2 ? Number(parts[1].padEnd(2, '0')) : 0;
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_ENTRY_CENTS) {
    throw new Error('金额须在 0.01 至 9,999,999.99 元之间');
  }
  return cents;
}

export function formatAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error('金额必须是安全范围内的整数分');
  }
  const absolute = Math.abs(cents);
  const yuan = Math.floor(absolute / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % 100).toString().padStart(2, '0');
  return (cents < 0 ? '-' : '') + yuan + '.' + fraction;
}

function validateMonth(month: string): void {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000')) {
    throw new Error('月份格式应为 YYYY-MM');
  }
}

function validateDate(date: string): void {
  if (typeof date !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
    throw new Error('日期格式应为 YYYY-MM-DD');
  }
  validateMonth(date.slice(0, 7));
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > monthDays[month - 1]) {
    throw new Error('该日期不存在，请检查月份和天数');
  }
}

export function todayString(): string {
  const now = new Date();
  return now.getFullYear().toString().padStart(4, '0') + '-' +
    (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
    now.getDate().toString().padStart(2, '0');
}

export function currentMonth(): string {
  return todayString().slice(0, 7);
}

export function shiftMonth(month: string, delta: number): string {
  validateMonth(month);
  if (!Number.isSafeInteger(delta)) {
    throw new Error('月份偏移必须是整数');
  }
  const monthIndex = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  if (!Number.isSafeInteger(monthIndex) || monthIndex < 12 || monthIndex > 119999) {
    throw new Error('月份超出支持范围');
  }
  return Math.floor(monthIndex / 12).toString().padStart(4, '0') + '-' +
    (monthIndex % 12 + 1).toString().padStart(2, '0');
}

export function validateEntry(entry: LedgerEntry): void {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('账目格式不正确');
  }
  if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id)) {
    throw new Error('账目标识不正确');
  }
  if (entry.type !== 'income' && entry.type !== 'expense') {
    throw new Error('账目收支类型不正确');
  }
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0 || entry.amountCents > MAX_ENTRY_CENTS) {
    throw new Error('账目金额超出范围或不是整数分');
  }
  if (typeof entry.categoryId !== 'string' || categoryById(entry.categoryId).type !== entry.type) {
    throw new Error('账目分类与收支类型不匹配');
  }
  validateDate(entry.date);
  if (typeof entry.note !== 'string' || Array.from(entry.note).length > 100) {
    throw new Error('备注最多填写 100 字');
  }
  if (!Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 || entry.createdAt > 8640000000000000) {
    throw new Error('账目创建时间不正确');
  }
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error('账本汇总金额超出安全计算范围');
  }
  return result;
}

function validateEntries(entries: LedgerEntry[]): void {
  if (!Array.isArray(entries)) {
    throw new Error('账本中的账目列表不正确');
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    validateEntry(entry);
    if (ids.has(entry.id)) {
      throw new Error('账本存在重复的账目标识');
    }
    ids.add(entry.id);
  }
}

function newestFirst(left: LedgerEntry, right: LedgerEntry): number {
  if (left.date !== right.date) {
    return left.date > right.date ? -1 : 1;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt > right.createdAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function entriesForMonth(entries: LedgerEntry[], month: string): LedgerEntry[] {
  validateMonth(month);
  validateEntries(entries);
  return entries.filter((entry: LedgerEntry) => entry.date.slice(0, 7) === month)
    .map((entry: LedgerEntry) => cloneEntry(entry)).sort(newestFirst);
}

export function summarize(entries: LedgerEntry[]): LedgerSummary {
  validateEntries(entries);
  let incomeCents = 0;
  let expenseCents = 0;
  for (const entry of entries) {
    if (entry.type === 'income') {
      incomeCents = checkedAdd(incomeCents, entry.amountCents);
    } else {
      expenseCents = checkedAdd(expenseCents, entry.amountCents);
    }
  }
  return { incomeCents, expenseCents, balanceCents: checkedAdd(incomeCents, -expenseCents), count: entries.length };
}

export function categoryTotals(entries: LedgerEntry[]): CategoryTotal[] {
  const summary = summarize(entries);
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === 'expense') {
      totals.set(entry.categoryId, checkedAdd(totals.get(entry.categoryId) ?? 0, entry.amountCents));
    }
  }
  const result: CategoryTotal[] = [];
  for (const category of getCategories('expense')) {
    const amountCents = totals.get(category.id) ?? 0;
    if (amountCents > 0) {
      result.push({
        categoryId: category.id, label: category.label, color: category.color, amountCents,
        percent: amountCents / summary.expenseCents * 100
      });
    }
  }
  return result.sort((left: CategoryTotal, right: CategoryTotal) => right.amountCents - left.amountCents);
}

export function upsertEntry(entries: LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  validateEntries(entries);
  validateEntry(entry);
  const result = entries.filter((item: LedgerEntry) => item.id !== entry.id)
    .map((item: LedgerEntry) => cloneEntry(item));
  result.push(cloneEntry(entry));
  summarize(result);
  return result.sort(newestFirst);
}

export function removeEntry(entries: LedgerEntry[], id: string): LedgerEntry[] {
  validateEntries(entries);
  return entries.filter((entry: LedgerEntry) => entry.id !== id).map((entry: LedgerEntry) => cloneEntry(entry));
}

export function encodeLedger(entries: LedgerEntry[]): string {
  summarize(entries);
  const document: LedgerDocument = { version: 1, entries: entries.map((entry: LedgerEntry) => cloneEntry(entry)) };
  return JSON.stringify(document);
}

/** A missing file is handled by storage; empty or malformed file contents are errors. */
export function decodeLedger(raw: string): LedgerEntry[] {
  let parsed: LedgerDocument;
  try {
    parsed = JSON.parse(raw) as LedgerDocument;
  } catch {
    throw new Error('账本文件无法解析，原始数据已保留');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('账本文件格式不正确，原始数据已保留');
  }
  if (parsed.version !== 1) {
    throw new Error('账本版本不受支持，原始数据已保留');
  }
  summarize(parsed.entries);
  return parsed.entries.map((entry: LedgerEntry) => cloneEntry(entry)).sort(newestFirst);
}
