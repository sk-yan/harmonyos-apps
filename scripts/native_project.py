"""Mirror one native app into an owned ASCII build path for Hvigor.

Generated output is preserved. Edits made in DevEco to mirrored source inputs
must be merged into the repository before another sync can overwrite them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INPUTS = ('AppScope', 'entry', 'hvigor', 'build-profile.json5', 'hvigorfile.ts',
          'oh-package.json5', 'code-linter.json5')
EXCLUDED = {'build', 'oh_modules', '.hvigor', 'node_modules', '.DS_Store'}
MARKER = '.harmonyos-source.json'


def app_source(slug):
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError('App ID must contain lowercase letters, digits and hyphens')
    catalog = json.loads((ROOT / 'apps.json').read_text(encoding='utf-8'))
    if not any(app['id'] == slug and app['path'] == f'apps/{slug}'
               for app in catalog['applications']):
        raise ValueError(f'App is not registered in apps.json: {slug}')
    source = ROOT / 'apps' / slug
    if not source.is_dir() or source.is_symlink():
        raise ValueError(f'App directory is missing or is a symlink: {source}')
    return source.resolve()


def build_directory(source):
    base = Path(os.environ.get('HARMONYOS_BUILD_ROOT',
                              str(Path(tempfile.gettempdir()) / 'harmonyos-apps')))
    digest = hashlib.sha256(str(source.resolve()).encode()).hexdigest()[:16]
    destination = (base / f'{source.name}-{digest}').resolve()
    if not str(destination).isascii():
        raise ValueError('Set HARMONYOS_BUILD_ROOT to an ASCII-only directory')
    return destination


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_target(destination, relative):
    item = Path(relative)
    if item.is_absolute() or '..' in item.parts or relative == MARKER:
        raise ValueError(f'Unsafe native input path: {relative}')
    target = destination / item
    if not target.resolve().is_relative_to(destination.resolve()) or target.is_symlink():
        raise ValueError(f'Native input points outside its owned copy: {relative}')
    return target


def sync_project(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if destination == source or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError('Build mirror and source must be separate directories')
    marker = destination / MARKER
    if destination.exists() and not marker.is_file():
        raise ValueError(f'Refusing to overwrite an unowned directory: {destination}')
    if marker.is_symlink():
        raise ValueError('Refusing a symlinked copy manifest')
    previous = json.loads(marker.read_text(encoding='utf-8')) if marker.exists() else {
        'source': str(source), 'sha256': {}}
    if previous['source'] != str(source):
        raise ValueError('Native mirror belongs to a different source directory')

    current = {}
    for name in INPUTS:
        item = source / name
        if not item.exists():
            raise ValueError(f'Missing native input: {item}')
        if item.is_symlink():
            raise ValueError(f'Symlinked native input is not supported: {item}')
        paths = [item] if item.is_file() else []
        if item.is_dir():
            for directory, directories, files in os.walk(item):
                directories[:] = [entry for entry in directories if entry not in EXCLUDED]
                for entry in directories:
                    if (Path(directory) / entry).is_symlink():
                        raise ValueError(f'Symlinked native directory: {entry}')
                paths.extend(Path(directory) / entry for entry in files if entry not in EXCLUDED)
        for path in paths:
            if path.is_symlink():
                raise ValueError(f'Symlinked native file: {path}')
            current[path.relative_to(source).as_posix()] = path
    checksums = {relative: digest(path) for relative, path in current.items()}

    # Complete all conflict checks before deleting or copying any input.
    for relative, old_hash in previous['sha256'].items():
        target = checked_target(destination, relative)
        if not target.exists():
            raise ValueError(f'Preserving a local deletion in {target}; resolve the mirror change before syncing')
        if target.exists() and (not target.is_file() or
                                digest(target) not in {old_hash, checksums.get(relative)}):
            raise ValueError(f'Preserving DevEco edits in {target}; merge them into the source first')
    for relative in current:
        target = checked_target(destination, relative)
        if target.exists() and (not target.is_file() or
                               relative not in previous['sha256'] and digest(target) != checksums[relative]):
            raise ValueError(f'Preserving an untracked file in the mirror: {target}')

    destination.mkdir(parents=True, exist_ok=True)
    for relative in previous['sha256'].keys() - current.keys():
        target = checked_target(destination, relative)
        if target.is_file():
            target.unlink()
    for relative, path in current.items():
        target = checked_target(destination, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        if digest(target) != checksums[relative]:
            raise ValueError(f'Copy verification failed: {relative}')
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=destination,
                                     prefix='.harmonyos-manifest-', delete=False) as stream:
        temporary = Path(stream.name)
        json.dump({'source': str(source), 'sha256': checksums}, stream, indent=2)
    try:
        temporary.replace(marker)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def prepare(slug):
    source = app_source(slug)
    return sync_project(source, build_directory(source))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', help='App ID in apps.json')
    args = parser.parse_args()
    try:
        print(prepare(args.app))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(2, f'{error}\n')
