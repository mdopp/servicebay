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
                "unit": "nginx.service",
                "active": "active",
                "sub": "running",
                "load": "loaded",
                "description": "Nginx Web Server"
            }
        ])
        mock_run_command.return_value = mock_output

        # Mock ~/.config/containers/systemd existence
        with patch('glob.glob', return_value=['/home/user/.config/containers/systemd/nginx.kube']):
             with patch('os.path.exists', return_value=True):
                 with patch('os.path.isfile', return_value=True):
                    services = agent.fetch_services()

        self.assertEqual(len(services), 1)
        self.assertEqual(services[0]['name'], "nginx")

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
        a.state['proxyRoutes'] = []
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
        a.state['proxyRoutes'] = initial_proxy
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
            if args[0] == 'SYNC_PARTIAL' and 'proxyRoutes' in args[1]:
                proxy_pushes += 1
        
        # To "find the bug", we assert that it should confirm deduplication works (0 pushes).
        # Since the code is currently broken, this assert will RAISE AssertionError, proving the bug.
        self.assertEqual(proxy_pushes, 0, "Bug Found: Proxy state pushed despite no changes!")

    @patch('agent.log_debug')
    @patch('sys.stderr')
    @patch('subprocess.check_call')
    @patch('subprocess.run')
    @patch('agent.run_command')
    def test_fetch_proxy_routes_silence(self, mock_run_cmd, mock_sub_run, mock_sub_check_call, mock_stderr, mock_log_debug):
        # Setup mocks to return valid proxy routes
        mock_run_cmd.return_value = "nginx-proxy" # found container

        # fetch_proxy_routes calls subprocess.check_call to `podman cp` the
        # inspector script into the nginx container before running it. The
        # original test only patched subprocess.run, so check_call escaped
        # to the real podman and the surrounding try/except swallowed the
        # FileNotFoundError, returning []. Stub check_call to a no-op too.
        mock_sub_check_call.return_value = 0

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

