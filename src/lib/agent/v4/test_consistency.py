
import unittest
from unittest.mock import patch, MagicMock
import json
import sys
import os

# Add current dir to path to import agent
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Mock shutil.which before importing checking for 'ss'
with patch('shutil.which', return_value='/bin/ss'):
    import agent

class TestAgentDataConsistency(unittest.TestCase):

    @patch('agent.run_command')
    def test_host_network_discrepancy_fix(self, mock_run_command):
        """
        Scenario: 
        - 'podman ps --format json' returns empty Networks: [] (The Bug in Podman 4.9.x)
        - 'podman inspect' returns NetworkMode: host (The Truth)
        
        Expectation:
        - The resulting container object MUST have:
          - isHostNetwork: True
          - networks: ['host'] (Patched list)
        """
        
        # 1. Setup Mock Data
        container_id = "test-cid-123"
        
        # Mock ps json output (Simulating the broken state)
        ps_json_output = [{
            "Id": container_id,
            "Names": ["test-host-container"],
            "Networks": [], # BUG: Empty in Podman 4.9.3 for host net
            "State": "running",
            "Image": "alpine:latest"
        }]
        
        # Mock inspect output (The side-channel fix)
        # Format: {{.Id}}|{{.HostConfig.NetworkMode}}
        inspect_output = f"{container_id}|host\n"
        
        # Mock ps -aq (List IDs)
        ps_ids_output = f"{container_id}\n"
        
        # Router for run_command mocks
        def side_effect(cmd, check=True):
            cmd_str = ' '.join(cmd)
            # Match strict commands used in agent.py
            if 'podman ps -a --format json' in cmd_str:
                return json.dumps(ps_json_output)
            if 'podman ps -aq' in cmd_str:
                return ps_ids_output
            if 'podman inspect' in cmd_str and '{{.Id}}|{{.HostConfig.NetworkMode}}' in cmd_str:
                return inspect_output
            if 'ss -tulpnH' in cmd_str:
                return ""
            if 'podman ps' in cmd_str and '{{.PodName}}' in cmd_str:
                return "" 
            # Default empty for others
            return ""

        mock_run_command.side_effect = side_effect

        # 2. Run
        containers = agent.fetch_containers()

        # 3. Assert
        self.assertEqual(len(containers), 1)
        c = containers[0]
        
        # Verify the Fixes
        self.assertTrue(c.get('isHostNetwork'), "isHostNetwork should be True when inspect reports 'host'")
        self.assertIn('host', c.get('networks'), "networks list should contain 'host' if isHostNetwork is True")
        self.assertEqual(c.get('id'), container_id)

    @patch('agent.run_command')
    def test_pod_name_retrieval(self, mock_run_command):
        """
        Scenario:
        - 'podman ps --format json' returns empty/missing PodName (Podman < 5 issue)
        - 'podman ps --format {{.ID}}|{{.PodName}}' returns the correct name
        """
        container_id = "test-cid-456"
        pod_name = "my-awesome-pod"
        
        ps_json_output = [{
            "Id": container_id,
            "Names": ["pod-container"],
            "PodName": "", # Missing in JSON
            "State": "running"
        }]
        
        # Side channel output
        pod_formatting_output = f"{container_id}|{pod_name}\n"
        
        def side_effect(cmd, check=True):
            cmd_str = ' '.join(cmd)
            if 'podman ps -a --format json' in cmd_str:
                return json.dumps(ps_json_output)
            if 'podman ps' in cmd_str and '{{.ID}}|{{.PodName}}' in cmd_str:
                return pod_formatting_output
            if 'podman ps -aq' in cmd_str:
                 return f"{container_id}\n"
            return "" # Default

        mock_run_command.side_effect = side_effect

        containers = agent.fetch_containers()
        self.assertEqual(len(containers), 1)
        c = containers[0]
        
        self.assertEqual(c.get('podName'), pod_name, "Should resolve PodName from side-channel command")

if __name__ == '__main__':
    unittest.main()
