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
    -v "$PROJECT_ROOT/tests/backend:/home/podmanuser/tests/backend:Z" \
    "$IMAGE_NAME" \
    bash -c "cd /home/podmanuser && python3 -m unittest discover tests/backend 'test_agent_*.py'"
