import {
  getCategories, categoryById, parseAmount, formatAmount, todayString,
  currentMonth, shiftMonth, entriesForMonth, summarize, categoryTotals,
  validateEntry, upsertEntry, removeEntry, encodeLedger, decodeLedger,
} from '../entry/src/main/ets/model/Ledger';
import type { EntryType, LedgerEntry } from '../entry/src/main/ets/model/Ledger';
import './style.css';

const STORAGE_KEY = 'yibi-ledger-v1';
const iconPaths: Record<string, string> = {
  book: '<path d="M5 4h12a2 2 0 0 1 2 2v14H6a3 3 0 0 1-3-3V6a2 2 0 0 1 2-2Z"/><path d="M7 4v12M3 17h16M11 8h4M11 11h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  down: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
  up: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14l-1 7Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  chart: '<path d="M4 20V4M4 20h17M9 15v-4M14 15V6M19 15v-7"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".5"/><circle cx="4" cy="12" r=".5"/><circle cx="4" cy="18" r=".5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  food: '<path d="M5 3v7m3-7v7M3 3v5a3 3 0 0 0 6 0V3M6 11v10M18 3c-4 2-4 8 0 9v9M18 3v9"/>',
  dining: '<path d="M5 3v7m3-7v7M3 3v5a3 3 0 0 0 6 0V3M6 11v10M18 3c-4 2-4 8 0 9v9M18 3v9"/>',
  transport: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 10h14M8 18v3M16 18v3M8 14h1M15 14h1"/>',
  shopping: '<path d="M5 8h14l1 13H4L5 8ZM8 8V6a4 4 0 0 1 8 0v2"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  housing: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  entertainment: '<path d="M9 3h6l1 5 4 8c2 5-3 6-5 2l-1-2h-4l-1 2c-2 4-7 3-5-2l4-8 1-5ZM7 11v4M5 13h4M16 12h.01M18 14h.01"/>',
  health: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>',
  medical: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z"/>',
  study: '<path d="m2 8 10-5 10 5-10 5L2 8Zm4 2v7c4 3 8 3 12 0v-7M22 8v8"/>',
  salary: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12c6 4 12 4 18 0M10 13h4v3h-4v-3Z"/>',
  bonus: '<path d="M3 9h18v4H3V9Zm2 4v8h14v-8M12 9v12M12 9c-9 0-7-8-3-5l3 5Zm0 0c9 0 7-8 3-5l-3 5Z"/>',
  gift: '<path d="M3 9h18v4H3V9Zm2 4v8h14v-8M12 9v12M12 9c-9 0-7-8-3-5l3 5Zm0 0c9 0 7-8 3-5l-3 5Z"/>',
  parttime: '<path d="M3 19h18M5 15l5-5 4 3 6-9M15 4h5v5"/>',
  other: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
};
function icon(name: string, className = ''): string {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.other}</svg>`;
}
function esc(value: string): string { return value.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]!)); }
function message(error: unknown): string { return error instanceof Error ? error.message : '请稍后重试'; }

let entries: LedgerEntry[] = [];
let month = currentMonth();
let activeTab: 'ledger' | 'stats' = 'ledger';
let filter: 'all' | EntryType = 'all';
let storageReady = false;
let lastLoadedRaw: string | null = null;
let storageError = '';
let notice = '';
let returnFocus: HTMLElement | null = null;
let dirty = false;
let editedEntry: LedgerEntry | null = null;
let draft = emptyDraft();
const narrow = window.matchMedia('(max-width: 719px)');

function emptyDraft() { return { type: 'expense' as EntryType, amount: '', categoryId: getCategories('expense')[0].id, date: todayString(), note: '' }; }

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div class="app-shell">
    <header class="app-header">
      <a class="brand" href="#" aria-label="一笔记账首页"><span class="brand-mark">${icon('book')}</span><span>一笔<span class="brand-light">记账</span></span></a>
      <div class="header-note"><span class="privacy-dot"></span><span>把日子，记清楚</span></div>
    </header>
    <div id="storage-banner"></div>
    <main class="workspace">
      <section class="ledger-pane" aria-label="账本总览"><div id="ledger-content"></div></section>
      <aside id="desktop-editor" class="editor-pane" aria-label="记账录入"></aside>
    </main>
    <footer class="app-footer"><span>浏览器预览 · 数据仅保存在当前浏览器</span><span class="footer-detail">一笔记账</span></footer>
  </div>
  <div class="mobile-action"><button id="mobile-add" class="button-primary" type="button">${icon('plus')}<span>记一笔</span></button></div>
  <dialog id="entry-dialog" aria-labelledby="editor-title"><div id="mobile-editor"></div></dialog>
  <div id="announcer" class="sr-only" role="status" aria-live="polite"></div>
`;
const editor = document.createElement('section');
editor.className = 'editor-card';
const dialog = document.querySelector<HTMLDialogElement>('#entry-dialog')!;

