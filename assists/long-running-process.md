---
title: Long-running processes — server-owned, reconnectable, durable
whenToUse: You are building a service with any operation that can exceed ~10s (bulk scans, per-item network lookups, migrations, report generation). Read this before wiring the UI so the work is a server-side process, not something the browser owns.
kind: checklist
tags: [long-running, jobs, durability, reconnect, resume, ux, standard]
---

# Long-running processes

Any operation that can exceed ~10s must satisfy all of the following. The point:
the **server owns the process**; the frontend is only a view + remote control.

1. **Server owns the work, not the browser.** Run it as a durable background job
   with an id. Never tie the work's lifetime to a request or a page — returning
   the response or closing the tab must not stop it.

2. **Reconnect via the server, not client state.** Expose "this user's
   current/last job" (e.g. `GET .../latest`) so *any* page load — a reload, or a
   different browser — attaches to the running job. Do **not** rely on
   localStorage; a reload aborts in-flight requests, and treating that abort as
   "job gone" is the classic bug that loses the process. Owner-scope job
   reads/cancel so one user can't see another's.

3. **Survive a service restart.** Persist the job's input + progress; on startup,
   **resume** jobs that were running (make it idempotent/cheap via caches). If the
   input is gone, report `interrupted` — never silently drop.

4. **Observable + cancelable:** progress (pct / counts / rough ETA), a cancel
   control, and explicit `done` / `error` / `interrupted` states the UI renders.

5. **Bound the runtime + push cost decisions upfront** (scope, date range,
   top-N, min-threshold, a cheaper source) so minutes/hours aren't spent on work
   the user didn't want. Hard caps must be disclosed, never silent.

6. **Multi-worker caveat:** if the server runs more than one worker, job state
   must be shared (disk/DB), not one process's memory — else a poll routed to
   another worker reports the job missing.

7. **Test the contract:** progress, cancel, done/error, **reload-reconnect**, and
   **restart-resume**.

Related: the `testing-and-ci-gate` standard (which requires these tests) and the
`cross-service-uid-writes` footgun (when the long job writes another service's
store).
