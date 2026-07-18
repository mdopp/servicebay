---
title: exec_command / container_exec are the sledgehammer — check a read tool first
whenToUse: before reaching for exec_command / container_exec — check whether a read-scoped tool already exposes what you need.
kind: footgun
tags: [mcp, exec, exec_command, container_exec, read-first, least-privilege, destructive-op, snapshot, box-verify]
---

# exec is the last resort — a read tool almost always covers it

## Symptom
You reach for `exec_command` (or `container_exec` / `podman exec …`) to answer a
simple question — "what image SHA is deployed?", "what's in this file?", "how
much disk is free?" — when a dedicated, read-scoped MCP tool already returns
exactly that. The exec call then trips a **destructive-op alert + an
auto-snapshot** (a `servicebay-full-*-auto.tar.gz`) for what was a harmless read.

## Cause
`exec_command` and `container_exec` are escape hatches. `exec_command` runs an
arbitrary host shell command; both are treated as destructive, so calling either
fires the destructive-op alert and snapshots before running. Generic prose like
"use the MCP tools" is advisory — an agent skips it. The read tools are the
structural answer: they are non-destructive, typed, and scoped, so they never
trip the alert.

## Fix — pick the read tool first
Consult this read-alternatives map before you type an exec call:

| You want | Use this read tool |
|---|---|
| image / revision / state | `list_containers` — labels `org.opencontainers.image.revision`, `org.opencontainers.image.version` |
| container logs | `get_container_logs` |
| service / unit (systemd) logs | `get_service_logs` |
| CPU / RAM / disk / uptime | `get_system_info` |
| read a file | `read_file` |
| a service's files | `get_service_files` |
| list services / containers | `list_services` / `list_containers` |

Only use `exec_command` / `container_exec` when **no** dedicated/read tool covers
the task (binary/huge files, or a genuine host/in-container action). `read_file`
and `list_dir` are jailed to `/mnt/data`; `container_exec` is scoped to one
container, not the host — still last-resort, but narrower than `exec_command`.

## Verify
When confirming a deployed build (e.g. in box-verify), read the revision from
`list_containers` labels (`org.opencontainers.image.revision`) — do **not** shell
out with `exec_command` / `podman inspect`.
