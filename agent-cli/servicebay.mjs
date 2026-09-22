#!/usr/bin/env node
/**
 * ServiceBay agent CLI (#2906, slice 1 of #2903).
 *
 * A coding agent's four tools are read/write/edit/bash — the shell IS the
 * access path, so ServiceBay ships one. This file is the whole client:
 *
 *   - **No build step, no dependency.** `node:` builtins only, no import of
 *     anything under `packages/`, no `npm install`. Delivery (#2908) is a git
 *     checkout dropped on the box the way the assist catalog is (ADR 0014), so
 *     the file must run exactly as it lies in the repo: `node servicebay.mjs
 *     services`. Anything that needs a transpile or a `node_modules` breaks
 *     that, permanently and silently.
 *   - **One seam, not three.** `templates/claude-dev/config-ui/server.mjs` and
 *     solarisbay's `pi-web-project` are two hand-maintained clients of the same
 *     routes, ageing apart. #2910 folds them onto this. That is why `VERBS`
 *     below is a *declarative table* rather than a function per verb: it is the
 *     contract those callers depend on, and #2907 pins it against the real
 *     routes so a route rename breaks the CLI instead of rotting it.
 *
 * ## The token never travels in argv
 *
 * There is deliberately **no `--token` flag**, and passing one is a usage
 * error. `/proc/<pid>/cmdline` is world-readable and an agent container has
 * real user logins on it, so a secret reaches a process through a file or the
 * environment — never an argument. Same rule, same reason as `gh auth login
 * --with-token` reading stdin in `config-ui/server.mjs` (#2681).
 *
 * ## Errors name the scope, not the status
 *
 * A refusal has to be actionable or the agent guesses, so the two cases are
 * kept apart and neither is reported as a bare status:
 *
 *   - **403** — the token verified and merely lacks the tier. ServiceBay says
 *     `Forbidden: '<scope>' scope required` (#3001) and the CLI relays that
 *     word verbatim: "authenticated but under-scoped, it needs `lifecycle`".
 *   - **401** — the token is unknown, revoked or expired, and the server
 *     deliberately says nothing about the route. The CLI falls back to the
 *     scope this verb *declares* (the ladder in
 *     `packages/backend/src/lib/auth/apiScope.ts`) so the message still names
 *     one, while being honest that the credential itself may be the problem.
 *
 * Until #3001 the server answered both with the flat 401, and that single
 * ambiguity is what an agent could not act on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Default base URL: the pod-crossing name from ADR 0007, never a LAN IP. */
export const DEFAULT_BASE_URL = 'http://host.containers.internal:5888';

const enc = encodeURIComponent;

