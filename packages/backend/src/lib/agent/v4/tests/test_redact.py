import unittest
import sys
import os

# Import the agent module the same way test_agent.py does.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent  # noqa: E402


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


if __name__ == '__main__':
    unittest.main()
