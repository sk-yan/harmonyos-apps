"""Real picker/import acceptance on a dedicated, empty HarmonyOS emulator.

Installs no hooks. Uses synthetic CSV/GBK/XLSX files from public Downloads.
Core Vision does not support emulators: text-assisted entry is tested here;
actual local image recognition is covered by the browser acceptance checks.
"""
import json
import shlex
import time
from pathlib import Path
import native_ui_test as ui

FIXTURES = Path(__file__).resolve().parent / 'fixtures/native-import'
REMOTE = '/storage/media/100/local/files/Docs/Download/'
stages = []


def checkpoint(name, image):
    ui.cli('ui', 'screenshot', '--device', ui.DEVICE, '--path', str(ui.RUN_DIR / image))
    stages.append(name)
    print('PASS:', name, flush=True)


def contains(nodes, text):
    return any(text in node.get('text', '') for node in nodes)


def pick_file(name):
    ui.click('ledger-import', 'down')
    ui.click('import-file')
    selected = False
    for _ in range(10):
        nodes = ui.layout()
        target = next((n for n in nodes if n.get('text') == name), None)
        if target:
            ui.click_text(name)
            selected = True
            break
        if contains(nodes, 'Download'):
            ui.click_text('Download')
        elif contains(nodes, '我的手机'):
            ui.click_text('我的手机')
        elif contains(nodes, '浏览'):
            ui.click_text('浏览')
        else:
            raise AssertionError('Unexpected system file picker page')
    assert selected, f'Fixture not visible in system picker: {name}'
    # Current phone picker returns immediately for maxSelectNumber=1; other
    # image/system versions expose a Done button after selecting the file.
    after_selection = ui.wait_for(lambda n: contains(n, '完成') or
                                  ui.node_by_id(n, 'import-confirm') is not None or
                                  ui.node_by_id(n, 'import-error') is not None,
                                  'Picker selection did not finish')
    if ui.node_by_id(after_selection, 'import-confirm') is None and contains(after_selection, '完成'):
        ui.click_text('完成')
    nodes = ui.wait_for(lambda n: ui.node_by_id(n, 'import-confirm') is not None or
                        ui.node_by_id(n, 'import-error') is not None, 'File did not produce a preview')
    error = ui.node_by_id(nodes, 'import-error')
    assert error is None, error
    return nodes


def close_preview():
    ui.click('import-close', 'down')
    ui.click_text('退出导入')
    ui.wait_for(lambda n: ui.node_by_id(n, 'ledger-import') is not None, 'Ledger not restored')


def undo(expected_balance='0.00'):
    ui.click('import-undo', 'down')
    ui.click_text('撤销导入')
    ui.balance(expected_balance)


def text_input(identifier, value):
    ui.click(identifier)
    # HDC concatenates shell arguments; quote the entire text once for the
    # device shell so newlines and spaces remain one uitest argument.
    ui.hdc('shell', 'uitest uiInput text ' + shlex.quote(value))
    ui.wait_for(lambda n: ui.node_by_id(n, identifier) is not None and
                ui.node_by_id(n, identifier).get('text') == value, 'Text was not entered intact')
    ui.hdc('shell', 'uitest', 'uiInput', 'keyEvent', '2')
    # Back must hide the IME first, not ask to discard this import. Do not swipe
    # on the keyboard while looking for an app button; that can alter the text.
    for _ in range(10):
        all_windows = json.loads(ui.cli('ui', 'layout', '--device', ui.DEVICE,
                                        '--all-windows', '--format', 'json'))
        if ui.node_by_id(ui.flatten(all_windows), 'KeyHideKbd') is None:
            break
        time.sleep(.3)
    else:
        raise AssertionError('Back did not hide the system keyboard')
    nodes = ui.layout()
    assert not contains(nodes, '退出导入'), 'Back opened the discard dialog before hiding the keyboard'
    assert ui.node_by_id(nodes, 'import-close') is not None, 'Back left the import page'
    assert ui.node_by_id(nodes, identifier).get('text') == value, 'Keyboard dismissal changed the receipt text'