function loadEntries() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    entries = stored === null ? [] : decodeLedger(stored);
    lastLoadedRaw = stored;
    storageReady = true;
    storageError = '';
  } catch (error) {
    storageReady = false;
    storageError = `无法读取账本，已暂停保存以避免覆盖原有数据。${message(error)}`;
  }
  renderBanner();
  renderLedger();
}

function renderBanner() {
  const banner = document.querySelector('#storage-banner')!;
  banner.innerHTML = storageError ? `<div class="error-banner" role="alert"><span>${esc(storageError)}</span><button type="button" id="retry-storage">重新读取</button></div>` : '';
  document.querySelector('#retry-storage')?.addEventListener('click', loadEntries);
}

function persist(next: LedgerEntry[]): boolean {
  if (!storageReady) { showFormError('账本存储尚未就绪，请先点击上方“重新读取”。'); return false; }
  try {
    const currentRaw = window.localStorage.getItem(STORAGE_KEY);
    if (currentRaw !== lastLoadedRaw) {
      storageReady = false;
      storageError = '账本已在另一个页面发生变化，未覆盖保存。当前填写已保留，请重新读取账本后再保存。';
      renderBanner();
      showFormError('账本发生变化，本次未保存。请点击上方“重新读取”后重试。');
      return false;
    }
    const nextRaw = encodeLedger(next);
    window.localStorage.setItem(STORAGE_KEY, nextRaw);
    lastLoadedRaw = nextRaw;
    entries = next;
    storageError = '';
    renderBanner();
    return true;
  } catch (error) {
    storageError = `保存失败，账本未更改。请检查浏览器存储空间或隐私设置。${message(error)}`;
    renderBanner();
    showFormError('未能保存，填写的内容已保留。请检查浏览器存储后重试。');
    return false;
  }
}

function announce(text: string) {
  document.querySelector('#announcer')!.textContent = text;
}

function monthLabel() { const [year, m] = month.split('-'); return `${year} 年 ${Number(m)} 月`; }

