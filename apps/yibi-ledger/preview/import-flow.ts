import {
  applyBillImport, detectBillSource, extractScreenshotDraft, parseBillRows,
} from '../entry/src/main/ets/model/BillImport';
import type { BillImportCandidate, BillImportPreview, BillSource, ScreenshotDraft } from '../entry/src/main/ets/model/BillImport';
import { categoryById, formatAmount, parseAmount, validateEntry } from '../entry/src/main/ets/model/Ledger';
import type { EntryType, LedgerEntry } from '../entry/src/main/ets/model/Ledger';
import { readBillFile } from './file-reader';
import type { BillFile } from './file-reader';
import { LocalOcr } from './local-ocr';

export interface ScreenshotEntryDraft { amount: string; date: string; type: EntryType; categoryId: string; note: string }
interface ImportHost {
  entries(): LedgerEntry[];
  save(entries: LedgerEntry[]): boolean;
  saved(added: LedgerEntry[], duplicateCount: number): void;
  adoptScreenshot(draft: ScreenshotEntryDraft): boolean;
  reload(): void;
  storageError(): string;
}
type Stage = 'choose' | 'loading' | 'review' | 'screenshot';
type RowFilter = 'all' | 'selected' | 'review' | 'skipped';
const PAGE_SIZE = 30;
const sourceName = (source: BillSource) => source === 'wechat' ? '微信支付' : '支付宝';
const stateName = { ready: '可导入', review: '需要核对', duplicate: '已存在', ignored: '不计入', invalid: '无法导入' };
const esc = (text: string) => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

