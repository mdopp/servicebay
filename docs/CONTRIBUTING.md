# Contributor quickstart

How to add the three things contributors hit first: an MCP tool, a
capability handler, and a diagnose probe. Each section is a copy-pasteable
recipe plus a working example already in the tree to crib from.

For the surrounding context — runtime topology, module boundaries, install
flow — read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first. For *why* the
diagnose probe shape exists, read [`UX_PHILOSOPHY.md`](./UX_PHILOSOPHY.md).

## Dev environment

`README.md:148-167` covers the two supported dev paths (fast mode +
containerized). After it's up, the three workflows below need no extra
setup — `npm test` exercises them all.

## 1. Add a new MCP tool

MCP tools live in `packages/backend/src/lib/mcp/server.ts`. Each tool is
one `server.tool(...)` call that the safety layer wraps automatically
(scope check, audit log, redaction). You write the handler; you do not
write auth or audit code.

**The recipe:**

```ts
server.tool(
  'list_widgets',                               // tool name (snake_case)
  'List all widgets on a node with their state', // description (LLM-facing)
  { node: nodeParam },                           // zod schema for args
  async ({ node }) => {                          // handler
    const widgets = await readWidgets(node);
    return textResult(widgets);
  },
);
```

A read-only tool needs nothing more — `safeHandler` recognises tools
that don't mutate state and lets them through with audit logging only.

**Mutating tools** declare the scope they need:

```ts
server.tool(
  'restart_widget',
  'Restart a widget on a node',
  { node: nodeParam, name: z.string() },
  async ({ node, name }) => { ... },
  { auth: { scope: 'lifecycle' } },             // ← required for mutate
);
```

Scopes (from `lib/mcp/scope.ts`): `read` | `lifecycle` | `mutate` |
`destroy` | `exec`. A token with scope `lifecycle` can call any tool
whose handler is annotated with `lifecycle` *or weaker* (`read`).
Picking the lowest scope that covers the operation is the rule — don't
default to `mutate` for a service-restart.

**Allow-list / denylist:** `exec_command` and friends use the
allowlist/denylist in `lib/mcp/safety.ts`. New tools that wrap arbitrary
shell should join that allowlist explicitly rather than route around
it. See `safety.ts` for the pattern.

**Worked example:** `lib/mcp/server.ts:257` (`list_nodes`) for a
read tool; `lib/mcp/server.ts` `manage_service` for the
mutating-with-scope + discriminator pattern.

**Testing:** add a case to `lib/mcp/safety.test.ts` if the tool wraps
something dangerous, and rely on the integration coverage that already
exists for the bulk of routes. Pure read tools rarely need their own
test file — the route they call has one.

## 2. Add a new capability handler

Capability handlers react to **feature-lifecycle events** so install
runner doesn't grow a new hardcoded call every time a template needs
cross-service plumbing. The four events
(`feature.installing` / `feature.installed` / `feature.uninstalling` /
`feature.uninstalled`, defined in `lib/capabilities/types.ts`) carry the
template manifest + resolved variables. Handlers read what they need
from those — there's no template-specific branching in the handler.

**The recipe:**

1. Create `packages/backend/src/lib/capabilities/<service>.ts` with the
   handler functions and a `register<Service>Handlers(bus)` export.
2. Wire it into `lib/capabilities/init.ts`.

Skeleton:

```ts
// lib/capabilities/widget.ts
import type { CapabilityBus } from './bus';
import type { FeatureInstalledEvent, HandlerResult } from './types';

const HANDLER_NAME = 'widget.subscription';

export async function handleInstalled(
  event: FeatureInstalledEvent,
): Promise<HandlerResult> {
  // Read what the template asked for from event.variables.
  // Return { ok: true } on success, { ok: false, retryable: true|false,
  // message: '...' } on failure. Non-retryable errors veto the install.
}

export function registerWidgetHandlers(bus: CapabilityBus): void {
  bus.subscribe('feature.installed', HANDLER_NAME, handleInstalled);
}
```

Then in `lib/capabilities/init.ts`:

```ts
import { registerWidgetHandlers } from './widget';
// ...
registerWidgetHandlers(bus);
```

**Constraints you'll hit:**

- **Don't reach into template internals.** Read from `manifest`
  (annotations) and `variables` (wizard-resolved). If you need a new
  field, add it to `variables.json` and the contract in
  `lib/template/contract.ts`.
- **Idempotency.** Handlers can fire on a redeploy of the same template
  — make `handleInstalled` safe to run twice. The NPM handler delegates
  to its API route's existing create-if-missing semantics; the AdGuard
  handler diffs current state and only writes the missing entries.
