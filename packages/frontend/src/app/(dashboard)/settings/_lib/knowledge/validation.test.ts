// Client-side proposal validation mirrors the backend gate (#2228). These
// assert the two acceptance criteria the frontend owns pre-flight: required
// frontmatter + the secret scan that blocks a PEM key or sb_ token.
import { describe, it, expect } from 'vitest';
import { validateProposal, scanForSecret, parseFrontmatterKeys, stripFrontmatter } from './validation';

const VALID = `---
title: Do a thing
whenToUse: You need to do a thing.
kind: guide
tags: [a, b]
---
Body here.`;

describe('validateProposal — frontmatter contract', () => {
  it('accepts a well-formed body', () => {
    expect(validateProposal(VALID)).toEqual({ ok: true });
  });

  it('rejects empty content', () => {
    expect(validateProposal('   ').ok).toBe(false);
  });

  it('rejects a missing title', () => {
    const r = validateProposal(`---\nwhenToUse: x\nkind: guide\n---\nbody`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/title/);
  });

  it('rejects a missing whenToUse', () => {
    const r = validateProposal(`---\ntitle: x\nkind: guide\n---\nbody`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/whenToUse/);
  });

  it('accepts snake_case when_to_use', () => {
    const r = validateProposal(`---\ntitle: x\nwhen_to_use: y\nkind: recipe\n---\nbody`);
    expect(r.ok).toBe(true);
  });

  it('rejects an invalid kind enum', () => {
    const r = validateProposal(`---\ntitle: x\nwhenToUse: y\nkind: nonsense\n---\nbody`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/kind/);
  });
});

describe('secret scan — blocks committed credentials', () => {
  it('blocks a PEM private key', () => {
    const body = `${VALID}\n-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`;
    expect(scanForSecret(body)).toMatch(/PEM/);
    const r = validateProposal(body);
    expect(r.ok).toBe(false);
    // Error must not echo the secret material.
    expect(r.error).not.toMatch(/BEGIN RSA/);
  });

  it('blocks an sb_ box token', () => {
    const body = `${VALID}\ntoken: sb_abc123_ABCDEFGHIJKLMNOPQRSTUVWX`;
    expect(scanForSecret(body)).toMatch(/sb_/);
    expect(validateProposal(body).ok).toBe(false);
  });

  it('blocks a GitHub token', () => {
    const body = `${VALID}\nghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345`;
    expect(validateProposal(body).ok).toBe(false);
  });

  it('passes clean content', () => {
    expect(scanForSecret(VALID)).toBeNull();
  });
});

describe('parseFrontmatterKeys', () => {
  it('returns {} for a body without a frontmatter block', () => {
    expect(parseFrontmatterKeys('no frontmatter here')).toEqual({});
  });

  it('handles CRLF line endings', () => {
    const keys = parseFrontmatterKeys('---\r\ntitle: x\r\nkind: guide\r\n---\r\nbody');
    expect(keys.title).toBe('x');
    expect(keys.kind).toBe('guide');
  });

  it('strips surrounding quotes on a scalar', () => {
    const keys = parseFrontmatterKeys(`---\ntitle: "quoted"\n---\nbody`);
    expect(keys.title).toBe('quoted');
  });
});

describe('stripFrontmatter — RenderedBody must not leak YAML (#2231)', () => {
  it('drops the leading --- frontmatter block, keeps the body', () => {
    const out = stripFrontmatter(VALID);
    expect(out).toBe('Body here.');
    // the YAML must be gone
    expect(out).not.toMatch(/---/);
    expect(out).not.toMatch(/title:/);
    expect(out).not.toMatch(/whenToUse:/);
    expect(out).not.toMatch(/kind:/);
  });

  it('returns a body with no frontmatter unchanged', () => {
    expect(stripFrontmatter('# Just markdown\n\ntext')).toBe('# Just markdown\n\ntext');
  });

  it('does not strip a mid-document --- horizontal rule', () => {
    const doc = `---\ntitle: x\nkind: guide\n---\nintro\n\n---\n\nafter the rule`;
    const out = stripFrontmatter(doc);
    expect(out).toBe('intro\n\n---\n\nafter the rule');
    expect(out).not.toMatch(/title:/);
  });

  it('tolerates CRLF frontmatter fences', () => {
    const out = stripFrontmatter('---\r\ntitle: x\r\nkind: guide\r\n---\r\nbody text');
    expect(out).toBe('body text');
    expect(out).not.toMatch(/title:/);
  });
});
