"""Run the official DevEco CLI for an app from its portable native mirror."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

from native_project import ROOT, prepare


def environment():
    env = os.environ.copy()
    for key, value in {
        'DEVECO_CLI_DISABLE_TELEMETRY': '1',
        'DEVECO_CLI_DISABLE_UPDATE': 'all',
        'DEVECO_CLI_DATA_DIR': str(ROOT / '.tools' / 'deveco-data'),
    }.items():
        env.setdefault(key, value)
    if not env.get('DEVECO_CLI_STUDIO_PATH') and not env.get('DEVECO_CLI_CLT_PATH'):
        candidates = [Path('/Applications/DevEco-Studio.app'),
                      Path('/Applications/DevEco Studio.app'),
                      Path.home() / 'Applications/DevEco-Studio.app',
                      Path.home() / 'Applications/DevEco Studio.app']
        for candidate in candidates:
            if candidate.is_dir():
                env['DEVECO_CLI_STUDIO_PATH'] = str(candidate)
                break
    return env


def executable(name, env):
    candidates = []
    explicit_key = 'HDC_BIN' if name == 'hdc' else 'DEVECO_CLI_BIN'
    if env.get(explicit_key):
        explicit = Path(env[explicit_key]).expanduser()
        if not explicit.is_file() or not os.access(explicit, os.X_OK):
            raise ValueError(f'{explicit_key} does not point to an executable file: {explicit}')
        return str(explicit.absolute())
    if name == 'hdc':
        if env.get('DEVECO_CLI_STUDIO_PATH'):
            studio = Path(env['DEVECO_CLI_STUDIO_PATH'])
            if (studio / 'Contents').is_dir():
                studio /= 'Contents'
            candidates.append(studio / 'sdk/default/openharmony/toolchains/hdc')
    else:
        candidates.append(ROOT / '.tools/deveco/node_modules/.bin/devecocli')
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.absolute())
    found = shutil.which(name, path=env.get('PATH'))
    if found:
        return found
    raise ValueError(f'{name} not found. See apps/yibi-ledger/docs/INSTALL.md for tool setup.')


def main():
    if len(sys.argv) < 3:
        print('Usage: python3 scripts/deveco.py <app-id> <CLI command...>\n'
              '       python3 scripts/deveco.py <app-id> hdc <HDC arguments...>', file=sys.stderr)
        return 2
    try:
        env = environment()
        command = sys.argv[2:]
        name = 'hdc' if command[0] == 'hdc' else 'devecocli'
        binary = executable(name, env)
        if name == 'hdc':
            command = command[1:]
        project = prepare(sys.argv[1])
        return subprocess.run([binary, *command], cwd=project, env=env).returncode
    except (ValueError, OSError, KeyError) as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
