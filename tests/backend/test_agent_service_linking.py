import unittest
import sys
import os
import json
from unittest.mock import MagicMock, patch

# Ensure we can import agent.py. 
try:
    import agent
except ImportError:
    current_dir = os.path.dirname(os.path.abspath(__file__))
    agent_path = os.path.abspath(os.path.join(current_dir, '../../src/lib/agent/v4'))
    sys.path.append(agent_path)
    import agent

class TestAgentServiceLinking(unittest.TestCase):

    @patch('agent.run_command')
    @patch('agent.os.path.isfile') # Patch isfile specifically
    @patch('agent.os.path.exists')
    @patch('agent.glob.glob')
    def test_service_inherits_container_ports(self, mock_glob, mock_exists, mock_isfile, mock_run_command):
        # 1. Setup Mock Containers (as returned by fetch_containers)
        # This container HAS ports (simulating the Host Network fix)
        containers = [{
            "id": "cid1",
            "names": ["adguard-home"],
            "ports": [{"host_port": 53, "container_port": 53, "protocol": "tcp"}],
            "podName": "",
            "networks": ["host"]
        }]

        # 2. Setup Mock Systemd Services
        # systemctl list-units output
        service_units = [{
            "unit": "adguard-home.service",
            "active": "active",
            "sub": "running",
            "description": "AdGuard Home"
        }]

        # 3. Setup Mock File Scans
        mock_exists.return_value = True
        mock_isfile.return_value = True
        mock_glob.return_value = ["/home/user/.config/containers/systemd/adguard-home.kube"]

        # 4. Mock run_command for systemctl
        def run_command_side_effect(cmd, check=True):
            cmd_str = ' '.join(cmd)
            if 'systemctl' in cmd_str and 'list-units' in cmd_str:
                return json.dumps(service_units)
            return ""
        
        mock_run_command.side_effect = run_command_side_effect

        # 5. Run fetch_services
        services = agent.fetch_services(containers=containers)

        # 6. Assertions
        # Find the adguard service
        svc = next((s for s in services if s['name'] == 'adguard-home'), None)
        self.assertIsNotNone(svc, "Service 'adguard-home' not found in result")
        
        # Check linkage
        self.assertIn("cid1", svc['associatedContainerIds'], "Service not linked to container ID")
        
        # Check PORTS propagation
        self.assertEqual(len(svc['ports']), 1, "Service should have inherited 1 port")
        self.assertEqual(svc['ports'][0]['host_port'], 53, "Port 53 not found in Service object")


    @patch('agent.run_command')
    @patch('agent.os.path.isfile')
    @patch('agent.os.path.exists')
    @patch('agent.glob.glob')
    def test_service_linking_systemd_generated_name(self, mock_glob, mock_exists, mock_isfile, mock_run_command):
        # Scenario: Quadlet generated name "systemd-nginx-web" for service "nginx-web"
        
        containers = [{
            "id": "cid2",
            "names": ["systemd-nginx-web"], # Generated name
            "ports": [{"host_port": 80, "container_port": 80, "protocol": "tcp"}],
            "podName": "",
            "networks": ["host"]
        }]

        service_units = [{
            "unit": "nginx-web.service",
            "active": "active",
            "sub": "running",
            "description": "Nginx Web"
        }]

        mock_exists.return_value = True
        mock_isfile.return_value = True
        mock_glob.return_value = ["/home/user/.config/containers/systemd/nginx-web.kube"]

        def run_command_side_effect(cmd, check=True):
            if 'systemctl' in ' '.join(cmd): return json.dumps(service_units)
            return ""
        mock_run_command.side_effect = run_command_side_effect

        services = agent.fetch_services(containers=containers)

        svc = next((s for s in services if s['name'] == 'nginx-web'), None)
        self.assertIsNotNone(svc)
        
        # This assertion SHOULD FAIL currently because agent.py only checks exact match
        self.assertIn("cid2", svc['associatedContainerIds'], "Failed to link systemd-generated container name")
        self.assertEqual(len(svc['ports']), 1)

if __name__ == '__main__':
    unittest.main()