/** Trim a body to something an agent can read without scrolling forever. */
function clip(value, max = 4000) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters, use --json for all of it)` : text;
}

/** `sha256:abcdef…` → `abcdef12`, so a digest pair fits one line. */
function shortDigest(value) {
  if (value === null || value === undefined || value === '') return '?';
  const text = String(value);
  const hex = text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
  return hex.length > 12 ? hex.slice(0, 12) : hex;
}

function line(...parts) {
  return parts.filter(p => p !== '' && p !== undefined && p !== null).join('  ');
}

/**
 * The verb table — THE contract.
 *
 * Each entry declares everything a caller (or #2907's contract test) needs
 * without executing anything:
 *   `effect`  WHAT THIS VERB IS ALLOWED TO DO, from a closed set of four
 *             (#2965, widened by #2990). `'read'` — it only inspects;
 *             `'own-credential'` — it acts on the caller's own token lineage
 *             and nothing else; `'request'` — it files a request an operator
 *             must approve, and ServiceBay, not this CLI, executes what was
 *             approved; `'mutate'` — it changes the box directly, and may do
 *             so ONLY because the token presented already carries the tier the
 *             route demands (ADR 0017). The fourth value is not a loophole:
 *             `tests/scripts/agent_cli_mutation_gate.test.ts` holds a
 *             `'mutate'` verb's declared `scope` against the route's real
 *             `tokenScope` and fails closed in BOTH directions — a read verb
 *             on a mutating route and a mutate verb on a read route are each
 *             red. What the CLI still may not do is decide: destroy-tier work
 *             (removal, reset, exec) has no verb and stays an approval.
 *   `auth`    how the route authenticates. Absent (the default) means the
 *             ServiceBay scope gate: the route carries `tokenScope` and the
 *             CLI quotes `scope` back in every auth error. `'parent-token'`
 *             means the route is mounted `skipAuth: true` because the token
 *             PRESENTED is itself the credential being acted on — see the
 *             delegate/revoke pair below.
 *   `scope`   the ApiScope this verb requires, or `null` for a `parent-token`
 *             verb, which is gated on lineage rather than on a scope
 *   `method`  / `path(args, options)` the exact route it speaks
 *   `optionalPositionals`
 *             trailing arguments a caller MAY supply. `progress` takes a job
 *             id, or nothing and reports the last run (#3027). Absent ones are
 *             `undefined`; one too many is still a usage error.
 *   `reads`   the top-level response fields `text()` actually consumes, so a
 *             route that stops returning one is a red rather than a blank line
 *   `text`    the human rendering; `--json` bypasses it entirely
 *   `exit`    optional: maps a SUCCESSFUL response to an exit code, for a verb
 *             whose HTTP 200 does not mean the thing happened. Only
 *             `request-status` has one — an agent that treats "still waiting
 *             for the operator" as success is the failure #2965 exists to
 *             prevent.
 */
export const VERBS = {
  services: {
    summary: 'list the services installed on the box',
    usage: 'services [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['node'],
    path: (_args, opts) => `/api/services${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    reads: ['name', 'status', 'activeState'],
    text: body => {
      const list = Array.isArray(body) ? body : [];
      if (list.length === 0) return 'no services';
      return list
        .map(s => line(String(s?.name ?? '?').padEnd(24), String(s?.activeState ?? s?.status ?? '?')))
        .join('\n');
    },
  },

  service: {
    summary: 'show one service — its unit file, pod manifest and config',
    usage: 'service <name> [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['name'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.name)}${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    // `GET /api/services/[name]` hands `ServiceListing.getServiceFiles` straight
    // through, so these are the payload's own names — `serviceFile`/`yamlFile`
    // (what this verb read until #2907's contract test ran) exist nowhere on
    // the wire and printed "no files returned" for every service.
    reads: ['serviceContent', 'yamlContent'],
    text: body => {
      const parts = [];
      if (body?.serviceContent) parts.push(`--- unit ---\n${clip(body.serviceContent)}`);
      if (body?.yamlContent) parts.push(`--- pod manifest ---\n${clip(body.yamlContent)}`);
      return parts.length ? parts.join('\n\n') : 'no files returned for this service';
    },
  },

  diagnose: {
    summary: 'run the box diagnosis and read the probe results',
    // A POST that writes nothing — it only inspects state, which is why `read`
    // is the right scope (same shape as /api/install/plan).
    effect: 'read',
    scope: 'read',
    method: 'POST',
    usage: 'diagnose [--node <name>]',
    positionals: [],
    options: ['node'],
    path: () => '/api/system/diagnose',
    body: (_args, opts) => (opts.node ? { node: opts.node } : {}),
    reads: ['probes'],
    text: body => {
      const probes = Array.isArray(body?.probes) ? body.probes : [];
      if (probes.length === 0) return 'no probes returned';
      return probes
        .map(p => line(String(p?.status ?? '?').padEnd(8), String(p?.id ?? p?.name ?? '?').padEnd(28), String(p?.message ?? '')))
        .join('\n');
    },
  },

  logs: {
    summary: 'fetch a service’s unit and podman logs',
    usage: 'logs <service> [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['service'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.service)}/logs${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    reads: ['serviceLogs', 'podmanLogs'],
    text: body => {
      const parts = [];
      if (body?.serviceLogs) parts.push(`--- service ---\n${clip(body.serviceLogs, 8000)}`);
      if (body?.podmanLogs) parts.push(`--- podman ---\n${clip(body.podmanLogs, 8000)}`);
      return parts.length ? parts.join('\n\n') : 'no logs returned';
    },
  },

  health: {
    summary: 'read the configured health checks and their last result',
    usage: 'health',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: [],
    path: () => '/api/health/checks',
    reads: ['name', 'lastResult'],
    text: body => {
      const list = Array.isArray(body) ? body : Array.isArray(body?.checks) ? body.checks : [];
      if (list.length === 0) return 'no health checks';
      return list
        .map(c => line(String(c?.lastResult?.status ?? 'pending').padEnd(8), String(c?.name ?? '?')))
        .join('\n');
    },
  },

  assists: {
    summary: 'list the assist catalog (ADRs, recipes, guides, footguns)',
    usage: 'assists [--query <text>] [--kind <kind>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['query', 'kind'],
    path: (_args, opts) => {
      const qs = [];
      if (opts.query) qs.push(`query=${enc(opts.query)}`);
      if (opts.kind) qs.push(`kind=${enc(opts.kind)}`);
      return `/api/assists${qs.length ? `?${qs.join('&')}` : ''}`;
    },
    reads: ['assists'],
    text: body => {
      const list = Array.isArray(body?.assists) ? body.assists : [];
      if (list.length === 0) return 'no assists';
      return list
        .map(a => line(String(a?.id ?? '?').padEnd(36), String(a?.kind ?? '').padEnd(10), String(a?.whenToUse ?? a?.title ?? '')))
        .join('\n');
    },
  },

  assist: {
    summary: 'print one assist in full (frontmatter + body)',
    usage: 'assist <id>',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['id'],
    options: [],
    path: args => `/api/assists/${enc(args.id)}`,
    reads: ['content'],
    text: body => (typeof body?.content === 'string' ? body.content : 'assist returned no content'),
  },

  /* ── the two writes (#2910) ───────────────────────────────────────────────
   *
   * Everything above only reads. These two mint and revoke a DELEGATED CHILD
   * of the token the caller already holds, and they are here because
   * `templates/claude-dev/config-ui/server.mjs` needed exactly them in order to
   * stop speaking the route itself — which is the consolidation #2910 is.
   *
   * They authenticate DIFFERENTLY from every read verb, and the difference is
   * declared rather than left to be inferred. `POST`/`DELETE
   * /api/system/api-tokens/delegate` is mounted `skipAuth: true`: there is no
   * `tokenScope` to gate on, because the presented token IS the credential —
   * it is the delegation parent, verified inside the handler, which refuses an
   * unknown, expired or foreign-parent request itself. Hence `auth:
   * 'parent-token'` and no `scope`; #2907's contract test asserts that shape
   * against the route rather than a `tokenScope` string.
   *
   * This does NOT widen what an agent token can do. A child is never wider
   * than its parent (`scopesAreSubset`, packages/backend/src/lib/auth/
   * apiScope.ts), so a read-only container token mints read-only children and
   * can revoke only what it minted.
   */

  delegate: {
    summary: 'mint a delegated child of this token, never wider than it',
    usage: 'delegate <name> [--scopes read,lifecycle] [--expires <iso8601>]',
    effect: 'own-credential',
    auth: 'parent-token',
    scope: null,
    method: 'POST',
    positionals: ['name'],
    options: ['scopes', 'expires'],
    path: () => '/api/system/api-tokens/delegate',
    body: (args, opts) => ({
      name: args.name,
      scopes: String(opts.scopes ?? 'read').split(',').map(s => s.trim()).filter(Boolean),
      ...(opts.expires ? { expiresAt: opts.expires } : {}),
    }),
    reads: ['token', 'secret'],
    // The child secret is returned ONCE and exists nowhere else afterwards, so
    // it has to leave through stdout. That is not the argv rule bending: argv
    // is world-readable through /proc/<pid>/cmdline, a pipe to the caller is
    // not. Nothing here ever puts a secret back into an argument.
    text: body => [
      line('id     ', String(body?.token?.id ?? '?')),
      line('name   ', String(body?.token?.name ?? '?')),
      line('scopes ', (Array.isArray(body?.token?.scopes) ? body.token.scopes : []).join(',') || '?'),
      line('secret ', String(body?.secret ?? '')),
    ].join('\n'),
  },

  revoke: {
    summary: 'revoke one child token this token delegated',
    usage: 'revoke <id>',
    effect: 'own-credential',
    auth: 'parent-token',
    scope: null,
    method: 'DELETE',
    positionals: ['id'],
    options: [],
    path: args => `/api/system/api-tokens/delegate?id=${enc(args.id)}`,
    reads: ['revoked', 'id', 'name'],
    // `revoked` is a COUNT and is printed as one: "revoked nothing" must never
    // read as "revoked it" (why the route answers a denominator at all). A 404
    // — not this parent's child, or already gone — stays a NOT_FOUND failure
    // here; deciding that "already gone" is acceptable is the caller's call,
    // not the CLI's.
    text: body => `revoked ${Number(body?.revoked ?? 0)}: ${String(body?.id ?? '?')} (${String(body?.name ?? '?')})`,
  },

  /* ── the request pair (#2965) ──────────────────────────────────────
   *
   * An agent that has finished building a template can ASK for it to be
   * installed. It cannot install it — not before the operator approves, and
   * not after. `request-install` writes ONE row into ServiceBay's durable
   * approval store and returns a request id; the operator reads the plan on
   * the approval card and approves or rejects it; ServiceBay then runs the
   * plan THE OPERATOR APPROVED. Nothing in this file ever touches the box.
   *
   * That asymmetry is the point (operator decision, 2026-09-09): a direct
   * install verb would mean anyone who reaches the pi web surface reaches
   * deployment. A request verb means they reach @mdopp's inbox.
   *
   * Both speak the `propose` tier of the scope ladder — the ladder's
   * independent "ask a human" capability, not part of read<…<exec. A
   * read-scoped token cannot file a request; a propose-scoped token can file
   * one and can do nothing else.
   */

  whoami: {
    summary: 'say what the token you hold is: name, scopes, parent, expiry',
    usage: 'whoami',
    effect: 'own-credential',
    // Report WHICH credential answered, not just what it may do (#3000).
    showsCredentialSource: true,
    auth: 'parent-token',
    // Same credential model as delegate/revoke, but the phrase must not say
    // "delegation parent": nothing is delegated here, the token is only asked
    // what it is.
    need: 'the token that is to be described (this verb carries no scope gate — a token of any scope may ask what it is)',
    scope: null,
    method: 'GET',
    positionals: [],
    options: [],
    path: () => '/api/system/api-tokens/me',
    reads: ['id', 'name', 'scopes'],
    // The one question a document cannot answer (#2984). A refusal here means
    // the token itself is unknown, revoked or expired — there is nothing
    // narrower to be under-scoped for.
    text: body => [
      line('id      ', String(body?.id ?? '?')),
      line('name    ', String(body?.name ?? '?')),
      line('scopes  ', (Array.isArray(body?.scopes) ? body.scopes : []).join(',') || '?'),
      line('parent  ', String(body?.parentId ?? '-')),
      line('expires ', String(body?.expiresAt ?? 'never')),
    ].join(String.fromCharCode(10)),
  },

  progress: {
    summary: 'how an install is going — or, when none is running, how the last one ended',
    usage: 'progress [<job-id>] [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['node'],
    // `install` prints a job id; until #3027 nothing took one back. The job
    // ended, `progress` said "no install job is running", and the recorded
    // error — a good one, naming exactly what went wrong — reached nobody. A
    // session then guessed three times at a fact that was on disk the whole
    // time.
    optionalPositionals: ['id'],
    path: (args, opts) => {
      const q = [args.id ? `jobId=${enc(args.id)}` : '', opts.node ? `node=${enc(opts.node)}` : '']
        .filter(Boolean).join('&');
      return `/api/install/current${q ? `?${q}` : ''}`;
    },
    reads: ['job', 'jobIsActive'],
    text: body => {
      const job = body?.job ?? body?.last ?? null;
      if (!job) return 'no install job is running, and none has been recorded on this box';
      const p = job?.progress ?? {};
      const deployed = Array.isArray(p?.deployedNames) ? p.deployedNames : [];
      const tail = Array.isArray(job?.logTail) ? job.logTail : [];
      const warnings = Array.isArray(job?.warnings) ? job.warnings : [];
      return [
        line('job     ', String(job?.id ?? '?'), body?.job ? '' : '(the last one — nothing is running now)'),
        line('phase   ', String(job?.phase ?? '?'), body?.jobIsActive === true ? '(active)' : '(finished)'),
        line('current ', String(p?.currentItem ?? '-'), `of ${String(p?.totalCount ?? '?')}`),
        line('deployed', deployed.length > 0 ? deployed.join(', ') : '-'),
        job?.error ? line('error   ', String(job.error)) : '',
        ...warnings.map(w => line('warning ', String(w))),
        ...(tail.length > 0 ? ['', 'last log lines:', ...tail.map(l => `  ${l}`)] : []),
      ].filter(Boolean).join('\n');
    },
    // A job that ENDED BADLY must not exit 0 — that is the whole complaint:
    // the outcome was recorded and unreachable, so a script could not tell a
    // finished install from a failed one.
    //   0 running or done · 11 error/crashed/aborted
    exit: body => {
      const job = body?.job ?? body?.last ?? null;
      if (!job) return 0;
      return ['error', 'crashed', 'aborted'].includes(String(job.phase)) ? 11 : 0;
    },
  },

  images: {
    summary: 'is what this service pulls actually published, pulled and current',
    usage: 'images <service> [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['service'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.service)}/images${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    // You cannot build an image from this container, so when a build does not
    // arrive the only useful question is WHERE it stopped. `problem` answers
    // that: `not-published` means nothing was ever pushed under this tag — the
    // state a workflow whose checkout failed leaves behind, and the one a
    // session otherwise spends hours failing to infer (#2995).
    reads: ['images', 'ok', 'summary'],
    text: body => {
      const images = Array.isArray(body?.images) ? body.images : [];
      const rows = images.map(img => {
        // Only `not-published` is an assertion that nothing was ever pushed.
        // `unreachable` and `unknown` mean we could not look — rendering those
        // as NOT PUBLISHED sends someone to fix a build that is fine (#3033).
        const verdict = img?.published !== true
          ? (img?.problem === 'not-published'
            ? 'NOT PUBLISHED — the registry serves no such tag'
            : `could not check (${String(img?.problem ?? 'unknown')})`)
          : img?.upToDate === false
            ? `published, local is behind ${shortDigest(img?.registry)}`
            : img?.pulled !== true
              ? `published ${shortDigest(img?.registry)}, not pulled here`
              : `published, pulled, current ${shortDigest(img?.registry)}`;
        return line(String(img?.image ?? '?').padEnd(44), verdict);
      });
      const details = images
        .filter(i => i?.detail)
        .map(i => line('  registry said:', String(i.detail)));
      return [
        line(String(body?.service ?? '?'), body?.ok === true ? 'ok' : 'PROBLEM'),
        ...(rows.length > 0 ? rows : ['no image reference in the service definition']),
        ...details,
        '',
        String(body?.summary ?? ''),
      ].join('\n');
    },
    // A 200 means the question was answered, not that the answer is good. An
    // unpublished image is the failure this verb exists to surface, so it must
    // not exit 0 — the same rule `update` follows for `stale`.
    exit: body => (body?.ok === true ? 0 : 7),
  },

  verify: {
    summary: 'is this deployment actually done — six measurements, not a claim',
    usage: 'verify <service> [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['service'],
    options: ['node'],
    path: (args, opts) => `/api/services/${enc(args.service)}/verify${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    // The six points used to be a catalog checklist, and prose only works when
    // somebody opens it — which a session does least when it believes it is
    // finished. This turns "did you verify?" into "what does verify say?", and
    // that fits in an acceptance criterion (#3021).
    reads: ['checks', 'ok', 'summary'],
    text: body => {
      const checks = Array.isArray(body?.checks) ? body.checks : [];
      const mark = s => (s === 'ok' ? 'ok  ' : s === 'problem' ? 'FAIL' : s === 'unknown' ? '??  ' : '--  ');
      const rows = checks.flatMap(c => {
        const head = line(mark(String(c?.status)), String(c?.title ?? '?').padEnd(46), String(c?.measured ?? ''));
        return c?.detail ? [head, line('        ', String(c.detail))] : [head];
      });
      const verdict = body?.ok === true
        ? (body?.complete === true ? 'DONE' : 'no problem found, but not fully measured')
        : 'NOT DONE';
      return [
        line(String(body?.service ?? '?'), verdict),
        ...(rows.length > 0 ? rows : ['nothing measured']),
        '',
        String(body?.summary ?? ''),
      ].join('\n');
    },
    // 0 only when every measurable check passed AND nothing was left unmeasured.
    // "no problem found" is not the same as "verified", and an exit code is the
    // only part of this a script reads.
    //   0 done · 8 a check failed · 9 nothing failed but something is unmeasured
    exit: body => (body?.ok === true ? (body?.complete === true ? 0 : 9) : 8),
  },

  ports: {
    summary: 'what is listening on the box, and what is free — including what is no service',
    usage: 'ports [--node <name>]',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: [],
    options: ['node'],
    path: (_args, opts) => `/api/system/ports${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    // Your pod has its own network namespace, so `ss -ltn` in here shows you
    // NOTHING about the box. Ask this before you pick a host port; a collision
    // found afterwards is an error message you have to interpret, and the last
    // session that interpreted one rewrote another service to free the port
    // (#3028).
    reads: ['ports', 'free', 'summary'],
    text: body => {
      const ports = Array.isArray(body?.ports) ? body.ports : [];
      const free = Array.isArray(body?.free) ? body.free : [];
      const rows = ports.map(p => line(
        String(p?.port ?? '?').padStart(6),
        String(p?.protocol ?? '').padEnd(4),
        String(p?.owner ?? '?').padEnd(34),
        p?.kind === 'service' ? '(service)' : p?.kind === 'control-plane' ? '(ServiceBay itself)' : '(no service)',
      ));
      return [
        ...(rows.length > 0 ? rows : ['could not read the listener table']),
        '',
        line('free: ', free.join('  ') || '(none suggested)'),
        '',
        String(body?.summary ?? ''),
      ].join('\n');
    },
    // An empty table is not "everything is free" — it is a failed read, and
    // acting on it walks into the collision this verb exists to prevent.
    exit: body => (Array.isArray(body?.ports) && body.ports.length > 0 ? 0 : 10),
  },

  /* ── the mutating pair (#2990, ADR 0017) ──────────────────────────────
   *
   * These change the box. They are here because the pi-web token already
   * carries `lifecycle,mutate`: before them the handbook's "when the CLI has
   * no verb for it" section sent a session to the raw `/mcp` endpoint with the
   * token in argv — the CLI was not preventing the mutation, it was only
   * forcing it through the worse door. The token decides; the door only has
   * to say what it is.
   */

  update: {
    summary: 'move a service onto the image its registry publishes — CHANGES the box',
    usage: 'update <service> [--mode fresh] [--node <name>]',
    effect: 'mutate',
    scope: 'lifecycle',
    method: 'POST',
    positionals: ['service'],
    options: ['mode', 'node'],
    path: (args, opts) => `/api/services/${enc(args.service)}/action${opts.node ? `?node=${enc(opts.node)}` : ''}`,
    // `force-update` re-checks the registry, re-pulls and force-recreates the
    // containers, so the unit cannot come back up on the cached image (#2397).
    // Plain `update` is deliberately NOT reachable from here: it restarts
    // without proving the image moved, which is exactly the false success
    // #2983 is about.
    body: (_args, opts) => ({ action: 'force-update', ...(opts.mode ? { mode: opts.mode } : {}) }),
    reads: ['service', 'images', 'changed', 'stale'],
    text: body => {
      const images = Array.isArray(body?.images) ? body.images : [];
      const rows = images.map(img => {
        const before = shortDigest(img?.before);
        const after = shortDigest(img?.after);
        const verdict = img?.stale === true
          ? 'STALE — the pull did not take'
          : img?.changed === true
            ? `updated ${before} → ${after}`
            : `already on ${after}`;
        return line(String(img?.image ?? '?').padEnd(40), verdict);
      });
      const head = line(String(body?.service ?? '?'), `mode=${String(body?.mode ?? '?')}`, String(body?.status ?? ''));
      const recreated = Array.isArray(body?.recreated) ? body.recreated : [];
      const tail = [
        recreated.length > 0 ? line('recreated', recreated.join(', ')) : '',
        body?.stale === true
          ? 'At least one image is still behind the registry. Retry with --mode fresh, which deletes the local image before pulling.'
          : '',
      ].filter(Boolean);
      return [head, ...(rows.length > 0 ? rows : ['no images declared']), ...tail].join('\n');
    },
    // A 200 here means "the action ran", never "the image moved". `stale` is
    // the server's own word for "the pull did not take" — an agent scripting
    // on `$?` must not read that as success, or #2983 is merely relocated.
    exit: body => (body?.stale === true ? 6 : 0),
  },

  'source-add': {
    summary: 'register a repo as a template source, so its templates can be installed — CHANGES the box',
    usage: 'source-add <repo-url> [--name <name>] [--branch <ref>]',
    effect: 'mutate',
    scope: 'mutate',
    method: 'POST',
    positionals: ['url'],
    options: ['name', 'branch'],
    path: () => '/api/system/template-sources',
    // The step that was missing between "I built a project" and "the box can
    // install it". Before this, a new source meant hand-editing config.json on
    // the box, which no session can do — so no agent could install anything it
    // had just built.
    body: (args, opts) => ({
      url: args.url,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.branch ? { branch: opts.branch } : {}),
    }),
    reads: ['name', 'added', 'synced', 'detail'],
    text: body => [
      line('source ', String(body?.name ?? '?'), body?.added === true ? '(registered)' : '(already registered)'),
      line('synced ', body?.synced === true ? 'yes' : 'NO'),
      String(body?.detail ?? ''),
    ].join('\n'),
    // Registered but not synced is not ready: the entry exists and the repo
    // served nothing. Reporting that as success is how a session installs from
    // a source that has no templates and then wonders why (#3034).
    //   0 registered and synced · 12 registered but the sync did not succeed
    exit: body => (body?.synced === true ? 0 : 12),
  },

  install: {
    summary: 'install a template the full wizard way — CHANGES the box',
    usage: 'install <template> [--var <NAME=value>] [--source <name>] [--node <name>]',
    effect: 'mutate',
    scope: 'mutate',
    method: 'POST',
    positionals: ['template'],
    options: ['var', 'source', 'node'],
    repeatable: ['var'],
    path: () => '/api/install/template',
    // The service is named after the TEMPLATE — assembleManifest takes template
    // names, and even an approved install request starts `names: [template]`.
    // There is deliberately no `--name`: the install pipeline has no per-install
    // rename, so the flag could only ever have been decorative. Renaming after
    // the fact is `rename_service`, a separate decision.
    body: (args, opts) => ({
      template: args.template,
      variables: parseVariables(opts.var),
      ...(opts.source ? { templateSource: opts.source } : {}),
      ...(opts.node ? { node: opts.node } : {}),
    }),
    reads: ['jobId', 'phase'],
    text: body => [
      line('job  ', String(body?.jobId ?? '?')),
      line('phase', String(body?.phase ?? '?')),
      'Watch it with: servicebay progress',
    ].join('\n'),
  },

  'request-remove': {
    summary: 'ASK the operator to remove a service — files a request, removes nothing',
    usage: 'request-remove <service> --reason <text> [--node <name>]',
    effect: 'request',
    scope: 'propose',
    method: 'POST',
    positionals: ['service'],
    options: ['reason', 'node'],
    path: (args) => `/api/services/${enc(args.service)}/removal-requests`,
    // Removal is destroy-tier and stays the operator's (ADR 0017). What was
    // missing was not the permission but the DOOR: a session told "the old one
    // can go" had nowhere to put that, and on 2026-09-20 one improvised by
    // redeploying the service it was replacing with a placeholder image to free
    // its port, taking the domain down (#2994).
    body: (_args, opts) => ({
      reason: opts.reason ?? '',
      ...(opts.node ? { node: opts.node } : {}),
    }),
    reads: ['id', 'status', 'detail'],
    text: body => [
      line('request', String(body?.id ?? '?')),
      line('status ', String(body?.status ?? '?')),
      String(body?.detail ?? ''),
      `Read the outcome with: servicebay approval ${String(body?.id ?? '<id>')}`,
    ].join('\n'),
  },

  approval: {
    summary: 'read what the operator decided about a request you filed',
    usage: 'approval <id>',
    effect: 'read',
    scope: 'read',
    method: 'GET',
    positionals: ['id'],
    options: [],
    path: args => `/api/approvals/${enc(args.id)}`,
    reads: ['approval'],
    text: body => {
      const a = body?.approval ?? {};
      const exec = a?.execution;
      return [
        line('id      ', String(a?.id ?? '?')),
        line('title   ', String(a?.title ?? '?')),
        line('status  ', String(a?.status ?? '?')),
        line('service ', String(a?.service ?? '-')),
        a?.resolved_at ? line('resolved', String(a.resolved_at)) : '',
        exec ? line('ran     ', exec?.ok === true ? 'yes' : `no${exec?.error ? ` — ${String(exec.error)}` : ''}`) : '',
      ].filter(Boolean).join('\n');
    },
    // Pending is not success, and neither is "approved but the action failed".
    // Same rule as `request-status`: an agent scripting on `$?` must be able to
    // tell the three apart without parsing English.
    //   0 done · 4 still waiting on the operator · 5 rejected or the action failed
    exit: body => {
      const a = body?.approval ?? {};
      if (a?.status === 'approved') return a?.execution && a.execution.ok === false ? 5 : 0;
      if (a?.status === 'rejected') return 5;
      return 4;
    },
  },

  'request-install': {
    summary: 'ASK the operator to install a template — files a request, installs nothing',
    usage: 'request-install <template> --as <service> --reason <text> [--subdomain <label>] [--mount <host:container[:ro]>] [--port <host:container[/udp]>] [--var <NAME=value>] [--source <name>] [--node <name>]',
    effect: 'request',
    scope: 'propose',
    method: 'POST',
    positionals: ['template'],
    options: ['as', 'reason', 'subdomain', 'mount', 'port', 'var', 'source', 'node'],
    // Repeating a flag ACCUMULATES instead of overwriting: a request declares
    // every mount and every port it wants, and a silently-dropped earlier
    // `--mount` would file a request narrower than the agent believes it filed.
    repeatable: ['mount', 'port', 'var'],
    path: () => '/api/install/requests',
    body: (args, opts) => ({
      reason: opts.reason ?? '',
      plan: {
        template: args.template,
        serviceName: opts.as ?? '',
        ...(opts.source ? { templateSource: opts.source } : {}),
        subdomain: opts.subdomain ?? null,
        mounts: parseMounts(opts.mount),
        ports: parsePorts(opts.port),
        variables: parseVariables(opts.var),
        ...(opts.node ? { node: opts.node } : {}),
      },
    }),
    reads: ['id', 'status', 'detail'],
    text: body => [
      line('request', String(body?.id ?? '?')),
      line('status ', String(body?.status ?? '?')),
      String(body?.detail ?? ''),
      `Poll it with: servicebay request-status ${String(body?.id ?? '<id>')}`,
    ].join('\n'),
  },

  'request-status': {
    summary: 'read what really happened to YOUR install request — waiting is not success',
    usage: 'request-status <id>',
    effect: 'request',
    scope: 'propose',
    method: 'GET',
    positionals: ['id'],
    options: [],
    path: args => `/api/install/requests/${enc(args.id)}`,
    reads: ['status', 'installed', 'detail'],
    text: body => [
      line('status   ', String(body?.status ?? '?')),
      line('installed', body?.installed === true ? 'yes' : 'no'),
      String(body?.detail ?? ''),
      body?.jobId ? line('job      ', String(body.jobId)) : '',
      body?.error ? line('error    ', String(body.error)) : '',
    ].filter(Boolean).join('\n'),
    // A 200 here means "the answer was read", never "it is installed". An
    // agent scripting on `$?` must be able to tell the three apart, so:
    //   0 installed · 4 still waiting on the operator · 5 decided against you.
    exit: body => {
      if (body?.installed === true) return 0;
      return body?.status === 'denied' || body?.status === 'failed' ? 5 : 4;
    },
  },
};

