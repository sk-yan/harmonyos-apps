import { EntryType, LedgerEntry, decodeLedger, encodeLedger, parseAmount, summarize, validateEntry } from './Ledger';

export type BillSource = 'wechat' | 'alipay';
export type ImportDirection = 'expense' | 'income' | 'unknown';
export type ImportState = 'ready' | 'duplicate' | 'review' | 'ignored' | 'invalid';

export interface BillImportCandidate {
  id: string;
  rowNumber: number;
  source: BillSource;
  tradeId: string;
  importFingerprint: string;
  transactionTime: string;
  date: string;
  type: ImportDirection;
  amountCents: number;
  categoryId: string;
  note: string;
  merchant: string;
  description: string;
  transactionStatus: string;
  state: ImportState;
  reason: string;
  selected: boolean;
  canSelect: boolean;
}

export interface BillImportPreview {
  source: BillSource;
  candidates: BillImportCandidate[];
  readyCount: number;
  duplicateCount: number;
  reviewCount: number;
  ignoredCount: number;
  invalidCount: number;
  monthFrom: string;
  monthTo: string;
}

export interface BillImportCommit {
  entries: LedgerEntry[];
  addedEntries: LedgerEntry[];
  duplicateCount: number;
}

export interface ScreenshotDraft {
  amount: string;
  date: string;
  type: ImportDirection;
  merchant: string;
  note: string;
  rawText: string;
  warnings: string[];
}

export const MAX_IMPORT_ROWS: number = 5000;

interface BillColumns {
  time: number;
  direction: number;
  amount: number;
  merchant: number;
  description: number;
  status: number;
  tradeId: number;
  transactionType: number;
  remark: number;
  refundAmount: number;
}

interface HeaderLocation {
  index: number;
  columns: BillColumns;
}

function clean(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}

function compact(value: string): string {
  return clean(value).replace(/[\s\u3000]/g, '').replace(/（/g, '(').replace(/）/g, ')');
}

function truncate(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

function separator(text: string): string {
  let comma = 0;
  let tab = 0;
  let quoted = false;
  for (let index = 0; index < Math.min(text.length, 65536); index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted) {
      if (character === ',') {
        comma++;
      } else if (character === '\t') {
        tab++;
      }
    }
  }
  return tab > comma ? '\t' : ',';
}

