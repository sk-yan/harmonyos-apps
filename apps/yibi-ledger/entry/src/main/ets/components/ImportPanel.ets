import { common } from '@kit.AbilityKit';
import { LedgerEntry, formatAmount } from '../model/Ledger';
import {
  BillImportCandidate, ScreenshotDraft, detectBillSource, parseBillRows, parseCsv, extractScreenshotDraft
} from '../model/BillImport';
import { readBillFile, recognizeReceipt, recognizeReceiptDocument } from '../services/ImportService';

const INK: string = '#182A24';
const GREEN: string = '#173F35';
const MUTED: string = '#64736B';
const EXPENSE: string = '#AD513F';

@ComponentV2
export struct ImportPanel {
  @Param entries: LedgerEntry[] = [];
  @Param saving: boolean = false;
  @Param externalError: string = '';
  @Param startTab: string = 'bill';
  @Event onClose: () => void = () => {};
  @Event onCommit: (candidates: BillImportCandidate[]) => void = () => {};
  @Event onReceipt: (draft: ScreenshotDraft) => void = () => {};
  @Event onDraftChanged: (value: boolean) => void = () => {};
  @Event onTextFocus: (value: boolean) => void = () => {};
  @Local candidates: BillImportCandidate[] = [];
  @Local fileName: string = '';
  @Local range: string = '';
  @Local error: string = '';
  @Local busy: boolean = false;
  @Local busyMessage: string = '';
  @Local tab: string = 'bill';
  @Local pasted: string = '';
  @Local receiptText: string = '';
  @Local page: number = 0;
  @Local filter: string = 'all';
  private generation: number = 0;

  aboutToAppear(): void {
    this.tab = this.startTab;
  }

  aboutToDisappear(): void {
    this.generation += 1;
    this.onTextFocus(false);
  }

  private context(): common.UIAbilityContext {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    if (!context) {
      throw new Error('无法打开文件选择器，请重新打开应用。');
    }
    return context;
  }

  private reportDraft(): void {
    this.onDraftChanged(this.pasted.length > 0 || this.receiptText.length > 0 || this.candidates.length > 0);
  }

  private previewRows(rows: string[][], name: string): void {
    const source = detectBillSource(rows);
    if (!source) {
      throw new Error('未找到微信或支付宝账单表头。请选择导出的明细文件，保留表头；压缩包请先解压。');
    }
    const result = parseBillRows(rows, source, this.entries);
    this.candidates = result.candidates;
    this.fileName = (source === 'wechat' ? '微信支付 · ' : '支付宝 · ') + name;
    this.range = result.monthFrom === result.monthTo ? result.monthFrom : result.monthFrom + ' 至 ' + result.monthTo;
    this.filter = 'all';
    this.page = 0;
    this.error = '';
    this.reportDraft();
  }

  private async chooseBill(): Promise<void> {
    if (this.busy || this.saving) { return; }
    const token = ++this.generation;
    this.busy = true;
    this.busyMessage = '正在读取账单…';
    this.error = '';
    try {
      const result = await readBillFile(this.context());
      if (token !== this.generation || !result) { return; }
      this.previewRows(result.rows, result.name);
    } catch (error) {
      if (token === this.generation) {
        this.error = (error as Error).message || '无法读取文件，原账本未修改。';
      }
    } finally {
      if (token === this.generation) { this.busy = false; }
    }
  }

  private previewPasted(): void {
    try {
      this.previewRows(parseCsv(this.pasted), '粘贴的账单');
    } catch (error) {
      this.error = (error as Error).message || '无法解析账单。';
    }
  }

  private async chooseReceipt(fromDocument: boolean = false): Promise<void> {
    if (this.busy || this.saving) { return; }
    const token = ++this.generation;
    this.busy = true;
    this.busyMessage = '正在本机识别截图，可返回取消…';
    this.error = '';
    try {
      const text = fromDocument ? await recognizeReceiptDocument(this.context()) : await recognizeReceipt(this.context());
      if (token !== this.generation || text === undefined) { return; }
      this.receiptText = text;
      this.reportDraft();
    } catch (error) {
      if (token === this.generation) {
        this.error = (error as Error).message || '截图识别失败，可粘贴文字继续。';
      }
    } finally {
      if (token === this.generation) { this.busy = false; }
    }
  }

