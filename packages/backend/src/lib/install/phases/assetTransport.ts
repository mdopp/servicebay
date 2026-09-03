/**
 * Asset transport — everything a single item ships to the box *except* the
 * `kube play` itself (#2742 — split out of `runner.ts`).
 *
 * Rendering the pod YAML, the two missing-variable guards, the `<redacted>`
 * post-render backstop, the config/asset file set, the Authelia OIDC-client
 * preservation, and the process environment the post-deploy / migration
 * scripts read. `kubePlay.ts` calls `runAssetTransportPhase` first and then
 * puts the result on the wire.
 *
 * The contract that holds this together: **script bodies travel verbatim,
 * values travel through the environment.** See `loadPostDeployScript` below.
 */
import { renderTemplate, renderPodYaml } from '@/lib/template/render';
import { getTemplatePostDeployScript } from '@/lib/registry';
import { getConfig } from '@/lib/config';
import type { StackVariable } from '@/lib/stackInstall/postInstall';
import type { JobInput, JobInputItem } from '../jobStore';
import { log } from './context';

/**
 * Install-time template variables ServiceBay injects on top of the
 * operator-supplied ones, keyed by template.
 *
 * `auth`: always force LLDAP to re-key its admin bind to *this install's*
 * `LLDAP_ADMIN_PASSWORD` via `LLDAP_FORCE_LDAP_USER_PASS_RESET=always`.
 * LLDAP seeds the admin password from env only on first DB init; on a
 * reinstall over a preserved `users.db` the DB keeps its old admin
 * password while Authelia binds with the new one → "Invalid Credentials"
 * (LDAP code 49) and an endless Authelia crash loop.
 *
 * `always` (NOT `true`, which one-shot resets then *exits* demanding a
 * restart without the flag — fatal with the flag baked permanently into
 * the pod env) re-syncs the admin password on every start AND keeps
 * serving. It only re-keys the admin account; LLDAP user accounts are
 * preserved.
 *
 * This is deliberately NOT gated on "was the secret freshly generated?".
 * The old heuristic (`isRegenerated ? 'always' : 'false'`) assumed a
 * reused/saved `LLDAP_ADMIN_PASSWORD` already matched a preserved
 * `users.db` — but once the saved secret and the DB diverge across
 * repeated reinstalls, the reused path never re-syncs and the bind fails
 * forever. Forcing `always` on every auth deploy closes that gap
 * idempotently (#666 / ARCH-15; the credential-reconciliation
 * "auto-rekey when safe" path for LLDAP).
 */
export function authDynamicVars(itemName: string): Record<string, string> {
  if (itemName === 'auth') {
    return { LLDAP_FORCE_LDAP_USER_PASS_RESET: 'always' };
  }
  return {};
}

/**
 * #1318 — find direct `{{VAR}}` interpolations in a pod template that would
 * render empty against `view`. Mustache turns an unfilled var into '', which
 * silently deploys a broken pod (empty image tag / env / mount) with no
 * breadcrumb. Section refs (`{{#VAR}}` / `{{^VAR}}` / `{{/VAR}}`) are
 * conditionals that are legitimately empty (e.g. `{{#ZWAVE_DEVICE}}`), so a
 * var used in a section is treated as optional and excluded; only *direct*
 * interpolations are considered. The caller warns (does not hard-fail) — some
 * direct refs are legitimately optional (an SSH key OR a password) and the
 * variable schema carries no `required` flag to tell them apart.
 */
