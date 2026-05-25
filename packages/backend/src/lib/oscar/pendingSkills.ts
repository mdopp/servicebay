import path from 'path';
import { getExecutor } from '../executor';
import { listNodes } from '../nodes';
import { getConfig } from '../config';
import { logger } from '../logger';
import type { Executor } from '../interfaces';

const TAG = 'oscar:pending-skills';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PendingSkill {
  slug: string;
  description: string | null;
  version: string | null;
  bytes: number;
  createdAt: string | null;
  preview: string;
}

interface Locations {
  pendingRoot: string;
  activeRoot: string;
  nodeName: string;
}

function dataDir(): string {
  // The two install runners default to '/mnt/data/stacks' when no
  // operator override is set; keep the same fallback so list/promote
  // hit the directory the templates actually use on a fresh install.
  return '/mnt/data/stacks';
}

async function resolveLocations(requestedNode: string | undefined): Promise<Locations> {
  const config = await getConfig();
  const root = config.templateSettings?.DATA_DIR || dataDir();

  let nodeName = requestedNode;
  if (!nodeName || nodeName === 'Local') {
    const nodes = await listNodes();
    nodeName = nodes[0]?.Name || 'Local';
  }

  return {
    pendingRoot: path.posix.join(root, 'oscar-household', 'skills-pending'),
    activeRoot: path.posix.join(root, 'oscar-household', 'skills'),
    nodeName,
  };
}

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid skill slug: ${slug}. Must be lowercase alphanumeric + dashes, 1-64 chars, no leading dot.`);
  }
}

function parseFrontmatter(text: string): { description: string | null; version: string | null } {
  if (!text.startsWith('---')) return { description: null, version: null };
  const closeIdx = text.indexOf('\n---', 3);
  if (closeIdx < 0) return { description: null, version: null };
  const block = text.slice(3, closeIdx);
  let description: string | null = null;
  let version: string | null = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sepIdx = line.indexOf(':');
    if (sepIdx <= 0) continue;
    const key = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key === 'description' && description === null) description = value;
    if (key === 'version' && version === null) version = value;
  }
  return { description, version };
}

async function readSkillFile(executor: Executor, pendingRoot: string, slug: string): Promise<string | null> {
  try {
    return await executor.readFile(path.posix.join(pendingRoot, slug, 'SKILL.md'));
  } catch (err) {
    logger.warn(TAG, `could not read SKILL.md for ${slug}: ${(err as Error).message}`);
    return null;
  }
}

async function listSlugs(executor: Executor, pendingRoot: string): Promise<string[]> {
  try {
    if (!(await executor.exists(pendingRoot))) return [];
    const entries = await executor.readdir(pendingRoot);
    return entries.filter(entry => SLUG_RE.test(entry));
  } catch (err) {
    // The directory exists check above already handled the most common
    // "not yet created" case. Anything else is a real failure to surface.
    logger.warn(TAG, `could not list ${pendingRoot}: ${(err as Error).message}`);
    return [];
  }
}

async function statMtime(executor: Executor, target: string): Promise<string | null> {
  try {
    const { stdout } = await executor.execArgv(['stat', '-c', '%Y', target]);
    const epoch = Number(stdout.trim());
    if (!Number.isFinite(epoch)) return null;
    return new Date(epoch * 1000).toISOString();
  } catch {
    return null;
  }
}

export async function listPendingSkills(requestedNode?: string): Promise<PendingSkill[]> {
  const { pendingRoot, nodeName } = await resolveLocations(requestedNode);
  const executor = getExecutor(nodeName);
  const slugs = await listSlugs(executor, pendingRoot);
  const out: PendingSkill[] = [];
  for (const slug of slugs) {
    const skillPath = path.posix.join(pendingRoot, slug, 'SKILL.md');
    const content = await readSkillFile(executor, pendingRoot, slug);
    if (content === null) continue;
    const { description, version } = parseFrontmatter(content);
    const preview = content.length > 2000 ? content.slice(0, 2000) + '\n…' : content;
    out.push({
      slug,
      description,
      version,
      bytes: content.length,
      createdAt: await statMtime(executor, skillPath),
      preview,
    });
  }
  out.sort((a, b) => (a.createdAt && b.createdAt ? b.createdAt.localeCompare(a.createdAt) : a.slug.localeCompare(b.slug)));
  return out;
}

export async function promotePendingSkill(slug: string, requestedNode?: string): Promise<void> {
  assertSlug(slug);
  const { pendingRoot, activeRoot, nodeName } = await resolveLocations(requestedNode);
  const src = path.posix.join(pendingRoot, slug);
  const dst = path.posix.join(activeRoot, slug);
  const executor = getExecutor(nodeName);

  if (!(await executor.exists(path.posix.join(src, 'SKILL.md')))) {
    throw new Error(`Pending skill not found: ${slug}`);
  }
  if (await executor.exists(dst)) {
    throw new Error(`A skill named ${slug} is already active — rename the pending draft before promoting.`);
  }
  await executor.mkdir(activeRoot);
  await executor.rename(src, dst);
  logger.info(TAG, `promoted skill ${slug} on node ${nodeName}`);
}

export async function rejectPendingSkill(slug: string, requestedNode?: string): Promise<void> {
  assertSlug(slug);
  const { pendingRoot, nodeName } = await resolveLocations(requestedNode);
  const target = path.posix.join(pendingRoot, slug);
  const executor = getExecutor(nodeName);
  if (!(await executor.exists(target))) {
    // Idempotent — rejecting an already-deleted draft is fine.
    return;
  }
  await executor.rm(target);
  logger.info(TAG, `rejected skill ${slug} on node ${nodeName}`);
}
