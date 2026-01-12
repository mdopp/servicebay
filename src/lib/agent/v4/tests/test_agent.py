import unittest
from unittest.mock import MagicMock, patch, mock_open
import sys
import os
import json

# Add parent directory to path to import agent
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent

class TestAgent(unittest.TestCase):

    @patch('agent.run_command')
    @patch('agent.get_host_ports_map')
    def test_fetch_containers_parsing(self, mock_get_host_ports, mock_run_command):
        # Mock Podman Output
        mock_output = json.dumps([{
            "Id": "12345",
            "Names": ["test-container"],
            "Image": "nginx:latest",
            "State": "running",
            "Status": "Up 2 hours",
            "Ports": [{"hostPort": 8080, "containerPort": 80, "protocol": "tcp"}],
            "Mounts": [],
            "Networks": ["podman"],
            "Pid": 100
        }])
        mock_run_command.return_value = mock_output
        mock_get_host_ports.return_value = {}

        containers = agent.fetch_containers()
        
        self.assertEqual(len(containers), 1)
        self.assertEqual(containers[0]['names'][0], "test-container")
        self.assertEqual(containers[0]['ports'][0]['hostPort'], 8080)

    @patch('agent.run_command')
    def test_fetch_services_parsing(self, mock_run_command):
        # Mock Systemctl Output
        mock_output = json.dumps([
            {
                "unit": "nginx-web.service",
                "active": "active",
                "sub": "running",
                "load": "loaded",
                "description": "Nginx Web Server"
            }
        ])
        mock_run_command.return_value = mock_output

        # Mock ~/.config/containers/systemd existence
        with patch('glob.glob', return_value=['/home/user/.config/containers/systemd/nginx-web.kube']):
             with patch('os.path.exists', return_value=True):
                 with patch('os.path.isfile', return_value=True):
                    services = agent.fetch_services()

        self.assertEqual(len(services), 1)
        self.assertEqual(services[0]['name'], "nginx-web")
        self.assertTrue(services[0]['isReverseProxy'])

    @patch('os.path.isdir')
    def test_get_nginx_config_dirs(self, mock_isdir):
        # Mock isdir to always return True for our test path
        mock_isdir.return_value = True

        # Setup mock container data
        containers = [
            {
                'names': ['nginx-proxy'],
                'labels': {'servicebay.role': 'reverse-proxy'},
                'mounts': [
                    {'Type': 'bind', 'Source': '/host/data', 'Destination': '/etc/nginx'}
                ]
            },
            {
                'names': ['other-container'],
                'mounts': []
            }
        ]
        
        # We need to access the Agent instance method, or if it's static/helper on module
        # In the file, _get_nginx_config_dirs is a method of Agent class.
        agent_instance = agent.Agent()
        
        dirs = agent_instance._get_nginx_config_dirs(containers)
        self.assertIn('/host/data', dirs)

    @patch('agent.fetch_containers')
    @patch('agent.fetch_services')
    @patch('agent.fetch_proxy_routes')
    @patch('agent.fetch_volumes')
    def test_deduplication(self, mock_vol, mock_prox, mock_svc, mock_cont):
        # Setup: Agent with initial state
        a = agent.Agent()
        a.state['containers'] = [{'id': '1'}]
        a.state['services'] = [{'name': 'svc1'}]
        a.state['proxy'] = []
        a.state['volumes'] = []
        
        # Mocks return SAME data
        mock_cont.return_value = [{'id': '1'}]
        mock_svc.return_value = [{'name': 'svc1'}]
        mock_prox.return_value = []
        mock_vol.return_value = []
        
        # Capture push_state
        a.push_state = MagicMock()
        
        # Trigger delayed scan logic directly
        a._perform_delayed_scan()
        
        # Expect NO push calls because data is identical
        a.push_state.assert_not_called()
        
        # Now change data
        mock_cont.return_value = [{'id': '1'}, {'id': '2'}]
        a._perform_delayed_scan()
        
        # Expect push for containers
        a.push_state.assert_called()
        # Verify it only pushed 'containers' container key?
        # The call args are (type, payload). Payload is dict.
        calls = a.push_state.call_args_list
        found_containers = False
        for c in calls:
            args, kwargs = c
            if args[0] == 'SYNC_PARTIAL' and 'containers' in args[1]:
                found_containers = True
        self.assertTrue(found_containers)
        
    @patch('threading.Timer')
    def test_debounce_logic(self, mock_timer):
        a = agent.Agent()
        
        # First event
        a.on_container_event('start')
        self.assertTrue(a.scan_scheduled)
        mock_timer.assert_called_once()
        
        # Reset mock to verify it's NOT called again
        mock_timer.reset_mock()
        
        # Second event immediately
        a.on_container_event('die')
        self.assertTrue(a.scan_scheduled)
        mock_timer.assert_not_called() # Should strictly rely on the existing timer

    @patch('agent.fetch_services')
    @patch('agent.fetch_proxy_routes')
    def test_deduplication_on_file_change(self, mock_fetch_proxy, mock_fetch_services):
        # Scenario: File watcher detects a change
        # But Proxy Routes return SAME data.
        # We expect Agent NOT to push 'proxy' updates.
        
        a = agent.Agent()
        a.push_state = MagicMock()
        
        # Initial State
        initial_proxy = [{"host": "example.com", "targetService": "127.0.0.1:80"}]
        a.state['proxy'] = initial_proxy
        a.state['services'] = []
        # (Files state isn't checked inside _process_file_changes, only updated)
        
        # Mocks
        mock_fetch_services.return_value = []
        # Return Identical Proxy Config
        mock_fetch_proxy.return_value = [{"host": "example.com", "targetService": "127.0.0.1:80"}]
        
        # Call the method
        new_files = {'/tmp/test': {'modified': 200}}
        a._process_file_changes(new_files)
        
        # ASSERT FAIL: The current implementation blindly pushes proxy
        # We expect this test to verify that the bug exists (it SHOULD fail if we assert it shouldn't push)
        
        # Let's count calls to push_state with 'proxy'
        proxy_pushes = 0
        for call in a.push_state.call_args_list:
            args, _ = call
            if args[0] == 'SYNC_PARTIAL' and 'proxy' in args[1]:
                proxy_pushes += 1
        
        # To "find the bug", we assert that it should confirm deduplication works (0 pushes).
        # Since the code is currently broken, this assert will RAISE AssertionError, proving the bug.
        self.assertEqual(proxy_pushes, 0, "Bug Found: Proxy state pushed despite no changes!")

    @patch('agent.log_debug')
    @patch('sys.stderr')
    @patch('subprocess.run')
    @patch('agent.run_command')
    def test_fetch_proxy_routes_silence(self, mock_run_cmd, mock_sub_run, mock_stderr, mock_log_debug):
        # Setup mocks to return valid proxy routes
        mock_run_cmd.return_value = "nginx-proxy" # found container
        
        # Mock exec output
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = '[{"host": "test.com", "targetService": "127.0.0.1:80", "targetPort": 80, "ssl": true}]'
        mock_proc.stderr = ""
        mock_sub_run.return_value = mock_proc
        
        # Enable agent.DEBUG_MODE = False (default)
        original_debug = agent.DEBUG_MODE
        agent.DEBUG_MODE = False
        
        try:
            routes = agent.fetch_proxy_routes()
            
            # Assert correct parsing
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0]['host'], "test.com")
            
            # CRITICAL: Should NOT write "Parsed Nginx Routes" to stderr
            # We iterate over all write calls to find the spammy one
            for call in mock_stderr.write.call_args_list:
                args, _ = call
                msg = args[0]
                if "Parsed Nginx Routes" in msg:
                    self.fail(f"Found spammy log in stderr: {msg}")
                    
        finally:
            agent.DEBUG_MODE = original_debug

if __name__ == '__main__':
    unittest.main()