export function findEmptyYamlVars(yaml: string, view: Record<string, string>): string[] {
  const sectionVars = new Set<string>();
  for (const m of yaml.matchAll(/\{\{\s*[#^/]\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g)) sectionVars.add(m[1]);
  const directRefs = new Set<string>();
  for (const m of yaml.matchAll(/\{\{\{?\s*([A-Z_][A-Z0-9_]*)\s*\}{2,3}/g)) directRefs.add(m[1]);
  return [...directRefs].filter(r => !sectionVars.has(r) && (!(r in view) || view[r] === ''));
}

/**
 * #2296 — post-render backstop: scan a rendered pod YAML for any `name: X`
 * env pair whose `value:` is the literal redaction sentinel (`<redacted>`).
 * The input guard in the runner already rejects the sentinel before render,
 * so a hit here means it slipped through some other path — hard-fail the
 * deploy rather than persist `<redacted>` as a live secret. Returns the env
 * var names carrying the sentinel value (empty when clean).
 */
export function findSentinelSecretsInYaml(yaml: string, sentinel: string): string[] {
  const out: string[] = [];
  // Match a kube env pair across one or two lines:
  //   - name: FOO
  //     value: "<redacted>"   (quoted or bare)
  const re = /name:\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:\n\s*)?value:\s*["']?([^"'\n]*)["']?/g;
  for (const m of yaml.matchAll(re)) {
    if (m[2] === sentinel) out.push(m[1]);
  }
  return out;
}

/**
 * #2296 — the hard-fail message for the post-render backstop: a rendered pod
 * env still carries the redaction mask. Pure so the copy is unit-tested rather
 * than only reached through the full deploy loop.
 */
export function buildRenderedSentinelError(itemName: string, sentinelSecrets: string[], sentinel: string): string {
  return `Cannot deploy ${itemName}: env var(s) rendered to the redaction mask '${sentinel}' instead of a real secret: ${sentinelSecrets.join(', ')}. Deploying this would take the service's auth offline — re-send the real secret value for these vars (#2296).`;
}

/**
 * #1724 — before the auth stack overwrites Authelia's `configuration.yml`,
 * merge any OIDC clients already on disk that the fresh render doesn't own
 * back into the file-to-be-written. Without this, redeploying `auth` wipes
 * every other stack's incrementally-registered SSO client.
 *
 * Mutates the matching `extraFiles` entry in place. Best-effort: any failure
 * to read the existing config leaves the fresh render untouched (the
 * post-deploy `ensureOidcClients` reconcile is the backstop) — never throws.
 *
 * Returns the on-disk config text it read (or null when there is none / it
 * couldn't be read), so the caller can run the #2417 rotation pre-flight
 * against it without paying for a second `read_file` round-trip.
 */
export async function preserveAutheliaOidcClients(
  jobId: string,
  node: string | undefined,
  extraFiles: { path: string; content: string }[],
): Promise<string | null> {
  // Authelia's config is the only `configuration.yml` the auth stack writes.
  const cf = extraFiles.find(f => f.path.endsWith('/configuration.yml') || f.path.endsWith('configuration.yml'));
  if (!cf) return null;

  try {
    const { agentManager } = await import('@/lib/agent/manager');
    const agent = await agentManager.ensureAgent(node || 'Local');
    const readRes = await agent.sendCommand('read_file', { path: cf.path }).catch(() => null);
    const existing = readRes ? (readRes.content || readRes.stdout || '') : '';
    if (!existing) return null; // fresh install — nothing on disk to preserve

    const { mergeAutheliaOidcClients } = await import('@/lib/capabilities/autheliaClientMerge');
    const merged = mergeAutheliaOidcClients(cf.content, existing);
    if (merged !== cf.content) {
      cf.content = merged;
      await log(jobId, 'ℹ️ Preserved existing Authelia OIDC client registrations across the auth redeploy (#1724).');
    }
    return existing;
  } catch (e) {
    await log(jobId, `⚠️ Could not preserve existing Authelia OIDC clients (${e instanceof Error ? e.message : String(e)}); the post-deploy reconcile will re-register this install's clients.`);
    return null;
  }
}

/**
 * Load a template's `post-deploy.py` **verbatim** — never Mustache-rendered (#2415).
 *
 * ONE contract covers both Python script types a template can ship —
 * `post-deploy.py` (here) and `migrations/v{N}-to-v{N+1}.py`
 * (`buildMigrationSteps` in `./migrations`): the body goes to the box
 * byte-identical and values travel through the process environment only.
 *
 * Template values reach the script through its process environment
 * (`buildPostDeployEnv` below: every wizard variable plus HOST, LAN_IP
 * and OPERATOR_EMAIL), so a text-substitution pass over the script body
 * buys nothing and costs a lot:
 *
 *   - Mustache DELETES every `{{…}}` it doesn't recognise as a known
 *     variable. That silently ate a `podman inspect --format
 *     '{{.Image}}|{{index .Config.Labels "…"}}'` down to `--format '|'`,
 *     which podman answers with `|` and exit 0 — indistinguishable from
 *     "field is empty" (mdopp/solarisbay#1092: five debugging rounds
 *     chasing a race that never existed). Go templates, Helm, Jinja and
 *     Python f-string `{{…}}` escapes are all in the blast radius.
 *   - Splicing a raw value into Python *source* is a correctness hazard
 *     in its own right: a quote, apostrophe or newline in the value
 *     breaks the script's syntax. `os.environ` has no such failure mode.
 *
 * Keep this a pass-through. If a script needs a value, add it to
 * `buildPostDeployEnv` — do not reintroduce rendering.
 */
export async function loadPostDeployScript(
  name: string,
  source?: string,
): Promise<string | undefined> {
  try {
    return (await getTemplatePostDeployScript(name, source)) || undefined;
  } catch {
    return undefined; // template ships no script — fine
  }
}

/**
 * The process environment the box hands to `post-deploy.py` and to every
 * migration step: every wizard variable, plus the server-side context each
 * template would otherwise have to wire through `variables.json`.
 *
 *   LAN_IP: the address rootless podman actually port-forwards to.
 *   With `hostNetwork: true` on a rootless pod, ports inside the
 *   container's namespace (e.g. immich-server binding [::1]:2283)
 *   are not always visible on the host's main loopback; podman
 *   publishes them on the LAN IP via the userspace forwarder.
 *   Templates that HTTP-probe their own service from the host
 *   post-deploy shell can fall back to this.
 *
 *   OPERATOR_EMAIL: the single email address ServiceBay already
 *   collects for outbound notifications, used as the canonical
 *   "the operator" identity. Templates seeding admin accounts
 *   (immich, audiobookshelf, navidrome…) use it as a fallback when
 *   their per-template <SERVICE>_ADMIN_EMAIL variable is blank, so
 *   the operator only ever has to type their email once. SSO auto-
 *   linking by email also flows through this.
 *
 * Both are best-effort; a missing config field just leaves the env
 * var unset and templates fall back to their own defaults.
 */
export async function buildPostDeployEnv(input: JobInput): Promise<Record<string, string>> {
  const postDeployEnv: Record<string, string> = {};
  for (const v of input.variables) {
    if (typeof v.value === 'string') postDeployEnv[v.name] = v.value;
  }
  postDeployEnv.HOST = input.host || 'localhost';

  try {
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (lanIp) postDeployEnv.LAN_IP = lanIp;
    const operatorEmail = config.notifications?.email?.to?.[0]?.trim();
    if (operatorEmail) postDeployEnv.OPERATOR_EMAIL = operatorEmail;
  } catch { /* leave env unset; templates handle missing values */ }

  return postDeployEnv;
}

/** What the kube-play phase needs on the wire for one item. */
export interface ItemAssets {
  yamlContent: string;
  kubeContent: string;
  extraFiles: { path: string; content: string }[];
}

/**
 * Render one item's pod spec + delivered files, running every guard that must
 * fire before anything reaches the box. Throws (after logging) when a guard
 * hard-fails; the caller turns that into the job's terminal error.
 */
export async function runAssetTransportPhase(
  jobId: string,
  input: JobInput,
  item: JobInputItem & { yaml: string },
): Promise<ItemAssets> {
  const view = (input.variables as StackVariable[]).reduce<Record<string, string>>((acc, v) => {
    acc[v.name] = v.value;
    return acc;
  }, {});

  // Inject dynamic variables for self-healing and template rendering.
  Object.assign(view, authDynamicVars(item.name));
  // Render YAML with the pod renderer — it escapes control chars (newlines in
  // a multi-line PEM/token) so they emit as `\n` inside the double-quoted
  // scalar rather than splitting it across lines and producing YAML that
  // podman's parser rejects → crash-loop on the next restart (#2206).
  const yamlContent = renderPodYaml(item.yaml, view);

  // #1318 — the pod YAML had no missing-var guard (config files did), so an
  // unfilled {{VAR}} rendered empty and deployed silently. Surface a
  // breadcrumb for any direct ref that rendered empty so a crash-looping pod
  // traces back to the unfilled variable. Warn rather than hard-fail: some
  // direct refs are legitimately optional and there is no required flag.
  const emptyYamlVars = findEmptyYamlVars(item.yaml, view);
  if (emptyYamlVars.length > 0) {
    await log(jobId, `⚠️ ${item.name}: pod template variable(s) rendered empty: ${emptyYamlVars.join(', ')}. ` +
      `If any are required, go back to Configure and fill them in (or check the template's variables.json defaults) — an empty value can crash-loop the pod.`);
  }

  // #2296 — post-render backstop: never let the redaction mask string reach
  // the pod as a real secret value. The runner's pre-render input guard
  // already rejects `<redacted>` before we get here, so a hit means it
  // slipped through another path — hard-fail rather than deploy a pod whose
  // secret envs are all `<redacted>` (the multi-service auth outage this bug
  // caused). Imported lazily to keep this phase's top-level imports lean.
  {
    const { REDACTION_SENTINEL } = await import('@/lib/mcp/redact');
    const sentinelSecrets = findSentinelSecretsInYaml(yamlContent, REDACTION_SENTINEL);
    if (sentinelSecrets.length > 0) {
      const msg = buildRenderedSentinelError(item.name, sentinelSecrets, REDACTION_SENTINEL);
      await log(jobId, `❌ ${msg}`);
      throw new Error(msg);
    }
  }

  const kubeContent =
    `[Kube]\nYaml=${item.name}.yml\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;

  // Sanity-check that every {{VAR}} in a config file has a value. Without
  // this, Mustache renders missing vars as empty strings — silent data
  // loss that produces crash-looping pods with no breadcrumb.
  const refRe = /\{\{\s*[#^/{]?\s*([A-Z_][A-Z0-9_]*)\s*\}{1,3}/g;
  for (const cf of (item.configFiles || [])) {
    if (!cf.targetPath) continue;
    // Asset files (#1156) ship content verbatim, so {{…}} in the body
    // isn't a placeholder reference — skip the missing-var sanity check
    // for them.
    if (cf.renderContent === false) continue;
    const refs = new Set<string>();
    for (const m of cf.content.matchAll(refRe)) refs.add(m[1]);
    const missing = [...refs].filter(r => !(r in view) || view[r] === '');
    if (missing.length > 0) {
      const msg = `Cannot deploy ${item.name}: ${cf.filename} references variable(s) with no value: ${missing.join(', ')}. ` +
        `Go back to the Configure step and fill them in (or check the template's variables.json defaults).`;
      await log(jobId, `❌ ${msg}`);
      throw new Error(msg);
    }
  }

  const extraFiles = (item.configFiles || [])
    .filter(cf => cf.targetPath)
    .map(cf => ({
      path: renderTemplate(cf.targetPath!, view),
      // Asset files (#1156) opt out of content rendering — SKILL.md
      // bodies may contain `{{...}}` literals as documentation that
      // Mustache would otherwise corrupt. Default-true preserves the
      // existing `.mustache` behaviour for config files.
      content: cf.renderContent === false ? cf.content : renderTemplate(cf.content, view),
    }));

  return { yamlContent, kubeContent, extraFiles };
}
