#!/usr/bin/env node
/**
 * claude-dev → pi: wire the box's local model server into pi's models.json (#2803).
 *
 * pi reads custom providers from `<agent dir>/models.json` (default
 * `~/.pi/agent/models.json`). The operator decision on #2803 is that this
 * template configures EXACTLY ONE model source — the box's own
 * OpenAI-compatible llama-server, reached at
 * `http://host.containers.internal:18080/v1` per ADR 0007 (never a LAN IP,
 * never `localhost`: since claude-dev moved into its own netns that is the
 * pod's own loopback). No cloud provider, no `ANTHROPIC_API_KEY`, no
 * `OPENROUTER_API_KEY`, no pi OAuth — those may come later as optional
 * `type: "secret"` variables and are not part of this template.
 *
 * Two properties this script exists for:
 *
 *   1. **Merge, don't overwrite.** models.json lives on the /workspace volume
 *      and pi-web-ui's model panel writes to it. Rendering the whole file from
 *      the template on every boot would silently delete whatever the operator
 *      configured there. So only the `local-qwen` key of `providers` is
 *      replaced; everything else in the file is carried through untouched.
 *   2. **Don't guess the model id.** A llama-server names its models after the
 *      GGUF it loaded, which this repo cannot know. `CLAUDE_DEV_PI_MODEL_ID`
 *      pins it when the operator knows it; otherwise the caller discovers the
 *      ids from the server's own `/models` endpoint and passes them in. With
 *      neither, the provider is still written (so the endpoint is configured)
 *      and any model list already in the file is preserved rather than blanked.
 *
 * Exported as a pure function so tests can drive it without a filesystem or a
 * network; executing the file directly runs the boot path.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The one provider key this template owns. Everything else in models.json
 *  belongs to the operator and is never touched. */
export const PROVIDER_ID = 'local-qwen';

/**
 * pi treats a model as unavailable in `/model` until auth is configured for
 * its provider, so a keyless local server still needs a placeholder — this is
 * the value pi's own docs prescribe for that case (docs/models.md, "the
 * `apiKey` value is a placeholder because Ollama ignores it"). It is NOT a
 * credential: llama-server started without `--api-key` ignores it entirely,
 * and nothing on the box treats it as one.
 */
const PLACEHOLDER_API_KEY = 'local';

/**
 * Merge the local-qwen provider into a parsed models.json object.
 *
 * @param {object|null} existing            previously parsed models.json (or null/invalid)
 * @param {{baseUrl: string, modelIds?: string[]}} opts
 * @returns {{config: object, modelIds: string[], preserved: string[]}}
 */
export function mergeLocalQwenProvider(existing, { baseUrl, modelIds = [] }) {
  if (!baseUrl) throw new Error('baseUrl is required');

  const config =
    existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const providers =
    config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
      ? { ...config.providers }
      : {};

  const previous = providers[PROVIDER_ID];
  const previousModels =
    previous && Array.isArray(previous.models) ? previous.models.filter(m => m && m.id) : [];

  // An explicit / discovered id list wins; with none, keep whatever the file
  // already listed rather than blanking a working configuration.
  const ids = modelIds.filter(Boolean);
  const models = ids.length > 0 ? ids.map(id => ({ id })) : previousModels;

  // Every other provider key the operator added survives verbatim; the
  // provider names that were NOT ours are reported so the caller can log them.
  const preserved = Object.keys(providers).filter(k => k !== PROVIDER_ID);

  providers[PROVIDER_ID] = {
    baseUrl,
    api: 'openai-completions',
    apiKey: PLACEHOLDER_API_KEY,
    // llama-server and friends do not understand the `developer` role or
    // `reasoning_effort`; pi's docs prescribe turning both off for
    // OpenAI-compatible local servers (docs/models.md).
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models,
  };

  config.providers = providers;
  return { config, modelIds: models.map(m => m.id), preserved };
}

/**
 * Ask an OpenAI-compatible server which models it serves. Best-effort: the
 * model server is a sibling service that may simply not be up yet at container
 * boot, and that must not fail the boot — it only means the operator pins
 * CLAUDE_DEV_PI_MODEL_ID or restarts once the server is running.
 *
 * @returns {Promise<string[]>} model ids, or [] when the server is unreachable
 */
export async function discoverModelIds(baseUrl, { timeoutMs = 3000, fetchImpl = fetch } = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal });
    if (!res.ok) return [];
    const body = await res.json();
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows.map(r => r?.id).filter(id => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Read + parse models.json, tolerating "absent" and "corrupt" alike. */
export function readModelsFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** Write models.json atomically so a crash mid-write cannot truncate it. */
export function writeModelsFile(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function main() {
  const agentDir = process.env.PI_AGENT_DIR || path.join(process.env.HOME || '/workspace', '.pi', 'agent');
  const baseUrl = (process.env.CLAUDE_DEV_PI_MODEL_BASE_URL || '').trim();
  const pinned = (process.env.CLAUDE_DEV_PI_MODEL_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!baseUrl) {
    console.error('claude-dev: WARNING — CLAUDE_DEV_PI_MODEL_BASE_URL is empty; pi has no model source configured.');
    return 0;
  }

  const modelIds = pinned.length > 0 ? pinned : await discoverModelIds(baseUrl);
  const file = path.join(agentDir, 'models.json');
  const { config, modelIds: written, preserved } = mergeLocalQwenProvider(readModelsFile(file), {
    baseUrl,
    modelIds,
  });
  writeModelsFile(file, config);

  console.log(`claude-dev: pi model provider '${PROVIDER_ID}' -> ${baseUrl} (${file}).`);
  if (written.length > 0) {
    console.log(`claude-dev: pi models available from '${PROVIDER_ID}': ${written.join(', ')}.`);
  } else {
    console.error(
      `claude-dev: WARNING — ${baseUrl} listed no models and CLAUDE_DEV_PI_MODEL_ID is unset, ` +
      "so pi's /model picker will be empty. Start the model server and restart this container, " +
      'or set CLAUDE_DEV_PI_MODEL_ID to the id it serves.',
    );
  }
  if (preserved.length > 0) {
    console.log(`claude-dev: left ${preserved.length} operator-configured pi provider(s) untouched: ${preserved.join(', ')}.`);
  }
  return 0;
}

// Only when executed directly — importing this file (tests) must not write.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().then(code => process.exit(code)).catch(err => {
    console.error(`claude-dev: WARNING — could not seed pi's models.json: ${err?.message ?? err}`);
    process.exit(0);
  });
}