- **Retryable vs non-retryable.** A handler that fails because a
  platform service is cold-starting returns `{ ok: false, retryable:
  true }`. A handler that fails because the manifest is malformed
  returns `{ ok: false, retryable: false }` and the install aborts.

**Worked example:** `lib/capabilities/nginx.ts` (proxy-host creation on
install, deletion on uninstall — both delegating to existing API
routes) and `lib/capabilities/adguard.ts` (DNS rewrite reconciliation,
diff-and-patch).

**Testing:** there's a `bus.test.ts` for the bus itself + per-handler
tests like `nginx.test.ts` / `authelia.test.ts`. New handlers add a
similarly-shaped file with the four-or-fewer interesting event shapes.

## 3. Add a new diagnose probe

Diagnose probes are the **structured-actions contract** from
`UX_PHILOSOPHY.md` §2 in code form: each probe ships a
`{ status, detail, actions[] }` shape and the operator gets named
buttons with consequences rather than a raw error. Read the philosophy
doc first — the *what* makes no sense without the *why*.

**The recipe** (three files):

1. `packages/backend/src/lib/diagnose/probes/<name>.ts` — the check
   function and its registered actions.
2. `packages/backend/src/lib/diagnose/runDiagnose.ts` — import the
   check function and push its result into the `probes[]` array (one
   try/catch block).
3. `packages/backend/src/lib/diagnose/probes/<name>.test.ts` — unit
   coverage of the status branches (`ok` / `warn` / `info` / `fail`).

Probe skeleton:

```ts
// lib/diagnose/probes/widgetStale.ts
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'widget_stale';

export interface WidgetStaleResult {
  status: 'ok' | 'warn' | 'info' | 'fail';
  detail: string;
  hint?: string;
}

export async function checkWidgetStale(): Promise<WidgetStaleResult> {
  // Detect. Skip with status: 'ok' (or 'info') when the precondition
  // isn't met — see adguardRewritesMissing.ts:62 for the "feature not
  // installed → skip" pattern.
  if (!conditionMet) {
    return { status: 'ok', detail: 'Widgets not installed — check skipped.' };
  }
  // ...
  if (problemFound) {
    return {
      status: 'warn',
      detail: `Widget cache is N hours stale (expected < 1h).`,
      hint: 'The refresher job hasn't run since 09:00. Click "Reseed cache" to retry.',
    };
  }
  return { status: 'ok', detail: 'Widgets fresh.' };
}

export async function reseedCache(): Promise<ProbeActionResult> {
  try {
    await doReseed();
    return { ok: true, message: 'Widget cache reseeded.', refresh: true };
  } catch (e) {
    return {
      ok: false,
      message: `Reseed failed: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reseed',
    label: 'Reseed cache',
    description: 'Re-runs the widget refresher and overwrites the stale cache. Idempotent.',
  },
  reseedCache,
);
```

Then in `runDiagnose.ts` (mirror an existing probe's pattern at
`runDiagnose.ts:790-810`):

```ts
import { checkWidgetStale } from '@/lib/diagnose/probes/widgetStale';
// ...
try {
  const w = await checkWidgetStale();
  probes.push({
    id: 'widget_stale',
    label: 'Widget cache freshness',
    status: w.status,
    detail: w.detail,
    hint: w.hint,
  });
} catch (e) {
  probes.push({
    id: 'widget_stale',
    label: 'Widget cache freshness',
    status: 'info',
    detail: `Skipped: ${e instanceof Error ? e.message : String(e)}`,
  });
}
```

**Action contract** (from `UX_PHILOSOPHY.md` §2):

- Every probe with a fail / warn status should ship at least one
  `action` — a named button that **does** something, not a "Retry"
  that re-runs the same check.
- Destructive actions set `destructive: true` so the UI shows a
  confirm-on-destructive guard. Wipes, resets, deletes go here.
- Action handlers return `{ ok, message, details?, refresh? }`. Setting
  `refresh: true` re-runs the probe set after the action completes —
  useful when the fix is expected to flip the probe's status.

**Pattern-aware probes** (`UX_PHILOSOPHY.md` §2a) — when there are
multiple legitimate good states (e.g. DNS Pattern A vs Pattern B),
*name the topology* in the OK message rather than just saying "OK".
The operator confirms the configuration they chose, not "trust me".

**Worked example:**
`lib/diagnose/probes/adguardRewritesMissing.ts` shows the full shape:
the skip-when-not-installed early-return, the warn-with-fix-action
case, the named "Reprovision" action with a description that spells
out what the action does and that it's idempotent.

**Testing:** every probe needs a test file covering each status
branch. See `probes/domainUnreachable.test.ts` for the standard
shape. Stub the network / config layer with vitest mocks; do not hit
real services in unit tests.
