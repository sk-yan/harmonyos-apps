"""Browser acceptance checks. Uses an isolated Chrome profile; no user accounts."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get('YIBI_PREVIEW_ARTIFACTS', str(ROOT / 'artifacts/preview'))).resolve()
URL = os.environ.get('YIBI_PREVIEW_URL', 'http://127.0.0.1:5186/')
CHROME = os.environ.get('YIBI_CHROME_PATH')
KEY = 'yibi-ledger-v1'


def stored(page):
    raw = page.evaluate('(key) => localStorage.getItem(key)', KEY)
    return json.loads(raw)['entries'] if raw is not None else []


def add(page, amount, note='', income=False, date=None):
    if income:
        page.locator('#entry-form').get_by_role('button', name='收入', exact=True).click()
    page.get_by_label('金额', exact=True).fill(amount)
    if note:
        page.get_by_label('备注').fill(note)
    if date:
        page.get_by_label('日期', exact=True).fill(date)
    page.get_by_role('button', name='保存记录', exact=True).click()
    expect(page.locator('.save-notice')).to_have_text('已记下这一笔')


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'horizontal overflow'


def money(page, value):
    expect(page.locator('.balance-amount')).to_contain_text(value)


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    results = []
    runtime_errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(**({'executable_path': CHROME} if CHROME else {}), headless=True)

        def fresh(width=1280, height=1000):
            context = browser.new_context(viewport={'width': width, 'height': height}, locale='zh-CN', timezone_id='Asia/Shanghai')
            page = context.new_page()
            page.on('pageerror', lambda error: runtime_errors.append(str(error)))
            page.goto(URL)
            page.wait_for_load_state('networkidle')
            return context, page

        context, page = fresh()
        assert stored(page) == []
        money(page, '0.00')
        expect(page.get_by_text('从第一笔，开始记起')).to_be_visible()
        page.get_by_label('金额', exact=True).fill('0')
        page.get_by_role('button', name='保存记录', exact=True).click()
        expect(page.locator('#form-error')).to_be_visible()
        assert stored(page) == []
        page.get_by_label('金额', exact=True).fill('12.345')
        page.get_by_role('button', name='保存记录', exact=True).click()
        expect(page.locator('#form-error')).to_contain_text('两位小数')
        assert stored(page) == []
        initial_date = page.get_by_label('日期', exact=True).input_value()
        page.get_by_label('金额', exact=True).fill('12')
        for outside in ['1899-12-31', '2101-01-01']:
            page.get_by_label('日期', exact=True).fill(outside)
            page.get_by_role('button', name='保存记录', exact=True).click()
            expect(page.locator('#form-error')).to_contain_text('1900 年至 2100 年')
            assert stored(page) == []
        page.get_by_label('日期', exact=True).fill(initial_date)
        add(page, '36.50', '午餐')
        add(page, '100', '收入测试', income=True)
        money(page, '63.50')
        assert sorted(item['amountCents'] for item in stored(page)) == [3650, 10000]
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'desktop-populated.png'), full_page=True)
        results.append('Empty start, invalid amount rejection, exact expense/income and balance')

        page.get_by_role('button', name='编辑 餐饮 36.50 元').click()
        page.get_by_label('金额', exact=True).fill('40.20')
        page.get_by_role('button', name='保存修改', exact=True).click()
        money(page, '59.80')
        assert len(stored(page)) == 2
        page.get_by_role('tab', name='统计').click()
        expect(page.locator('.category-stats')).to_contain_text('40.20')
        expect(page.locator('.category-stats')).to_contain_text('100%')
        page.get_by_role('tab', name='账单').click()
        page.locator('.filter-group').get_by_role('button', name='收入', exact=True).click()
        expect(page.locator('.entry-row')).to_have_count(1)
        expect(page.locator('.entry-label')).to_have_text('工资')
        page.locator('.filter-group').get_by_role('button', name='全部', exact=True).click()
        results.append('Edit replaces one record; expense statistics and income filter agree')

        today = page.get_by_label('日期', exact=True).input_value()
        year, month, _ = [int(part) for part in today.split('-')]
        previous = f'{year-1 if month == 1 else year:04d}-{12 if month == 1 else month-1:02d}-15'
        page.get_by_role('button', name='编辑 餐饮 40.20 元').click()
        page.get_by_label('日期', exact=True).fill(previous)
        page.get_by_role('button', name='保存修改', exact=True).click()
        money(page, '40.20')
        expect(page.locator('.entry-row')).to_have_count(1)
        page.get_by_role('button', name='回到本月', exact=True).click()
        money(page, '100.00')
        page.reload()
        page.wait_for_load_state('networkidle')
        assert len(stored(page)) == 2
        money(page, '100.00')
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.get_by_role('button', name='删除 工资 100.00 元').click()
        assert len(stored(page)) == 2
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='删除 工资 100.00 元').click()
        assert len(stored(page)) == 1
        money(page, '0.00')
        results.append('Move to previous month, reload persistence, cancel and confirm deletion')
        context.close()

        context, page = fresh()
        add(page, '20', '原账单')
        before = stored(page)
        page.evaluate("() => { Storage.prototype.setItem = function() { throw new DOMException('Test quota full', 'QuotaExceededError'); }; }")
        page.get_by_label('金额', exact=True).fill('88')
        page.get_by_role('button', name='保存记录', exact=True).click()
        expect(page.get_by_role('alert').first).to_contain_text('保存失败')
        expect(page.get_by_label('金额', exact=True)).to_have_value('88')
        assert stored(page) == before
        expect(page.locator('.entry-row')).to_have_count(1)
        results.append('Storage quota failure keeps original ledger and the unsaved form')
        context.close()

        for corrupt in ['', '{broken', '{"version":99,"entries":[]}']:
            context, page = fresh()
            page.evaluate('([key, value]) => localStorage.setItem(key, value)', [KEY, corrupt])
            page.reload()
            expect(page.get_by_role('alert').first).to_contain_text('无法读取账本')
            page.get_by_label('金额', exact=True).fill('12')
            page.get_by_role('button', name='保存记录', exact=True).click()
            assert page.evaluate('(key) => localStorage.getItem(key)', KEY) == corrupt
            context.close()
        results.append('Empty, corrupt and unsupported-version storage cannot be overwritten')

        context, page = fresh()
        add(page, '10', '第一笔')
        page.get_by_label('金额', exact=True).fill('30')
        # Same document writes emit no storage event: this verifies the pre-write comparison.
        external = '{"version":1,"entries":[]}'
        page.evaluate('([key, raw]) => localStorage.setItem(key, raw)', [KEY, external])
        page.get_by_role('button', name='保存记录', exact=True).click()
        expect(page.get_by_role('alert').first).to_contain_text('重新读取')
        assert page.evaluate('(key) => localStorage.getItem(key)', KEY) == external
        expect(page.get_by_label('金额', exact=True)).to_have_value('30')
        page.get_by_role('button', name='重新读取').click()
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert len(stored(page)) == 1 and stored(page)[0]['amountCents'] == 3000
        results.append('Stale browser snapshot cannot overwrite newer data; explicit reread permits merge')
        page.get_by_label('金额', exact=True).fill('45')
        other_page = context.new_page()
        other_page.goto(URL)
        other_page.wait_for_load_state('networkidle')
        other_page.evaluate('() => { localStorage.clear(); }')
        expect(page.get_by_role('alert').first).to_contain_text('另一个页面')
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert page.evaluate('(key) => localStorage.getItem(key)', KEY) is None
        expect(page.get_by_label('金额', exact=True)).to_have_value('45')
        page.get_by_role('button', name='重新读取').click()
        page.get_by_role('button', name='保存记录', exact=True).click()
        assert len(stored(page)) == 1 and stored(page)[0]['amountCents'] == 4500
        results.append('Real second-page clear event prevents writing until reread and preserves draft')
        context.close()

        context, page = fresh(390, 844)
        expect(page.locator('#entry-dialog')).not_to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'phone-empty.png'), full_page=True)
        page.locator('#mobile-add').click()
        expect(page.locator('#entry-dialog')).to_be_visible()
        page.get_by_label('金额', exact=True).fill('12.80')
        page.get_by_label('备注').fill('折叠测试')
        page.set_viewport_size({'width': 834, 'height': 1112})
        expect(page.locator('#entry-dialog')).not_to_be_visible()
        expect(page.get_by_label('金额', exact=True)).to_have_value('12.80')
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'unfolded-editor.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        expect(page.locator('#entry-dialog')).to_be_visible()
        expect(page.get_by_label('金额', exact=True)).to_have_value('12.80')
        page.once('dialog', lambda dialog: dialog.dismiss())
        page.keyboard.press('Escape')
        expect(page.locator('#entry-dialog')).to_be_visible()
        page.screenshot(path=str(OUTPUT / 'phone-editor.png'), full_page=True)
        page.once('dialog', lambda dialog: dialog.accept())
        page.get_by_role('button', name='关闭记账').click()
        expect(page.locator('#entry-dialog')).not_to_be_visible()
        expect(page.locator('#mobile-add')).to_be_focused()
        assert stored(page) == []
        page.locator('#mobile-add').click()
        add(page, '18.80', '<img src=x onerror=alert(1)>')
        expect(page.locator('.entry-note')).to_have_text('<img src=x onerror=alert(1)>')
        expect(page.locator('.entry-note img')).to_have_count(0)
        expect(page.locator('#entry-dialog')).not_to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(OUTPUT / 'phone-populated.png'), full_page=True)
        page.set_viewport_size({'width': 320, 'height': 640})
        no_overflow(page)
        results.append('Fold/unfold keeps draft; Esc respects discard choice; focus restores; notes render safely')
        context.close()

        context, page = fresh(320, 640)
        page.locator('#mobile-add').click()
        page.get_by_label('金额', exact=True).fill('10000000')
        page.get_by_role('button', name='保存记录', exact=True).click()
        expect(page.locator('#form-error')).to_contain_text('9,999,999.99')
        assert stored(page) == []
        page.get_by_label('备注').fill('完整备注' * 25)
        assert len(page.get_by_label('备注').input_value()) == 100
        add(page, '9999999.99')
        money(page, '9,999,999.99')
        expect(page.locator('.entry-note')).to_have_text('完整备注' * 25)
        expect(page.locator('.entry-amount')).to_have_text('−9,999,999.99')
        assert page.locator('.balance-amount > span:last-child').evaluate('(e) => e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).fontSize) * 1.5'), 'balance amount wraps into multiple lines'
        no_overflow(page)
        assert page.locator('.entry-amount').evaluate('(e) => e.getBoundingClientRect().right <= e.closest(".entry-row").getBoundingClientRect().right'), 'amount clipped inside narrow entry row'
        assert page.locator('.entry-details').evaluate('(e) => e.getBoundingClientRect().right <= e.parentElement.querySelector(".entry-amount").getBoundingClientRect().left'), 'note overlaps amount'
        page.screenshot(path=str(OUTPUT / 'phone-maximum.png'), full_page=True)
        page.locator('#mobile-add').click()
        page.get_by_label('备注').fill('学' * 101)
        assert len(page.get_by_label('备注').input_value()) == 100
        results.append('Date bounds, amount ceiling and 100-character notes; maximum amount fits 320px screen')
        context.close()

        assert not runtime_errors, runtime_errors
        browser.close()
    report = {'passed': len(results), 'scenarios': results, 'runtimeErrors': runtime_errors,
              'scope': 'Browser preview only; not native ArkUI runtime or HAP validation'}
    (OUTPUT / 'ui-test-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
