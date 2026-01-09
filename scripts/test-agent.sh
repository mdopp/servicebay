#!/bin/bash
set -e

# Path to the project root
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
DOCKERFILE_PATH="$PROJECT_ROOT/tests/docker/Dockerfile.test-agent"
IMAGE_NAME="servicebay-agent-test"

echo "=== Building Test Agent Image ==="
# Build from project root to allow COPY src/... to work
podman build -t "$IMAGE_NAME" -f "$DOCKERFILE_PATH" "$PROJECT_ROOT"

echo "=== Running Test Agent Container ==="
# We run in privileged mode (or adequate caps) to allow Podman-in-Podman (Mock)
# We mount the local agent code to allow quick iteration without rebuilds
podman run --rm -ti \
    --name servicebay-agent-test-run \
    --privileged \
    -v "$PROJECT_ROOT/src/lib/agent/v4/agent.py:/home/podmanuser/agent.py:Z" \
    "$IMAGE_NAME" \
    bash -c "python3 agent.py & echo 'Agent PID: $!'; echo 'Waiting for logs...'; sleep 2; podman run --rm hello-world; wait"
