#!/usr/bin/env node
/**
 * ServiceBay agent kit — check a repo's release path BEFORE blaming the box (#2995).
 *
 * This is the repo half of the question `servicebay images <service>` answers
 * from the box. The box can tell you **nothing was ever published**; only the
 * repo can tell you **why**. Between them there is no gap left for a session to
 * fill with invention.
 *
 * ## Why this is not a `servicebay` verb
 *
 * The CLI speaks one seam: ServiceBay's own REST routes, one named verb per
 * route, each carrying that route's `tokenScope` — and
 * `tests/scripts/agent_cli_mutation_gate.test.ts` fails any verb that speaks no
 * route (ADR 0017). This tool speaks to GitHub, with a credential ServiceBay
 * does not hold and should not: `gh` is authenticated **in the agent's own
 * container** (config-ui's `gh auth login --web`, #2681), and that is the right
 * place for it. Making it a verb would have meant either lying to the gate or
 * handing the box a GitHub token it has no use for.
 *
 * So: a second tool beside the CLI, same rules — `node:` builtins only, no
 * dependency, no build step, runs exactly as it lies in the repo.
 *
 * ## The credential never reaches argv
 *
 * Everything here goes through `gh`, which reads its own stored credential
 * inside its own process. There is no token flag, no `Authorization` header
 * built here, nothing for `/proc/<pid>/cmdline` to leak. That is not incidental:
 * the evening this tool exists to prevent included `curl -H "Authorization:
 * Bearer $(cat …)"` thirty-five times.
 *
 * ## What it checks, and what each failure means
 *
 *   1. `gh` is present and authenticated            — else nothing below is knowable
 *   2. the repo has a workflow that builds an image — else there is no release path at all
 *   3. it declares `contents: read`                 — a PRIVATE repo's checkout fails without it,
 *                                                     with "Repository not found", which reads
 *                                                     like a typo and is not
 *   4. it declares `packages: write`                — the push to ghcr fails without it
 *   5. the most recent run of it passed             — else read that run, do not guess
 *
 * Exit 0 only when every check passes. Anything else is a numbered reason.
 *
 *   0 ok · 2 usage · 3 no usable `gh` · 4 no build workflow · 5 permissions missing
 *   6 last run failed · 7 no run yet · 1 something else
 *
 * Usage:
 *   node release-check.mjs [--repo owner/name] [--workflow <file.yml>] [--json]
 *
 * With no `--repo` it asks `gh` what the current directory's repo is.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const EXIT = {
  ok: 0,
  other: 1,
  usage: 2,
  noGh: 3,
  noWorkflow: 4,
  permissions: 5,
  runFailed: 6,
  noRun: 7,
};

/** Run `gh` and return stdout, or throw an Error carrying stderr. */
async function gh(args, { timeoutMs = 30_000 } = {}) {
  try {
    const { stdout } = await run('gh', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const detail = String(e?.stderr || e?.message || e).trim();
    const err = new Error(detail);
    err.code = e?.code;
    throw err;
  }
}

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--repo' || a === '--workflow') {
      const v = argv[++i];
      if (!v) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith('-')) return { error: `unknown option ${a}` };
    return { error: `unexpected argument "${a}" — this tool takes options only` };
  }
  return opts;
}

/**
 * Does this workflow build and push a container image? Deliberately loose: the
 * point is to find the file a human would call "the release workflow", not to
 * validate it. A false positive here is harmless (the permission checks below
 * carry the verdict); a false negative would send someone hunting.
 */
function looksLikeImageBuild(text) {
  return /docker\/build-push-action|buildah|podman\s+build|docker\s+build|ko-build|\bghcr\.io\b/i.test(text);
}

/**
 * Read a top-level or job-level `permissions:` block well enough to answer two
 * yes/no questions, without a YAML parser (no dependency, by contract).
 *
 * `permissions: write-all` and a bare `contents: write` both satisfy read —
 * write implies read in GitHub's model, and reporting otherwise would be a
 * false alarm on a workflow that works.
 */
export function readPermissions(text) {
  const found = { contentsRead: false, packagesWrite: false, declared: false };
  if (/^\s*permissions:\s*write-all\s*$/m.test(text)) {
    return { contentsRead: true, packagesWrite: true, declared: true };
  }
  if (/^\s*permissions:/m.test(text)) found.declared = true;
  if (/^\s*contents:\s*(read|write)\s*$/m.test(text)) found.contentsRead = true;
  if (/^\s*packages:\s*write\s*$/m.test(text)) found.packagesWrite = true;
  return found;
}

