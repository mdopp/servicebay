---
title: Testing, coverage & CI gate for a new service
whenToUse: You are building or changing a ServiceBay service and need the required standard for tests, coverage, and the CI gate so the box only ever runs code that passed tests. Read this before writing the CI or shipping a service.
kind: checklist
tags: [tests, coverage, ci, gate, quality, new-service, standard]
---

# Testing, coverage & CI gate

A new/changed service must satisfy all of the following. These make the platform
promise real: the box never runs code that did not pass tests at threshold.

1. **A real test suite**, not an ad-hoc script — use the language's standard
   runner (Python: `pytest`). Cover:
   - unit tests for real logic (parsing, matching, error handling), no network;
   - API tests via a TestClient against isolated, throwaway data trees;
   - the SSO guard: a request missing the forward-auth `Remote-User` header is
     rejected (no LAN bypass);
   - bad input returns a clean 4xx, not a 500.

2. **Coverage, measured and enforced.**
   - Measure over the app package. **Turn on thread/async coverage**
     (coverage.py `concurrency = ["thread"]`) or background-job/worker code shows
     a false-low number.
   - Floor: the platform's **70% diff-coverage minimum on changed lines**
     (see `generic-project-standards` and `docs/ARCHITECTURE_INVARIANTS.md`); a
     new service should target **>= 85% total**, including the long-running/async
     paths.

3. **CI runs the tests as a GATE.** The image build/publish job must `needs:`
   the test job — publish only on green at threshold (`--cov-fail-under`). Run
   tests on pull requests too. A CI that only builds the image (no test step) is
   non-compliant.

4. **A `/healthz` endpoint** wired to `servicebay.healthcheck` — it is both a
   test seam and the install gate.

5. **Box-verify after deploy** (do not trust green CI alone): healthcheck 200;
   the public host returns **302 -> auth.<domain>** when unauthenticated; the
   feature actually works; a request missing `Remote-User` is rejected.

6. **Long-running work has its own tests**: assert the durable-job contract —
   progress, cancel, done/error, and reload/interrupt survival (see the
   `long-running-process` standard).

Related: ADR 0003 (release discipline / parser-clean commits), the enforced
diff-coverage floor in `docs/ARCHITECTURE_INVARIANTS.md`, and the
`report-standards-gaps` convention (report friction back so the standards
improve).