/** Decode after the platform has converted UTF-8/GBK bytes into text. */
export function parseCsv(text: string): string[][] {
  if (typeof text !== 'string' || clean(text).length === 0) {
    throw new Error('账单文件为空');
  }
  if (text.length > 8 * 1024 * 1024) {
    throw new Error('账单文本过大，请按更短的时间范围重新导出');
  }
  const input = text.replace(/^\uFEFF/, '');
  const delimiter = separator(input);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else if (character === '\r' && input[index + 1] === '\n') {
        cell += '\n';
        index++;
      } else {
        cell += character;
      }
    } else if (character === delimiter || character === '\n' || character === '\r') {
      row.push(cell);
      cell = '';
      quoteClosed = false;
      if (character !== delimiter) {
        rows.push(row);
        row = [];
        if (character === '\r' && input[index + 1] === '\n') {
          index++;
        }
      }
    } else if (character === '"') {
      if (cell.trim().length !== 0 || quoteClosed) {
        throw new Error('CSV 引号格式不正确，请使用平台导出的原始账单文件');
      }
      cell = '';
      quoted = true;
    } else {
      if (quoteClosed && character.trim().length !== 0) {
        throw new Error('CSV 引号后存在无法识别的内容');
      }
      if (!quoteClosed) {
        cell += character;
      }
    }
  }
  if (quoted) {
    throw new Error('CSV 引号没有闭合，文件可能不完整');
  }
  if (cell.length > 0 || row.length > 0 || quoteClosed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function column(row: string[], names: string[]): number {
  return row.findIndex((value: string) => names.includes(compact(value)));
}

function columns(row: string[]): BillColumns {
  return {
    time: column(row, ['交易时间', '交易创建时间', '创建时间', '付款时间']),
    direction: column(row, ['收/支', '收支', '收支类型']),
    amount: column(row, ['金额(元)', '金额', '交易金额(元)', '交易金额']),
    merchant: column(row, ['交易对方', '交易对方名称', '对方名称', '商户名称']),
    description: column(row, ['商品', '商品名称', '商品说明', '交易说明']),
    status: column(row, ['当前状态', '交易状态', '交易当前状态']),
    tradeId: column(row, ['交易单号', '交易订单号', '交易号']),
    transactionType: column(row, ['交易类型', '交易分类', '类型']),
    remark: column(row, ['备注']),
    refundAmount: column(row, ['成功退款(元)', '退款金额(元)', '退款金额'])
  };
}

function findHeader(rows: string[][]): HeaderLocation {
  for (let index = 0; index < rows.length; index++) {
    const result = columns(rows[index]);
    if (result.time >= 0 && result.direction >= 0 && result.amount >= 0 &&
      (result.merchant >= 0 || result.description >= 0) && result.status >= 0) {
      return { index, columns: result };
    }
  }
  throw new Error('未找到微信或支付宝账单表头，请选择平台导出的账单明细文件');
}

function validateRows(rows: string[][]): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('账单文件为空');
  }
  // Bound even files made only of descriptions or empty lines before the header.
  if (rows.length > MAX_IMPORT_ROWS + 200) {
    throw new Error('每次最多导入 5000 笔账单，请缩小导出时间范围');
  }
  for (const row of rows) {
    if (!Array.isArray(row) || row.length > 128) {
      throw new Error('账单表格格式不正确或列数过多');
    }
    for (const value of row) {
      if (typeof value !== 'string') {
        throw new Error('账单单元格必须是文本，交易单号不可先转换成数字');
      }
      if (value.length > 16384) {
        throw new Error('账单单元格内容过长，请检查导出文件');
      }
    }
  }
}

export function detectBillSource(rows: string[][]): BillSource | undefined {
  validateRows(rows);
  let header: HeaderLocation;
  try {
    header = findHeader(rows);
  } catch {
    return undefined;
  }
  const names = rows[header.index].map((value: string) => compact(value));
  if (names.includes('交易单号')) {
    return 'wechat';
  }
  if (names.includes('交易订单号') || names.includes('交易号')) {
    return 'alipay';
  }
  const heading = rows.slice(0, header.index).map((row: string[]) => row.join(' ')).join('\n');
  if (heading.includes('微信') && !heading.includes('支付宝')) {
    return 'wechat';
  }
  if (heading.includes('支付宝') && !heading.includes('微信')) {
    return 'alipay';
  }
  return undefined;
}

function valueAt(row: string[], index: number): string {
  return index >= 0 && index < row.length ? clean(row[index]) : '';
}

function direction(value: string): ImportDirection {
  const normalized = compact(value);
  if (normalized === '支出' || normalized === '支') {
    return 'expense';
  }
  if (normalized === '收入' || normalized === '收') {
    return 'income';
  }
  return 'unknown';
}

function dateIsValid(date: string): boolean {
  try {
    validateEntry({ id: 'date-check', type: 'expense', amountCents: 1,
      categoryId: 'other', date, note: '', createdAt: 0 });
    return date >= '1900-01-01' && date <= '2100-12-31';
  } catch {
    return false;
  }
}

function normalizeTime(value: string): string {
  const match = clean(value).match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match === null) {
    return '';
  }
  const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  if (!dateIsValid(date)) {
    return '';
  }
  if (match[4] === undefined) {
    return date;
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) {
    return '';
  }
  return date + ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String(second).padStart(2, '0');
}

