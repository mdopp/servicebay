/**
 * Assist-catalog → MCP native-primitive mapping (#2326 slice 6).
 *
 * Slices 1–5 exposed the assist catalog over two MCP *tools* (`list_assists` /
 * `get_assist`). Those stay for back-compat. This module adds the mapping that
 * lets `createMcpServer` register the SAME catalog as MCP-*native* primitives:
 *
 *   - **Resources** — every assist (built-in + landed local) is an MCP Resource
 *     under an `assist://<id>` URI, so any MCP client natively lists + reads
 *     them without knowing our tool names. Resources reflect newly-landed
 *     local-assists dynamically because they enumerate via the same `listAssists`
 *     loader the tools use — nothing is snapshotted at server-construction time.
 *
 *   - **Prompts** — the curated, ACTIONABLE guides (kinds `guide`/`recipe`/
 *     `checklist`; ADR recommendations are `guide`-adjacent orientation and are
 *     included) are ALSO exposed as MCP Prompts, so a client can invoke an
 *     operational how-to by name. `footgun`/`snippet` kinds stay resources-only
 *     (they're reference/gotcha material, not a runnable walkthrough).
 *
 * The mapping lives here — a small, pure-ish data layer over the catalog — so it
 * is unit-testable directly without spinning up the full MCP server + a
 * transport. `server.ts` calls `registerAssistCatalog(server)` to wire it.
 *
 * Scope/visibility (#2325 consistency): reading assists is read-tier knowledge.
 * Assists carry no secrets by contract (the secret-scan gate,
 * tests/backend/assist_consistency.test.ts) and are already exposed to any
 * read-scoped token via list_assists/get_assist, so the resource/prompt surface
 * introduces no new privilege — it's an additional, equivalent read surface.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ListResourcesResult, ReadResourceResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { listAssists, getAssist, type AssistKind, type AssistSummary } from '@/lib/assists/catalog';

/** The `assist://` URI scheme every assist resource is served under. */
export const ASSIST_URI_SCHEME = 'assist';

/**
 * Assist kinds that make good ACTIONABLE prompts (runnable how-tos an agent can
 * follow start-to-finish). `guide` covers the orientation/how-to assists (e.g.
 * servicebay-overview) AND the ADR-style recommendation assists — the catalog
 * coerces an unknown kind to `guide`, and new-service-architecture is kind
 * `adr` which we intentionally include below. `footgun`/`snippet`/`template`
 * stay resources-only (reference/gotcha material, not a walkthrough).
 */
export const PROMPT_ASSIST_KINDS: readonly AssistKind[] = ['guide', 'recipe', 'checklist', 'adr'];

/** Build the canonical `assist://<id>` URI for an assist id. */
export function assistUri(id: string): string {
  return `${ASSIST_URI_SCHEME}://${id}`;
}

/**
 * Parse an `assist://<id>` URI back to its assist id, or null if the URI is not
 * an assist URI. Handles the landed `local/<slug>` namespaced ids: the `local/`
 * shows up in the URI path, so we recover it from the full href rather than
 * `URL.host` alone (which drops the path segment).
 */
export function assistIdFromUri(uri: string | URL): string | null {
  const href = typeof uri === 'string' ? uri : uri.href;
  const prefix = `${ASSIST_URI_SCHEME}://`;
  if (!href.startsWith(prefix)) return null;
  const id = decodeURIComponent(href.slice(prefix.length));
  return id.length > 0 ? id : null;
}

/**
 * A stable, MCP-safe prompt name for an assist. Prompt names should be simple
 * identifiers; the landed `local/<slug>` ids contain a `/`, so we flatten it to
 * `local_<slug>`. Prefixed `assist_` so the prompt namespace is self-describing
 * and can't collide with a future non-assist prompt.
 */
export function assistPromptName(id: string): string {
  return `assist_${id.replace(/\//g, '_')}`;
}

/**
 * Map an assist summary to its MCP Resource descriptor (the `resources/list`
 * entry shape). `source` (Built-in/Local) rides in both the description and the
 * `_meta`, and `kind` rides in `_meta` so a client can filter without a read.
 */
export function assistResourceDescriptor(a: AssistSummary): ListResourcesResult['resources'][number] {
  return {
    uri: assistUri(a.id),
    name: a.id,
    title: a.title,
    description: `[${a.source} · ${a.kind}] ${a.whenToUse}`.trim(),
    mimeType: 'text/markdown',
    _meta: { source: a.source, kind: a.kind, tags: a.tags },
  };
}

