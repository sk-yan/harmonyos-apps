"""Real browser import/OCR checks with synthetic data and no external requests."""
import csv
import io
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit
from xml.sax.saxutils import escape
import zipfile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get('YIBI_PREVIEW_ARTIFACTS', str(ROOT / 'artifacts/preview'))).resolve()
FIXTURES = ROOT / 'tests/fixtures/import'
URL = os.environ.get('YIBI_PREVIEW_URL', 'http://127.0.0.1:5186/')
CHROME = os.environ.get('YIBI_CHROME_PATH')
KEY = 'yibi-ledger-v1'
HEADER = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注']


def row(amount='40.20', trade='42000000000000000000000000000001', merchant='测试食堂'):
    return ['2026-09-10 12:20:00', '商户消费', merchant, '午餐', '支出', amount, '零钱', '支付成功', trade, 'merchant-test', '/']


def csv_bytes(rows, encoding='utf-8'):
    stream = io.StringIO(newline='')
    csv.writer(stream).writerows(rows)
    return stream.getvalue().encode(encoding)


def xlsx_bytes(rows):
    sheet_rows = []
    for number, values in enumerate(rows, 1):
        cells = ''.join(f'<c r="{chr(65 + column)}{number}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
                        for column, value in enumerate(values))
        sheet_rows.append(f'<row r="{number}">{cells}</row>')
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="合成账单" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' + ''.join(sheet_rows) + '</sheetData></worksheet>',
    }
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return result.getvalue()


def stored(page):
    raw = page.evaluate('(key) => localStorage.getItem(key)', KEY)
    return json.loads(raw)['entries'] if raw is not None else []


def file_input(page, content, name='wechat.csv'):
    page.get_by_role('button', name='导入账单', exact=True).click()
    page.locator('#bill-file').set_input_files({'name': name, 'mimeType': 'application/octet-stream', 'buffer': content})