function importAmount(value: string): number {
  let amount = compact(value).replace(/^(人民币|CNY)/i, '').replace(/^([+-])[¥￥]/, '$1')
    .replace(/^[¥￥]/, '').replace(/元$/, '');
  amount = amount.replace(/^[+-]/, '');
  if (amount.includes(',')) {
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(amount)) {
      throw new Error('金额中的千位分隔符不正确');
    }
    amount = amount.replace(/,/g, '');
  }
  return parseAmount(amount);
}

function transactionId(value: string): string {
  let result = clean(value).replace(/^'/, '');
  const formula = result.match(/^="([A-Za-z0-9_-]+)"$/);
  if (formula !== null) {
    result = formula[1];
  }
  if (result === '/' || result === '-' || result === '--' || result === '无') {
    return '';
  }
  return result;
}

function validTradeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/.test(value) && !/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(value);
}

function identity(source: string, tradeId: string): string {
  return source + ':' + tradeId;
}

function approximateKey(type: string, date: string, amount: number): string {
  return type + ':' + date + ':' + amount.toString();
}

function sameTransaction(candidate: BillImportCandidate, entry: LedgerEntry): boolean {
  return candidate.amountCents === entry.amountCents && candidate.date === entry.date && candidate.type === entry.type;
}

function hasStateFingerprint(value: string | undefined): boolean {
  if (value === undefined) { return false; }
  try {
    const fields = JSON.parse(value) as string[];
    return Array.isArray(fields) && fields.length === 9 &&
      fields.every((field: string) => typeof field === 'string');
  } catch {
    return false;
  }
}

function sameImportDetails(candidate: BillImportCandidate, entry: LedgerEntry): boolean {
  return hasStateFingerprint(entry.importFingerprint) &&
    hasStateFingerprint(candidate.importFingerprint) && entry.importFingerprint === candidate.importFingerprint;
}

function sameCandidate(left: BillImportCandidate, right: BillImportCandidate): boolean {
  return left.amountCents === right.amountCents && left.date === right.date && left.type === right.type;
}

function conflictingStatus(left: BillImportCandidate, right: BillImportCandidate): boolean {
  return left.transactionStatus !== right.transactionStatus ||
    specialTransaction(left.reason) !== specialTransaction(right.reason);
}

function review(candidate: BillImportCandidate, reason: string, selectable: boolean): void {
  candidate.state = 'review';
  candidate.reason = reason;
  candidate.selected = false;
  candidate.canSelect = selectable;
}

function failedStatus(value: string): boolean {
  return /交易关闭|支付失败|交易失败|已撤销|已取消|未支付|等待付款|待支付|待付款|已作废/.test(value);
}

function specialTransaction(value: string): boolean {
  return /退款|退货|退回|转账|充值|提现|还款|理财|基金|余额宝|零钱通/.test(value);
}

function skipRow(row: string[]): boolean {
  if (row.every((value: string) => clean(value) === '')) {
    return true;
  }
  const first = row.find((value: string) => clean(value).length > 0) ?? '';
  return /^(?:[-*]{3,}|总笔数|共计|合计|总计|温馨提示|特别提示|统计时间|导出时间|说明[：:]|注[：:])/.test(clean(first));
}

