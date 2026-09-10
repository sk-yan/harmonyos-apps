"""Start an isolated local Vite server, run acceptance checks, and stop it.

Install Node dependencies from the repository root and Python dependencies from
tests/requirements.txt first. Chromium is managed by Playwright unless
YIBI_CHROME_PATH names an existing browser executable.
"""
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_ROOT.parents[1]


def stop_server(server):
    if server.poll() is not None:
        return
    if os.name == 'nt':
        # The PID belongs only to the server started by this invocation.
        subprocess.run(['taskkill', '/PID', str(server.pid), '/T', '/F'],
                       capture_output=True, check=False)
    else:
        os.killpg(server.pid, signal.SIGTERM)
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name == 'nt':
            server.kill()
        else:
            os.killpg(server.pid, signal.SIGKILL)
        server.wait(timeout=5)


def main():
    node = shutil.which('node')
    vite = next((root / 'node_modules/vite/bin/vite.js'
                 for root in [APP_ROOT, REPO_ROOT]
                 if (root / 'node_modules/vite/bin/vite.js').is_file()), None)
    if not node or not vite:
        raise RuntimeError('Node.js and Vite are required. Run npm ci from the repository root.')

    # By default choose a free port, so existing development servers remain alone.
    # A requested port must also be free; never test an unrelated running server.
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', int(os.environ.get('YIBI_PREVIEW_PORT', '0'))))
        port = reservation.getsockname()[1]
    url = f'http://127.0.0.1:{port}/'
    run_name = time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid())
    output = Path(os.environ.get('YIBI_PREVIEW_ARTIFACTS',
                                str(APP_ROOT / 'artifacts/preview/runs' / run_name))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    log_path = output / 'vite.log'
    env = dict(os.environ, YIBI_PREVIEW_URL=url, YIBI_PREVIEW_ARTIFACTS=str(output))
    timeout = int(os.environ.get('YIBI_PREVIEW_TIMEOUT', '300'))
    print(f'Preview acceptance: {url}\nArtifacts: {output}', flush=True)

    with log_path.open('w', encoding='utf-8') as log:
        server = subprocess.Popen(
            [node, str(vite), str(APP_ROOT / 'preview'), '--host', '127.0.0.1',
             '--port', str(port), '--strictPort'],
            cwd=APP_ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=os.name != 'nt',
        )
        try:
            deadline = time.monotonic() + 45
            while True:
                if server.poll() is not None:
                    raise RuntimeError(f'Vite exited before it was ready. See {log_path}')
                try:
                    with urlopen(url, timeout=1) as response:
                        if response.status == 200:
                            break
                except (URLError, TimeoutError, ConnectionError):
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'Vite readiness timed out. See {log_path}')
                time.sleep(.15)
            for suite in ['preview_ui_test.py', 'preview_import_test.py']:
                result = subprocess.run(
                    [sys.executable, str(APP_ROOT / 'tests' / suite)],
                    cwd=APP_ROOT, env=env, timeout=timeout, check=False,
                )
                if result.returncode:
                    return result.returncode
            return 0
        finally:
            stop_server(server)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'Preview acceptance failed: {error}', file=sys.stderr)
        sys.exit(1)
