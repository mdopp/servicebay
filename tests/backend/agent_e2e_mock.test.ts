
import { describe, it, expect } from 'vitest';
import { DigitalTwinStore } from '../../src/lib/store/twin';
import { execSync } from 'child_process';
import path from 'path';

describe('End-to-End Agent Data Flow', () => {
    
    it('should correctly parse and store valid Agent JSON output', () => {
        // 1. Run the Agent in "Once" mode to generate JSON
        // We use the same mock script logic as the shell script but executed here?
        // No, we can't easily run python with mocks from here without complex setup.
        // Instead, we will Mock the Output of the Agent Python Script directly 
        // using the EXACT structure we saw in agent.py
        
        // This JSON mimics exactly what agent.py produces (snake_case)
        const agentOutput = {
            "type": "snapshot",
            "payload": {
                "resources": null,
                "containers": [
                    {
                        "id": "cid1",
                        "names": ["/nginx-web"],
                        "ports": [
                            { "host_port": 80, "container_port": 80, "protocol": "tcp" }
                        ],
                        "labels": { "PODMAN_SYSTEMD_UNIT": "nginx-web.service" },
                        "networks": ["host"]
                    }
                ],
                "services": [
                    {
                        "name": "nginx-web",
                        "active": true,
                        "subState": "running",
                        "ports": [
                            { "host_port": 80, "container_port": 80, "protocol": "tcp" }
                        ],
                        "associatedContainerIds": ["cid1"],
                        "isManaged": true
                    }
                ],
                "volumes": [],
                "files": {},
                "timestamp": 123456
            }
        };
        
        // 2. Feed to Store
        const store = DigitalTwinStore.getInstance();
        
        // @ts-ignore
        store.updateNode('E2ENode', agentOutput.payload);
        
        // 3. Verify
        const node = store.nodes['E2ENode'];
        expect(node).toBeDefined();
        
        // Check Service Ports
        const svc = node.services[0];
        // The Store should preserve the snake_case keys if the interface allows it
        // Or if it just stores raw objects.
        expect(svc.ports).toBeDefined();
        expect(svc.ports!.length).toBe(1);
        
        // Robustness check: TS Interface vs Runtime
        // @ts-ignore
        expect(svc.ports![0].host_port).toBe(80);
    });
});
