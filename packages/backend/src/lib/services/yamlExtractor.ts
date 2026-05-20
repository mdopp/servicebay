/**
 * Quadlet YAML parser with per-(node, path) content-hash cache (#589).
 *
 * Lifted from ServiceManager.listServices, which inlined the cache +
 * yaml.loadAll call. Same semantics — cache returns the parsed docs
 * unchanged when the content hash hasn't moved, otherwise re-parses
 * and updates the cache.
 *
 * Pure module-level Map: lives for the process lifetime, gets cleared
 * when the file content changes (typical hot-reload pattern), and
 * doesn't grow without bound because each (nodeName, yamlPath) entry
 * gets overwritten on content change.
 */

import yaml from 'js-yaml';
import type { PodLikeDoc } from './containerNameMatcher';

interface CacheEntry {
  hash: string;
  parsed: PodLikeDoc[];
}

const cache = new Map<string, CacheEntry>();

/**
 * Parse a multi-doc YAML string into an array of Pod-like docs,
 * returning the cached result when the content matches the previous
 * parse for the same `cacheKey`. Errors are swallowed and represented
 * as an empty array — callers treat "no docs" the same as "parse
 * failed" (both fall back to the systemd-naming-only matcher path).
 */
export function parseQuadletYaml(content: string, cacheKey: string): PodLikeDoc[] {
  const cached = cache.get(cacheKey);
  if (cached && cached.hash === content) return cached.parsed;
  try {
    const docs = (yaml.loadAll(content) as PodLikeDoc[]) ?? [];
    cache.set(cacheKey, { hash: content, parsed: docs });
    return docs;
  } catch {
    cache.set(cacheKey, { hash: content, parsed: [] });
    return [];
  }
}