def main():
    info = ui.ensure_emulator_target()
    ui.RUN_DIR.mkdir(parents=True, exist_ok=False)
    print('Native import artifacts:', ui.RUN_DIR, flush=True)
    for name in ['synthetic-wechat-large.csv', 'synthetic-alipay-gbk.csv', 'synthetic-wechat-deflated.xlsx']:
        ui.hdc('file', 'send', str(FIXTURES / name), REMOTE + name)
    try:
        ui.hdc('shell', 'power-shell', 'timeout', '-o', '1800000')
        ui.hdc('shell', 'power-shell', 'wakeup')
        ui.cli('emulator', 'fold', 'open', '--target', ui.EMULATOR)
        ui.hdc('shell', 'aa', 'force-stop', ui.BUNDLE)
        ui.hdc('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', ui.BUNDLE, '-m', 'entry')
        initial = ui.wait_for(lambda n: ui.node_by_id(n, 'ledger-import') is not None, 'App did not start')
        assert not ui.rows(initial), 'Use a dedicated empty test ledger; refusing existing visible entries'
        ui.balance('0.00')

        nodes = pick_file('synthetic-wechat-large.csv')
        assert contains(nodes, '已选 300') and contains(nodes, '369.00'), 'Large UTF-8 CSV counts/amount mismatch'
        checkpoint('Real system picker reads UTF-8 CSV larger than 64 KiB', 'import-large-preview.png')
        ui.click('import-confirm')
        ui.balance('-369.00')
        nodes = pick_file('synthetic-wechat-large.csv')
        assert contains(nodes, '已存在 300') and contains(nodes, '导入已选 0 笔'), 'Reimport was not fully deduplicated'
        checkpoint('Repeated 300-row import is recognized and not selected', 'import-large-duplicates.png')
        close_preview()
        undo()
        assert not ui.rows(ui.balance('0.00'))
        checkpoint('Batch undo restores empty ledger after large import', 'import-large-undone.png')

        nodes = pick_file('synthetic-alipay-gbk.csv')
        assert contains(nodes, '已选 2') and contains(nodes, '30.50') and contains(nodes, '10.25'), 'GBK decoding mismatch'
        ui.click('import-confirm')
        ui.balance('20.25')
        checkpoint('GBK Alipay file imports exact income and expense', 'import-gbk.png')
        undo()

        nodes = pick_file('synthetic-wechat-deflated.xlsx')
        assert contains(nodes, '已选 2') and contains(nodes, '000092320260910000000000001'), 'XLSX identity/date decoding failed'
        ui.click('import-confirm')
        nodes = ui.balance('187.70')
        expense = next(row for row in ui.rows(nodes) if contains(ui.flatten(row), '12.30'))
        ui.click(expense['id'])
        ui.fill('ledger-amount', '12.50', 'down')
        ui.click('ledger-save')
        ui.balance('187.50')
        nodes = pick_file('synthetic-wechat-deflated.xlsx')
        assert contains(nodes, '需核对 1') and contains(nodes, '已存在 1') and contains(nodes, '导入已选 0 笔'), 'Edited import identity was lost'
        checkpoint('Native DEFLATE XLSX preserves long IDs and blocks conflicts after editing', 'import-xlsx-conflict.png')
        close_preview()
        ui.fill('ledger-amount', '5', 'down')
        ui.fill('ledger-note', 'YIBI_TEST_IMPORT_SURVIVOR')
        ui.click('ledger-save')
        ui.balance('182.50')
        undo('-5.00')
        nodes = ui.balance('-5.00')
        assert len(ui.rows(nodes)) == 1 and contains(nodes, 'YIBI_TEST_IMPORT_SURVIVOR')
        checkpoint('Undo removes edited batch entries but retains later manual entry', 'import-undo-preserves-manual.png')
        ui.click(ui.record('YIBI_TEST_IMPORT_SURVIVOR')['id'])
        ui.click('ledger-delete')
        ui.click_text('删除账单')
        assert not ui.rows(ui.balance('0.00'))

        ui.click('ledger-receipt', 'down')
        text_input('receipt-text', '支付成功\n¥ 9.80\n商户名称：YIBI_TEST_COFFEE\n交易时间：2026-09-10 12:30:00')
        ui.click('receipt-use')
        ui.wait_for(lambda n: ui.node_by_id(n, 'ledger-amount') is not None, 'Receipt did not create draft')
        ui.click('ledger-save')
        assert contains(ui.layout(), '请明确选择收入或支出'), 'Receipt was saved without explicit acknowledgement'
        ui.click('receipt-acknowledge')
        ui.click('ledger-save')
        ui.balance('-9.80')
        checkpoint('Receipt text is only a draft until fields are explicitly acknowledged', 'receipt-confirmed.png')
        ui.click(ui.record('YIBI_TEST_COFFEE')['id'])
        ui.click('ledger-delete')
        ui.click_text('删除账单')
        assert not ui.rows(ui.balance('0.00'))
        checkpoint('All acceptance fixtures removed from ledger', 'import-final-empty.png')
        report = {'passed': len(stages), 'stages': stages, 'device': info, 'testFixturesRemoved': True,
                  'nativeImageOcr': 'not_supported_on_emulator', 'physicalPhoneTested': False}
        (ui.RUN_DIR / 'native-import-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False), flush=True)
    finally:
        ui.hdc('shell', 'power-shell', 'timeout', '-r')


if __name__ == '__main__':
    main()
