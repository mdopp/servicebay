---
title: "Your healthcheck runs a binary the image does not have"
whenToUse: "You are writing a healthcheck or livenessProbe for a service, or a container you just deployed restarts every few minutes, or `podman ps` shows it as (unhealthy)/(starting) while the page it serves answers 200 perfectly well. Also when a deployment was reported healthy and the service keeps recreating itself."
kind: footgun
tags: [healthcheck, livenessProbe, deploy, alpine, restart-loop, verification]
---
# Your healthcheck runs a binary the image does not have

**Answer first:** a healthcheck is a command run **inside the container**, so it
can only use what that image ships. `curl` is not in `node:*-alpine`, not in
`*-slim`, not in `distroless`, not in most language base images. A healthcheck
that calls it fails forever, the container is marked unhealthy, and something
restarts it — while the service itself is answering requests correctly the whole
time.

## What it looks like

```yaml
livenessProbe:
  exec:
    command: ["sh", "-c", "curl -f http://localhost:8080/ || exit 1"]
```

```
$ podman inspect <container> --format '{{range .State.Health.Log}}[{{.ExitCode}}] {{.Output}}{{end}}'
[1] /bin/sh: curl: not found
[1] /bin/sh: curl: not found
```

The page returns 200. The health log says the check never ran. This happened on
this box twice in two days with the same image and the same line: once reaching
**1006 restarts** before anyone noticed — the box had become visibly slow from
the constant pod teardown — and once at 13 and climbing while the deployment was
being reported as "Health Check: ok".

## Use what the image has

| Image | A check that works |
|---|---|
| `node:*` (any variant) | `node -e "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` |
| `python:*` | `python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/').status==200 else 1)"` |
| busybox/alpine userland | `wget -q -O /dev/null http://127.0.0.1:8080/` |
| anything with a shell only | let the app write a file and check its age — or drop the check |

Verify the command *before* you ship it:

```sh
podman exec <container> sh -c '<your check command>'; echo "exit=$?"
```

If that prints `not found`, the check is decoration.

## Two different things are called "health" here

- **The container healthcheck / livenessProbe** — runs inside the container, and
  decides whether the container is restarted. This is the one that bites.
- **ServiceBay's health check** — an HTTP probe from the box, visible via
  `servicebay health`. It says "the port answers", which a crash-looping
  container does perfectly well between restarts.

A green ServiceBay probe is not evidence that the container is healthy. Read the
container's own log:

```sh
podman inspect <container> --format '{{.State.Health.Status}} fails={{.State.Health.FailingStreak}}'
podman inspect <container> --format '{{.RestartCount}}'   # read twice, minutes apart
```

`RestartCount` climbing while nothing is being deployed is the signature.

See also `checklist-a-deployment-is-not-done-until-you-looked` for the rest of
what "deployed" has to mean, and `checklist-a-probe-that-cannot-fail-is-not-a-check`
for the same mistake made the other way around.
