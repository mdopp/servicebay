import ast
import io
import json
import unittest
import sys
import os
from contextlib import redirect_stderr

# Import the agent module the same way test_agent.py does.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402

# Obvious placeholders — never a real credential in a committed fixture.
FAKE_SECRET = 'PLACEHOLDER-NOT-A-REAL-SECRET'
FAKE_QUADLET = (
    '[Container]\n'
    'Image=ghcr.io/example/app:1\n'
    'Environment=SSO_CLIENT_SECRET=' + FAKE_SECRET + '\n'
)


def _sync_files_payload():
    """The exact shape push_state('SYNC_PARTIAL', {'files': …}) emits."""
    return {
        'files': {
            '/home/x/.config/containers/systemd/vaultwarden.kube': {
                'path': '/home/x/.config/containers/systemd/vaultwarden.kube',
                'content': FAKE_QUADLET,
                'modified': 1.0,
            },
        },
    }


class TestRedactForLog(unittest.TestCase):
    def test_redacts_write_file_content(self):
        # The rendered pod YAML (with plaintext env secrets) rides in `content`.
        out = agent._redact_for_log({'path': '/x.yml', 'content': 'a' * 500})
        self.assertEqual(out['path'], '/x.yml')
        self.assertEqual(out['content'], '<500 chars redacted>')
        self.assertNotIn('aaaa', str(out))

    def test_masks_secret_keys(self):
        out = agent._redact_for_log({'PUSH_TOKEN': 'abc', 'api_key': 'k', 'name': 'svc'})
        self.assertEqual(out['PUSH_TOKEN'], '***')
        self.assertEqual(out['api_key'], '***')
        self.assertEqual(out['name'], 'svc')

    def test_non_dict_passthrough(self):
        self.assertEqual(agent._redact_for_log('hi'), 'hi')
        self.assertEqual(agent._redact_for_log(None), None)

    def test_redacts_nested_state_sync_content(self):
        # #2603: the same quadlet bytes, one level deeper. A top-level-only
        # redaction walked straight past this.
        out = agent._redact_for_log(_sync_files_payload())
        entry = out['files']['/home/x/.config/containers/systemd/vaultwarden.kube']
        self.assertEqual(entry['content'], f'<{len(FAKE_QUADLET)} chars redacted>')
        self.assertNotIn(FAKE_SECRET, json.dumps(out))

    def test_redacts_inside_lists(self):
        out = agent._redact_for_log({'env': [{'name': 'A', 'API_KEY': 'k'}, {'content': 'zz'}]})
        self.assertEqual(out['env'][0]['API_KEY'], '***')
        self.assertEqual(out['env'][1]['content'], '<2 chars redacted>')

    def test_depth_cap_terminates(self):
        deep = {}
        node = deep
        for _ in range(40):
            node['next'] = {}
            node = node['next']
        node['content'] = FAKE_SECRET
        self.assertNotIn(FAKE_SECRET, json.dumps(agent._redact_for_log(deep)))


class TestLogStructuredIsRedactedAtTheSink(unittest.TestCase):
    """The sink redacts, so no call site can reopen the leak (#1211 -> #2603)."""

    def _capture(self, event, payload):
        buf = io.StringIO()
        with redirect_stderr(buf):
            agent.log_structured(event, payload)
        return buf.getvalue()

    def test_state_sync_files_never_reaches_stderr_verbatim(self):
        emitted = self._capture('SYNC_PARTIAL', _sync_files_payload())
        self.assertNotIn(FAKE_SECRET, emitted)
        self.assertIn('chars redacted', emitted)

    def test_still_emits_parseable_json_with_the_diagnostic_keys(self):
        emitted = self._capture('SYNC_PARTIAL', _sync_files_payload())
        parsed = json.loads(emitted)
        self.assertEqual(parsed['event'], 'SYNC_PARTIAL')
        # The path is what makes the line useful; only the bytes are masked.
        self.assertIn(
            '/home/x/.config/containers/systemd/vaultwarden.kube',
            parsed['payload']['files'],
        )

    def test_secret_looking_top_level_keys_are_masked_too(self):
        emitted = self._capture('SYNC_PARTIAL', {'PUSH_TOKEN': FAKE_SECRET})
        self.assertNotIn(FAKE_SECRET, emitted)


class TestNoUnredactedLogSinkExists(unittest.TestCase):
    """Ratchet: a *fourth* raw stderr writer must not be addable silently.

    #1211 plugged the command path, #2603 found the state-sync path emitting
    the identical payload through a second sink. The structural fix is that
    every stderr writer lives in a redacting helper — this test fails if a new
    one appears anywhere else in agent.py.
    """

    ALLOWED_WRITERS = {'log_message', 'log_structured', '<module>'}

    def test_stderr_writes_only_live_in_sanctioned_helpers(self):
        source = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'agent.py'
        )
        with open(source, 'r') as f:
            tree = ast.parse(f.read())

        def is_stderr_write(func):
            return (
                isinstance(func, ast.Attribute)
                and func.attr == 'write'
                and isinstance(func.value, ast.Attribute)
                and func.value.attr == 'stderr'
                and isinstance(func.value.value, ast.Name)
                and func.value.value.id == 'sys'
            )

        offenders = []

        def visit(node, enclosing):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    visit(child, child.name)
                    continue
                if isinstance(child, ast.Call) and is_stderr_write(child.func):
                    if enclosing not in self.ALLOWED_WRITERS:
                        offenders.append(f'line {child.lineno} in {enclosing}()')
                visit(child, enclosing)

        visit(tree, '<module>')

        self.assertEqual(
            offenders, [],
            'New raw stderr writer(s) outside the redacting helpers: '
            + ', '.join(offenders)
            + '. Route the payload through log_structured()/log_message() '
              'instead of adding a third leak path (#1211, #2603).',
        )

    def test_log_structured_redacts_its_own_payload(self):
        source = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'agent.py'
        )
        with open(source, 'r') as f:
            body = f.read().split('def log_structured(')[1].split('\ndef ')[0]
        self.assertIn('_redact_for_log(payload)', body)


if __name__ == '__main__':
    unittest.main()