function suggestedCategory(type: ImportDirection, transactionType: string, merchant: string, description: string): string {
  if (type === 'income') {
    const text = transactionType + ' ' + description;
    if (/工资|薪资/.test(text)) { return 'salary'; }
    if (/奖金/.test(text)) { return 'bonus'; }
    if (/兼职|劳务费/.test(text)) { return 'parttime'; }
    return 'other_income';
  }
  const label = compact(transactionType);
  if (label === '餐饮美食' || label === '餐饮') { return 'food'; }
  if (label === '交通出行') { return 'transport'; }
  if (label === '日用百货' || label === '服饰装扮' || label === '购物') { return 'shopping'; }
  if (label === '家居家装' || label === '住房物业') { return 'home'; }
  if (label === '文化休闲') { return 'entertainment'; }
  if (label === '医疗健康' || label === '医疗保健') { return 'health'; }
  if (label === '教育培训' || label === '文化教育') { return 'study'; }
  const text = merchant + ' ' + description;
  const guesses: string[] = [];
  if (/餐厅|饭店|食堂|面馆|咖啡|奶茶|早餐|午餐|晚餐/.test(text)) { guesses.push('food'); }
  if (/公交|地铁|打车|出租车|网约车|火车票|高铁票|机票/.test(text)) { guesses.push('transport'); }
  if (/超市|便利店|百货|服装|鞋店/.test(text)) { guesses.push('shopping'); }
  if (/水费|电费|燃气费|物业费|房租/.test(text)) { guesses.push('home'); }
  if (/电影院|电影票|演唱会/.test(text)) { guesses.push('entertainment'); }
  if (/药房|医院|挂号|诊所/.test(text)) { guesses.push('health'); }
  if (/学费|培训费|教材|书店/.test(text)) { guesses.push('study'); }
  return guesses.length === 1 ? guesses[0] : 'other';
}

function candidateFor(row: string[], rowNumber: number, source: BillSource, indices: BillColumns): BillImportCandidate {
  const time = normalizeTime(valueAt(row, indices.time));
  const type = direction(valueAt(row, indices.direction));
  const merchant = valueAt(row, indices.merchant);
  const description = valueAt(row, indices.description);
  const status = valueAt(row, indices.status);
  const transactionType = valueAt(row, indices.transactionType);
  const tradeId = transactionId(valueAt(row, indices.tradeId));
  const remark = valueAt(row, indices.remark);
  const noteParts: string[] = [];
  for (const part of [merchant, description, remark]) {
    if (part !== '' && part !== '/' && part !== '-' && !noteParts.includes(part)) {
      noteParts.push(part);
    }
  }
  const candidate: BillImportCandidate = {
    id: 'bill-row-' + rowNumber.toString(), rowNumber, source, tradeId,
    importFingerprint: '', transactionTime: time, date: time.slice(0, 10), type,
    amountCents: 0, categoryId: suggestedCategory(type, transactionType, merchant, description),
    note: truncate(noteParts.join(' · '), 100), merchant, description,
    transactionStatus: status, state: 'ready', reason: '', selected: true, canSelect: true
  };
  const errors: string[] = [];
  let refundCents = 0;
  try {
    candidate.amountCents = importAmount(valueAt(row, indices.amount));
  } catch (error) {
    errors.push((error as Error).message);
  }
  const refund = compact(valueAt(row, indices.refundAmount));
  if (refund !== '' && refund !== '/' && refund !== '-' && !/^[¥￥]?0(?:\.0{1,2})?$/.test(refund)) {
    try {
      refundCents = importAmount(refund);
    } catch {
      errors.push('成功退款金额格式不正确，请核对原始账单');
    }
  }
  if (time === '') {
    errors.push('交易日期或时间不正确，支持 1900 至 2100 年');
  }
  if (tradeId !== '' && !validTradeId(tradeId)) {
    errors.push('交易单号格式不正确或已变成科学计数法，请重新导出原始文件');
  }
  // Original state is retained independently of editable ledger values. The first
  // six fields match the early fingerprint; nine fields explicitly include status.
  const fields: string[] = [source, time, type, candidate.amountCents.toString(), compact(merchant), compact(description),
    compact(status), compact(transactionType), refundCents.toString()];
  candidate.importFingerprint = JSON.stringify(fields);
  if (candidate.importFingerprint.length > 4096) {
    errors.push('交易描述过长，无法保留完整比对信息');
  }
  if (errors.length > 0) {
    candidate.state = 'invalid';
    candidate.reason = errors.join('；');
    candidate.selected = false;
    candidate.canSelect = false;
    return candidate;
  }
  if (failedStatus(status)) {
    candidate.state = 'ignored';
    candidate.reason = '交易未完成或已关闭，本次不计入账本';
    candidate.selected = false;
    candidate.canSelect = false;
    return candidate;
  }
  if (type === 'unknown') {
    review(candidate, '账单未明确标为收入或支出，可能是不计收支交易；请核对后手动记账', false);
  } else if (refundCents > 0 || specialTransaction(transactionType + ' ' + status + ' ' + description)) {
    const treatment = type === 'income' ? '收入' : '支出';
    const reason = refundCents > 0 || /退款|退货|退回/.test(transactionType + status + description) ?
      (refundCents > 0 ? '该行包含成功退款 ' + amountString(refundCents) + ' 元；' : '退款相关交易需核对；') +
      '勾选后按' + treatment + '计入，不会自动冲减或修改原支出' :
      '转账、充值、提现、还款或理财可能不是日常收支；勾选后按' + treatment + '计入';
    review(candidate, reason, true);
  } else if (status === '' || !/成功|已收钱|已收款|已支付|支付完成|交易完成|已到账/.test(status)) {
    review(candidate, '交易状态不明确，请确认已完成且应计入' + (type === 'income' ? '收入' : '支出'), true);
  }
  if (candidate.state === 'ready' && type === 'income' && compact(valueAt(row, indices.amount)).startsWith('-')) {
    review(candidate, '金额带负号但账单标为收入，请确认后再勾选；勾选后按收入计入', true);
  }
  if (tradeId === '' && candidate.state === 'ready') {
    review(candidate, '没有交易单号，无法可靠去重；请确认这笔账单尚未记录', true);
  }
  return candidate;
}

