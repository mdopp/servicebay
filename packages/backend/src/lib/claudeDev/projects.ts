/**
 * The control plane's caller for claude-dev's OWN project mechanics (#2714).
 *
 * The admin chat needs to create, restart and remove the dev box's Claude
 * projects. Those operations already exist — `addProject`, `restartProjectSession`
 * and `removeProject` in `templates/claude-dev/config-ui/server.mjs`, reached by
 * the configuration UI through `API_ROUTES`. They run INSIDE the claude-dev
 * container, where the checkouts, the tmux session and the `claude` CLI live, so
 * the backend cannot import them — but it must not re-implement them either.
 * Two paths that clone, delegate a token, anchor a tmux target and confirm a
 * restart would drift, and the next fix would land in only one of them (#2682's
 * anchored `claude:=<name>` target and its ask-tmux-afterwards rule are exactly
 * the properties that would be lost in the copy).
 *
 * So this module is a CALLER, not a second implementation: it resolves the
 * container's loopback address and speaks the three routes the panel speaks.
 * Everything that decides an outcome — name validation, the unmanaged-checkout
 * guard, the anchored kill target, the post-restart tmux re-read — stays in
 * `server.mjs` and answers here as a status plus a JSON body.
 *
 * ## Reaching it
 *
 * `CLAUDE_DEV_CONFIG_PORT` is published on the host's `127.0.0.1` only
 * (`templates/claude-dev/template.yml`), so the reverse proxy is the single way
 * in from a network. The backend is on the host side of that loopback, the same
 * way `lib/hermes/client.ts` reaches Hermes' loopback API (the ServiceBay
 * container runs `NetworkMode: host`, so its 127.0.0.1 is the host's).
 *
 * BOTH the port and the group are resolved through the ONE shared read-path
 * resolver (#2544) rather than assumed from the template's declared defaults.
 * The group especially: this box runs `CLAUDE_DEV_LDAP_GROUP=devs`, not the
 * declared `admins`, so a client that hard-coded the default would be refused
 * with a 403 on every single call.
 *
 * ## Identity
 *
 * `server.mjs` authenticates on the `Remote-User` identity Authelia hands nginx
 * and authorizes it against `CLAUDE_DEV_LDAP_GROUP` (SEAM 2). A call from here
 * does not come through Authelia, so it states an identity itself. That is not
 * a way around the gate — the authorization decision was already made, one layer
 * up and more strictly: the MCP scope gate (`destroy` for a removal) plus the
 * destroy-tier human-approval gate in `lib/mcp/server.ts`. What the header does
 * is carry WHO asked into the container's own log line, so a project that
 * appears or disappears is attributable to the token that asked for it rather
 * than to an anonymous localhost caller.
 */
import { getConfig, type AppConfig } from '@/lib/config';
import { getTemplateVariables } from '@/lib/registry';
import { resolveEffectiveVariable } from '@/lib/template/effectiveVariables';
import { logger } from '@/lib/logger';

/** The template that declares the variables below. */
export const CLAUDE_DEV_TEMPLATE = 'claude-dev';
/** Template variable holding the configuration UI's loopback port. */
const CONFIG_PORT_VAR = 'CLAUDE_DEV_CONFIG_PORT';
/** Template variable holding the group `server.mjs` authorizes against. */
const LDAP_GROUP_VAR = 'CLAUDE_DEV_LDAP_GROUP';
/** Last resort, used only when the template's `variables.json` cannot be read
 *  at all. NOT the declared default — that is read from the template, so a
 *  template that bumps it cannot drift away from this client (#2551). */
const DEFAULT_CONFIG_PORT = 8790;
/** Same, for the group. */
const DEFAULT_GROUP = 'admins';

/** Where the container's configuration UI is, and which group it wants. */
export interface ClaudeDevConnection {
  /** e.g. `http://127.0.0.1:8790` */
  baseUrl: string;
  /** The group `authorizeRequest` requires the caller to be in. */
  group: string;
}

/**
 * Resolve the loopback connection from config: global Template Setting >
 * operator-set `installedVariables` > the template's declared default (#2544).
 */
export async function resolveClaudeDevConnection(config: AppConfig): Promise<ClaudeDevConnection> {
  const declarations = await getTemplateVariables(CLAUDE_DEV_TEMPLATE).catch(() => null);
  const portRaw = resolveEffectiveVariable(config, declarations, CONFIG_PORT_VAR);
  const parsed = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIG_PORT;
  const group = resolveEffectiveVariable(config, declarations, LDAP_GROUP_VAR) || DEFAULT_GROUP;
  return { baseUrl: `http://127.0.0.1:${port}`, group };
}

/** The three verbs the operator asked for — one tool, one discriminator. */
export type ClaudeDevProjectAction = 'create' | 'delete' | 'restart';

