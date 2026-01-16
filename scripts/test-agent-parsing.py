#!/usr/bin/env python3
"""
Integration test for agent Quadlet parsing
Tests the actual file reading and parsing flow
"""

import sys
import os
import json
import tempfile

# Add agent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../src/lib/agent/v4'))

from quadlet_parser import parse_quadlet_file

def test_immich_server_parsing():
    """Test parsing the actual immich-server.container file structure"""
    
    # Create a test file with the exact content you showed
    test_content = """# /etc/containers/systemd/immich-server.container

[Unit]
Description=Immich Server
Requires=immich-redis.service
Requires=immich-database.service
After=immich-redis.service
After=immich-database.service

[Container]
# This container joins the pod defined in immich.pod
Pod=immich.pod
ContainerName=immich_server
Image=ghcr.io/immich-app/immich-server:release
Volume=${UPLOAD_LOCATION}:/data
Volume=/etc/localtime:/etc/localtime:ro
EnvironmentFile=./.env

[Service]
#EnvironmentFile=/home/mdopp/.config/containers/systemd/.env
EnvironmentFile=%h/.config/containers/systemd/.env
Healthcheck=none
Restart=always
"""

    print("="*60)
    print("AGENT QUADLET PARSING INTEGRATION TEST")
    print("="*60)
    print()
    
    print("Test file content:")
    print("-"*60)
    print(test_content)
    print("-"*60)
    print()
    
    # Parse the file
    result = parse_quadlet_file(test_content)
    
    print("Parsed result:")
    print("-"*60)
    print(json.dumps(result, indent=2))
    print("-"*60)
    print()
    
    # Verify the parsing
    print("Verification:")
    print("-"*60)
    
    tests_passed = 0
    tests_failed = 0
    
    # Check requires
    if 'requires' in result and len(result['requires']) == 2:
        print("✅ PASS: Found 2 Requires directives")
        print(f"   Values: {result['requires']}")
        tests_passed += 1
    else:
        print(f"❌ FAIL: Expected 2 Requires, got {len(result.get('requires', []))}")
        print(f"   Values: {result.get('requires', [])}")
        tests_failed += 1
    
    # Check after
    if 'after' in result and len(result['after']) == 2:
        print("✅ PASS: Found 2 After directives")
        print(f"   Values: {result['after']}")
        tests_passed += 1
    else:
        print(f"❌ FAIL: Expected 2 After, got {len(result.get('after', []))}")
        print(f"   Values: {result.get('after', [])}")
        tests_failed += 1
    
    # Check pod
    if 'pod' in result and result['pod'] == 'immich':
        print("✅ PASS: Found Pod directive")
        print(f"   Value: {result['pod']}")
        tests_passed += 1
    else:
        print(f"❌ FAIL: Expected pod='immich', got {result.get('pod')}")
        tests_failed += 1
    
    # Check sourceType
    if result.get('sourceType') == 'container':
        print("✅ PASS: Detected sourceType as 'container'")
        tests_passed += 1
    else:
        print(f"❌ FAIL: Expected sourceType='container', got {result.get('sourceType')}")
        tests_failed += 1
    
    print("-"*60)
    print()
    print(f"Tests passed: {tests_passed}")
    print(f"Tests failed: {tests_failed}")
    print()
    
    if tests_failed > 0:
        print("❌ INTEGRATION TEST FAILED")
        sys.exit(1)
    else:
        print("✅ ALL INTEGRATION TESTS PASSED")
        sys.exit(0)

if __name__ == '__main__':
    test_immich_server_parsing()