export function parseBillRows(rows: string[][], source: BillSource, existing: LedgerEntry[]): BillImportPreview {
  validateRows(rows);
  summarize(existing);
  if (source !== 'wechat' && source !== 'alipay') {
    throw new Error('请选择微信或支付宝账单');
  }
  const detected = detectBillSource(rows);
  if (detected !== undefined && detected !== source) {
    throw new Error('账单平台与选择的来源不一致，请重新选择');
  }
  const header = findHeader(rows);
  const candidates: BillImportCandidate[] = [];
  const known = new Map<string, LedgerEntry>();
  const nearAll = new Set<string>();
  const nearWithoutIdentity = new Set<string>();
  const fingerprintsAll = new Set<string>();
  const fingerprintsWithoutIdentity = new Set<string>();
  for (const entry of existing) {
    const near = approximateKey(entry.type, entry.date, entry.amountCents);
    nearAll.add(near);
    if (entry.importFingerprint !== undefined) {
      fingerprintsAll.add(entry.importFingerprint);
    }
    if (entry.source !== undefined && entry.tradeId !== undefined) {
      known.set(identity(entry.source, entry.tradeId), entry);
    } else {
      nearWithoutIdentity.add(near);
      if (entry.importFingerprint !== undefined) {
        fingerprintsWithoutIdentity.add(entry.importFingerprint);
      }
    }
  }
  const seen = new Map<string, BillImportCandidate>();
  for (let index = header.index + 1; index < rows.length; index++) {
    if (skipRow(rows[index])) {
      continue;
    }
    if (candidates.length >= MAX_IMPORT_ROWS) {
      throw new Error('每次最多导入 5000 笔账单，请缩小导出时间范围');
    }
    const candidate = candidateFor(rows[index], index + 1, source, header.columns);
    candidates.push(candidate);
    const key = identity(candidate.source, candidate.tradeId);
    const withinFile = validTradeId(candidate.tradeId) ? seen.get(key) : undefined;
    if (withinFile !== undefined && (!sameCandidate(candidate, withinFile) || conflictingStatus(candidate, withinFile) ||
      candidate.importFingerprint !== withinFile.importFingerprint)) {
      const reason = '文件内相同交易单号的金额、日期、收支方向或交易状态冲突；请核对原始账单，本次不能直接新增';
      review(candidate, reason, false);
      review(withinFile, reason, false);
      continue;
    }
    if (candidate.state === 'invalid' || candidate.state === 'ignored') {
      if (validTradeId(candidate.tradeId) && withinFile === undefined) {
        seen.set(key, candidate);
      }
      continue;
    }
    const previous = candidate.tradeId !== '' ? known.get(key) : undefined;
    if (previous !== undefined) {
      if (!sameTransaction(candidate, previous)) {
        review(candidate, '已有相同平台和交易单号，但金额、日期或收支方向不同；请核对原记录，本次不能直接新增', false);
      } else if (!sameImportDetails(candidate, previous)) {
        review(candidate, hasStateFingerprint(previous.importFingerprint) ?
          '已有相同交易单号，但原始导入信息（时间、对方、交易状态或退款金额等）发生变化；请核对原记录，本次不能直接新增' :
          '已有相同交易单号，但旧记录没有完整的原始交易状态，无法确认一致；请核对原记录，本次不能直接新增', false);
      } else {
        candidate.state = 'duplicate';
        candidate.reason = '相同平台、交易单号、日期、金额和收支方向已存在';
        candidate.selected = false;
        candidate.canSelect = false;
      }
    } else if (withinFile !== undefined) {
      if (!sameCandidate(candidate, withinFile)) {
        const reason = '文件内相同交易单号的金额、日期或收支方向冲突；请核对原始账单，本次不能直接新增';
        review(candidate, reason, false);
        review(withinFile, reason, false);
      } else {
        candidate.state = 'duplicate';
        candidate.reason = '同一文件中已出现相同平台和交易单号';
        candidate.selected = false;
        candidate.canSelect = false;
      }
    } else {
      const near = approximateKey(candidate.type, candidate.date, candidate.amountCents);
      if ((candidate.tradeId === '' ? fingerprintsAll : fingerprintsWithoutIdentity).has(candidate.importFingerprint) && candidate.canSelect) {
        review(candidate, '与既有账目的原始导入信息相同，可能是重复导入；即使修改过金额或日期，也请先核对原记录。' + candidate.reason, true);
      } else if ((candidate.tradeId === '' ? nearAll : nearWithoutIdentity).has(near) && candidate.canSelect) {
        review(candidate, '已有同日、同额、同方向账目，可能是手工记录或缺单号的重复项；确认是另一笔后再勾选。' + candidate.reason, true);
      }
      nearAll.add(near);
      if (candidate.tradeId === '') {
        nearWithoutIdentity.add(near);
      } else {
        seen.set(key, candidate);
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('文件中没有账单明细');
  }
  const result: BillImportPreview = {
    source, candidates, readyCount: 0, duplicateCount: 0, reviewCount: 0,
    ignoredCount: 0, invalidCount: 0, monthFrom: '', monthTo: ''
  };
  for (const candidate of candidates) {
    if (candidate.state === 'ready') { result.readyCount++; }
    if (candidate.state === 'duplicate') { result.duplicateCount++; }
    if (candidate.state === 'review') { result.reviewCount++; }
    if (candidate.state === 'ignored') { result.ignoredCount++; }
    if (candidate.state === 'invalid') { result.invalidCount++; }
    const month = candidate.date.slice(0, 7);
    if (month !== '' && (result.monthFrom === '' || month < result.monthFrom)) { result.monthFrom = month; }
    if (month !== '' && (result.monthTo === '' || month > result.monthTo)) { result.monthTo = month; }
  }
  return result;
}

/** Pure preflight: either returns one complete next snapshot or throws without mutation. */
export function applyBillImport(existing: LedgerEntry[], candidates: BillImportCandidate[], now: number): BillImportCommit {
  if (!Array.isArray(candidates) || candidates.length > MAX_IMPORT_ROWS) {
    throw new Error('每次最多导入 5000 笔账单');
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) {
    throw new Error('导入时间不正确');
  }
  const entries = decodeLedger(encodeLedger(existing));
  const known = new Map<string, LedgerEntry>();
  const ids = new Set<string>();
  for (const entry of entries) {
    ids.add(entry.id);
    if (entry.source !== undefined && entry.tradeId !== undefined) {
      known.set(identity(entry.source, entry.tradeId), entry);
    }
  }
  const addedEntries: LedgerEntry[] = [];
  let duplicateCount = 0;
  let selectedCount = 0;
  let sequence = 0;
  for (const candidate of candidates) {
    if (!candidate.selected) {
      if (candidate.state === 'duplicate') {
        duplicateCount++;
      }
      continue;
    }
    selectedCount++;
    if (candidate.source !== 'wechat' && candidate.source !== 'alipay') {
      throw new Error('导入来源不正确');
    }
    if (candidate.tradeId !== '' && !validTradeId(candidate.tradeId)) {
      throw new Error('第 ' + candidate.rowNumber + ' 行交易单号不正确');
    }
    if (!candidate.canSelect || candidate.state === 'ignored' || candidate.state === 'invalid' ||
      candidate.state === 'duplicate' || candidate.type === 'unknown' || failedStatus(candidate.transactionStatus)) {
      throw new Error('第 ' + candidate.rowNumber + ' 行尚不能导入，请先核对；本次没有保存任何账单');
    }
    const key = identity(candidate.source, candidate.tradeId);
    const previous = candidate.tradeId === '' ? undefined : known.get(key);
    if (previous !== undefined) {
      if (!sameTransaction(candidate, previous)) {
        throw new Error('第 ' + candidate.rowNumber + ' 行与已有同号交易冲突，请核对原记录；本次没有保存任何账单');
      }
      if (!sameImportDetails(candidate, previous)) {
        throw new Error('第 ' + candidate.rowNumber + ' 行与已有同号交易的原始状态不一致或缺失，请核对原记录；本次没有保存任何账单');
      }
      duplicateCount++;
      continue;
    }
    if (!dateIsValid(candidate.date)) {
      throw new Error('第 ' + candidate.rowNumber + ' 行日期不正确');
    }
    let id = 'import-' + now.toString() + '-' + sequence.toString();
    while (ids.has(id)) {
      sequence++;
      id = 'import-' + now.toString() + '-' + sequence.toString();
    }
    sequence++;
    const type: EntryType = candidate.type;
    const entry: LedgerEntry = {
      id, type, amountCents: candidate.amountCents, categoryId: candidate.categoryId,
      date: candidate.date, note: candidate.note, createdAt: now, source: candidate.source,
      importFingerprint: candidate.importFingerprint
    };
    if (candidate.tradeId !== '') {
      entry.tradeId = candidate.tradeId;
    }
    validateEntry(entry);
    ids.add(id);
    entries.push(entry);
    addedEntries.push(entry);
    if (entry.tradeId !== undefined) {
      known.set(key, entry);
    }
  }
  if (selectedCount === 0) {
    throw new Error('请先选择要导入的账单');
  }
  summarize(entries);
  // Separate return snapshots so a caller cannot mutate the ledger through addedEntries.
  return { entries: decodeLedger(encodeLedger(entries)),
    addedEntries: decodeLedger(encodeLedger(addedEntries)), duplicateCount };
}

function amountString(cents: number): string {
  return Math.floor(cents / 100).toString() + '.' + (cents % 100).toString().padStart(2, '0');
}

function screenshotMoney(line: string): number {
  try {
    return importAmount(line);
  } catch {
    return 0;
  }
}

/** OCR text only creates an untrusted draft. No ledger entry or identity is created. */
export function extractScreenshotDraft(text: string): ScreenshotDraft {
  if (typeof text !== 'string' || clean(text).length === 0) {
    throw new Error('没有识别到文字，请换一张清晰截图或手动记账');
  }
  if (text.length > 65536) {
    throw new Error('识别文字过多，请裁剪到一笔交易的详情');
  }
  const result: ScreenshotDraft = {
    amount: '', date: '', type: 'unknown', merchant: '', note: '', rawText: text,
    warnings: ['识别结果只会填入草稿，请核对金额、日期和收支方向后保存']
  };
  const lines = text.split(/\r?\n/).map((line: string) => clean(line)).filter((line: string) => line !== '');
  const dates = new Set<string>();
  const dateMatches = text.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g) ?? [];
  for (const date of dateMatches) {
    const normalized = normalizeTime(date);
    if (normalized !== '') {
      dates.add(normalized.slice(0, 10));
    }
  }
  if (dates.size === 1) {
    for (const date of dates) { result.date = date; }
  } else {
    result.warnings.push(dates.size > 1 ? '识别到多个日期，请确认实际交易日期' : '没有识别到完整交易日期，请手动选择');
  }
  const amounts = new Set<number>();
  let positive = false;
  let negative = false;
  const forbidden = /余额|优惠|抵扣|手续费|原价|红包抵|积分|累计|总计|合计/;
  const moneyPattern = /^[+-]?\s*[¥￥]?\s*[+-]?\s*\d[\d,]*(?:\.\d{1,2})?\s*元?$/;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (forbidden.test(line)) {
      continue;
    }
    let rawAmount = '';
    const labeled = line.match(/^(?:实付(?:款|金额)?|支付金额|付款金额|收款金额|到账金额|转账金额|退款金额|交易金额|金额)[：:\s]*(.*)$/);
    if (labeled !== null) {
      rawAmount = labeled[1] || (index + 1 < lines.length ? lines[index + 1] : '');
    } else if (moneyPattern.test(line) && /[¥￥+.-]/.test(line) &&
      (index === 0 || !forbidden.test(lines[index - 1])) &&
      !(index > 1 && /^[¥￥]$/.test(lines[index - 1]) && forbidden.test(lines[index - 2]))) {
      rawAmount = line;
    }
    if (rawAmount !== '' && moneyPattern.test(rawAmount)) {
      const cents = screenshotMoney(rawAmount);
      if (cents > 0) {
        amounts.add(cents);
        if (rawAmount.includes('-')) { negative = true; }
        if (rawAmount.includes('+')) { positive = true; }
      }
    }
    const merchant = line.match(/^(?:商户名称|商户|交易对方|收款方|收款人|对方)[：:\s]+(.+)$/);
    if (merchant !== null && result.merchant === '') {
      result.merchant = truncate(merchant[1], 100);
    } else if (/^(?:商户名称|商户|交易对方|收款方|收款人|对方)[：:]?$/.test(line) && index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!moneyPattern.test(next) && !/时间|状态|金额/.test(next)) {
        result.merchant = truncate(next, 100);
      }
    }
  }
  if (amounts.size === 1) {
    for (const amount of amounts) { result.amount = amountString(amount); }
  } else {
    result.warnings.push(amounts.size > 1 ? '识别到多个金额，请确认实际收支金额，不能使用余额或优惠金额' :
      '没有识别到可靠的交易金额，余额和优惠金额不会自动填入');
  }
  const expense = negative || /支出|支付成功|付款成功|交易付款/.test(text);
  const income = positive || /收入|收款成功|已收款|收钱成功|收款到账/.test(text);
  if (specialTransaction(text) || failedStatus(text)) {
    result.warnings.push('截图可能包含退款、转账或未完成交易，请核对是否应计入日常收支');
  } else if (expense !== income) {
    result.type = expense ? 'expense' : 'income';
  }
  if (result.type === 'unknown') {
    result.warnings.push('收支方向不确定，请手动选择');
  }
  result.note = result.merchant;
  return result;
}
