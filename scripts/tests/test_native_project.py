"""Protect source and local signing edits while preparing an ASCII mirror."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_project import INPUTS, MARKER, sync_project


class NativeMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / '应用'
        self.source.mkdir()
        for name in INPUTS:
            (self.source / name).write_text('original', encoding='utf-8')
        self.target = self.base / 'mirror'

    def test_updates_inputs_and_preserves_generated_outputs(self):
        sync_project(self.source, self.target)
        (self.target / 'generated.hap').write_text('output')
        (self.source / 'build-profile.json5').write_text('new')
        sync_project(self.source, self.target)
        self.assertEqual((self.target / 'build-profile.json5').read_text(), 'new')
        self.assertEqual((self.target / 'generated.hap').read_text(), 'output')

    def test_refuses_foreign_directory(self):
        self.target.mkdir()
        with self.assertRaisesRegex(ValueError, 'unowned'):
            sync_project(self.source, self.target)

    def test_preserves_local_signing_edits_before_mutating_any_input(self):
        sync_project(self.source, self.target)
        (self.source / 'AppScope').write_text('new')
        (self.target / 'build-profile.json5').write_text('private signing settings')
        with self.assertRaisesRegex(ValueError, 'Preserving DevEco edits'):
            sync_project(self.source, self.target)
        self.assertEqual((self.target / 'AppScope').read_text(), 'original')
        self.assertEqual((self.target / 'build-profile.json5').read_text(), 'private signing settings')

    def test_refuses_manifest_traversal_without_touching_external_file(self):
        sync_project(self.source, self.target)
        outside = self.base / 'important.txt'
        outside.write_text('keep')
        manifest = json.loads((self.target / MARKER).read_text())
        manifest['sha256']['../important.txt'] = 'untrusted'
        (self.target / MARKER).write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'Unsafe native input'):
            sync_project(self.source, self.target)
        self.assertEqual(outside.read_text(), 'keep')

    def test_refuses_input_symlink(self):
        (self.source / 'AppScope').unlink()
        (self.source / 'AppScope').symlink_to(self.source / 'entry')
        with self.assertRaisesRegex(ValueError, 'Symlinked native input'):
            sync_project(self.source, self.target)

    def test_refuses_other_source_claim(self):
        sync_project(self.source, self.target)
        manifest = json.loads((self.target / MARKER).read_text())
        manifest['source'] = str(self.base / 'elsewhere')
        (self.target / MARKER).write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'different source'):
            sync_project(self.source, self.target)

    def test_preserves_local_deletion(self):
        sync_project(self.source, self.target)
        (self.target / 'build-profile.json5').unlink()
        with self.assertRaisesRegex(ValueError, 'local deletion'):
            sync_project(self.source, self.target)
        self.assertFalse((self.target / 'build-profile.json5').exists())

    def test_manifest_write_does_not_follow_predictable_temporary_symlink(self):
        sync_project(self.source, self.target)
        outside = self.base / 'important.txt'
        outside.write_text('keep')
        (self.target / '.harmonyos-source.tmp').symlink_to(outside)
        sync_project(self.source, self.target)
        self.assertEqual(outside.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
