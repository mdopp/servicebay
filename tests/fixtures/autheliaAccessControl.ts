/**
 * A small, faithful evaluator for Authelia's `access_control` table (#2936).
 *
 * Tests about "who may reach this host" have to assert ENFORCEMENT, not the
 * presence of a hostname somewhere in a YAML file. `pi.<domain>` stayed a
 * publicly reachable agent shell for a whole release because the test that was
 * supposed to cover it matched `CLAUDE_DEV_LDAP_GROUP` inside a log line — a
 * string that says nothing about whether anyone is actually refused.
 *
 * So this module reproduces the two rules of Authelia's matcher that decide the
 * outcome, and nothing else:
 *
 *   1. **Rules are evaluated top to bottom, first match wins.** No match at all
 *      → `default_policy`.
 *   2. **A `subject` mismatch SKIPS the rule, it does not deny.** This is the
 *      #878 trap: an `admins`-only rule above a `*.<domain>` family catch-all
 *      looks restrictive and lets every family user straight through to the
 *      host via the catch-all. The explicit-deny twin (same domains, no
 *      `subject`, `policy: deny`) is what actually closes it, and an evaluator
 *      is the only way a test can tell the two apart.
 *
 * `subject` semantics: the list is OR'd; a nested array is AND'd
 * (Authelia's documented `[[a, b], c]` shape). Entries are `group:<name>` or
 * `user:<name>`.
 *
 * Anonymous callers: Authelia skips every rule that carries subject criteria
 * (there is no subject to match yet) — so only a `bypass` rule can be reached
 * without signing in. That is exactly the property the auth portal's own rule
 * needs, and the reason `audience: "anonymous"` is checkable at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import Mustache from 'mustache';
import yaml from 'js-yaml';

interface AccessControlRule {
  domain?: unknown;
  policy?: unknown;
  subject?: unknown;
}

export interface AccessControlTable {
  defaultPolicy: string;
  rules: AccessControlRule[];
}

/** The signed-in principal a rule is evaluated against. `null` = anonymous. */
export interface Subject {
  user?: string;
  groups: string[];
}

/** Pull `access_control` out of a rendered Authelia `configuration.yml`. */
function parseAccessControl(renderedYaml: string): AccessControlTable {
  const doc = yaml.load(renderedYaml) as
    | { access_control?: { default_policy?: unknown; rules?: unknown } }
    | undefined;
  const ac = doc?.access_control;
  const defaultPolicy = typeof ac?.default_policy === 'string' ? ac.default_policy : 'deny';
  const rules = Array.isArray(ac?.rules) ? (ac.rules as AccessControlRule[]) : [];
  return { defaultPolicy, rules };
}

/**
 * Parse the SHIPPED auth template's access_control table against a stand-in
 * public domain. Only `PUBLIC_DOMAIN` affects that table; every other
 * placeholder renders empty, which is harmless — the document is parsed, never
 * deployed. Both the class gate and the per-template tests go through here, so
 * they can never end up asserting against two different renders.
 */
export function authTemplateAccessControl(
  repoRoot: string,
  publicDomain: string,
): AccessControlTable {
  const src = fs.readFileSync(
    path.join(repoRoot, 'templates', 'auth', 'configuration.yml.mustache'),
    'utf-8',
  );
  return parseAccessControl(Mustache.render(src, { PUBLIC_DOMAIN: publicDomain }));
}

function asList(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Authelia's domain matcher: exact host, or a single-label `*.` wildcard. */
function domainMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (p === h) return true;
  if (!p.startsWith('*.')) return false;
  const suffix = p.slice(1); // '.example.test'
  if (!h.endsWith(suffix)) return false;
  const label = h.slice(0, h.length - suffix.length);
  return label.length > 0 && !label.includes('.');
}

function subjectEntryMatches(entry: string, subject: Subject): boolean {
  const e = entry.trim().toLowerCase();
  if (e.startsWith('group:')) return subject.groups.some(g => g.toLowerCase() === e.slice(6));
  if (e.startsWith('user:')) return (subject.user ?? '').toLowerCase() === e.slice(5);
  return false;
}

/** OR over entries; a nested array is AND'd. */
function subjectMatches(criteria: unknown, subject: Subject): boolean {
  if (criteria === undefined || criteria === null) return true;
  const list = Array.isArray(criteria) ? criteria : [criteria];
  if (list.length === 0) return true;
  return list.some(entry => {
    if (Array.isArray(entry)) {
      const all = entry.filter((x): x is string => typeof x === 'string');
      return all.length > 0 && all.every(e => subjectEntryMatches(e, subject));
    }
    return typeof entry === 'string' && subjectEntryMatches(entry, subject);
  });
}

/**
 * The policy Authelia would apply to `host` for `subject`
 * (`null` = not signed in). Returns `default_policy` when nothing matches.
 */
export function policyFor(
  table: AccessControlTable,
  host: string,
  subject: Subject | null,
): string {
  for (const rule of table.rules) {
    const policy = typeof rule.policy === 'string' ? rule.policy : '';
    if (!asList(rule.domain).some(d => domainMatches(d, host))) continue;
    const hasSubjectCriteria = rule.subject !== undefined && rule.subject !== null;
    if (subject === null) {
      // Anonymous: only a subject-free rule can be reached.
      if (hasSubjectCriteria) continue;
    } else if (!subjectMatches(rule.subject, subject)) {
      continue; // subject mismatch SKIPS — it does not deny (#878)
    }
    return policy;
  }
  return table.defaultPolicy;
}

/** True when the policy actually lets the request through to the upstream. */
export function isAllowed(policy: string): boolean {
  return policy === 'bypass' || policy === 'one_factor' || policy === 'two_factor';
}

/**
 * The host labels named by every rule that grants access to the admins group
 * and to nobody else — i.e. the admin-surface table, read back out of the
 * rendered config rather than out of a hard-coded list.
 */
export function adminOnlyHostLabels(table: AccessControlTable, publicDomain: string): string[] {
  const labels = new Set<string>();
  for (const rule of table.rules) {
    for (const pattern of asList(rule.domain)) {
      const p = pattern.trim().toLowerCase();
      if (p.startsWith('*.')) continue;
      if (!p.endsWith(`.${publicDomain.toLowerCase()}`)) continue;
      const label = p.slice(0, p.length - publicDomain.length - 1);
      if (label.includes('.')) continue;
      const family: Subject = { groups: ['family'] };
      const admin: Subject = { groups: ['admins'] };
      if (!isAllowed(policyFor(table, p, family)) && isAllowed(policyFor(table, p, admin))) {
        labels.add(label);
      }
    }
  }
  return [...labels].sort();
}