export interface ClaudeDevProjectInput {
  action: ClaudeDevProjectAction;
  /** Project (= checkout = tmux window) name. Optional only on `create`, where
   *  the mechanics derive it from the clone URL. */
  name?: string;
  /** `create` only: the remote to clone. Omitted ⇒ adopt an existing checkout. */
  gitUrl?: string;
  /** `delete` only: "I know this checkout was not added through that page". */
  acknowledgeUnmanaged?: boolean;
  /** Who asked — carried into the container's log line. */
  caller?: string;
}

/** What happened, reported rather than inferred (the #2682 rule). */
export interface ClaudeDevProjectOutcome {
  ok: boolean;
  /** HTTP status from the container, or 0 when it could not be reached. */
  status: number;
  action: ClaudeDevProjectAction;
  /** The mechanics' own JSON body — `{ok, project|removed|restarted, warnings}`. */
  result?: unknown;
  /** Present only on a failure; the container's own sayable reason. */
  error?: string;
  detail?: string;
}

/**
 * `Remote-User` goes into an HTTP header, so it may not carry a newline (header
 * injection) and it may not be empty (an empty identity is what `server.mjs`
 * refuses). Token names are operator-set free text, so this is a real edge and
 * not a formality.
 */
export function callerIdentity(caller?: string): string {
  const cleaned = String(caller ?? '').replace(/[^A-Za-z0-9._@+-]/g, '').slice(0, 64);
  return cleaned || 'servicebay';
}

/** How long each verb may take. A clone is a network operation; the other two
 *  are tmux + a token revoke. */
const TIMEOUT_MS: Record<ClaudeDevProjectAction, number> = {
  create: 300_000,
  delete: 60_000,
  restart: 60_000,
};

/**
 * The route table, once. `server.mjs` reads the removal's arguments off the
 * QUERY string and the other two off a JSON body, so the mapping is spelled out
 * here rather than guessed per call site.
 */
function requestFor(input: ClaudeDevProjectInput): { method: string; path: string; body?: unknown } {
  const name = String(input.name ?? '').trim();
  if (input.action === 'create') {
    return { method: 'POST', path: '/api/projects', body: { url: input.gitUrl ?? '', name } };
  }
  if (input.action === 'restart') {
    return { method: 'POST', path: '/api/projects/restart', body: { name } };
  }
  const query = new URLSearchParams({ name });
  if (input.acknowledgeUnmanaged) query.set('acknowledgeUnmanaged', '1');
  return { method: 'DELETE', path: `/api/projects?${query.toString()}` };
}

/**
 * Which arguments each action actually needs. Passing a clone URL to a restart
 * is not harmless noise — it is a caller that believes something untrue about
 * what is going to happen, so it is refused rather than ignored.
 */
export function checkProjectArgs(input: ClaudeDevProjectInput): string {
  const name = String(input.name ?? '').trim();
  if (input.action !== 'create' && !name) {
    return `\`name\` is required for action "${input.action}" — it names the project to ${input.action}.`;
  }
  if (input.action === 'create' && !name && !input.gitUrl) {
    return 'action "create" needs a `gitUrl` to clone, or a `name` of a checkout that is already on the box to adopt.';
  }
  if (input.action !== 'create' && input.gitUrl) {
    return `\`gitUrl\` applies only to action "create"; action "${input.action}" does not clone anything.`;
  }
  if (input.action !== 'delete' && input.acknowledgeUnmanaged) {
    return `\`acknowledgeUnmanaged\` applies only to action "delete".`;
  }
  return '';
}

/**
 * Run ONE project operation against the container's own mechanics.
 *
 * Never throws for an outcome the container reported: a 404 on a project that
 * is not there, a 409 on an unmanaged checkout and a 500 on a session that did
 * not come back are all ANSWERS, and each is returned with the container's own
 * reason so the caller can say what happened instead of guessing.
 */
export async function callClaudeDevProject(
  input: ClaudeDevProjectInput,
  config?: AppConfig,
): Promise<ClaudeDevProjectOutcome> {
  const conn = await resolveClaudeDevConnection(config ?? await getConfig());
  const { method, path, body } = requestFor(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[input.action]);
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // SEAM 2's identity, stated by the control plane — see the module note.
        'Remote-User': callerIdentity(input.caller),
        'Remote-Groups': conn.group,
        'Remote-Name': 'ServiceBay',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('claude-dev', `project ${input.action} could not reach the configuration UI`, { reason });
    return {
      ok: false,
      status: 0,
      action: input.action,
      error: `claude-dev's configuration UI is not reachable at ${conn.baseUrl} — is the claude-dev service installed and running?`,
      detail: reason,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const payload = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      action: input.action,
      error: typeof payload.error === 'string' ? payload.error : text.slice(0, 300) || `HTTP ${res.status}`,
      ...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
    };
  }
  return { ok: true, status: res.status, action: input.action, result: parsed };
}