function renderLedger() {
  const monthEntries = entriesForMonth(entries, month);
  const summary = summarize(monthEntries);
  const balanceText = `${summary.balanceCents < 0 ? '−' : ''}${formatAmount(Math.abs(summary.balanceCents))}`;
  const filtered = monthEntries.filter(entry => filter === 'all' || entry.type === filter);
  document.querySelector('#ledger-content')!.innerHTML = `
    <div class="section-eyebrow">我的日常账本 <span>人民币 · CNY</span></div>
    <div class="month-toolbar">
      <div class="month-title"><h1>${monthLabel()}</h1>${month !== currentMonth() ? '<button class="text-button" id="current-month" type="button">回到本月</button>' : '<span class="this-month">本月</span>'}</div>
      <div class="month-controls"><button type="button" class="icon-button" id="previous-month" aria-label="上个月">${icon('left')}</button><button type="button" class="icon-button" id="next-month" aria-label="下个月">${icon('right')}</button></div>
    </div>
    <section class="balance-card" aria-label="月度收支">
      <div class="balance-top"><span>本月结余</span><span class="balance-symbol">${icon('book')}</span></div>
      <div class="balance-amount ${balanceText.length > 10 ? 'compact' : ''}" style="--balance-digits:${balanceText.length}"><span class="currency">¥</span><span>${balanceText}</span></div>
      <div class="balance-bottom">
        <div><span class="stat-label"><span class="stat-arrow">${icon('down')}</span>月收入</span><span class="stat-value">¥ ${formatAmount(summary.incomeCents)}</span></div>
        <div><span class="stat-label"><span class="stat-arrow">${icon('up')}</span>月支出</span><span class="stat-value">¥ ${formatAmount(summary.expenseCents)}</span></div>
        <span class="entry-count">${summary.count} 笔记录</span>
      </div>
    </section>
    <section class="records-card">
      <div class="records-toolbar">
        <div class="view-tabs" role="tablist" aria-label="账本视图"><button type="button" role="tab" id="tab-ledger" tabindex="${activeTab === 'ledger' ? 0 : -1}" aria-selected="${activeTab === 'ledger'}" aria-controls="records-panel" class="view-tab ${activeTab === 'ledger' ? 'active' : ''}">${icon('list')}账单</button><button type="button" role="tab" id="tab-stats" tabindex="${activeTab === 'stats' ? 0 : -1}" aria-selected="${activeTab === 'stats'}" aria-controls="records-panel" class="view-tab ${activeTab === 'stats' ? 'active' : ''}">${icon('chart')}统计</button></div>
        <span class="records-caption">${activeTab === 'ledger' ? '每一笔，都算数' : '看看钱花在哪里'}</span>
      </div>
      <div id="records-panel" role="tabpanel" aria-labelledby="tab-${activeTab}">
        ${activeTab === 'ledger' ? `
          <div class="filter-row"><div class="filter-group" role="group" aria-label="筛选账单">${([['all','全部'],['expense','支出'],['income','收入']] as const).map(([key,label]) => `<button type="button" data-filter="${key}" class="filter-button ${filter === key ? 'selected' : ''}" aria-pressed="${filter === key}">${label}</button>`).join('')}</div><span class="filter-count">共 ${filtered.length} 笔</span></div>
          ${filtered.length ? renderEntries(filtered) : renderEmpty(monthEntries.length > 0 ? '这个分类，还没有记录' : '从第一笔，开始记起', monthEntries.length > 0 ? '切换筛选，查看这个月的其他收支。' : '一杯咖啡、一次出行，也值得好好记下。', monthEntries.length === 0)}
        ` : renderStats(monthEntries)}
      </div>
    </section>
    ${notice ? `<p class="save-notice" role="status">${icon('check')}${esc(notice)}</p>` : ''}
  `;
  document.querySelector('#previous-month')!.addEventListener('click', () => changeMonth(-1));
  document.querySelector('#next-month')!.addEventListener('click', () => changeMonth(1));
  document.querySelector('#current-month')?.addEventListener('click', () => { month = currentMonth(); notice = ''; renderLedger(); });
  for (const tab of ['ledger', 'stats'] as const) {
    document.querySelector(`#tab-${tab}`)!.addEventListener('click', () => { activeTab = tab; renderLedger(); document.querySelector<HTMLButtonElement>(`#tab-${tab}`)!.focus(); });
    document.querySelector(`#tab-${tab}`)!.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      event.preventDefault();
      activeTab = key === 'Home' ? 'ledger' : key === 'End' ? 'stats' : activeTab === 'ledger' ? 'stats' : 'ledger';
      renderLedger();
      document.querySelector<HTMLButtonElement>(`#tab-${activeTab}`)!.focus();
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter as typeof filter; renderLedger(); document.querySelector<HTMLButtonElement>(`[data-filter="${filter}"]`)!.focus(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach(button => button.addEventListener('click', () => beginEdit(button.dataset.edit!, button)));
  document.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(button => button.addEventListener('click', () => deleteEntry(button.dataset.delete!)));
  document.querySelector('#empty-add')?.addEventListener('click', event => openEditor(event.currentTarget as HTMLElement));
}

function changeMonth(delta: number) { month = shiftMonth(month, delta); notice = ''; renderLedger(); document.querySelector<HTMLButtonElement>(delta < 0 ? '#previous-month' : '#next-month')!.focus(); }

function renderEmpty(title: string, text: string, add: boolean): string {
  return `<div class="empty-state"><div class="empty-art"><span class="empty-line"></span>${icon('book')}<span class="empty-plus">${icon('plus')}</span></div><h2>${title}</h2><p>${text}</p>${add ? '<button type="button" id="empty-add" class="empty-add">记下第一笔 <span aria-hidden="true">↗</span></button>' : ''}</div>`;
}

function renderEntries(list: LedgerEntry[]): string {
  const dates = [...new Set(list.map(entry => entry.date))].sort().reverse();
  return `<div class="entry-groups">${dates.map(date => {
    const daily = list.filter(entry => entry.date === date).sort((a,b) => b.createdAt - a.createdAt);
    const d = new Date(`${date}T12:00:00`);
    const weekday = ['日','一','二','三','四','五','六'][d.getDay()];
    return `<section class="day-group"><div class="day-heading"><h3>${Number(date.slice(5,7))} 月 ${Number(date.slice(8,10))} 日 <span>星期${weekday}${date === todayString() ? ' · 今天' : ''}</span></h3></div><ul class="entry-list">${daily.map(entry => {
      const category = categoryById(entry.categoryId);
      return `<li class="entry-row"><span class="category-icon" style="--category-color:${esc(category.color)}">${icon(category.id)}</span><div class="entry-details"><span class="entry-label">${esc(category.label)}</span><span class="entry-note">${entry.note ? esc(entry.note) : (entry.type === 'expense' ? '日常支出' : '收入记录')}</span></div><span class="entry-amount ${entry.type}">${entry.type === 'expense' ? '−' : '+'}${formatAmount(entry.amountCents)}</span><div class="entry-actions"><button class="icon-button small" data-edit="${esc(entry.id)}" type="button" aria-label="编辑 ${esc(category.label)} ${formatAmount(entry.amountCents)} 元">${icon('edit')}</button><button class="icon-button small delete" data-delete="${esc(entry.id)}" type="button" aria-label="删除 ${esc(category.label)} ${formatAmount(entry.amountCents)} 元">${icon('trash')}</button></div></li>`;
    }).join('')}</ul></section>`;
  }).join('')}</div>`;
}

function renderStats(monthEntries: LedgerEntry[]): string {
  const totals = categoryTotals(monthEntries);
  return `<div class="filter-row"><span class="stats-subheading">支出分类</span><span class="filter-count">按金额排序</span></div>${totals.length ? `<div class="category-stats">${totals.map(category => `<div class="category-stat"><div class="category-stat-label"><span><i style="background:${esc(category.color)}"></i>${esc(category.label)}</span><strong>¥ ${formatAmount(category.amountCents)} <small>${Math.round(category.percent)}%</small></strong></div><div class="bar-track" role="img" aria-label="${esc(category.label)}占${Math.round(category.percent)}%"><div style="width:${category.percent}%;background:${esc(category.color)}"></div></div></div>`).join('')}<p class="stats-note">统计范围：${monthLabel()}的全部支出记录</p></div>` : renderEmpty('还没有可以统计的支出', '记下这个月的支出，分类分布就会出现在这里。', false)}`;
}

function renderForm() {
  const categories = getCategories(draft.type);
  editor.innerHTML = `
    <div class="editor-heading"><div><span class="editor-eyebrow">留住生活的每一笔</span><h2 id="editor-title">${editedEntry ? '编辑记录' : '记一笔'}</h2></div><button id="close-editor" class="icon-button close-editor" type="button" aria-label="关闭记账">${icon('close')}</button><span class="editor-decoration" aria-hidden="true">${icon('plus')}</span></div>
    <form id="entry-form" novalidate>
      <div class="type-switch" role="group" aria-label="收支类型">${(['expense','income'] as const).map(type => `<button type="button" data-type="${type}" aria-pressed="${draft.type === type}" class="type-button ${draft.type === type ? 'active' : ''}">${icon(type === 'expense' ? 'up' : 'down')}${type === 'expense' ? '支出' : '收入'}</button>`).join('')}</div>
      <div class="amount-field"><label for="amount">金额</label><div class="amount-input-wrap"><span aria-hidden="true">¥</span><input id="amount" name="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(draft.amount)}" aria-describedby="amount-hint" required maxlength="14" /></div><span id="amount-hint" class="field-hint">人民币，最多两位小数</span></div>
      <fieldset class="category-field"><legend>分类</legend><div class="category-grid">${categories.map(category => `<button type="button" data-category="${esc(category.id)}" class="category-option ${draft.categoryId === category.id ? 'selected' : ''}" aria-pressed="${draft.categoryId === category.id}"><span>${icon(category.id)}</span>${esc(category.label)}</button>`).join('')}</div></fieldset>
      <div class="input-group"><label for="entry-date">日期</label><input type="date" id="entry-date" name="date" value="${esc(draft.date)}" required min="1900-01-01" max="2100-12-31" /></div>
      <div class="input-group note-group"><label for="entry-note">备注 <span>选填</span></label><textarea id="entry-note" name="note" rows="2" maxlength="100" placeholder="这笔钱，用在了哪里？">${esc(draft.note)}</textarea><span id="note-count" class="note-count">${draft.note.length}/100</span></div>
      <p id="form-error" class="form-error" role="alert" hidden></p>
      <button type="submit" class="button-primary save-button">${icon('check')}<span>${editedEntry ? '保存修改' : '保存记录'}</span></button>
      <button type="button" id="reset-form" class="reset-button">${editedEntry ? '取消编辑' : '清空填写'}</button>
    </form>
  `;
  editor.querySelector<HTMLFormElement>('#entry-form')!.addEventListener('submit', submitEntry);
  editor.querySelectorAll<HTMLButtonElement>('[data-type]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.type as EntryType;
    if (draft.type !== next) { draft.type = next; draft.categoryId = getCategories(next)[0].id; dirty = true; renderForm(); editor.querySelector<HTMLButtonElement>(`[data-type="${next}"]`)!.focus(); }
  }));
  editor.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.addEventListener('click', () => {
    draft.categoryId = button.dataset.category!; dirty = true;
    editor.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(item => { item.classList.toggle('selected', item.dataset.category === draft.categoryId); item.setAttribute('aria-pressed', String(item.dataset.category === draft.categoryId)); });
  }));
  editor.querySelector<HTMLInputElement>('#amount')!.addEventListener('input', event => { draft.amount = (event.target as HTMLInputElement).value; dirty = true; clearFormError(); });
  editor.querySelector<HTMLInputElement>('#entry-date')!.addEventListener('input', event => { draft.date = (event.target as HTMLInputElement).value; dirty = true; clearFormError(); });
  editor.querySelector<HTMLTextAreaElement>('#entry-note')!.addEventListener('input', event => { draft.note = (event.target as HTMLTextAreaElement).value; dirty = true; editor.querySelector('#note-count')!.textContent = `${draft.note.length}/100`; clearFormError(); });
  editor.querySelector('#close-editor')!.addEventListener('click', attemptClose);
  editor.querySelector('#reset-form')!.addEventListener('click', () => { if (!canDiscard()) return; resetDraft(); renderForm(); editor.querySelector<HTMLInputElement>('#amount')!.focus(); });
}