/* ── option shapes for `request-install` ─────────────────────────────────
 *
 * These only SHAPE what the request says; they authorize nothing. ServiceBay
 * re-validates every field (mounts are jailed to the service's own data root,
 * privileged ports refused, secret-shaped variable names refused) and it is
 * that validation, not this parsing, that bounds what an approval can grant.
 */

/** A repeated option arrives as an array; a single one as a string. */
function many(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** `--mount /mnt/data/stacks/foo/data:/data[:ro]` */
export function parseMounts(value) {
  return many(value).map(entry => {
    const parts = String(entry).split(':');
    const mode = parts.length > 2 ? parts.pop() : undefined;
    return { host: parts[0] ?? '', container: parts[1] ?? '', ...(mode ? { mode } : {}) };
  });
}

/** `--port 8080:80[/udp]` */
export function parsePorts(value) {
  return many(value).map(entry => {
    const [pair, protocol] = String(entry).split('/');
    const [host, container] = String(pair).split(':');
    return {
      host: Number(host),
      container: Number(container === undefined ? host : container),
      ...(protocol ? { protocol } : {}),
    };
  });
}

/** `--var TZ=Europe/Berlin` */
export function parseVariables(value) {
  const out = {};
  for (const entry of many(value)) {
    const text = String(entry);
    const eq = text.indexOf('=');
    if (eq === -1) { out[text] = ''; continue; }
    out[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return out;
}

/**
 * Read the ServiceBay token the way the container is given it.
 *
 * `SERVICEBAY_MCP_TOKEN_FILE` is the path the entrypoint writes — a file only
 * the CLI's user may read, because the environment is readable by other accounts on the container.
 * The plain env var is the fallback for running by hand. One-for-one with
 * `readServicebayToken` in `templates/claude-dev/config-ui/server.mjs`, which
 * deliberately keeps its own copy: that server must read the token
 * synchronously at boot, before it can load this file at all. What #2910
 * collapsed onto this file is the ROUTE knowledge — the thing that was ageing
 * apart — not four lines of env reading.
 */
/**
 * The credential, AND where it came from (#3000).
 *
 * The precedence itself is the safe one and always was: if
 * `SERVICEBAY_MCP_TOKEN_FILE` is set it wins, and a file that is missing, empty
 * or unreadable yields NOTHING — it never falls back to `SERVICEBAY_MCP_TOKEN`.
 * A fallback there would hand a caller who asked for a narrow credential the
 * widest one the container has, in the one case where it is least expected.
 *
 * What was missing is the ability to SEE which one you got. A wrapper between
 * the shell and this file can rewrite the environment before we ever run, and
 * on 2026-09-20 one did: a check script pointed the variable at a `read`-only
 * token to prove a refusal, the wrapper overwrote it with the pod's full token,
 * and the call went through — a real force-update on a service nobody meant to
 * touch. Nothing in any output said which credential had been used.
 *
 * So `whoami` reports the source next to the identity. The path is not a
 * secret; the token it holds never appears.
 */
export function resolveToken(env, readFile) {
  const file = env.SERVICEBAY_MCP_TOKEN_FILE;
  if (file) {
    try {
      return { token: String(readFile(file)).trim(), source: `file: ${file}` };
    } catch {
      return { token: '', source: `file: ${file} (unreadable)` };
    }
  }
  const token = String(env.SERVICEBAY_MCP_TOKEN || '').trim();
  return { token, source: token ? 'env: SERVICEBAY_MCP_TOKEN' : 'none' };
}

/** The token alone. Kept because callers and tests use it by name. */
export function readToken(env, readFile) {
  return resolveToken(env, readFile).token;
}

export function baseUrl(env) {
  return String(env.SERVICEBAY_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function usage() {
  const rows = Object.values(VERBS).map(v => `  ${v.usage.padEnd(38)} ${v.summary}`);
  return [
    'servicebay — read the box from a shell.',
    '',
    'Usage: node servicebay.mjs <verb> [args] [--json]',
    '',
    'Verbs:',
    ...rows,
    '',
    'Every verb accepts --json for machine-readable output.',
    '',
    'Exit codes:',
    '  0 done  ·  1 failed  ·  2 usage  ·  3 no token / wrong scope',
    '  4 the install request is still waiting for the operator (NOT installed)',
    '  5 the operator rejected the request, or the approved install failed',
    '',
    'Environment:',
    '  SERVICEBAY_MCP_TOKEN_FILE  path to the token file (preferred; readable only by this user)',
    '  SERVICEBAY_MCP_TOKEN       the token itself (fallback, for running by hand)',
    `  SERVICEBAY_API_URL         base URL (default ${DEFAULT_BASE_URL})`,
    '',
    'The token is never a command-line argument: /proc/<pid>/cmdline is world-readable',
    'and this container has real user logins on it.',
  ].join('\n');
}

/** Argument shapes the CLI refuses outright, and why. */
const FORBIDDEN_FLAGS = new Map([
  ['--token', 'a token must not travel in argv (/proc/<pid>/cmdline is world-readable) — use SERVICEBAY_MCP_TOKEN_FILE or SERVICEBAY_MCP_TOKEN'],
  ['--password', 'a password must not travel in argv — this CLI authenticates with a scoped API token only'],
  ['--secret', 'a secret must not travel in argv — use SERVICEBAY_MCP_TOKEN_FILE'],
]);

/**
 * Split argv into `{ verb, args, options, json }`.
 * Returns `{ error }` instead of throwing so `run` stays a pure function.
 */
export function parseArgs(argv) {
  const [verbName, ...rest] = argv;
  if (!verbName || verbName === 'help' || verbName === '--help' || verbName === '-h') {
    return { help: true };
  }
  const verb = VERBS[verbName];
  if (!verb) return { error: `unknown verb \`${verbName}\`` };

  const positionals = [];
  const options = {};
  let json = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const bare = token.split('=')[0];
    if (FORBIDDEN_FLAGS.has(bare)) return { error: `${bare} is not accepted: ${FORBIDDEN_FLAGS.get(bare)}` };
    if (token === '--json') { json = true; continue; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (!verb.options.includes(name)) return { error: `\`${verbName}\` has no option \`--${name}\` (usage: ${verb.usage})` };
      const value = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (value === undefined) return { error: `--${name} needs a value (usage: ${verb.usage})` };
      // A repeatable option accumulates; every other one keeps last-wins.
      // Silently dropping an earlier `--mount` would file a request for less
      // reach than the agent asked for and then report that as success.
      if (verb.repeatable?.includes(name)) {
        options[name] = [...(Array.isArray(options[name]) ? options[name] : options[name] === undefined ? [] : [options[name]]), value];
      } else {
        options[name] = value;
      }
      continue;
    }
    positionals.push(token);
  }

  // A verb may declare trailing OPTIONAL positionals (#3027: `progress` takes
  // a job id, or none and reports the last run). Required ones are still
  // required; an optional one that is absent is simply undefined, and anything
  // beyond the declared list is a usage error rather than a silently ignored
  // argument.
  const optional = verb.optionalPositionals ?? [];
  const min = verb.positionals.length;
  const max = min + optional.length;
  if (positionals.length < min || positionals.length > max) {
    const expected = min === max ? `${min}` : `${min}-${max}`;
    return { error: `\`${verbName}\` takes ${expected} argument(s) (usage: ${verb.usage})` };
  }
  const args = {};
  [...verb.positionals, ...optional].forEach((name, i) => {
    if (positionals[i] !== undefined) args[name] = positionals[i];
  });
  return { verbName, verb, args, options, json };
}

/**
 * What this verb needs of a token, as a phrase — the one place the two auth
 * models differ in wording, so every message below reads the same either way.
 */
function credentialNeed(verb) {
  if (verb.need) return verb.need;
  return verb.auth === 'parent-token'
    ? 'the token that is to be the delegation parent (this verb carries no scope gate — the token it presents IS the credential)'
    : `a token with the \`${verb.scope}\` scope`;
}

/**
 * Turn an auth refusal into a message that names the SCOPE.
 *
 * A bare `401 Authentication required` tells an agent nothing it can act on.
 * The verb knows the scope it needs; a 403 additionally carries the server's
 * own `Forbidden: '<scope>' scope required`, which we prefer when present.
 *
 * A `parent-token` verb (#2910) has no scope to name, so it says the thing
 * that IS actionable there instead: the presented token was rejected *as a
 * parent* — unknown, revoked, expired, or not the parent of that child.
 */
function scopeRefusal(verbName, verb, status, body) {
  const serverSaid = typeof body?.error === 'string' ? body.error : '';
  if (verb.auth === 'parent-token') {
    return {
      code: 'SCOPE',
      status,
      requiredScope: null,
      message: `ServiceBay refused the token for \`${verbName}\`. This verb needs ${credentialNeed(verb)}, and the token presented was rejected as one: it is unknown, revoked, expired, or not the parent of that child. ServiceBay says: ${serverSaid || (status === 403 ? 'Forbidden' : 'Authentication required')}.`,
    };
  }
  const named = /'([a-z]+)' scope required/.exec(serverSaid);
  const required = named ? named[1] : verb.scope;
  const message = status === 403
    ? `the token is authenticated but under-scoped for \`${verbName}\`: it needs the \`${required}\` scope. ServiceBay says: ${serverSaid || 'Forbidden'}.`
    : `ServiceBay refused the token for \`${verbName}\`. This verb needs the \`${verb.scope}\` scope; the token presented was rejected, so it is either not valid (revoked or expired) or does not hold \`${verb.scope}\`.`;
  return { code: 'SCOPE', status, requiredScope: required, message };
}

function fail(verbName, error, json) {
  const payload = { ok: false, verb: verbName ?? null, error };
  const exitCode = error.code === 'USAGE' ? 2 : error.code === 'SCOPE' || error.code === 'NO_TOKEN' ? 3 : 1;
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : '',
    stderr: json ? '' : `servicebay: ${error.message}\n`,
  };
}

/**
 * Run one invocation. Pure: every effect is injected, nothing is written to
 * `process`, so the whole verb table is unit-testable against a fake server.
 */
export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const readFile = deps.readFile ?? (p => fs.readFileSync(p, 'utf-8'));

  const parsed = parseArgs(argv);
  if (parsed.help) return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' };
  if (parsed.error) return fail(null, { code: 'USAGE', message: `${parsed.error}\n\n${usage()}` }, false);

  const { verbName, verb, args, options, json } = parsed;

  const { token, source: credentialSource } = resolveToken(env, readFile);
  if (!token) {
    return fail(verbName, {
      code: 'NO_TOKEN',
      requiredScope: verb.scope,
      message: `no ServiceBay API token found, so \`${verbName}\` cannot authenticate. This verb needs ${credentialNeed(verb)}. `
        + 'Point SERVICEBAY_MCP_TOKEN_FILE at the token file this container was given (a file only this user may read), or set SERVICEBAY_MCP_TOKEN. '
        + 'The token is never passed as an argument: /proc/<pid>/cmdline is world-readable.',
    }, json);
  }

  const url = `${baseUrl(env)}${verb.path(args, options)}`;
  const init = {
    method: verb.method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
  if (verb.body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(verb.body(args, options));
  }

  let response;
  try {
    response = await doFetch(url, init);
  } catch (err) {
    return fail(verbName, {
      code: 'NETWORK',
      message: `could not reach ServiceBay at ${baseUrl(env)}: ${err?.message || err}. Set SERVICEBAY_API_URL if the box is somewhere else.`,
    }, json);
  }

  const text = await response.text().catch(() => '');
  let body = null;
  let parseFailed = false;
  if (text) {
    try { body = JSON.parse(text); } catch { parseFailed = true; }
  }

  if (response.status === 401 || response.status === 403) {
    return fail(verbName, scopeRefusal(verbName, verb, response.status, body), json);
  }

  if (!response.ok) {
    const detail = (typeof body?.error === 'string' && body.error) || clip(text, 300) || `HTTP ${response.status}`;
    return fail(verbName, {
      code: response.status === 404 ? 'NOT_FOUND' : 'HTTP',
      status: response.status,
      message: `\`${verbName}\` failed: HTTP ${response.status} — ${detail}`,
    }, json);
  }

  if (parseFailed || (text && body === null)) {
    return fail(verbName, {
      code: 'BAD_JSON',
      status: response.status,
      message: `\`${verbName}\` got a ${response.status} whose body is not JSON: ${clip(text, 300)}`,
    }, json);
  }

  // A 200 does not always mean the thing happened — `request-status` answers
  // "still waiting for the operator" with one. `ok` follows the exit code so
  // `--json` cannot read as success while nothing has been installed (#2965).
  const exitCode = verb.exit ? verb.exit(body) : 0;
  // `whoami` answers "what may I do"; without the source it cannot answer the
  // question behind it — "and is this the credential I meant to use?" (#3000).
  const payload = verb.showsCredentialSource
    ? { ok: exitCode === 0, verb: verbName, data: body, credentialSource }
    : { ok: exitCode === 0, verb: verbName, data: body };
  const rendered = verb.showsCredentialSource
    ? `${verb.text(body)}\n${line('source  ', credentialSource)}`
    : verb.text(body);
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : `${rendered}\n`,
    stderr: '',
  };
}

/* c8 ignore start — process wiring; `run` above is what the tests drive. */
export async function main(argv = process.argv.slice(2)) {
  const result = await run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();
/* c8 ignore stop */