/** Enumerate every catalog assist as an MCP resource-list result. */
export async function listAssistResources(): Promise<ListResourcesResult> {
  const assists = await listAssists();
  return { resources: assists.map(assistResourceDescriptor) };
}

/**
 * Read one assist by its `assist://<id>` URI and return the MCP
 * read-resource result (the raw markdown). Throws if the id is unknown/unsafe —
 * the SDK turns a thrown error into a proper MCP error response.
 */
export async function readAssistResource(uri: URL): Promise<ReadResourceResult> {
  const id = assistIdFromUri(uri);
  if (!id) throw new Error(`Not an assist URI: ${uri.href}`);
  const body = await getAssist(id);
  if (body == null) throw new Error(`No assist found with id "${id}".`);
  return {
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }],
  };
}

/**
 * The curated set of assists exposed as MCP prompts: the actionable-kind
 * subset (guide/recipe/checklist/adr). Data-driven from the catalog — new
 * actionable assists (built-in OR landed local) appear automatically.
 */
export async function listPromptAssists(): Promise<AssistSummary[]> {
  const assists = await listAssists();
  const promptKinds = new Set<AssistKind>(PROMPT_ASSIST_KINDS);
  return assists.filter(a => promptKinds.has(a.kind));
}

/**
 * Read one assist and wrap its markdown as an MCP prompt result (a single user
 * message carrying the guide content). Throws for an unknown id.
 */
export async function readAssistPrompt(id: string): Promise<GetPromptResult> {
  const body = await getAssist(id);
  if (body == null) throw new Error(`No assist found with id "${id}".`);
  return {
    messages: [
      { role: 'user', content: { type: 'text', text: body } },
    ],
  };
}

/**
 * Register the assist catalog as MCP **resources** on `server` (synchronous).
 *
 * Registering a resource makes the SDK advertise the `resources` capability to
 * clients automatically (capability declaration is registration-driven), so
 * this is all that's needed for that advertisement — nothing in server.ts
 * suppresses it.
 *
 * Uses a ResourceTemplate (`assist://{id}`) whose list callback enumerates the
 * catalog LIVE and whose read callback resolves the id at read time — so
 * newly-landed local-assists show up without re-registration. Because the
 * enumeration is deferred to the (async) list callback, this registration
 * itself is synchronous and safe to call from the sync `createMcpServer`.
 */
export function registerAssistResources(server: McpServer): void {
  server.registerResource(
    'assist',
    new ResourceTemplate(`${ASSIST_URI_SCHEME}://{id}`, {
      list: async () => listAssistResources(),
    }),
    {
      title: 'ServiceBay assist catalog',
      description:
        'Task-help knowledge entries (guides, recipes, ADR-style recommendations, checklists, footguns, snippets) — built-in and landed local. Read one to get its full markdown.',
      mimeType: 'text/markdown',
    },
    async (uri) => readAssistResource(uri),
  );
}

/**
 * Register the curated actionable guides as MCP **prompts** on `server` (async).
 *
 * Registering a prompt makes the SDK advertise the `prompts` capability
 * automatically. Prompts are per-assist named (`assist_<id>`) and registered
 * from a snapshot of the current actionable assists — unlike resources, MCP
 * prompts have no template/list primitive to defer enumeration, so this must
 * fetch the catalog up front (hence async). A fresh server is built per MCP
 * request path, so a landed actionable assist becomes a prompt on the next
 * server construction; the resource surface is the always-live view, prompts
 * are the curated convenience layer over the actionable subset.
 */
export async function registerAssistPrompts(server: McpServer): Promise<void> {
  const promptAssists = await listPromptAssists();
  for (const a of promptAssists) {
    server.registerPrompt(
      assistPromptName(a.id),
      {
        title: a.title,
        description: `[${a.source} · ${a.kind}] ${a.whenToUse}`.trim(),
      },
      async () => readAssistPrompt(a.id),
    );
  }
}

/**
 * Register the full assist catalog (resources + prompts) on `server`. Async
 * because the prompt half needs a catalog snapshot; call it after
 * `createMcpServer(...).__baseServer` at the transport boundary (where an await
 * is available) so every MCP client gets both native surfaces.
 */
export async function registerAssistCatalog(server: McpServer): Promise<void> {
  registerAssistResources(server);
  await registerAssistPrompts(server);
}
