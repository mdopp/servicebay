/**
 * Lint guard for ARCH-01 / #582.
 *
 * The wizard used to crash when a downstream registry didn't ship a
 * stack named exactly `full-stack`. The fix is a `?? availableStacks[0]`
 * fallback on every `availableStacks.find(...)` call site. This test
 * scans the wizard for that pattern and fails if any call site loses
 * its fallback — cheaper and more reliable than a full RTL render
 * given how large OnboardingWizard.tsx has grown.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WIZARD = path.join(REPO_ROOT, 'src', 'components', 'OnboardingWizard.tsx');

describe('OnboardingWizard stack lookup safety (#582)', () => {
  it('every availableStacks.find(...) has a fallback within 2 lines', () => {
    const source = fs.readFileSync(WIZARD, 'utf-8');
    const lines = source.split('\n');
    const callRe = /availableStacks\.find\s*\(/;
    const offenders: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (!callRe.test(lines[i])) continue;
      // Grab this line + the next two — the fallback may sit on the
      // next line (`?? availableStacks[0]`) when the call is wrapped.
      const window = lines.slice(i, i + 3).join(' ');
      const hasFallback = /\?\?\s*availableStacks\s*\[\s*0\s*\]/.test(window);
      if (!hasFallback) {
        offenders.push(`L${i + 1}: ${lines[i].trim()}`);
      }
    }

    expect(
      offenders,
      `availableStacks.find() without a \`?? availableStacks[0]\` fallback — ` +
      `a downstream registry without a stack named exactly 'full-stack' will crash here.\n` +
      `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