  private useReceipt(): void {
    try {
      this.onReceipt(extractScreenshotDraft(this.receiptText));
    } catch (error) {
      this.error = (error as Error).message || '未找到可识别的文字。';
    }
  }

  private selectedCount(): number {
    return this.candidates.filter((item: BillImportCandidate) => item.selected && item.canSelect).length;
  }

  private count(state: string): number {
    return this.candidates.filter((item: BillImportCandidate) => item.state === state).length;
  }

  private selectedTotal(type: string): number {
    let total = 0;
    this.candidates.forEach((item: BillImportCandidate) => {
      if (item.selected && item.canSelect && item.type === type) { total += item.amountCents; }
    });
    return total;
  }

  private filtered(): BillImportCandidate[] {
    return this.candidates.filter((item: BillImportCandidate) =>
      this.filter === 'all' || (this.filter === 'selected' ? item.selected :
        this.filter === 'skipped' ? !item.canSelect : item.state === 'review'));
  }

  private pageItems(): BillImportCandidate[] {
    return this.filtered().slice(this.page * 30, (this.page + 1) * 30);
  }

  private toggle(item: BillImportCandidate): void {
    if (!item.canSelect || this.saving || this.busy) { return; }
    this.candidates = this.candidates.map((candidate: BillImportCandidate) => {
      if (candidate.id === item.id) { candidate.selected = !candidate.selected; }
      return candidate;
    });
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.filtered().length / 30) - 1));
  }

  private selectReady(selected: boolean): void {
    this.candidates = this.candidates.map((item: BillImportCandidate) => {
      item.selected = selected && item.canSelect && item.state === 'ready';
      return item;
    });
    this.page = 0;
  }

  private stateLabel(item: BillImportCandidate): string {
    if (item.state === 'ready') { return '可导入'; }
    if (item.state === 'review') { return '需核对'; }
    if (item.state === 'duplicate') { return '已存在'; }
    if (item.state === 'invalid') { return '字段有误'; }
    return '已跳过';
  }

  @Builder
  filterButton(label: string, value: string) {
    Button(label).height(40).fontSize(13).fontColor(this.filter === value ? '#FFFFFF' : GREEN)
      .backgroundColor(this.filter === value ? GREEN : '#E7ECE4')
      .onClick(() => { this.filter = value; this.page = 0; })
  }

  @Builder
  candidateRow(item: BillImportCandidate) {
    Column({ space: 8 }) {
      Row({ space: 10 }) {
        Button(item.canSelect ? (item.selected ? '✓' : '○') : '—', { type: ButtonType.Circle })
          .width(44).height(44).fontSize(22).fontColor(item.selected ? '#FFFFFF' : MUTED)
          .backgroundColor(item.selected ? GREEN : '#E7ECE4')
          .id(`import-row-${item.id}`).accessibilityText(`${item.selected ? '取消选择' : '选择'}第${item.rowNumber}行`)
          .enabled(item.canSelect && !this.saving && !this.busy).onClick(() => { this.toggle(item); })
        Column({ space: 5 }) {
          Text(item.merchant || item.description || '未标注商家').fontSize(15).fontColor(INK).maxLines(2)
          Text(item.date || '日期缺失').fontSize(12).fontColor(MUTED)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Column({ space: 5 }) {
          Text((item.type === 'income' ? '+' : item.type === 'expense' ? '−' : '') +
            (item.amountCents > 0 ? formatAmount(item.amountCents) : '金额缺失'))
            .fontSize(16).fontColor(item.type === 'expense' ? EXPENSE : GREEN)
          Text(this.stateLabel(item)).fontSize(12).fontColor(item.state === 'review' ? EXPENSE : MUTED)
        }.alignItems(HorizontalAlign.End)
      }.width('100%')
      Text(item.reason || '按账单收支方向计入，分类可在导入后编辑。')
        .fontSize(12).fontColor(MUTED).lineHeight(18).width('100%')
      if (item.tradeId) {
        Text('交易号：' + item.tradeId).fontSize(11).fontColor(MUTED).maxLines(2).width('100%')
      }
      if (item.state === 'review' && item.canSelect) {
        Text(`勾选即确认按${item.type === 'income' ? '收入' : '支出'}计入；请先核对原账单。`)
          .fontSize(12).fontColor(EXPENSE).lineHeight(18).width('100%')
      }
    }.padding(14).width('100%').backgroundColor('#FFFFFF').borderRadius(16)
  }

  @Builder
  billInput() {
    Column({ space: 12 }) {
      Text('把历史消费带进账本').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
      Text('选择微信或支付宝导出的 CSV / XLSX。先预览，再确认；每次最多 5,000 行，文件不超过 8 MB。')
        .fontSize(14).fontColor(MUTED).lineHeight(22)
      Button('选择账单文件').id('import-file').width('100%').height(48).backgroundColor(GREEN).fontColor('#FFFFFF')
        .enabled(!this.busy && !this.saving).onClick(() => { this.chooseBill(); })
      Text('也可以粘贴账单文字（须保留表头）').fontSize(13).fontColor(MUTED)
      TextArea({ text: this.pasted, placeholder: '将 CSV 内容或表格中的行粘贴到这里' })
        .id('import-pasted').height(126).maxLength(1000000).fontSize(14).backgroundColor('#E7ECE4')
        .enabled(!this.busy && !this.saving)
        .onChange((value: string) => { this.pasted = value; this.reportDraft(); })
        .onFocus(() => { this.onTextFocus(true); }).onBlur(() => { this.onTextFocus(false); })
      Button('预览粘贴账单').id('import-preview').height(44).width('100%').fontColor(GREEN).backgroundColor('#E7ECE4')
        .enabled(this.pasted.trim().length > 0 && !this.busy && !this.saving).onClick(() => { this.previewPasted(); })
      Text('仅平台与交易号一致的记录自动跳过。同日同额仅提示疑似重复；退款、转账、还款等默认不选。')
        .fontSize(12).fontColor(MUTED).lineHeight(20)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  receiptInput() {
    Column({ space: 12 }) {
      Text('截图辅助记一笔').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
      Text('图片仅在本机识别。识别完成后核对原文，再检查金额、日期和收支方向，确认后保存。')
        .fontSize(14).fontColor(MUTED).lineHeight(22)
      Button('选择付款截图').id('receipt-image').height(48).width('100%').backgroundColor(GREEN).fontColor('#FFFFFF')
        .enabled(!this.busy && !this.saving).onClick(() => { this.chooseReceipt(); })
      Button('从文件选择图片').id('receipt-image-file').height(44).width('100%').fontColor(GREEN).backgroundColor('#E7ECE4')
        .enabled(!this.busy && !this.saving).onClick(() => { this.chooseReceipt(true); })
      Text('识别文字（可粘贴或修改）').fontSize(13).fontColor(MUTED)
      TextArea({ text: this.receiptText, placeholder: '识别结果将显示在这里，也可以粘贴付款详情文字' })
        .id('receipt-text').height(240).maxLength(20000).fontSize(14).backgroundColor('#E7ECE4')
        .enabled(!this.busy && !this.saving)
        .onChange((value: string) => { this.receiptText = value; this.reportDraft(); })
        .onFocus(() => { this.onTextFocus(true); }).onBlur(() => { this.onTextFocus(false); })
      Button('核对并填写账单').id('receipt-use').height(48).width('100%').backgroundColor(GREEN).fontColor('#FFFFFF')
        .enabled(this.receiptText.trim().length > 0 && !this.busy && !this.saving).onClick(() => { this.useReceipt(); })
      Text('缺失或有歧义的字段会留空，原账本和正在编辑的内容不会被识别过程修改。')
        .fontSize(12).fontColor(MUTED).lineHeight(20)
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  previewList() {
    Column({ space: 12 }) {
      Text(this.fileName).fontSize(17).fontWeight(FontWeight.Medium).fontColor(INK).maxLines(2)
      Text(`${this.range} · 共 ${this.candidates.length} 行`).fontSize(13).fontColor(MUTED)
      Text(`已选 ${this.selectedCount()} · 已存在 ${this.count('duplicate')} · 需核对 ${this.count('review')} · 字段有误 ${this.count('invalid')}`)
        .fontSize(13).fontColor(MUTED).lineHeight(20)
      Text(`已选收入 ¥ ${formatAmount(this.selectedTotal('income'))}  /  支出 ¥ ${formatAmount(this.selectedTotal('expense'))}`)
        .fontSize(14).fontColor(INK).lineHeight(22)
      Flex({ wrap: FlexWrap.Wrap }) {
        this.filterButton('全部', 'all')
        this.filterButton('已选', 'selected')
        this.filterButton('需核对', 'review')
        this.filterButton('已跳过', 'skipped')
      }.width('100%')
      Row({ space: 12 }) {
        Button('选中可导入').height(44).fontColor(GREEN).backgroundColor('#E7ECE4')
          .enabled(!this.saving).onClick(() => { this.selectReady(true); })
        Button('全部取消').height(44).fontColor(MUTED).backgroundColor('#E7ECE4')
          .enabled(!this.saving).onClick(() => { this.selectReady(false); })
      }.width('100%')
      ForEach(this.pageItems(), (item: BillImportCandidate) => {
        this.candidateRow(item)
      }, (item: BillImportCandidate) => `${item.id}-${item.state}-${item.selected}`)
      if (this.filtered().length === 0) {
        Text('此筛选下没有记录').fontSize(14).fontColor(MUTED).padding(20)
      }
      Row({ space: 12 }) {
        Button('上一页').enabled(this.page > 0).onClick(() => { this.page -= 1; })
        Text(`${this.page + 1} / ${Math.max(1, Math.ceil(this.filtered().length / 30))}`).fontSize(13).fontColor(MUTED)
        Button('下一页').enabled((this.page + 1) * 30 < this.filtered().length).onClick(() => { this.page += 1; })
      }.width('100%').justifyContent(FlexAlign.Center)
      Button('重新选择文件').height(44).width('100%').fontColor(GREEN).backgroundColor('#E7ECE4')
        .enabled(!this.saving && !this.busy).onClick(() => { this.chooseBill(); })
    }.width('100%').alignItems(HorizontalAlign.Start)
  }

  build() {
    Column({ space: 12 }) {
      Row() {
        Text('导入与截图').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK).layoutWeight(1)
        Button('返回账本').id('import-close').height(44).fontColor(GREEN).backgroundColor('#E7ECE4')
          .enabled(!this.saving).onClick(() => { this.onClose(); })
      }.width('100%')
      Row({ space: 12 }) {
        Button('账单文件').id('import-tab-bill').layoutWeight(1).height(44)
          .backgroundColor(this.tab === 'bill' ? GREEN : '#E7ECE4').fontColor(this.tab === 'bill' ? '#FFFFFF' : GREEN)
          .enabled(!this.busy && !this.saving).onClick(() => { this.tab = 'bill'; this.error = ''; })
        Button('截图 / 文字').id('import-tab-receipt').layoutWeight(1).height(44)
          .backgroundColor(this.tab === 'receipt' ? GREEN : '#E7ECE4').fontColor(this.tab === 'receipt' ? '#FFFFFF' : GREEN)
          .enabled(!this.busy && !this.saving).onClick(() => { this.tab = 'receipt'; this.error = ''; })
      }.width('100%')
      if (this.busy) {
        Text(this.busyMessage).fontSize(14).fontColor(MUTED).width('100%')
      }
      if (this.error || this.externalError) {
        Text(this.error || this.externalError).id('import-error').fontSize(14).fontColor(EXPENSE)
          .lineHeight(22).width('100%')
      }
      Scroll() {
        if (this.tab === 'receipt') {
          this.receiptInput()
        } else if (this.candidates.length > 0) {
          this.previewList()
        } else {
          this.billInput()
        }
      }.width('100%').layoutWeight(1).align(Alignment.TopStart)
      if (this.tab === 'bill' && this.candidates.length > 0) {
        Button(this.saving ? '正在保存…' : `导入已选 ${this.selectedCount()} 笔`)
          .id('import-confirm').height(52).width('100%').fontSize(17).backgroundColor(GREEN).fontColor('#FFFFFF')
          .enabled(this.selectedCount() > 0 && !this.saving && !this.busy)
          .onClick(() => { this.onCommit(this.candidates); })
      }
    }.width('100%').height('100%').padding({ top: 4, bottom: 8 })
  }
}
