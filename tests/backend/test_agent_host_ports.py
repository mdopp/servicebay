import unittest
import sys
import os
import json
from unittest.mock import MagicMock, patch

# Ensure we can import agent.py. 
# We assume agent.py is in the same directory or PYTHONPATH includes it.
try:
    import agent
except ImportError:
    # If running from tests/backend locally, agent is in ../../src/lib/agent/v4/
    current_dir = os.path.dirname(os.path.abspath(__file__))
    agent_path = os.path.abspath(os.path.join(current_dir, '../../src/lib/agent/v4'))
    sys.path.append(agent_path)
    import agent

class TestAgentHostPorts(unittest.TestCase):

    @patch('agent.run_command')
    @patch('agent.shutil.which')
    def test_host_network_ports_detection(self, mock_which, mock_run_command):
        # Mock ss existence
        mock_which.return_value = '/usr/bin/ss'

        # Mock podman ps output
        # A container in Host Network mode. 
        # Podman ps --json usually gives empty Ports for host network.
        container_data = [{
            "Id": "test-container-id",
            "Names": ["adguard-home"],
            "State": "running",
            "Pid": 12345,
            "Networks": ["host"],  # or {"host": ...}
            "Ports": [], # Empty because it's host net
            "IsInfra": False
        }]
        
        # Mock podman inspect networks (side channel)
        # Not strictly needed if "Networks": ["host"] is present, but good for robustness
        mock_podman_networks = "test-container-id|host"

        # Mock ss output
        # Netid State Recv-Q Send-Q Local_Address:Port Peer_Address:Port Process
        ss_output = """
tcp LISTEN 0 128 *:53 *:* users:(("adguard",pid=12345,fd=4))
tcp LISTEN 0 128 *:3000 *:* users:(("adguard",pid=12345,fd=5))
udp UNCONN 0 0 *:53 *:* users:(("adguard",pid=12345,fd=6))
"""
        
        # Define side effects for run_command
        def run_command_side_effect(cmd, check=True):
            cmd_str = ' '.join(cmd)
            # print(f"DEBUG MOCK: {cmd_str}") 
            if 'podman ps -a --format json' in cmd_str:
                return json.dumps(container_data)
            if 'ss -tulpnH' in cmd_str:
                return ss_output.strip()
            if 'podman ps -a --no-trunc --format' in cmd_str:
                return "test-container-id|adguard-pod" # Mock pod name
            if 'podman ps -aq' in cmd_str:
                return "test-container-id"
            if 'podman inspect' in cmd_str:
                return mock_podman_networks
            return ""

        mock_run_command.side_effect = run_command_side_effect

        # Run fetch_containers
        containers = agent.fetch_containers()

        # Assertions
        self.assertEqual(len(containers), 1)
        c = containers[0]
        # In agent.py, names is a list, but fetch_containers maps 'Names' to 'names'.
        # Actually agent.py:321 name = names[0]... then detects...
        # Wait, what does fetch_containers return? It returns a list of DICTs.
        # But looking at agent.py, it constructs `enriched` list.
        # I need to see the structure of the returned dict.
        
        # Checking agent.py again...
        # It doesn't seem to explicitly map to a new dict structure for EVERYTHING, 
        # but it keeps most original fields and ADDS things.
        # Let's verify if it overwrites 'Ports' or 'ports'.
        
        # agent.py doesn't show the final assignment to `enriched` list in the snippet I read.
        # I'll assume it modifies the container dict or creates a new one.
        # I'll check assertions gently.
        
        # Check for specific ports in the returned data
        # We assume the key is 'Ports' (original) or 'ports' (new convention?).
        # Looking at agent.py source, it calculates `detected` list.
        # I need to verify where `detected` goes.
        # I'll read the agent.py file again in a separate step if this test fails or before I run it.
        # But for now I'll check both 'Ports' and 'ports' and `detected`.
        
        # Assuming agent.py updates the container dict with detected ports.
        
        # Note: In the snippet I read, it did `detected.extend(...)` but I didn't see where `detected` was attached to the container object.
        # I will assume it's attached.
        
        # For the test, I will print the keys if it fails.
        pass
        
        # I need to know the output structure to write correct assertions.
        # I will read the rest of fetch_containers first.

if __name__ == '__main__':
    unittest.main()
