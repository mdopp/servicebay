import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

try:
    import agent
except ImportError:
    current_dir = os.path.dirname(os.path.abspath(__file__))
    agent_path = os.path.abspath(os.path.join(current_dir, '../../src/lib/agent/v4'))
    sys.path.append(agent_path)
    import agent


class TestAgentCommands(unittest.TestCase):
    def setUp(self):
        self.agent = agent.Agent()
        self.agent.push_state = MagicMock()
        self.stdout = io.StringIO()
        self.stdout_patcher = patch('agent.sys.stdout', new=self.stdout)
        self.stdout_patcher.start()
        self.addCleanup(self.stdout_patcher.stop)

    def _drain_responses(self):
        data = self.stdout.getvalue()
        self.stdout.seek(0)
        self.stdout.truncate(0)
        if not data:
            return []
        chunks = [chunk for chunk in data.split('\0') if chunk]
        return [json.loads(chunk) for chunk in chunks]

    def _dispatch(self, message):
        self.agent.handle_command(message)
        return self._drain_responses()

    def _single_response(self, message):
        responses = self._dispatch(message)
        self.assertEqual(len(responses), 1)
        return responses[0]

    def test_ping_command(self):
        response = self._single_response({'id': 'cmd-ping', 'action': 'ping'})
        self.assertEqual(response['payload']['result'], 'pong')

    def test_list_services_returns_cached_state(self):
        self.agent.state['services'] = [{'name': 'svc'}]
        response = self._single_response({'id': 'cmd-services', 'action': 'listServices'})
        self.assertEqual(response['payload']['result'], {'services': [{'name': 'svc'}]})

    def test_list_containers_returns_cached_state(self):
        self.agent.state['containers'] = [{'id': 'cid'}]
        response = self._single_response({'id': 'cmd-containers', 'action': 'listContainers'})
        self.assertEqual(response['payload']['result'], [{'id': 'cid'}])

    def test_refresh_invokes_refresh_all(self):
        self.agent.refresh_all = MagicMock()
        responses = self._dispatch({'id': 'cmd-refresh', 'action': 'refresh'})
        self.assertEqual(responses, [])
        self.agent.refresh_all.assert_called_once_with()

    def test_set_resource_mode_toggles_flags(self):
        response_on = self._single_response({
            'id': 'cmd-mode-on',
            'action': 'setResourceMode',
            'payload': {'active': True}
        })
        self.assertEqual(response_on['payload']['result'], 'ok')
        self.assertTrue(self.agent.resource_monitoring_high_freq)
        self.assertEqual(self.agent.last_resource_push, 0)

        self.agent.last_resource_push = 42
        response_off = self._single_response({
            'id': 'cmd-mode-off',
            'action': 'setResourceMode',
            'payload': {'active': False}
        })
        self.assertEqual(response_off['payload']['result'], 'ok')
        self.assertFalse(self.agent.resource_monitoring_high_freq)
        self.assertEqual(self.agent.last_resource_push, 42)

    def test_exec_command_runs_via_executor(self):
        mock_executor = MagicMock()
        mock_executor.execute.return_value = ('out', 'err', 5)
        with patch.object(agent, '_executor', mock_executor):
            response = self._single_response({
                'id': 'cmd-exec',
                'action': 'exec',
                'payload': {'command': 'echo test'}
            })
        self.assertEqual(response['payload']['result'], {
            'code': 5,
            'stdout': 'out',
            'stderr': 'err'
        })
        mock_executor.execute.assert_called_once_with(['sh', '-c', 'echo test'], check=False)

    def test_exec_command_missing_payload(self):
        response = self._single_response({'id': 'cmd-exec', 'action': 'exec'})
        self.assertIsNotNone(response['payload']['error'])

    def test_write_file_creates_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, 'sample.txt')
            response = self._single_response({
                'id': 'cmd-write',
                'action': 'write_file',
                'payload': {'path': target, 'content': 'hello'}
            })
            self.assertEqual(response['payload']['result'], 'ok')
            with open(target, 'r') as handle:
                self.assertEqual(handle.read(), 'hello')

    def test_write_file_missing_parameters(self):
        response = self._single_response({
            'id': 'cmd-write',
            'action': 'write_file',
            'payload': {'content': 'missing path'}
        })
        self.assertIn('Missing path', response['payload']['error'])

    def test_read_file_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, 'data.txt')
            with open(target, 'w') as handle:
                handle.write('payload')
            response = self._single_response({
                'id': 'cmd-read',
                'action': 'read_file',
                'payload': {'path': target}
            })
            self.assertEqual(response['payload']['result'], {'content': 'payload'})

    def test_read_file_missing_path(self):
        response = self._single_response({'id': 'cmd-read', 'action': 'read_file'})
        self.assertIn('Missing path', response['payload']['error'])

    def test_read_file_not_found(self):
        missing_path = '/tmp/non-existent-file.txt'
        response = self._single_response({
            'id': 'cmd-read',
            'action': 'read_file',
            'payload': {'path': missing_path}
        })
        self.assertIn('File not found', response['payload']['error'])

    def test_start_monitoring_enables_flag_and_triggers_tick(self):
        class ImmediateThread:
            def __init__(self, target=None, args=(), kwargs=None, **_):
                self.target = target
                self.args = args
                self.kwargs = kwargs or {}

            def start(self):
                if self.target:
                    self.target(*self.args, **self.kwargs)

        with patch('agent.threading.Thread', ImmediateThread):
            with patch.object(self.agent, 'on_resource_tick') as mock_tick:
                response = self._single_response({'id': 'cmd-start', 'action': 'startMonitoring'})
        self.assertEqual(response['payload']['result'], 'ok')
        self.assertTrue(self.agent.monitoring_enabled)
        mock_tick.assert_called_once_with(True)

    def test_stop_monitoring_disables_flag(self):
        self.agent.monitoring_enabled = True
        response = self._single_response({'id': 'cmd-stop', 'action': 'stopMonitoring'})
        self.assertEqual(response['payload']['result'], 'ok')
        self.assertFalse(self.agent.monitoring_enabled)

    def test_unknown_command_returns_error(self):
        response = self._single_response({'id': 'cmd-unknown', 'action': 'doesNotExist'})
        self.assertIn('Unknown command', response['payload']['error'])


if __name__ == '__main__':
    unittest.main()