function clearFormError() { const element = editor.querySelector<HTMLParagraphElement>('#form-error')!; element.hidden = true; element.textContent = ''; }
function showFormError(text: string) { const element = editor.querySelector<HTMLParagraphElement>('#form-error'); if (element) { element.hidden = false; element.textContent = text; } announce(text); }
function canDiscard() { return !dirty || window.confirm('放弃尚未保存的记录？'); }
function resetDraft() { editedEntry = null; draft = emptyDraft(); dirty = false; }

function submitEntry(event: SubmitEvent) {
  event.preventDefault();
  try {
    const amountCents = parseAmount(draft.amount);
    if (draft.date < '1900-01-01' || draft.date > '2100-12-31') throw new Error('日期须在 1900 年至 2100 年之间');
    const entry: LedgerEntry = {
      id: editedEntry?.id ?? crypto.randomUUID(), type: draft.type, amountCents,
      categoryId: draft.categoryId, date: draft.date, note: draft.note.trim(),
      createdAt: editedEntry?.createdAt ?? Date.now(),
    };
    validateEntry(entry);
    if (!persist(upsertEntry(entries, entry))) return;
    const wasEditing = editedEntry !== null;
    month = entry.date.slice(0, 7);
    filter = 'all';
    activeTab = 'ledger';
    notice = wasEditing ? '这笔记录已更新' : '已记下这一笔';
    resetDraft();
    renderForm();
    renderLedger();
    announce(notice);
    if (dialog.open) closeDialog();
    else editor.querySelector<HTMLInputElement>('#amount')!.focus();
  } catch (error) { showFormError(message(error)); }
}

