---
applyTo: "{src/lib/agent/**/*.py,tests/backend/test_agent_*.py,scripts/test-agent.sh}"
---

# ServiceBay Python Agent Instructions

## Scope
These instructions cover the V4 Python agent that runs inside the Podman-managed node. Follow them whenever touching the agent itself, its Docker-based harness, or the Python tests in `tests/backend/`.

## Prerequisites
- **Rootless Podman 4+** with `podman build` and `podman run` available to your user.
- Ability to run `systemctl --user` on the host (the container image provisions systemd for simulations).
- The following binaries must exist on the host because the test image expects them: `python3`, `procps-ng (ss)`, `iproute`, `systemd`. The Dockerfile `tests/docker/Dockerfile.test-agent` installs them automatically, but they must exist in the registry image you extend.
- Environment variables when running inside a container:
  - `HOST_USER`: rootless username on the host (e.g., output of `whoami`).
  - `HOST_SSH`: hostname/IP for the host (defaults to `host.containers.internal`).
  - `SSH_KEY_PATH`: path to the private key that can log in as `HOST_USER` (default `/root/.ssh/id_rsa`).

## Containerized Test Workflow
1. Run `npm run test:agent`.
2. The script `scripts/test-agent.sh` builds the `servicebay-agent-test` image from `tests/docker/Dockerfile.test-agent` and mounts the working agent plus the entire `tests/backend/` folder into the container.
3. Inside the container we run `python3 -m unittest discover tests/backend 'test_agent_*.py'`, so every file that matches the pattern is executed automatically. Keep new agent tests under `tests/backend/` with the `test_agent_*.py` prefix and they will run without further script changes.
4. Inspect the output directly in your terminal. Errors are emitted with standard unittest formatting.

## Command Validation Procedure
The ServiceBay backend issues the following agent commands. Every change must confirm that each command still works when the agent runs inside the container image described above.

| Command | Required Payload | Expected Result |
| --- | --- | --- |
| `ping` | none | Responds with `pong`.
| `listServices` | none | Returns the cached `services` array.
| `listContainers` | none | Returns the cached `containers` array.
| `refresh` | none | Forces `refresh_all()` and pushes SYNC events.
| `setResourceMode` | `{ "active": bool }` | Toggles high-frequency resource sampling and responds `ok`.
| `exec` | `{ "command": "sh string" }` | Executes via `_executor`, returning `code`, `stdout`, `stderr`.
| `write_file` | `{ "path": "~/.config/...", "content": "..." }` | Writes the file and replies `ok`.
| `read_file` | `{ "path": "..." }` | Returns `{ "content": "..." }`.
| `startMonitoring` | none | Enables resource pushes and responds `ok`.
| `stopMonitoring` | none | Disables resource pushes and responds `ok`.

### Manual Command Matrix (inside container)
Use this snippet while inside the previously built container to run every command end-to-end without needing the backend:

```bash
podman run --rm -it \
  -e HOST_USER="$USER" \
  -e SSH_KEY_PATH="$HOME/.ssh/id_rsa" \
  -v "$(pwd)/src/lib/agent/v4/agent.py:/home/podmanuser/agent.py:Z" \
  servicebay-agent-test bash
```

Once inside:

```bash
python3 - <<'PY'
import json
import agent
from unittest.mock import patch

cmds = [
    {"id": "cmd-ping", "action": "ping"},
    {"id": "cmd-services", "action": "listServices"},
    {"id": "cmd-containers", "action": "listContainers"},
    {"id": "cmd-refresh", "action": "refresh"},
    {"id": "cmd-mode", "action": "setResourceMode", "payload": {"active": True}},
    {"id": "cmd-exec", "action": "exec", "payload": {"command": "podman version"}},
    {"id": "cmd-write", "action": "write_file", "payload": {"path": "~/tmp-test.txt", "content": "hello"}},
    {"id": "cmd-read", "action": "read_file", "payload": {"path": "~/tmp-test.txt"}},
    {"id": "cmd-start", "action": "startMonitoring"},
    {"id": "cmd-stop", "action": "stopMonitoring"},
]

# Patch push_state during manual runs so stdout only contains command responses
with patch.object(agent.Agent, 'push_state', lambda *args, **kwargs: None):
    instance = agent.Agent()
    instance.refresh_all()
    for cmd in cmds:
        instance.handle_command(cmd)
PY
```

The script boots an `Agent`, primes its cache with `refresh_all()`, and iterates through every command. Review stderr for log lines and ensure each response contains either a result or a useful error message.

## Troubleshooting
- Logs written by the containerized agent stream into `data/logs.db`. Query it with `python3 scripts/logs.py --tail` when reproducing issues.
- If `HOST_USER` is missing you will see SSH failures immediately; export it before running the container.
- When Podman socket access fails, verify that your user belongs to the necessary groups (`podman`, `wheel`) on the host.

## Automation
Every staged `*.py` change now triggers `npm run test:agent` through `lint-staged` (executed by `.husky/pre-commit`). Do not bypass the hook unless absolutely necessary; otherwise agent regressions can ship unnoticed.
