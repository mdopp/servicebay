/**
 * Registering a template source, so a new project can be installed at all.
 *
 * A repo only becomes installable once it is a **template source**. Until now
 * the only way in was the onboarding route — cookie-only, and it never adds an
 * item, it only toggles the feature on. So a new project meant editing
 * `config.json` by hand on the box, which no agent can do: it is the one step
 * that kept a session from installing anything it had just built.
 *
 * ## It verifies, it does not just record
 *
 * Writing the entry and answering "added" would be a silent success of the kind
 * this repo has spent a week removing: a source that is unreachable, private or
 * carries no templates looks exactly the same in `config.json` as one that
 * works. So a registration runs the sync immediately and reports what the
 * registry actually did — synced, failed with the reason, or skipped.
 *
 * Adding the entry is still the point, and a failed sync does not undo it: an
 * operator may be adding a repo that is about to exist, and silently dropping
 * their entry would be its own surprise. The answer says which of the two
 * happened.
 */
import { getConfig, saveConfig, type RegistryConfig } from '@/lib/config';
import { syncRegistries } from '@/lib/registry';
import { logger } from '@/lib/logger';

export interface AddSourceResult {
  name: string;
  url: string;
  branch?: string;
  /** False when a source with this name or URL was already registered. */
  added: boolean;
  /** Did the registry sync cleanly right after registration? */
  synced: boolean;
  detail: string;
}

export class TemplateSourceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'TemplateSourceError';
  }
}

/**
 * `https://github.com/mdopp/flutstunde.git` → `flutstunde`.
 *
 * The name is what `--source` takes and what shows up beside every template
 * from this repo, so it is derived from the URL rather than invented: a caller
 * who did not pick one still gets a name they can predict.
 */
export function deriveSourceName(url: string): string {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? '';
  const bare = last.replace(/\.git$/i, '').trim();
  return bare || 'source';
}

/** A URL git can actually clone, and nothing that reaches the local filesystem. */
export function assertUsableRepoUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) throw new TemplateSourceError('a repository URL is required');
  if (/^(https?|git|ssh):\/\//i.test(trimmed) || /^git@[^:]+:.+/.test(trimmed)) return;
  if (/^file:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    // A local path would make "add a source" a way to read the box's own
    // filesystem through the template loader. The jail exists for that.
    throw new TemplateSourceError(
      `"${trimmed}" is a local path, not a repository URL. A template source is cloned over https/ssh; `
      + 'to install a template you wrote yourself, write it under the local-templates directory instead '
      + '(`servicebay assist create-service`).',
    );
  }
  throw new TemplateSourceError(`"${trimmed}" is not a repository URL git can clone (expected https://…, ssh://… or git@host:path).`);
}

export async function addTemplateSource(input: { url: string; name?: string; branch?: string }): Promise<AddSourceResult> {
  assertUsableRepoUrl(input.url);
  const url = input.url.trim();
  const name = (input.name ?? deriveSourceName(url)).trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new TemplateSourceError(`"${name}" is not a usable source name (letters, digits, dot, dash, underscore; up to 64).`);
  }

  const config = await getConfig();
  const existing: RegistryConfig[] = Array.isArray(config.registries)
    ? config.registries
    : config.registries?.items ?? [];

  const already = existing.find(r => r.name === name || r.url === url);
  let added = false;
  if (!already) {
    config.registries = {
      // Adding a source while the mechanism is off would record an entry that
      // does nothing — the silent-success shape again. Registering one IS the
      // opt-in, and the answer says so.
      enabled: true,
      items: [...existing, { name, url, ...(input.branch ? { branch: input.branch } : {}) }],
    };
    await saveConfig(config);
    added = true;
    logger.info('templateSources', `registered template source ${name} (${url})`);
  } else if (config.registries && !Array.isArray(config.registries) && !config.registries.enabled) {
    config.registries = { ...config.registries, enabled: true };
    await saveConfig(config);
  }

  const { synced, detail } = await syncAndDescribe(name, Boolean(already));
  return { name, url, ...(input.branch ? { branch: input.branch } : {}), added, synced, detail };
}

/**
 * Run the sync and say what the REGISTRY did — never that a line was written.
 *
 * Four outcomes, and collapsing any of them into "added" is the silent success
 * this verb exists to avoid: synced, reported-and-failed, ran-but-said-nothing
 * about us, and could-not-run at all. In every failing case the entry stays:
 * an operator may be registering a repo that is about to exist, and dropping
 * it behind their back would be its own surprise.
 */
async function syncAndDescribe(name: string, already: boolean): Promise<{ synced: boolean; detail: string }> {
  const registered = already ? 'registered' : 'now registered';
  try {
    const summary = await syncRegistries({ force: true });
    const mine = summary.results.find(o => o.name === name);
    if (mine?.status === 'synced') {
      return {
        synced: true,
        detail: already
          ? `${name} was already registered; its templates are refreshed. Install one with \`servicebay install <template> --source ${name}\`.`
          : `${name} registered and synced. Install one of its templates with \`servicebay install <template> --source ${name}\`.`,
      };
    }
    if (mine) {
      return {
        synced: false,
        detail: `${name} is ${registered}, but the sync did not succeed: ${mine.reason ?? mine.status}.`
          + (mine.advice ? ` ${mine.advice}` : '')
          + ' The entry is kept — fix the repo or the access and it will pick up on the next sync.',
      };
    }
    return {
      synced: false,
      detail: `${name} is ${registered}, but the sync run did not report on it. `
        + 'Check `servicebay assists` / the registry list before relying on it.',
    };
  } catch (e) {
    return {
      synced: false,
      detail: `${name} is ${registered}, but the sync could not run: `
        + `${e instanceof Error ? e.message : String(e)}. The entry is kept.`,
    };
  }
}