export function createImportFlow(host: ImportHost) {
  const modal = document.createElement('dialog');
  modal.className = 'import-dialog';
  modal.id = 'import-dialog';
  modal.setAttribute('aria-labelledby', 'import-title');
  document.body.append(modal);
  const ocr = new LocalOcr();
  let stage: Stage = 'choose';
  let source: BillSource | 'auto' = 'auto';
  let file: BillFile | undefined;
  let preview: BillImportPreview | undefined;
  let trigger: HTMLElement | null = null;
  let error = '';
  let token = 0;
  let rowFilter: RowFilter = 'all';
  let page = 0;
  let busy = false;
  let committing = false;
  let imageUrl = '';
  let imageName = '';
  let rawText = '';
  let screenshot: ScreenshotDraft | undefined;
  let reviewed = false;
  let screenshotTouched = false;
  const confirmedRows = new Set<string>();

  function unsaved() { return modal.open && (busy || stage === 'review' || screenshotTouched || rawText.length > 0 || imageUrl.length > 0); }
  function revokeImage() { if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; imageName = ''; }
  function clear() {
    token += 1;
    ocr.cancel();
    revokeImage();
    stage = 'choose'; source = 'auto'; file = undefined; preview = undefined;
    error = ''; rowFilter = 'all'; page = 0; busy = false; committing = false;
    rawText = ''; screenshot = undefined; reviewed = false; screenshotTouched = false;
    confirmedRows.clear();
  }
  function close(force = false) {
    if (committing) return;
    if (!force && unsaved() && !window.confirm('退出这次导入？尚未确认的内容不会写入账本，原有记录和手工草稿会保留。')) return;
    clear(); modal.close();
    if (trigger?.isConnected) trigger.focus();
  }
  function open(element: HTMLElement, initial: 'choose' | 'screenshot' = 'choose') {
    trigger = element;
    clear(); stage = initial; render(); modal.showModal();
    modal.querySelector<HTMLButtonElement>('#choose-file')?.focus();
  }
  function returnToChoose() {
    if (unsaved() && !window.confirm('返回选择方式？当前导入预览或截图草稿将被清除，账本不会改变。')) return;
    clear(); render();
  }
  function selected() { return preview?.candidates.filter(candidate => candidate.selected && candidate.canSelect) ?? []; }
  function selectedTotals() {
    const candidates = selected();
    return {
      income: candidates.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amountCents, 0),
      expense: candidates.filter(item => item.type === 'expense').reduce((sum, item) => sum + item.amountCents, 0),
    };
  }
  function statusMarkup() {
    return error ? `<div class="import-error" role="alert"><p>${esc(error)}</p>${host.storageError() ? '<button type="button" id="reload-import" class="button-secondary">重新读取并复核</button>' : ''}</div>` : '';
  }

  function render() {
    const focusedId = (document.activeElement as HTMLElement | null)?.id;
    const scroll = modal.scrollTop;
    const title = stage === 'review' ? '确认导入内容' : stage === 'screenshot' ? '截图辅助记账' : stage === 'loading' ? '正在读取账单' : '导入账单';
    modal.innerHTML = `<div class="import-shell">
      <header class="import-heading"><div><p class="import-eyebrow">只在本机处理</p><h2 id="import-title">${title}</h2></div><button type="button" id="close-import" class="icon-button" aria-label="关闭导入">×</button></header>
      ${stage === 'choose' ? chooseMarkup() : stage === 'loading' ? '<div class="import-loading" role="status"><span class="loading-ring"></span><p>正在本地解析文件，账本尚未改变。</p><button type="button" id="cancel-parse" class="button-secondary">取消读取</button></div>' : stage === 'review' ? reviewMarkup() : screenshotMarkup()}
      ${statusMarkup()}
      <p class="import-privacy">文件、图片与识别文字不会上传。确认前不会增加任何账单。</p>
    </div>`;
    modal.querySelector('#close-import')!.addEventListener('click', () => close());
    modal.querySelector('#return-import')?.addEventListener('click', returnToChoose);
    modal.querySelector('#cancel-parse')?.addEventListener('click', returnToChoose);
    modal.querySelector('#reload-import')?.addEventListener('click', () => {
      host.reload();
      if (host.storageError()) { error = host.storageError(); render(); return; }
      if (file && source !== 'auto') { preview = parseBillRows(file.rows, source, host.entries()); confirmedRows.clear(); }
      error = ''; render();
    });
    if (stage === 'choose') bindChoose();
    else if (stage === 'review') bindReview();
    else if (stage === 'screenshot') bindScreenshot();
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    modal.scrollTop = scroll;
  }

  function chooseMarkup() {
    return `<p class="import-intro">把已有记录带进来，再逐笔确认。</p>
      <div class="import-options">
        <button id="choose-file" type="button" class="import-option"><span class="option-symbol" aria-hidden="true">↧</span><strong>支付宝 / 微信账单</strong><span>CSV、XLSX 文件 · 支持重复检查</span></button>
        <button id="choose-screenshot" type="button" class="import-option"><span class="option-symbol" aria-hidden="true">▧</span><strong>账单截图 / 识别文字</strong><span>生成一笔待核对草稿</span></button>
      </div>
      <div class="import-file-settings"><label for="bill-source">账单来源</label><select id="bill-source"><option value="auto">自动识别</option><option value="alipay">支付宝</option><option value="wechat">微信支付</option></select></div>
      <input id="bill-file" class="sr-only" type="file" accept=".csv,.xlsx" aria-label="选择支付宝或微信账单文件" />
      <div class="import-help"><strong>文件准备</strong><p>从支付宝或微信支付导出交易明细，解压后选择 CSV / XLSX。CSV 自动识别 UTF-8 或 GBK；XLSX 读取首张可见工作表。</p><p>单个文件最多 8 MB、5,000 行。退款、转账和可疑重复需要单独核对。</p></div>`;
  }
  function bindChoose() {
    modal.querySelector<HTMLSelectElement>('#bill-source')!.value = source;
    modal.querySelector('#bill-source')!.addEventListener('change', event => { source = (event.target as HTMLSelectElement).value as BillSource | 'auto'; });
    modal.querySelector('#choose-file')!.addEventListener('click', () => modal.querySelector<HTMLInputElement>('#bill-file')!.click());
    modal.querySelector('#bill-file')!.addEventListener('change', event => { const chosen = (event.target as HTMLInputElement).files?.[0]; if (chosen) void loadFile(chosen); });
    modal.querySelector('#choose-screenshot')!.addEventListener('click', () => { stage = 'screenshot'; error = ''; render(); });
  }
  async function loadFile(chosen: File) {
    const current = ++token;
    stage = 'loading'; busy = true; error = ''; render();
    try {
      const read = await readBillFile(chosen, () => current !== token);
      if (current !== token) return;
      const detected = source === 'auto' ? detectBillSource(read.rows) : source;
      if (!detected) throw new Error('没有识别到支付宝或微信账单表头。请选择原始导出明细，或在选择文件前指定账单来源。');
      const result = parseBillRows(read.rows, detected, host.entries());
      file = read; source = detected; preview = result; stage = 'review'; page = 0; rowFilter = 'all';
    } catch (failure) {
      if (current !== token) return;
      error = errorText(failure); stage = 'choose';
    } finally { if (current === token) { busy = false; render(); modal.scrollTop = 0; } }
  }

  function visibleCandidates() {
    return preview!.candidates.filter(candidate => rowFilter === 'all' ||
      (rowFilter === 'selected' && candidate.selected) ||
      (rowFilter === 'review' && candidate.state === 'review') ||
      (rowFilter === 'skipped' && !candidate.canSelect));
  }
  function reviewMarkup() {
    if (!preview || !file) return '';
    const totals = selectedTotals();
    const count = selected().length;
    const selectedMonths = [...new Set(selected().map(candidate => candidate.date.slice(0, 7)))].sort();
    const selectedScope = selectedMonths.length > 1 ? `${selectedMonths[0]} 至 ${selectedMonths.at(-1)}` : selectedMonths[0] || '未选择记录';
    const visible = visibleCandidates();
    const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    page = Math.min(page, pageCount - 1);
    return `<div class="import-file-description"><strong>${sourceName(preview.source)}</strong><span>${esc(file.name)}</span><small>账单月份：${preview.monthFrom || '未识别'}${preview.monthTo && preview.monthTo !== preview.monthFrom ? ` 至 ${preview.monthTo}` : ''} · ${file.format}</small></div>
      <div class="import-counts"><span><b>${preview.readyCount}</b>可导入</span><span><b>${preview.reviewCount}</b>待核对</span><span><b>${preview.duplicateCount}</b>已存在</span><span><b>${preview.ignoredCount}</b>不计入</span><span><b>${preview.invalidCount}</b>无效</span></div>
      <p class="import-review-note">已存在的交易不会重复写入。待核对项默认不选；请核实退款、转账与同日同额记录。缺少关键字段的行需手工补记。</p>
      <div class="import-list-toolbar"><label for="import-filter">显示</label><select id="import-filter"><option value="all">全部 ${preview.candidates.length} 行</option><option value="selected">已选 ${count} 行</option><option value="review">待核对 ${preview.reviewCount} 行</option><option value="skipped">不能导入 ${preview.candidates.filter(candidate => !candidate.canSelect).length} 行</option></select><button type="button" id="select-ready" class="text-button">选择可直接导入项</button><button type="button" id="deselect-all" class="text-button">全部取消</button></div>
      <div class="import-rows">${visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(candidate => candidateMarkup(candidate)).join('') || '<p class="import-no-rows">这个筛选下没有记录。</p>'}</div>
      ${pageCount > 1 ? `<nav class="import-pagination" aria-label="导入预览分页"><button type="button" id="import-previous" class="button-secondary" ${page === 0 ? 'disabled' : ''}>上一页</button><span>第 ${page + 1} / ${pageCount} 页</span><button type="button" id="import-next" class="button-secondary" ${page === pageCount - 1 ? 'disabled' : ''}>下一页</button></nav>` : ''}
      <div class="import-confirmation"><div class="import-selected-summary" aria-live="polite"><strong>已选 ${count} 笔<small class="selection-scope">${sourceName(preview.source)} · ${selectedScope}</small></strong><span>收入 ¥ ${formatAmount(totals.income)}<br/>支出 ¥ ${formatAmount(totals.expense)}</span></div><button type="button" id="confirm-import" class="button-primary" ${count === 0 || committing ? 'disabled' : ''}>${committing ? '正在保存…' : `导入已选 ${count} 笔`}</button><button type="button" id="return-import" class="button-secondary">返回选择文件</button></div>`;
  }
  function candidateMarkup(candidate: BillImportCandidate) {
    const index = preview!.candidates.indexOf(candidate);
    const direction = candidate.type === 'expense' ? '支出' : candidate.type === 'income' ? '收入' : '方向未明';
    const amount = candidate.amountCents > 0 ? formatAmount(candidate.amountCents) : '金额缺失';
    const selectable = candidate.canSelect && (candidate.state !== 'review' || confirmedRows.has(candidate.id));
    const matches = candidate.state === 'review' ? host.entries().filter(entry => entry.date === candidate.date && entry.amountCents === candidate.amountCents && entry.type === candidate.type).slice(0, 3) : [];
    return `<article class="import-row ${candidate.state}" data-import-row="${index}"><div class="import-row-main"><label class="import-row-check"><input type="checkbox" id="import-row-${index}" data-select-row="${index}" aria-label="选择第 ${candidate.rowNumber} 行 ${esc(candidate.merchant || candidate.description || direction)} ${amount} 元" ${candidate.selected ? 'checked' : ''} ${selectable ? '' : 'disabled'} /></label><div class="import-row-detail"><strong>${esc(candidate.merchant || candidate.description || '未提供交易对象')}</strong><span>${esc(candidate.transactionTime || candidate.date || '日期缺失')} · ${esc(direction)}</span><span class="import-row-description">${esc(candidate.description || candidate.note)}</span></div><strong class="import-row-amount ${candidate.type}">${candidate.type === 'expense' ? '−' : candidate.type === 'income' ? '+' : ''}${amount}</strong></div>
      <div class="import-row-context"><span class="import-status">${stateName[candidate.state]}</span><span>原文件第 ${candidate.rowNumber} 行${candidate.tradeId ? ` · 交易号尾号 ${esc(candidate.tradeId.slice(-8))}` : ''}</span></div>
      ${candidate.reason ? `<p class="import-row-reason">${esc(candidate.reason)}</p>` : ''}
      ${matches.map(entry => `<p class="import-existing">账本已有：${esc(entry.date)} · ${esc(categoryById(entry.categoryId).label)} · ¥ ${formatAmount(entry.amountCents)}${entry.note ? ` · ${esc(entry.note)}` : ''}</p>`).join('')}
      ${candidate.state === 'review' && candidate.canSelect ? `<label class="review-row-ack"><input type="checkbox" id="confirm-row-${index}" data-confirm-row="${index}" ${confirmedRows.has(candidate.id) ? 'checked' : ''}/>我已核对，按${direction} ¥ ${amount} 单独计入</label>` : ''}
    </article>`;
  }
  function bindReview() {
    modal.querySelector<HTMLSelectElement>('#import-filter')!.value = rowFilter;
    modal.querySelector('#import-filter')!.addEventListener('change', event => { rowFilter = (event.target as HTMLSelectElement).value as RowFilter; page = 0; render(); });
    modal.querySelector('#select-ready')!.addEventListener('click', () => { preview!.candidates.forEach(candidate => { if (candidate.state === 'ready' && candidate.canSelect) candidate.selected = true; }); render(); });
    modal.querySelector('#deselect-all')!.addEventListener('click', () => { preview!.candidates.forEach(candidate => { candidate.selected = false; }); render(); });
    modal.querySelectorAll<HTMLInputElement>('[data-select-row]').forEach(element => element.addEventListener('change', () => { preview!.candidates[Number(element.dataset.selectRow)].selected = element.checked; render(); }));
    modal.querySelectorAll<HTMLInputElement>('[data-confirm-row]').forEach(element => element.addEventListener('change', () => {
      const candidate = preview!.candidates[Number(element.dataset.confirmRow)];
      if (element.checked) confirmedRows.add(candidate.id); else confirmedRows.delete(candidate.id);
      candidate.selected = element.checked;
      render();
    }));
    modal.querySelector('#import-previous')?.addEventListener('click', () => { page -= 1; render(); });
    modal.querySelector('#import-next')?.addEventListener('click', () => { page += 1; render(); });
    modal.querySelector('#confirm-import')!.addEventListener('click', () => {
      if (committing || selected().length === 0) return;
      committing = true; error = '';
      try {
        const committed = applyBillImport(host.entries(), preview!.candidates, Date.now());
        if (committed.addedEntries.length > 0 && !host.save(committed.entries)) { error = host.storageError() || '未能保存。导入预览已保留，可重新读取并复核。'; return; }
        host.saved(committed.addedEntries, committed.duplicateCount);
        committing = false; close(true);
      } catch (failure) { error = errorText(failure); }
      finally { committing = false; if (modal.open) render(); }
    });
  }

  function screenshotMarkup() {
    const fields = screenshot;
    return `<p class="import-intro">选择一张单笔账单截图，或粘贴已识别的文字。先核对，再记账。</p>
      <div class="screenshot-inputs"><button type="button" id="choose-image" class="button-secondary" ${busy ? 'disabled' : ''}>选择账单截图</button><input type="file" class="sr-only" id="screenshot-file" accept="image/png,image/jpeg,image/webp" aria-label="选择账单截图文件"/><span>PNG / JPEG / WebP，最大 8 MB</span></div>
      ${imageUrl ? `<figure class="screenshot-preview"><img src="${imageUrl}" alt="待核对的原始账单截图"/><figcaption>${esc(imageName)} · <a href="${imageUrl}" target="_blank" rel="noopener" aria-label="在新标签页放大查看原始账单截图">放大查看原图</a></figcaption></figure>` : ''}
      ${busy ? '<div class="ocr-status" role="status"><span class="loading-ring"></span><span id="ocr-progress">正在本机识别，首次加载可能稍慢…</span><button type="button" id="cancel-ocr" class="text-button">取消识别</button></div>' : ''}
      <div class="screenshot-text"><label for="screenshot-text">截图中的文字</label><textarea id="screenshot-text" maxlength="12000" rows="5" placeholder="可粘贴系统识别出的文字，例如交易金额、支付时间和收支方向。" ${busy ? 'disabled' : ''}>${esc(rawText)}</textarea><button type="button" id="parse-screenshot-text" class="button-secondary" ${busy ? 'disabled' : ''}>从文字生成草稿</button></div>
      ${fields ? `<section class="screenshot-fields" aria-label="核对截图识别结果"><h3>核对这一笔</h3><p class="screenshot-caution">识别可能有误；空缺项需手动补全。图片不会保存到账本。</p>${fields.warnings.length ? `<ul class="screenshot-warnings">${fields.warnings.map(warning => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}<div class="screenshot-field-grid"><label>金额（元）<input id="screenshot-amount" inputmode="decimal" value="${esc(fields.amount)}" placeholder="请核对金额"/></label><label>收支方向<select id="screenshot-type"><option value="unknown">请选择收入或支出</option><option value="expense" ${fields.type === 'expense' ? 'selected' : ''}>支出</option><option value="income" ${fields.type === 'income' ? 'selected' : ''}>收入</option></select></label><label>日期<input id="screenshot-date" type="date" min="1900-01-01" max="2100-12-31" value="${esc(fields.date)}"/><small id="screenshot-date-display">${fields.date ? `记账日期：${esc(fields.date)}` : '请补全日期（年-月-日）'}</small></label><label>交易对象<input id="screenshot-merchant" maxlength="100" value="${esc(fields.merchant)}" placeholder="选填"/></label></div><label class="screenshot-note-label">备注<input id="screenshot-note" maxlength="100" value="${esc(fields.note)}"/></label><label class="screenshot-ack"><input id="screenshot-reviewed" type="checkbox" ${reviewed ? 'checked' : ''}/>我已对照原图 / 原文，核对金额、方向与日期</label><button type="button" id="use-screenshot-draft" class="button-primary" ${reviewed ? '' : 'disabled'}>带入记账，继续确认</button></section>` : ''}
      <button type="button" id="return-import" class="button-secondary screenshot-return">返回选择方式</button>`;
  }
  function bindScreenshot() {
    modal.querySelector('#choose-image')!.addEventListener('click', () => modal.querySelector<HTMLInputElement>('#screenshot-file')!.click());
    modal.querySelector('#screenshot-file')!.addEventListener('change', event => { const chosen = (event.target as HTMLInputElement).files?.[0]; if (chosen) void recognizeImage(chosen); });
    modal.querySelector('#cancel-ocr')?.addEventListener('click', () => { token += 1; ocr.cancel(); busy = false; error = '识别已取消。可重新选图或粘贴文字，账本未改变。'; render(); });
    modal.querySelector<HTMLTextAreaElement>('#screenshot-text')!.addEventListener('input', event => { rawText = (event.target as HTMLTextAreaElement).value; screenshotTouched = true; reviewed = false; screenshot = undefined; modal.querySelector('.screenshot-fields')?.remove(); });
    modal.querySelector('#parse-screenshot-text')!.addEventListener('click', () => {
      error = '';
      if (!rawText.trim()) { error = '请先选取截图，或粘贴截图中的文字。'; render(); return; }
      screenshot = extractScreenshotDraft(rawText); reviewed = false; screenshotTouched = true; render();
    });
    if (!screenshot) return;
    const update = (key: 'amount' | 'date' | 'merchant' | 'note' | 'type', event: Event) => {
      const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
      if (key === 'type') screenshot!.type = value as ScreenshotDraft['type']; else screenshot![key] = value;
      screenshotTouched = true; reviewed = false; error = ''; modal.querySelector('.import-error')?.remove();
      if (key === 'date') modal.querySelector('#screenshot-date-display')!.textContent = value ? `记账日期：${value}` : '请补全日期（年-月-日）';
      modal.querySelector<HTMLInputElement>('#screenshot-reviewed')!.checked = false;
      modal.querySelector<HTMLButtonElement>('#use-screenshot-draft')!.disabled = true;
    };
    for (const key of ['amount', 'date', 'merchant', 'note', 'type'] as const) modal.querySelector(`#screenshot-${key}`)!.addEventListener(key === 'type' ? 'change' : 'input', event => update(key, event));
    modal.querySelector('#screenshot-reviewed')!.addEventListener('change', event => { reviewed = (event.target as HTMLInputElement).checked; modal.querySelector<HTMLButtonElement>('#use-screenshot-draft')!.disabled = !reviewed; });
    modal.querySelector('#use-screenshot-draft')!.addEventListener('click', () => {
      try {
        if (!reviewed) throw new Error('请先核对识别结果。');
        const candidate = screenshot!;
        const cents = parseAmount(candidate.amount);
        if (candidate.type !== 'income' && candidate.type !== 'expense') throw new Error('请选择这笔记录是收入还是支出。');
        if (!candidate.date || candidate.date < '1900-01-01' || candidate.date > '2100-12-31') throw new Error('请填写 1900 年至 2100 年之间的有效日期。');
        const categoryId = candidate.type === 'expense' ? 'other' : 'other_income';
        const note = candidate.note.trim() || candidate.merchant.trim();
        validateEntry({ id: 'screenshot-validation', type: candidate.type, amountCents: cents, categoryId, date: candidate.date, note, createdAt: Date.now() });
        const next = { amount: (cents / 100).toFixed(2), type: candidate.type, date: candidate.date, categoryId, note };
        if (!host.adoptScreenshot(next)) return;
        close(true);
      } catch (failure) { error = errorText(failure); render(); }
    });
  }
  async function recognizeImage(chosen: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(chosen.type) || chosen.size > 8 * 1024 * 1024) { error = '请选择不超过 8 MB 的 PNG、JPEG 或 WebP 截图。'; render(); return; }
    const current = ++token;
    revokeImage(); imageUrl = URL.createObjectURL(chosen); imageName = chosen.name;
    busy = true; error = ''; screenshot = undefined; rawText = ''; reviewed = false; screenshotTouched = true; render();
    try {
      const text = await ocr.recognize(chosen, fraction => {
        if (current !== token) return;
        const label = modal.querySelector('#ocr-progress');
        if (label) label.textContent = fraction > 0 ? `正在本机识别 ${Math.round(fraction * 100)}%` : '正在本机加载识别资源…';
      });
      if (current !== token) return;
      rawText = text.slice(0, 12000);
      screenshot = extractScreenshotDraft(rawText);
      if (!rawText.trim()) error = '没有识别到文字。请换一张清晰截图，或手动粘贴文字。';
    } catch (failure) { if (current === token) error = `${errorText(failure)} 可粘贴系统识别出的文字继续。`; }
    finally { if (current === token) { busy = false; render(); } }
  }

  modal.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return { open, hasUnsavedChanges: unsaved };
}
