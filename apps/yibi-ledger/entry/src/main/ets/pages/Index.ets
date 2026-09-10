import {
  Category, CategoryTotal, EntryType, LedgerEntry, LedgerSummary,
  categoryById, categoryTotals, currentMonth, entriesForMonth, formatAmount,
  getCategories, parseAmount, removeEntry, shiftMonth, summarize, todayString, upsertEntry
} from '../model/Ledger';
import { LedgerStore } from '../storage/LedgerStore';

const INK: string = '#182A24';
const GREEN: string = '#173F35';
const MUTED: string = '#64736B';
const PAPER: string = '#F5F6F1';
const EXPENSE: string = '#AD513F';

@Entry
@ComponentV2
struct Index {
  @Local entries: LedgerEntry[] = [];
  @Local month: string = currentMonth();
  @Local filter: string = 'all';
  @Local ready: boolean = false;
  @Local saving: boolean = false;
  @Local loading: boolean = false;
  @Local loadError: string = '';
  @Local formError: string = '';
  @Local wide: boolean = false;
  @Local sheetOpen: boolean = false;
  @Local entryType: EntryType = 'expense';
  @Local amount: string = '';
  @Local categoryId: string = getCategories('expense')[0].id;
  @Local entryDate: string = todayString();
  @Local note: string = '';
  @Local editingId: string = '';
  @Local editingCreatedAt: number = 0;
  private store: LedgerStore | undefined = undefined;

  aboutToAppear(): void {
    this.loadLedger();
  }

  onBackPress(): boolean {
    if (this.saving) {
      return true;
    }
    if (this.sheetOpen || (this.wide && this.hasDraft())) {
      this.closeEditor();
      return true;
    }
    return false;
  }

  private async loadLedger(): Promise<void> {
    if (this.loading || this.saving) {
      return;
    }
    this.loading = true;
    this.ready = false;
    this.loadError = '';
    try {
      const context = this.getUIContext().getHostContext();
      if (!context) {
        throw new Error('无法访问本地账本，请重新打开应用。');
      }
      this.store = new LedgerStore(context);
      this.entries = await this.store.load();
      this.ready = true;
    } catch (error) {
      this.loadError = '账本读取失败，已暂停写入以保护原数据。请重试；若仍失败，请保留应用并检查存储空间。';
    } finally {
      this.loading = false;
    }
  }

  private notifySaved(message: string): void {
    try {
      this.getUIContext().getPromptAction().showToast({ message });
    } catch (error) {
      // Notification failure must never be reported as a failed ledger write.
    }
  }

  private monthEntries(): LedgerEntry[] {
    return entriesForMonth(this.entries, this.month);
  }

  private visibleEntries(): LedgerEntry[] {
    return this.monthEntries().filter((entry: LedgerEntry) => this.filter === 'all' || entry.type === this.filter);
  }

  private totals(): LedgerSummary {
    return summarize(this.monthEntries());
  }

  private monthTitle(): string {
    return `${this.month.substring(0, 4)} 年 ${Number(this.month.substring(5, 7))} 月`;
  }

  private hasDraft(): boolean {
    return this.amount.length > 0 || this.note.length > 0 || this.editingId.length > 0 ||
      this.entryDate !== todayString() || this.entryType !== 'expense' ||
      this.categoryId !== getCategories('expense')[0].id;
  }

  private resetForm(): void {
    this.entryType = 'expense';
    this.categoryId = getCategories('expense')[0].id;
    this.amount = '';
    this.note = '';
    this.entryDate = todayString();
    this.editingId = '';
    this.editingCreatedAt = 0;
    this.formError = '';
  }