class TestDnsResolvers(unittest.TestCase):
    """#1676 — read the box's effective DNS resolvers for the System health
    Networks section. The agent reports the raw IP list; labelling + the
    public-resolver warning live frontend-side."""

    def test_parse_resolvectl_global_and_link(self):
        text = (
            "Global\n"
            "         Protocols: -LLMNR\n"
            "       DNS Servers: 127.0.0.1\n"
            "Link 2 (eth0)\n"
            "    Current Scopes: DNS\n"
            "       DNS Servers: 192.168.178.1 8.8.8.8\n"
        )
        self.assertEqual(
            agent.parse_resolvectl_servers(text),
            ['127.0.0.1', '192.168.178.1', '8.8.8.8'],
        )

    def test_parse_resolvectl_continuation_and_dedupe(self):
        text = (
            "       DNS Servers: 192.168.178.1\n"
            "                    8.8.8.8\n"
            "                    192.168.178.1\n"  # dup, dropped
            "    Fallback DNS Servers: 1.1.1.1\n"  # a labelled line, not a continuation
        )
        servers = agent.parse_resolvectl_servers(text)
        self.assertEqual(servers[0], '192.168.178.1')
        self.assertIn('8.8.8.8', servers)
        # 192.168.178.1 appears once only
        self.assertEqual(servers.count('192.168.178.1'), 1)

    def test_parse_resolvectl_strips_iface_scope(self):
        self.assertEqual(
            agent.parse_resolvectl_servers('       DNS Servers: fe80::1%eth0\n'),
            ['fe80::1'],
        )

    def test_parse_resolv_conf(self):
        text = (
            "# generated\n"
            "; comment\n"
            "nameserver 192.168.178.1\n"
            "nameserver 8.8.8.8\n"
            "search lan\n"
        )
        self.assertEqual(agent.parse_resolv_conf(text), ['192.168.178.1', '8.8.8.8'])

    def test_get_dns_resolvers_prefers_resolvectl(self):
        with patch.object(agent, '_executor') as mock_exec:
            mock_exec.execute.return_value = ('       DNS Servers: 127.0.0.1\n', '', 0)
            result = agent.get_dns_resolvers()
        self.assertEqual(result, {'servers': ['127.0.0.1'], 'source': 'resolvectl'})

    def test_get_dns_resolvers_falls_back_to_resolv_conf(self):
        def fake_execute(cmd, check=True):
            if cmd[0] == 'resolvectl':
                return ('', 'not found', 1)
            return ('nameserver 192.168.178.1\n', '', 0)
        with patch.object(agent, '_executor') as mock_exec:
            mock_exec.execute.side_effect = fake_execute
            result = agent.get_dns_resolvers()
        self.assertEqual(result, {'servers': ['192.168.178.1'], 'source': 'resolv.conf'})

    def test_get_dns_resolvers_unknown_when_nothing_readable(self):
        with patch.object(agent, '_executor') as mock_exec:
            mock_exec.execute.return_value = ('', 'err', 1)
            result = agent.get_dns_resolvers()
        self.assertEqual(result, {'servers': [], 'source': 'unknown'})

    def test_disk_import_binaries_on_safe_exec_allowlist(self):
        # #1694 host-side mount + apply uses these via safe_exec (argv is
        # assembled + validated TS-side in diskImport/mounter.ts + plan.ts).
        for binary in ('lsblk', 'mount', 'umount', 'rsync', 'chown'):
            self.assertIn(binary, agent.SAFE_EXEC_ALLOWLIST)

    def test_safe_exec_allowlist_stays_minimal(self):
        # Guard against speculative additions: the allow-list is binary-only,
        # so every entry is a real consumer. `bash`/`sh` must never be on it
        # (that would defeat the structured-argv hardening).
        for shell in ('bash', 'sh', 'zsh', 'eval'):
            self.assertNotIn(shell, agent.SAFE_EXEC_ALLOWLIST)

    # ---- safe_exec opt-in sudo (#1713) ----

    def _run_safe_exec(self, argv, sudo=None):
        """Drive the safe_exec branch of handle_command with a mocked executor
        and capture (the argv actually executed, the reply dict)."""
        import threading
        inst = agent.Agent.__new__(agent.Agent)
        inst.io_lock = threading.Lock()

        captured = {}

        def fake_execute(run_argv, check=False, timeout=None, stdin_data=None):
            captured['argv'] = run_argv
            return ('out', '', 0)

        payload = {'argv': argv}
        if sudo is not None:
            payload['sudo'] = sudo
        msg = {'action': 'safe_exec', 'id': 'req-1', 'payload': payload}

        replies = []
        real_dumps = json.dumps

        class _CapStdout:
            def write(self, s):
                # handle_command writes `json + "\0"`.
                for chunk in s.split('\0'):
                    if chunk:
                        replies.append(real_dumps and json.loads(chunk))
            def flush(self):
                pass

        with patch.object(agent._executor, 'execute', side_effect=fake_execute), \
             patch('agent.sys.stdout', _CapStdout()):
            inst.handle_command(msg)

        reply = replies[-1]['payload'] if replies else {}
        return captured.get('argv'), reply

    def test_safe_exec_default_is_unprivileged(self):
        # No `sudo` flag → run the argv verbatim, no `sudo -n` prepended.
        run_argv, reply = self._run_safe_exec(['lsblk', '-J'])
        self.assertEqual(run_argv, ['lsblk', '-J'])
        self.assertIsNone(reply.get('error'))
        self.assertEqual(reply['result']['code'], 0)

    def test_safe_exec_sudo_false_is_unprivileged(self):
        run_argv, _ = self._run_safe_exec(['lsblk', '-J'], sudo=False)
        self.assertEqual(run_argv, ['lsblk', '-J'])

    def test_safe_exec_sudo_true_prepends_sudo_n(self):
        # Opt-in privilege mirrors the write_file branch: `sudo -n <argv>`.
        run_argv, reply = self._run_safe_exec(['mount', '-o', 'ro', '/dev/sda1', '/run/servicebay/disk-import/sda1'], sudo=True)
        self.assertEqual(run_argv[:2], ['sudo', '-n'])
        self.assertEqual(run_argv[2:], ['mount', '-o', 'ro', '/dev/sda1', '/run/servicebay/disk-import/sda1'])
        self.assertIsNone(reply.get('error'))

    def test_safe_exec_sudo_still_enforces_allowlist_on_real_binary(self):
        # Escalation can't smuggle an un-allow-listed binary: argv[0] (the real
        # binary, not `sudo`) is still checked against SAFE_EXEC_ALLOWLIST.
        run_argv, reply = self._run_safe_exec(['rm', '-rf', '/'], sudo=True)
        # 'rm' is allow-listed, so it runs — proving the check is on argv[0]
        # and sudo is wrapped around it, not bypassing the list.
        self.assertEqual(run_argv[:2], ['sudo', '-n'])
        # An un-allow-listed binary is rejected even with sudo:true.
        run_argv2, reply2 = self._run_safe_exec(['dd', 'if=/dev/zero'], sudo=True)
        self.assertIsNone(run_argv2)  # never reached the executor
        self.assertIn('allow-list', reply2.get('error', ''))


if __name__ == '__main__':
    unittest.main()
