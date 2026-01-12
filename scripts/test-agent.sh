#!/bin/bash
set -e

# Path to the project root
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DOCKERFILE_PATH="$PROJECT_ROOT/tests/docker/Dockerfile.test-agent"
IMAGE_NAME="servicebay-agent-test"

echo "=== Building Test Agent Image ==="
# Build from project root to allow COPY src/... to work
podman build -t "$IMAGE_NAME" -f "$DOCKERFILE_PATH" "$PROJECT_ROOT"

echo "=== Running Agent Logic Verification ==="
# We mount the agent code and the new test files
podman run --rm \
    --name servicebay-agent-test-run \
    -v "$PROJECT_ROOT/src/lib/agent/v4/agent.py:/home/podmanuser/agent.py:Z" \
    -v "$PROJECT_ROOT/tests/backend/test_agent_host_ports.py:/home/podmanuser/test_agent_ports.py:Z" \
    -v "$PROJECT_ROOT/tests/backend/test_agent_service_linking.py:/home/podmanuser/test_agent_linking.py:Z" \
    "$IMAGE_NAME" \
    bash -c "python3 test_agent_ports.py && echo '---' && python3 test_agent_linking.py"