async function resolveRepo(opts) {
  if (opts.repo) return opts.repo;
  const out = await gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  return out.trim();
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts?.error) {
    process.stderr.write(`release-check: ${opts.error}\n`);
    return EXIT.usage;
  }
  if (opts.help) {
    process.stdout.write(
      'release-check — does this repo actually have a working path from code to a published image?\n\n'
      + 'usage: node release-check.mjs [--repo owner/name] [--workflow <file.yml>] [--json]\n\n'
      + 'exit: 0 ok · 2 usage · 3 no usable gh · 4 no build workflow · 5 permissions missing\n'
      + '      6 last run failed · 7 no run yet · 1 something else\n',
    );
    return EXIT.ok;
  }

  const report = { repo: null, workflow: null, checks: [], ok: false, summary: '' };
  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  // 1 — gh itself.
  try {
    await gh(['auth', 'status'], { timeoutMs: 15_000 });
    add('gh authenticated', true, '');
  } catch (e) {
    add('gh authenticated', false, e.message);
    report.summary = 'This container has no usable `gh` credential, so the repo half cannot be checked from here. '
      + 'Sign in through the ServiceBay config UI (it runs `gh auth login --web`); never paste a token on a command line.';
    return finish(report, opts, EXIT.noGh);
  }

  try {
    report.repo = await resolveRepo(opts);
  } catch (e) {
    add('repo resolved', false, e.message);
    report.summary = 'Could not work out which repo this is. Run inside the checkout, or pass --repo owner/name.';
    return finish(report, opts, EXIT.other);
  }
  add('repo resolved', true, report.repo);

  // 2 — a workflow that builds an image.
  let workflows = [];
  try {
    const listed = JSON.parse(await gh(['api', `repos/${report.repo}/actions/workflows`, '--jq', '.workflows']) || '[]');
    workflows = Array.isArray(listed) ? listed : [];
  } catch (e) {
    add('workflows listed', false, e.message);
    report.summary = `Could not list workflows for ${report.repo}: ${e.message}`;
    return finish(report, opts, EXIT.other);
  }

  const candidates = [];
  for (const wf of workflows) {
    const file = String(wf.path || '').split('/').pop();
    if (opts.workflow && file !== opts.workflow) continue;
    let body = '';
    try {
      body = await gh(['api', `repos/${report.repo}/contents/${wf.path}`, '--jq', '.content'])
        .then(b64 => Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8'));
    } catch { continue; }
    if (opts.workflow || looksLikeImageBuild(body)) candidates.push({ ...wf, file, body });
  }

  if (candidates.length === 0) {
    add('build workflow', false, opts.workflow ? `no workflow named ${opts.workflow}` : 'no workflow builds a container image');
    report.summary = opts.workflow
      ? `${report.repo} has no workflow named ${opts.workflow}.`
      : `${report.repo} has no workflow that builds a container image. There is no path from this code to something the box `
        + 'can pull — that is the thing to fix, and `servicebay assist create-service` ships a working one.';
    return finish(report, opts, EXIT.noWorkflow);
  }

  const wf = candidates[0];
  report.workflow = wf.path;
  add('build workflow', true, wf.path);

  // 3 + 4 — the two permissions whose absence fails in a misleading way.
  const perms = readPermissions(wf.body);
  add('contents: read', perms.contentsRead, perms.declared ? '' : 'no permissions block at all');
  add('packages: write', perms.packagesWrite, '');
  if (!perms.contentsRead || !perms.packagesWrite) {
    const missing = [
      !perms.contentsRead ? '`contents: read`' : null,
      !perms.packagesWrite ? '`packages: write`' : null,
    ].filter(Boolean).join(' and ');
    report.summary = `${wf.path} does not declare ${missing}. `
      + (!perms.contentsRead
        ? 'On a PRIVATE repo the checkout then fails with "Repository not found", which reads like a typo in the repo name '
          + 'and is not — it is the token having no read grant. '
        : '')
      + (!perms.packagesWrite ? 'Without `packages: write` the push to the registry is refused. ' : '')
      + 'Add the block and re-run the workflow before touching anything on the box.';
    return finish(report, opts, EXIT.permissions);
  }

  // 5 — did the most recent run of it actually pass?
  let runs = [];
  try {
    runs = JSON.parse(await gh([
      'api', `repos/${report.repo}/actions/workflows/${encodeURIComponent(wf.file)}/runs?per_page=1`,
      '--jq', '[.workflow_runs[] | {status, conclusion, html_url, head_branch, created_at}]',
    ]) || '[]');
  } catch (e) {
    add('last run', false, e.message);
    report.summary = `Could not read runs of ${wf.path}: ${e.message}`;
    return finish(report, opts, EXIT.other);
  }

  const last = runs[0];
  if (!last) {
    add('last run', false, 'never run');
    report.summary = `${wf.path} has never run, so nothing has been published from it yet.`;
    return finish(report, opts, EXIT.noRun);
  }
  report.lastRun = last;
  if (last.status !== 'completed') {
    add('last run', false, `still ${last.status}`);
    report.summary = `The latest run of ${wf.path} is still ${last.status}. Wait for it, then check again: ${last.html_url}`;
    return finish(report, opts, EXIT.noRun);
  }
  if (last.conclusion !== 'success') {
    add('last run', false, `${last.conclusion}`);
    report.summary = `The latest run of ${wf.path} ended "${last.conclusion}". Read it — do not work around it: ${last.html_url}\n`
      + 'Three failed attempts at the same goal is the limit; then stop and report what the log said.';
    return finish(report, opts, EXIT.runFailed);
  }
  add('last run', true, last.html_url);

  report.ok = true;
  report.summary = `${report.repo}: ${wf.path} declares both permissions and its latest run passed. `
    + 'If the box still has no new image, ask the box: `servicebay images <service>` says whether the registry serves the tag '
    + 'the service actually pulls — a green build pushing a tag nothing pulls looks exactly like this.';
  return finish(report, opts, EXIT.ok);
}

function finish(report, opts, code) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, exitCode: code }, null, 2)}\n`);
    return code;
  }
  const lines = [`${report.repo ?? '?'}${report.workflow ? `  ${report.workflow}` : ''}`];
  for (const c of report.checks) {
    lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  lines.push('', report.summary);
  process.stdout.write(`${lines.join('\n')}\n`);
  return code;
}

/* c8 ignore start — process wiring; `main` above is what the tests drive. */
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('release-check.mjs');
if (invokedDirectly) process.exitCode = await main();
/* c8 ignore stop */

export { main, EXIT, looksLikeImageBuild };
