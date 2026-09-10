"""Acceptance checks on the dedicated YibiFoldable emulator via official tools.

Requires a running, unlocked emulator and installed current HAP. Refuses an
existing nonempty ledger and only deletes fixtures created by this test run.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
DEVECO = REPO_ROOT / 'scripts/deveco.py'
ARTIFACTS = Path(os.environ.get('YIBI_NATIVE_ARTIFACTS', str(ROOT / 'artifacts/native'))).resolve()
RUN_NAME = time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid())
RUN_DIR = ARTIFACTS / 'runs' / RUN_NAME
DEVICE = os.environ.get('YIBI_DEVICE', '127.0.0.1:5555')
EMULATOR = os.environ.get('YIBI_EMULATOR', 'YibiFoldable')
# Read the actual app configuration rather than embedding a personal bundle name.
BUNDLE_MATCH = re.search(r'"bundleName"\s*:\s*"([^"\n]+)"',
                         (ROOT / 'AppScope/app.json5').read_text(encoding='utf-8'))
if not BUNDLE_MATCH:
    raise RuntimeError('AppScope/app.json5 must declare bundleName')
BUNDLE = os.environ.get('YIBI_BUNDLE_ID', BUNDLE_MATCH.group(1))
PREFIX = 'YIBI_TEST_' + RUN_NAME + '_'
ENV = os.environ.copy()
stages = []
emulator_info = {}


def run(args):
    result = subprocess.run([str(x) for x in args], cwd=ROOT, env=ENV,
                            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90)
    if result.returncode:
        raise RuntimeError((result.stdout + result.stderr)[-3000:])
    return result.stdout


def cli(*args):
    return run([sys.executable, DEVECO, 'yibi-ledger', *args])


def hdc(*args):
    return cli('hdc', '-t', DEVICE, *args)


def ensure_emulator_target():
    """Refuse physical devices or an emulator other than the named test target."""
    if not DEVECO.is_file():
        raise RuntimeError(f'Missing repository DevEco launcher: {DEVECO}')
    candidates = json.loads(cli('emulator', 'list', '--format', 'json'))
    if not isinstance(candidates, list):
        raise RuntimeError('Expected a JSON array from emulator list')
    target = next((item for item in candidates if isinstance(item, dict)
                   and item.get('name') == EMULATOR
                   and item.get('status') == 'running'
                   and item.get('serial') == DEVICE), None)
    if target is None:
        raise RuntimeError(f'Refusing UI input: no running emulator named {EMULATOR!r} '
                           f'has serial {DEVICE!r}. Set YIBI_EMULATOR and YIBI_DEVICE as needed.')
    if target.get('deviceType') != 'foldable':
        raise RuntimeError('Native fold/unfold acceptance requires a foldable emulator')
    return target


def flatten(node):
    if isinstance(node, list):
        return [item for child in node for item in flatten(child)]
    return [node] + flatten(node.get('children', []))


def layout():
    for _ in range(5):
        raw = cli('ui', 'layout', '--device', DEVICE, '--format', 'json')
        tree = json.loads(raw)
        nodes = flatten(tree)
        (RUN_DIR / 'latest-test-layout.json').write_text(json.dumps(tree, ensure_ascii=False, indent=2), encoding='utf-8')
        if nodes and nodes[0].get('bounds', [0, 0, 0, 0])[2] > 0:
            return nodes
        time.sleep(.3)
    raise AssertionError('Emulator returned an empty display tree repeatedly')


def normalize(value):
    return re.sub(r'\s+', '', value).replace('−', '-')


def wait_for(predicate, description):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        nodes = layout()
        if predicate(nodes):
            return nodes
        time.sleep(.3)
    raise AssertionError(description)


def node_by_id(nodes, identifier):
    return next((node for node in nodes if node.get('id') == identifier), None)


def get_visible(identifier, direction='up'):
    for _ in range(4):
        nodes = layout()
        target = node_by_id(nodes, identifier)
        width, height = nodes[0]['bounds'][2:]
        if target:
            left, top, right, bottom = target['bounds']
            if 0 <= left < right <= width and 125 < top < bottom < height - 60:
                return target
        x = int(width * (.76 if width > 1500 else .5))
        start, end = int(height * .73), int(height * .34)
        if direction == 'down':
            start, end = end, start
        cli('ui', 'swipe', str(x), str(start), str(x), str(end), '--device', DEVICE, '--speed', '1300')
    raise AssertionError(f'Control is not visible: {identifier}')


def click(identifier, direction='up'):
    get_visible(identifier, direction)
    cli('ui', 'click', '--device', DEVICE, '--id', identifier)


def click_text(text):
    nodes = wait_for(lambda nodes: any(node.get('text') == text for node in nodes), f'Missing text: {text}')
    target = next(node for node in nodes if node.get('text') == text)
    left, top, right, bottom = target['bounds']
    cli('ui', 'click', str((left + right)//2), str((top + bottom)//2), '--device', DEVICE)


def fill(identifier, value, direction='up'):
    current = get_visible(identifier, direction).get('text', '')
    if current:
        click(identifier, direction)
        # Normal End + Backspace editing; avoid the emulator's Control-key path.
        hdc('shell', 'uitest', 'uiInput', 'keyEvent', '2082')
        for _ in range(len(current)):
            hdc('shell', 'uitest', 'uiInput', 'keyEvent', '2055')
        wait_for(lambda nodes: node_by_id(nodes, identifier) is not None and
                 node_by_id(nodes, identifier).get('text', '') == '', 'Backspace did not clear the input')
    cli('ui', 'text', value, '--device', DEVICE, '--id', identifier)
    wait_for(lambda nodes: node_by_id(nodes, identifier) is not None and
             node_by_id(nodes, identifier).get('text') == value, f'Input did not match: {identifier}')
    hdc('shell', 'uitest', 'uiInput', 'keyEvent', '2')
    after_back = layout()
    if any(node.get('text') == '继续编辑' for node in after_back):
        click_text('继续编辑')


def rows(nodes):
    return [node for node in nodes if node.get('id', '').startswith('entry-')]


def balance(value):
    return wait_for(lambda nodes: any(normalize(node.get('text', '')) == '¥' + value for node in nodes),
                    f'Expected balance {value}')


def record(note):
    nodes = layout()
    return next(node for node in rows(nodes) if any(child.get('text') == note for child in flatten(node)))


def checkpoint(name, screenshot):
    cli('ui', 'screenshot', '--device', DEVICE, '--path', str(RUN_DIR / screenshot))
    stages.append(name)
    print('PASS:', name, flush=True)
    (RUN_DIR / 'native-test-progress.json').write_text(json.dumps({'stages': stages}, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    # Normal wake + swipe only; never disable the guest's lock or developer mode.
    hdc('shell', 'power-shell', 'wakeup')
    screen = layout()[0]['bounds']
    cli('ui', 'swipe', str(screen[2]//2), str(int(screen[3]*.85)), str(screen[2]//2),
        str(int(screen[3]*.25)), '--device', DEVICE, '--speed', '1300')
    hdc('shell', 'aa', 'force-stop', BUNDLE)
    hdc('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', BUNDLE, '-m', 'entry')
    initial = wait_for(lambda nodes: node_by_id(nodes, 'ledger-amount') is not None,
                       'Unfolded device must show the two-column editor after app launch')
    assert not rows(initial), 'Refusing to modify a nonempty ledger'
    balance('0.00')
    checkpoint('Empty ledger and native unfolded two-column layout', 'native-unfolded-empty.png')

    fill('ledger-amount', '36.50', 'down')
    fill('ledger-note', PREFIX + 'LUNCH')
    click('ledger-save')
    assert len(rows(balance('-36.50'))) == 1
    click('type-income', 'down')
    fill('ledger-amount', '100', 'down')
    fill('ledger-note', PREFIX + 'INCOME')
    click('ledger-save')
    assert len(rows(balance('63.50'))) == 2
    checkpoint('Real native expense/income persistence and exact balance', 'native-two-records.png')

    click(record(PREFIX + 'LUNCH')['id'])
    fill('ledger-amount', '40.20', 'down')
    click('ledger-save')
    assert len(rows(balance('59.80'))) == 2
    click_text('统计')
    wait_for(lambda nodes: any('40.20' in node.get('text', '') for node in nodes) and
             any(node.get('text') == '100.0%' for node in nodes), 'Expense category totals mismatch')
    checkpoint('Edit updates one record and native category statistics', 'native-statistics.png')
    click_text('账单')
    click('month-previous', 'down')
    assert len(rows(balance('0.00'))) == 0
    click('month-next', 'down')
    assert len(rows(balance('59.80'))) == 2

    hdc('shell', 'aa', 'force-stop', BUNDLE)
    hdc('shell', 'aa', 'start', '-a', 'EntryAbility', '-b', BUNDLE, '-m', 'entry')
    assert len(rows(balance('59.80'))) == 2
    checkpoint('Month filtering and process restart retain exact ledger data', 'native-after-restart.png')

    cli('emulator', 'fold', 'close', '--target', EMULATOR)
    wait_for(lambda nodes: node_by_id(nodes, 'ledger-add') is not None, 'Folded layout missing add button')
    checkpoint('Native folded-screen layout', 'native-folded.png')
    click('ledger-add')
    fill('ledger-amount', '12.80', 'down')
    cli('emulator', 'fold', 'open', '--target', EMULATOR)
    wait_for(lambda nodes: node_by_id(nodes, 'ledger-amount') is not None and
             node_by_id(nodes, 'ledger-amount').get('text') == '12.80', 'Draft lost when unfolding')
    checkpoint('Draft retained when unfolding', 'native-unfolded-draft.png')
    cli('emulator', 'fold', 'close', '--target', EMULATOR)
    wait_for(lambda nodes: node_by_id(nodes, 'ledger-amount') is not None and
             node_by_id(nodes, 'ledger-amount').get('text') == '12.80', 'Draft lost when folding')
    click_text('关闭')
    click_text('放弃编辑')
    cli('emulator', 'fold', 'open', '--target', EMULATOR)
    assert len(rows(balance('59.80'))) == 2
    checkpoint('Folded draft can be safely discarded without adding a bill', 'native-draft-discarded.png')

    for note in [PREFIX + 'INCOME', PREFIX + 'LUNCH']:
        target = record(note)
        click(target['id'])
        click('ledger-delete')
        click_text('删除账单')
        wait_for(lambda nodes: all(node.get('id') != target['id'] for node in rows(nodes)), 'Deletion failed')
    assert not rows(balance('0.00'))
    checkpoint('Confirmed deletion removes only test fixtures and restores empty ledger', 'native-final-empty.png')
    report = {'passed': len(stages), 'stages': stages, 'device': emulator_info,
              'physicalPhoneTested': False, 'testFixturesRemoved': True, 'artifactDirectory': str(RUN_DIR)}
    (RUN_DIR / 'native-ui-test-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    emulator_info = ensure_emulator_target()
    RUN_DIR.mkdir(parents=True, exist_ok=False)
    print(f'Native artifacts: {RUN_DIR}', flush=True)
    try:
        hdc('shell', 'power-shell', 'timeout', '-o', '1800000')
        cli('emulator', 'fold', 'open', '--target', EMULATOR)
        main()
    finally:
        # Always restore the guest's normal display timeout, including failures.
        hdc('shell', 'power-shell', 'timeout', '-r')