function beginEdit(id: string, trigger: HTMLElement) {
  if (!canDiscard()) return;
  const entry = entries.find(item => item.id === id);
  if (!entry) return;
  editedEntry = entry;
  draft = { type: entry.type, amount: (entry.amountCents / 100).toFixed(2), categoryId: entry.categoryId, date: entry.date, note: entry.note };
  dirty = false;
  renderForm();
  openEditor(trigger);
}

function deleteEntry(id: string) {
  const entry = entries.find(item => item.id === id);
  if (!entry) return;
  if (!window.confirm(`删除这笔${categoryById(entry.categoryId).label}记录（¥ ${formatAmount(entry.amountCents)}）？删除后无法撤销。`)) return;
  try {
    if (!persist(removeEntry(entries, id))) return;
    if (editedEntry?.id === id) { resetDraft(); renderForm(); }
    notice = '记录已删除';
    renderLedger();
    announce(notice);
  } catch (error) { showFormError(message(error)); }
}

function openEditor(trigger: HTMLElement) {
  returnFocus = trigger;
  if (narrow.matches && !dialog.open) dialog.showModal();
  editor.querySelector<HTMLInputElement>('#amount')!.focus();
}

function closeDialog() {
  dialog.close();
  const target = returnFocus?.isConnected ? returnFocus : document.querySelector<HTMLElement>('#mobile-add');
  target?.focus();
}

function attemptClose() {
  if (!canDiscard()) return;
  resetDraft();
  renderForm();
  closeDialog();
}

function placeEditor() {
  if (narrow.matches) document.querySelector('#mobile-editor')!.append(editor);
  else {
    if (dialog.open) dialog.close();
    document.querySelector('#desktop-editor')!.append(editor);
  }
}

document.querySelector('#mobile-add')!.addEventListener('click', event => openEditor(event.currentTarget as HTMLElement));
document.querySelector('.brand')!.addEventListener('click', event => { event.preventDefault(); month = currentMonth(); activeTab = 'ledger'; filter = 'all'; renderLedger(); });
dialog.addEventListener('cancel', event => { event.preventDefault(); attemptClose(); });
narrow.addEventListener('change', placeEditor);
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('storage', event => {
  if (event.storageArea === window.localStorage && (event.key === STORAGE_KEY || event.key === null)) {
    if (dirty) { storageError = '账本已在另一个页面发生变化。请保存当前填写的内容到别处，再重新读取，避免覆盖。'; storageReady = false; renderBanner(); }
    else loadEntries();
  }
});
renderForm();
placeEditor();
loadEntries();