  private async mayDiscard(): Promise<boolean> {
    if (this.saving) {
      return false;
    }
    if (!this.hasDraft()) {
      return true;
    }
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '放弃这次编辑？',
        message: '当前内容还没有保存到你的账本。',
        buttons: [{ text: '继续编辑', color: GREEN }, { text: '放弃编辑', color: EXPENSE }]
      });
      return result.index === 1;
    } catch (error) {
      return false;
    }
  }

  private async closeEditor(): Promise<void> {
    if (await this.mayDiscard()) {
      this.resetForm();
      this.sheetOpen = false;
    }
  }

  private async editEntry(entry: LedgerEntry): Promise<void> {
    if (!this.ready || this.saving) {
      return;
    }
    if (this.hasDraft() && !(await this.mayDiscard())) {
      return;
    }
    this.editingId = entry.id;
    this.editingCreatedAt = entry.createdAt;
    this.entryType = entry.type;
    this.categoryId = entry.categoryId;
    this.amount = (entry.amountCents / 100).toFixed(2);
    this.entryDate = entry.date;
    this.note = entry.note;
    this.formError = '';
    this.sheetOpen = !this.wide;
  }

  private changeType(value: EntryType): void {
    this.entryType = value;
    this.categoryId = getCategories(value)[0].id;
    this.formError = '';
  }

  private chooseDate(): void {
    const parts = this.entryDate.split('-');
    this.getUIContext().showDatePickerDialog({
      start: new Date(1900, 0, 1),
      end: new Date(2100, 11, 31),
      selected: new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
      lunar: false,
      onDateAccept: (value: Date) => {
        this.entryDate = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
      }
    });
  }

  private async saveEntry(): Promise<void> {
    if (!this.ready || this.saving || !this.store) {
      return;
    }
    this.formError = '';
    let next: LedgerEntry[];
    let savedMonth: string;
    try {
      const entry: LedgerEntry = {
        id: this.editingId || `${Date.now()}-${Math.random().toString(36).substring(2, 12)}`,
        type: this.entryType,
        amountCents: parseAmount(this.amount),
        categoryId: this.categoryId,
        date: this.entryDate,
        note: this.note.trim(),
        createdAt: this.editingId ? this.editingCreatedAt : Date.now()
      };
      next = upsertEntry(this.entries, entry);
      savedMonth = entry.date.substring(0, 7);
    } catch (error) {
      this.formError = (error as Error).message || '请检查金额、分类和日期。';
      return;
    }
    this.saving = true;
    try {
      await this.store.save(next);
      this.entries = next;
      this.month = savedMonth;
      this.filter = 'all';
      this.resetForm();
      this.sheetOpen = false;
      this.notifySaved('已保存到本地账本');
    } catch (error) {
      this.formError = '保存失败，内容仍保留在这里。请检查手机存储空间后重试。';
    } finally {
      this.saving = false;
    }
  }

  private async deleteEditingEntry(): Promise<void> {
    if (!this.editingId || !this.store || this.saving || !this.ready) {
      return;
    }
    const id = this.editingId;
    try {
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '删除这笔账单？',
        message: '删除后无法撤销，月度统计也会随之更新。',
        buttons: [{ text: '保留账单', color: GREEN }, { text: '删除账单', color: EXPENSE }]
      });
      if (result.index !== 1) {
        return;
      }
    } catch (error) {
      return;
    }
    this.saving = true;
    try {
      const next = removeEntry(this.entries, id);
      await this.store.save(next);
      this.entries = next;
      this.resetForm();
      this.sheetOpen = false;
      this.notifySaved('账单已删除');
    } catch (error) {
      this.formError = '删除失败，原账单仍保留。请稍后重试。';
    } finally {
      this.saving = false;
    }
  }

  @Builder
  monthPicker() {
    Row({ space: 8 }) {
      Text(this.monthTitle()).fontSize(20).fontWeight(FontWeight.Medium).fontColor(INK).layoutWeight(1)
      Button('‹', { type: ButtonType.Circle }).width(44).height(44).fontSize(28)
        .backgroundColor('#E7ECE4').fontColor(GREEN)
        .id('month-previous').accessibilityText('上个月').enabled(this.month > '1900-01')
        .onClick(() => { this.month = shiftMonth(this.month, -1); })
      Button('›', { type: ButtonType.Circle }).width(44).height(44).fontSize(28)
        .backgroundColor('#E7ECE4').fontColor(GREEN)
        .id('month-next').accessibilityText('下个月').enabled(this.month < '2100-12')
        .onClick(() => { this.month = shiftMonth(this.month, 1); })
    }.width('100%').margin({ bottom: 16 })
  }

  @Builder
  overview() {
    Column({ space: 18 }) {
      Row() {
        Text('本月结余').fontSize(14).fontColor('#D4E4D8')
        Blank()
        Text('CNY · 人民币').fontSize(12).fontColor('#D4E4D8')
      }.width('100%')
      Text(`¥ ${formatAmount(this.totals().balanceCents)}`)
        .fontSize(36).minFontSize(24).maxFontSize(36).maxLines(1)
        .fontWeight(FontWeight.Medium).fontColor('#FFFFFF').width('100%')
      Row() {
        Column({ space: 7 }) {
          Text('本月收入').fontSize(13).fontColor('#D4E4D8')
          Text(`+ ${formatAmount(this.totals().incomeCents)}`).fontSize(18).fontColor('#FFFFFF')
            .maxLines(1).minFontSize(12).maxFontSize(18)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        Column({ space: 7 }) {
          Text('本月支出').fontSize(13).fontColor('#D4E4D8')
          Text(`− ${formatAmount(this.totals().expenseCents)}`).fontSize(18).fontColor('#FFFFFF')
            .maxLines(1).minFontSize(12).maxFontSize(18)
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      }.width('100%')
    }.width('100%').padding(22).backgroundColor(GREEN).borderRadius(24)
      .alignItems(HorizontalAlign.Start).margin({ bottom: 18 })
  }

  @Builder
  filterButton(label: string, value: string) {
    Button(label).height(44).fontSize(14)
      .fontColor(this.filter === value ? '#FFFFFF' : MUTED)
      .backgroundColor(this.filter === value ? GREEN : '#E7ECE4')
      .onClick(() => { this.filter = value; })
      .id(`filter-${value}`).accessibilityText(`${label}${this.filter === value ? '，已选中' : ''}`)
  }

  @Builder
  entryRow(entry: LedgerEntry) {
    Row({ space: 14 }) {
      Text(categoryById(entry.categoryId).label.substring(0, 1))
        .fontSize(18).fontWeight(FontWeight.Medium).fontColor(categoryById(entry.categoryId).color)
        .width(44).height(44).textAlign(TextAlign.Center).backgroundColor('#E7ECE4').borderRadius(14)
      Column({ space: 6 }) {
        Text(categoryById(entry.categoryId).label).fontSize(16).fontColor(INK)
        Text(entry.note || (entry.type === 'expense' ? '日常支出' : '一笔收入'))
          .fontSize(12).fontColor(MUTED).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Column({ space: 6 }) {
        Text(`${entry.type === 'expense' ? '−' : '+'} ${formatAmount(entry.amountCents)}`)
          .fontSize(17).fontWeight(FontWeight.Medium).fontColor(entry.type === 'expense' ? EXPENSE : GREEN)
        Text(entry.date.substring(5).replace('-', '月') + '日').fontSize(12).fontColor(MUTED)
      }.alignItems(HorizontalAlign.End)
    }.width('100%').padding({ top: 15, bottom: 15 })
      .id(`entry-${entry.id}`).accessibilityText(`${entry.date} ${categoryById(entry.categoryId).label} ${entry.type === 'expense' ? '支出' : '收入'} ${formatAmount(entry.amountCents)}元，${entry.note}，点击编辑`)
      .onClick(() => { this.editEntry(entry); }).enabled(!this.saving)
  }

  @Builder
  emptyState(title: string, description: string) {
    Column({ space: 12 }) {
      Text('一笔').fontSize(24).fontWeight(FontWeight.Medium).fontColor(GREEN)
        .width(76).height(76).textAlign(TextAlign.Center).backgroundColor('#E7ECE4').borderRadius(26)
      Text(title).fontSize(18).fontWeight(FontWeight.Medium).fontColor(INK)
      Text(description).fontSize(14).fontColor(MUTED).textAlign(TextAlign.Center).lineHeight(22)
    }.width('100%').padding({ top: 42, bottom: 32, left: 12, right: 12 })
  }

  @Builder
  bills() {
    Column() {
      Row({ space: 8 }) {
        this.filterButton('全部', 'all')
        this.filterButton('支出', 'expense')
        this.filterButton('收入', 'income')
        Blank()
        Text(`${this.visibleEntries().length} 笔`).fontSize(12).fontColor(MUTED)
      }.width('100%').margin({ top: 14, bottom: 4 })
      List() {
        if (this.visibleEntries().length === 0) {
          ListItem() {
            this.emptyState(this.monthEntries().length === 0 ? '这个月，等你记下第一笔' : '这个分类还没有账单',
              this.monthEntries().length === 0 ? '从一杯咖啡、一趟出行开始。' : '试试切换“全部”，查看本月其他记录。')
          }
        } else {
          ForEach(this.visibleEntries(), (entry: LedgerEntry) => {
            ListItem() { this.entryRow(entry) }
          }, (entry: LedgerEntry) => `${entry.id}-${entry.type}-${entry.categoryId}-${entry.amountCents}-${entry.date}-${entry.note}`)
        }
      }.layoutWeight(1).width('100%').divider({ strokeWidth: 0.5, color: '#DCE3D9' })
    }.width('100%').height('100%')
  }

  @Builder
  statsRow(item: CategoryTotal) {
    Column({ space: 10 }) {
      Row() {
        Text(item.label).fontSize(15).fontColor(INK)
        Blank()
        Text(`¥ ${formatAmount(item.amountCents)}`).fontSize(15).fontWeight(FontWeight.Medium).fontColor(INK)
        Text(`${item.percent.toFixed(1)}%`).fontSize(12).fontColor(MUTED).width(56).textAlign(TextAlign.End)
      }.width('100%')
      Progress({ value: item.percent, total: 100, type: ProgressType.Linear })
        .width('100%').color(item.color).backgroundColor('#E3E9DF').style({ strokeWidth: 7 })
    }.width('100%').padding({ top: 14, bottom: 14 })
  }

  @Builder
  stats() {
    List() {
      ListItem() {
        Row() {
          Text('支出分类').fontSize(17).fontWeight(FontWeight.Medium).fontColor(INK)
          Blank()
          Text('占本月总支出').fontSize(12).fontColor(MUTED)
        }.width('100%').padding({ top: 22, bottom: 10 })
      }
      if (categoryTotals(this.monthEntries()).length === 0) {
        ListItem() { this.emptyState('还没有支出统计', '记下支出后，就能看到钱花在哪里。') }
      } else {
        ForEach(categoryTotals(this.monthEntries()), (item: CategoryTotal) => {
          ListItem() { this.statsRow(item) }
        }, (item: CategoryTotal) => `${item.categoryId}-${item.amountCents}`)
      }
      ListItem() {
        Text('结余 = 本月收入 − 本月支出，仅反映已记录账单。')
          .fontSize(12).fontColor(MUTED).lineHeight(20).padding({ top: 24, bottom: 24 })
      }
    }.width('100%').height('100%')
  }

  @Builder
  ledgerPanel() {
    Column() {
      this.monthPicker()
      this.overview()
      Tabs() {
        TabContent() { this.bills() }.tabBar('账单')
        TabContent() { this.stats() }.tabBar('统计')
      }.layoutWeight(1).width('100%').barHeight(48).barMode(BarMode.Fixed)
    }.width('100%').height('100%')
  }

  @Builder
  categoryButton(category: Category) {
    Button({ type: ButtonType.Normal }) {
      Column({ space: 8 }) {
        Text(category.label.substring(0, 1)).fontSize(18).fontWeight(FontWeight.Medium)
        Text(category.label).fontSize(13)
      }.padding({ top: 12, bottom: 12 }).width('100%')
    }.width('23%').borderRadius(14)
      .fontColor(this.categoryId === category.id ? '#FFFFFF' : INK)
      .backgroundColor(this.categoryId === category.id ? GREEN : '#E7ECE4')
      .margin({ bottom: 10 }).enabled(!this.saving)
      .id(`category-${category.id}`).accessibilityText(`${category.label}${this.categoryId === category.id ? '，已选中' : ''}`)
      .onClick(() => { this.categoryId = category.id; })
  }

  @Builder
  editor() {
    Column({ space: 18 }) {
      Row() {
        Text(this.editingId ? '编辑账单' : '记一笔').fontSize(24).fontWeight(FontWeight.Medium).fontColor(INK)
        Blank()
        Button(this.wide ? '重置' : '关闭').height(44).fontSize(14)
          .fontColor(MUTED).backgroundColor('#E7ECE4').enabled(!this.saving)
          .onClick(() => { this.closeEditor(); })
      }.width('100%')
      Row({ space: 10 }) {
        Button('支出').id('type-expense').layoutWeight(1).height(44).fontSize(16)
          .fontColor(this.entryType === 'expense' ? '#FFFFFF' : INK)
          .backgroundColor(this.entryType === 'expense' ? GREEN : '#E7ECE4')
          .onClick(() => { this.changeType('expense'); })
        Button('收入').id('type-income').layoutWeight(1).height(44).fontSize(16)
          .fontColor(this.entryType === 'income' ? '#FFFFFF' : INK)
          .backgroundColor(this.entryType === 'income' ? GREEN : '#E7ECE4')
          .onClick(() => { this.changeType('income'); })
      }.width('100%').enabled(!this.saving)
      Column({ space: 8 }) {
        Text('金额（元）').fontSize(13).fontColor(MUTED)
        TextInput({ text: this.amount, placeholder: '0.00' }).type(InputType.NUMBER_DECIMAL)
          .fontSize(36).fontWeight(FontWeight.Medium).fontColor(INK).height(68)
          .backgroundColor('#E7ECE4').borderRadius(16).maxLength(12)
          .id('ledger-amount').accessibilityText('金额，单位元，最多两位小数').enabled(!this.saving)
          .onChange((value: string) => { this.amount = value; this.formError = ''; })
      }.alignItems(HorizontalAlign.Start).width('100%')
      Column({ space: 12 }) {
        Text('分类').fontSize(13).fontColor(MUTED)
        Flex({ wrap: FlexWrap.Wrap, justifyContent: FlexAlign.SpaceBetween }) {
          ForEach(getCategories(this.entryType), (category: Category) => {
            this.categoryButton(category)
          }, (category: Category) => category.id)
        }.width('100%')
      }.alignItems(HorizontalAlign.Start).width('100%')
      Row() {
        Text('日期').fontSize(14).fontColor(MUTED)
        Blank()
        Button(this.entryDate).height(44).fontSize(15).fontColor(INK).backgroundColor('#E7ECE4')
          .id('ledger-date').accessibilityText(`记账日期 ${this.entryDate}，点击选择`)
          .enabled(!this.saving).onClick(() => { this.chooseDate(); })
      }.width('100%')
      Column({ space: 8 }) {
        Text('备注（选填）').fontSize(13).fontColor(MUTED)
        TextInput({ text: this.note, placeholder: '写一点这笔钱的小事' }).maxLength(100)
          .height(52).backgroundColor('#E7ECE4').borderRadius(14).fontSize(15).fontColor(INK)
          .id('ledger-note').accessibilityText('备注，选填，最多100字').enabled(!this.saving)
          .onChange((value: string) => { this.note = value; })
      }.alignItems(HorizontalAlign.Start).width('100%')
      if (this.formError) {
        Text(this.formError).fontSize(14).fontColor(EXPENSE).lineHeight(22).width('100%')
      }
      Button(this.saving ? '正在保存…' : (this.editingId ? '保存修改' : '保存账单'))
        .id('ledger-save').width('100%').height(52).fontSize(17).fontWeight(FontWeight.Medium)
        .backgroundColor(GREEN).fontColor('#FFFFFF').enabled(this.ready && !this.saving)
        .onClick(() => { this.saveEntry(); })
      if (this.editingId) {
        Button('删除这笔账单').id('ledger-delete').width('100%').height(44).fontSize(14).fontColor(EXPENSE)
          .backgroundColor('#F6E8E1').enabled(!this.saving)
          .onClick(() => { this.deleteEditingEntry(); })
      }
      Text('账目仅保存在这台手机，无需登录。').fontSize(12).fontColor(MUTED).textAlign(TextAlign.Center)
    }.width('100%').padding(22).alignItems(HorizontalAlign.Start)
  }

  @Builder
  editorSheet() {
    Scroll() { this.editor() }.width('100%').height('100%').backgroundColor(PAPER)
  }

  build() {
    Navigation() {
      Column() {
        if (!this.ready) {
          Column({ space: 20 }) {
            if (this.loading) {
              LoadingProgress().width(40).height(40).color(GREEN)
              Text('正在打开本地账本…').fontSize(16).fontColor(MUTED)
            } else {
              Text('暂时无法读取账本').fontSize(22).fontWeight(FontWeight.Medium).fontColor(INK)
              Text(this.loadError).fontSize(15).fontColor(MUTED).lineHeight(24).textAlign(TextAlign.Center)
              Button('重新读取').height(48).backgroundColor(GREEN).fontColor('#FFFFFF')
                .onClick(() => { this.loadLedger(); })
            }
          }.width('100%').layoutWeight(1).justifyContent(FlexAlign.Center).padding(24)
        } else {
          if (this.wide) {
            Row({ space: 24 }) {
              Column() { this.ledgerPanel() }.layoutWeight(1).height('100%')
              Scroll() { this.editor() }.width(336).height('100%')
                .backgroundColor('#EDF1E8').borderRadius(24)
            }.layoutWeight(1).width('100%').alignItems(VerticalAlign.Top)
          } else {
            Column() { this.ledgerPanel() }.layoutWeight(1).width('100%')
            Button('+ 记一笔').id('ledger-add').height(54).width('100%').fontSize(18).backgroundColor(GREEN).fontColor('#FFFFFF')
              .margin({ top: 12, bottom: 8 }).enabled(!this.saving)
              .onClick(() => { this.sheetOpen = true; })
          }
        }
      }.height('100%').width('100%').padding({ left: 20, right: 20, top: 12, bottom: 8 })
        .onAreaChange((oldArea: Area, newArea: Area) => {
          const wasWide = this.wide;
          this.wide = Number(newArea.width) >= 680;
          if (this.wide) {
            this.sheetOpen = false;
          } else if (wasWide && this.hasDraft()) {
            this.sheetOpen = true;
          }
        })
    }.title('一笔记账').titleMode(NavigationTitleMode.Mini).hideBackButton(true)
      .mode(NavigationMode.Stack).width('100%').height('100%').backgroundColor(PAPER)
      .bindSheet(this.sheetOpen!!, this.editorSheet(), {
        height: SheetSize.LARGE,
        showClose: false,
        dragBar: true,
        backgroundColor: PAPER,
        onWillDismiss: (action: DismissSheetAction) => {
          this.mayDiscard().then((allow: boolean) => {
            if (allow) {
              action.dismiss();
              this.sheetOpen = false;
              this.resetForm();
            }
          });
        }
      })
  }
}