def cancel_import(page):
    page.once('dialog', lambda dialog: dialog.accept())
    page.get_by_role('button', name='关闭导入').click()
    expect(page.locator('#import-dialog')).not_to_be_visible()


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'page horizontal overflow'
    assert page.locator('#import-dialog').evaluate('(e) => e.scrollWidth <= e.clientWidth'), 'dialog horizontal overflow'


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    passed = []
    runtime_errors = []
    external_requests = []
    ocr_result = {}
    origin = urlsplit(URL).netloc
    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path': CHROME} if CHROME else {}), headless=True)

        def fresh(width=1280, height=1000):
            context = browser.new_context(viewport={'width': width, 'height': height}, locale='zh-CN', timezone_id='Asia/Shanghai', service_workers='block')

            def local_only(route):
                if urlsplit(route.request.url).netloc == origin:
                    route.continue_()
                else:
                    external_requests.append(route.request.url)
                    route.abort()
            context.route('**/*', local_only)
            page = context.new_page()
            page.on('pageerror', lambda error: runtime_errors.append(str(error)))
            page.goto(URL)
            page.wait_for_load_state('networkidle')
            return context, page

        context, page = fresh(390, 844)
        file_input(page, (FIXTURES / 'wechat.csv').read_bytes())
        expect(page.locator('#import-title')).to_have_text('确认导入内容')
        assert stored(page) == []
        expect(page.locator('.import-file-description')).to_contain_text('2026-01 至 2026-09')
        expect(page.locator('#confirm-import')).to_have_text('导入已选 2 笔')
        expect(page.locator('.import-row.review input[data-confirm-row]')).to_have_count(2)
        for checkbox in page.locator('.import-row.review input[data-confirm-row]').all():
            expect(checkbox).not_to_be_checked()
        page.locator('[data-confirm-row="2"]').check()
        expect(page.locator('#confirm-import')).to_have_text('导入已选 3 笔')
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'import-phone-review.png'), full_page=True)
        page.set_viewport_size({'width': 711, 'height': 1000})
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'import-unfolded-review.png'), full_page=True)
        page.locator('#confirm-import').click()
        assert len(stored(page)) == 3
        assert sorted(entry['amountCents'] for entry in stored(page)) == [2000, 4020, 10000]
        expect(page.locator('#month-select')).to_have_value('2026-09')
        expect(page.locator('.balance-amount')).to_contain_text('60.20')
        page.locator('#month-select').fill('2026-01')
        expect(page.locator('.balance-amount')).to_contain_text('100.00')
        file_input(page, (FIXTURES / 'wechat.csv').read_bytes())
        expect(page.locator('.import-row.duplicate')).to_have_count(3)
        expect(page.locator('#confirm-import')).to_be_disabled()
        cancel_import(page)
        assert len(stored(page)) == 3
        passed.append('UTF-8 CSV preview is read-only, review rows require consent, cross-month totals and repeat import agree')
        context.close()

        context, page = fresh()
        text = (FIXTURES / 'alipay.csv').read_text(encoding='utf-8')
        file_input(page, text.encode('gbk'), 'alipay-gbk.csv')
        expect(page.locator('#confirm-import')).to_have_text('导入已选 2 笔')
        expect(page.locator('.import-rows')).to_contain_text('测试早餐店')
        page.locator('#confirm-import').click()
        assert {entry['source'] for entry in stored(page)} == {'alipay'}
        assert sorted(entry['amountCents'] for entry in stored(page)) == [10000, 123450]
        assert stored(page)[0]['tradeId'].startswith('20260910')
        passed.append('GBK Alipay file preserves Chinese text, thousand-separated money and long transaction IDs')
        context.close()

        context, page = fresh()
        content = xlsx_bytes([HEADER, row(merchant='<img src=x onerror=alert(1)>')])
        file_input(page, content, 'synthetic-wechat.xlsx')
        expect(page.locator('#confirm-import')).to_have_text('导入已选 1 笔')
        expect(page.locator('.import-row-detail')).to_contain_text('<img src=x onerror=alert(1)>')
        expect(page.locator('.import-row img')).to_have_count(0)
        page.locator('#confirm-import').click()
        assert stored(page)[0]['tradeId'] == '42000000000000000000000000000001'
        assert stored(page)[0]['amountCents'] == 4020
        passed.append('Real DEFLATE XLSX is decoded locally, long IDs remain strings and merchant text cannot execute HTML')
        context.close()

        context, page = fresh()
        page.get_by_label('金额', exact=True).fill('40.20')
        page.get_by_label('日期', exact=True).fill('2026-09-10')
        page.get_by_role('button', name='保存记录', exact=True).click()
        file_input(page, csv_bytes([HEADER, row()]))
        expect(page.locator('#confirm-import')).to_be_disabled()
        expect(page.locator('.import-existing')).to_contain_text('账本已有')
        expect(page.locator('[data-confirm-row="0"]')).not_to_be_checked()
        page.locator('#select-ready').click()
        expect(page.locator('#confirm-import')).to_be_disabled()
        page.locator('[data-confirm-row="0"]').check()
        expect(page.locator('#confirm-import')).to_have_text('导入已选 1 笔')
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.get_by_role('button', name='关闭导入').click()
        expect(page.locator('#import-dialog')).to_be_visible()
        cancel_import(page)
        assert len(stored(page)) == 1
        file_input(page, csv_bytes([HEADER, row(), row(amount='50.00')]))
        expect(page.locator('.import-row.review')).to_have_count(2)
        expect(page.locator('[data-confirm-row]')).to_have_count(0)
        expect(page.locator('#confirm-import')).to_be_disabled()
        cancel_import(page)
        assert len(stored(page)) == 1
        passed.append('Possible manual duplicate needs individual confirmation; conflicting same-ID rows cannot be imported; cancel preserves ledger')
        context.close()

        context, page = fresh()
        file_input(page, csv_bytes([HEADER, row()]))
        page.evaluate("() => { Storage.prototype.setItem = function() { throw new DOMException('Synthetic full storage', 'QuotaExceededError'); }; }")
        page.locator('#confirm-import').click()
        expect(page.locator('#import-dialog .import-error')).to_contain_text('保存失败')
        expect(page.locator('#confirm-import')).to_have_text('导入已选 1 笔')
        assert stored(page) == []
        passed.append('Import persistence failure retains preview and makes no partial ledger change')
        context.close()

        context, page = fresh()
        file_input(page, csv_bytes([HEADER, row()]))
        other = {'id': 'concurrent-manual', 'type': 'income', 'amountCents': 500, 'categoryId': 'salary', 'date': '2026-09-10', 'note': 'independent', 'createdAt': 1}
        page.evaluate('([key, value]) => localStorage.setItem(key, value)', [KEY, json.dumps({'version': 1, 'entries': [other]})])
        page.locator('#confirm-import').click()
        expect(page.locator('#import-dialog .import-error')).to_contain_text('未覆盖保存')
        assert stored(page) == [other]
        page.locator('#reload-import').click()
        page.locator('#confirm-import').click()
        assert len(stored(page)) == 2
        assert any(entry['id'] == other['id'] for entry in stored(page))
        passed.append('Stale import preview cannot overwrite concurrent records; explicit reread revalidates before merging')
        context.close()

        context, page = fresh()
        file_input(page, csv_bytes([HEADER, row()]))
        page.locator('#confirm-import').click()
        imported_id = stored(page)[0]['id']
        page.get_by_role('button', name='编辑 餐饮 40.20 元', exact=True).click()
        page.get_by_label('金额', exact=True).fill('41.20')
        page.get_by_role('button', name='保存修改', exact=True).click()
        page.get_by_label('金额', exact=True).fill('7.00')
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert len(stored(page)) == 2
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.get_by_role('button', name='撤销本次导入').click()
        assert len(stored(page)) == 2
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='撤销本次导入').click()
        assert len(stored(page)) == 1 and stored(page)[0]['amountCents'] == 700
        assert stored(page)[0]['id'] != imported_id
        passed.append('Undo last import removes its edited records only and preserves later manual entries')
        context.close()

        context, page = fresh(320, 700)
        page.get_by_role('button', name='截图记账').click()
        page.locator('#screenshot-text').fill('余额：888.88\n优惠金额：10.00')
        page.locator('#parse-screenshot-text').click()
        expect(page.locator('#screenshot-amount')).to_have_value('')
        expect(page.locator('#screenshot-date')).to_have_value('')
        expect(page.locator('#screenshot-type')).to_have_value('unknown')
        page.locator('#screenshot-reviewed').check()
        page.locator('#use-screenshot-draft').click()
        expect(page.locator('#import-dialog')).to_be_visible()
        assert stored(page) == []
        page.locator('#screenshot-amount').fill('12.50')
        page.locator('#screenshot-date').fill('2026-09-10')
        page.locator('#screenshot-type').select_option('expense')
        page.locator('#screenshot-reviewed').check()
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'screenshot-manual-review.png'), full_page=True)
        page.locator('#use-screenshot-draft').click()
        expect(page.locator('#import-dialog')).not_to_be_visible()
        expect(page.locator('#entry-dialog')).to_be_visible()
        expect(page.get_by_label('金额', exact=True)).to_have_value('12.50')
        expect(page.locator('[data-category="other"]')).to_have_attribute('aria-pressed', 'true')
        assert stored(page) == []
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert stored(page)[0]['source'] == 'screenshot'
        page.get_by_role('button', name='截图记账').click()
        page.locator('#screenshot-text').fill('支付成功\n金额：12.50\n2026-09-10')
        page.locator('#parse-screenshot-text').click()
        page.locator('#screenshot-reviewed').check()
        page.locator('#use-screenshot-draft').click()
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert len(stored(page)) == 1
        expect(page.get_by_label('金额', exact=True)).to_have_value('12.50')
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert len(stored(page)) == 2
        passed.append('Screenshot text is only an editable draft; missing money/date/direction cannot save and category defaults to Other')
        context.close()

        context, page = fresh()
        page.get_by_label('金额', exact=True).fill('7.00')
        page.get_by_role('button', name='截图记账').click()
        page.locator('#screenshot-text').fill('支付成功\n实付金额：38.50\n2026-09-10')
        page.locator('#parse-screenshot-text').click()
        cancel_import(page)
        expect(page.get_by_label('金额', exact=True)).to_have_value('7.00')
        assert stored(page) == []
        passed.append('Cancelling screenshot review preserves the previous unsaved manual draft')
        context.close()

        context, page = fresh()
        page.get_by_role('button', name='截图记账').click()
        start = time.monotonic()
        page.locator('#screenshot-file').set_input_files(str(FIXTURES / 'screenshot.png'))
        expect(page.locator('.screenshot-fields')).to_be_visible(timeout=90000)
        text = page.locator('#screenshot-text').input_value()
        expect(page.locator('#screenshot-amount')).to_have_value('38.50')
        expect(page.locator('#screenshot-date')).to_have_value('2026-09-10')
        expect(page.locator('#screenshot-type')).to_have_value('expense')
        assert '测试' in text and '38.50' in text, text
        assert stored(page) == []
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'screenshot-real-local-ocr.png'), full_page=True)
        ocr_result = {'seconds': round(time.monotonic() - start, 2), 'rawText': text,
                      'amount': page.locator('#screenshot-amount').input_value(),
                      'date': page.locator('#screenshot-date').input_value(),
                      'type': page.locator('#screenshot-type').input_value()}
        passed.append('Real Chinese screenshot OCR with all nonlocal requests blocked yields amount/date/direction without writing records')
        context.close()

        context, page = fresh()
        page.get_by_role('button', name='截图记账').click()
        page.locator('#screenshot-file').set_input_files(str(FIXTURES / 'screenshot.png'))
        page.locator('#cancel-ocr').click()
        expect(page.locator('.ocr-status')).to_have_count(0)
        expect(page.locator('.screenshot-fields')).to_have_count(0)
        page.wait_for_timeout(500)
        expect(page.locator('.screenshot-fields')).to_have_count(0)
        assert stored(page) == []
        cancel_import(page)
        passed.append('Cancelling OCR ignores late results and never applies a pending screenshot')
        context.close()

        context, page = fresh()
        file_input(page, b'"unterminated', 'broken.csv')
        expect(page.locator('.import-error')).to_be_visible()
        assert stored(page) == []
        page.get_by_role('button', name='关闭导入').click()
        file_input(page, csv_bytes([HEADER] + [row(trade=f'pagination-{index:04d}') for index in range(31)]))
        expect(page.locator('.import-row')).to_have_count(30)
        expect(page.locator('#confirm-import')).to_have_text('导入已选 31 笔')
        page.locator('#import-next').click()
        expect(page.locator('.import-row')).to_have_count(1)
        page.locator('[data-select-row="30"]').uncheck()
        expect(page.locator('#confirm-import')).to_have_text('导入已选 30 笔')
        assert stored(page) == []
        passed.append('Malformed files cannot change ledger; paginated selection retains decisions across the whole file')
        context.close()

        assert not runtime_errors, runtime_errors
        assert not external_requests, external_requests
        browser.close()
    report = {'passed': len(passed), 'scenarios': passed, 'runtimeErrors': runtime_errors,
              'externalRequests': external_requests, 'syntheticChineseOcr': ocr_result,
              'scope': 'Browser import and local OCR only. No real financial data or native-device OCR.'}
    (OUTPUT / 'import-test-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
