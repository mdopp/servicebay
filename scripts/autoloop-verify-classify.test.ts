import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseSchemaVersion,
  parsePodContainerNames,
  classifyTemplateFile,
  classifyChanges,
  parseRange,
  formatVerdict,
  type ChangedFile,
} from './autoloop-verify-classify';

/** A minimal but realistic template manifest, shaped like `templates/<name>/template.yml`. */
function manifest(opts: { schemaVersion: number; containers: string[] }): string {
  const containers = opts.containers
    .map(
      name => `  - name: ${name}
    image: ghcr.io/example/${name}:latest
    env:
      - name: TZ
        value: "UTC"
      - name: PORT
        value: "8080"
`,
    )
    .join('');
  return `apiVersion: v1
kind: Pod
metadata:
  name: demo
  annotations:
    servicebay.label: "Demo"
    servicebay.schema-version: "${opts.schemaVersion}"
    servicebay.ports: "8080/tcp"
spec:
  containers:
${containers}  volumes:
  - name: demo-data
    persistentVolumeClaim:
      claimName: demo-data
`;
}

const v3 = manifest({ schemaVersion: 3, containers: ['demo'] });

describe('parseSchemaVersion', () => {
  it('reads the servicebay.schema-version annotation', () => {
    expect(parseSchemaVersion(v3)).toBe(3);
  });
  it('tolerates an unquoted value and a trailing comment', () => {
    expect(parseSchemaVersion('    servicebay.schema-version: 5  # bumped')).toBe(5);
  });
  it('defaults to 1 when the annotation is missing or unparseable', () => {
    expect(parseSchemaVersion('apiVersion: v1\n')).toBe(1);
    expect(parseSchemaVersion('    servicebay.schema-version: "abc"')).toBe(1);
    expect(parseSchemaVersion(null)).toBe(1);
  });
});

describe('parsePodContainerNames', () => {
  it('lists the pod containers', () => {
    expect(parsePodContainerNames(v3)).toEqual(['demo']);
  });
  it('does not count env entries or volumes as containers', () => {
    const withMoreEnv = v3.replace(
      '      - name: PORT\n        value: "8080"\n',
      '      - name: PORT\n        value: "8080"\n      - name: EXTRA\n        value: "1"\n',
    );
    expect(parsePodContainerNames(withMoreEnv)).toEqual(['demo']);
  });
  it('picks up a name declared on the line after the dash', () => {
    const yaml = `spec:
  containers:
  - image: ghcr.io/example/a:latest
    name: a
  volumes:
  - name: vol
`;
    expect(parsePodContainerNames(yaml)).toEqual(['a']);
  });
  it('includes initContainers', () => {
    const yaml = `spec:
  initContainers:
  - name: seed
    image: busybox
  containers:
  - name: app
    image: app
`;
    expect(parsePodContainerNames(yaml)).toEqual(['seed', 'app']);
  });
  it('returns nothing for a manifest without containers', () => {
    expect(parsePodContainerNames('apiVersion: v1\n')).toEqual([]);
  });
});

// The acceptance matrix from #2825 — the four cases the prose allowlist got wrong.
describe('templates/** classification (the #2823 gap)', () => {
  it('(1) a rendered asset edit at the same schema version stays LIGHT', () => {
    const changes: ChangedFile[] = [
      { status: 'M', path: 'templates/demo/config-ui/public/shell.css' },
      { status: 'M', path: 'templates/demo/template.yml', before: v3, after: v3.replace('UTC', 'Europe/Berlin') },
    ];
    const result = classifyChanges(changes);
    expect(result.path).toBe('light');
    expect(result.reasons).toEqual([]);
  });

  it('(2) a template.yml schemaVersion bump classifies FULL', () => {
    const changes: ChangedFile[] = [
      { status: 'M', path: 'templates/demo/template.yml', before: v3, after: manifest({ schemaVersion: 4, containers: ['demo'] }) },
    ];
    const result = classifyChanges(changes);
    expect(result.path).toBe('full');
    expect(result.reasons.join('\n')).toMatch(/schema-version 3 → 4/);
  });

  it('(3) a new templates/*/migrations/* file classifies FULL', () => {
    const result = classifyChanges([{ status: 'A', path: 'templates/demo/migrations/v3-to-v4.py' }]);
    expect(result.path).toBe('full');
    expect(result.reasons.join('\n')).toMatch(/migration script/);
  });

  it('(4) a new container added to an existing pod classifies FULL', () => {
    const changes: ChangedFile[] = [
      {
        status: 'M',
        path: 'templates/demo/template.yml',
        before: v3,
        after: manifest({ schemaVersion: 3, containers: ['demo', 'sidecar'] }),
      },
    ];
    const result = classifyChanges(changes);
    expect(result.path).toBe('full');
    expect(result.reasons.join('\n')).toMatch(/container\(s\) added to the pod: sidecar/);
  });

  it('a brand-new template manifest classifies FULL (absent from the :latest image)', () => {
    const result = classifyChanges([{ status: 'A', path: 'templates/fresh/template.yml', before: null, after: v3 }]);
    expect(result.path).toBe('full');
    expect(result.reasons.join('\n')).toMatch(/new template manifest/);
  });

  it('a removed template does not force a FULL flip', () => {
    expect(classifyTemplateFile({ status: 'D', path: 'templates/gone/template.yml', before: v3, after: null })).toBeNull();
  });
});

describe('non-template classification', () => {
  it('an app request-path file is FULL', () => {
    const result = classifyChanges([{ status: 'M', path: 'packages/frontend/src/app/api/system/nginx/route.ts' }]);
    expect(result.path).toBe('full');
    expect(result.files.full).toEqual(['packages/frontend/src/app/api/system/nginx/route.ts']);
  });
  it('the render-only allowlist stays LIGHT', () => {
    const result = classifyChanges([{ status: 'M', path: 'packages/backend/src/lib/stackInstall/forwardAuth.ts' }]);
    expect(result.path).toBe('light');
  });
  it('an unlisted source file falls through to FULL ("if in doubt, go FULL")', () => {
    const result = classifyChanges([{ status: 'M', path: 'packages/backend/src/lib/services/lifecycle/deploy.ts' }]);
    expect(result.path).toBe('full');
  });
  it('docs, playbooks, scripts and tests are ignored, not FULL', () => {
    const result = classifyChanges([
      { status: 'M', path: 'docs/ARCHITECTURE_INVARIANTS.md' },
      { status: 'M', path: '.claude/skills/autoloop-issues/stages/box-verify.md' },
      { status: 'A', path: 'scripts/autoloop-verify-classify.ts' },
      { status: 'M', path: 'packages/backend/src/lib/install/runner.test.ts' },
    ]);
    expect(result.path).toBe('light');
    expect(result.files.full).toEqual([]);
    expect(result.files.ignored).toHaveLength(4);
  });
  it('one FULL file outweighs any number of LIGHT ones', () => {
    const result = classifyChanges([
      { status: 'M', path: 'templates/demo/README.md' },
      { status: 'M', path: 'templates/demo/variables.json' },
      { status: 'A', path: 'templates/demo/migrations/v1-to-v2.py' },
    ]);
    expect(result.path).toBe('full');
  });
});

describe('cli surface', () => {
  it('accepts both a range and two revs', () => {
    expect(parseRange(['a..b'])).toEqual({ base: 'a', head: 'b' });
    expect(parseRange(['a..'])).toEqual({ base: 'a', head: 'HEAD' });
    expect(parseRange(['a', 'b'])).toEqual({ base: 'a', head: 'b' });
    expect(parseRange(['a'])).toEqual({ base: 'a', head: 'HEAD' });
    expect(parseRange([])).toBeNull();
  });
  it('emits a single machine-readable verdict line', () => {
    const line = formatVerdict(classifyChanges([{ status: 'A', path: 'templates/demo/migrations/v1-to-v2.py' }]));
    expect(line.startsWith('AUTOLOOP_VERIFY_CLASS ')).toBe(true);
    expect(JSON.parse(line.slice('AUTOLOOP_VERIFY_CLASS '.length)).path).toBe('full');
  });
});

describe('box-verify.md Step 0 is wired to the classifier', () => {
  const playbook = readFileSync('.claude/skills/autoloop-issues/stages/box-verify.md', 'utf8');

  it('calls the classifier', () => {
    expect(playbook).toMatch(/npm run autoloop:classify/);
    expect(playbook).toMatch(/AUTOLOOP_VERIFY_CLASS/);
  });

  it('no longer puts templates/** on the render-only list wholesale', () => {
    const renderOnly = playbook.split('\n').filter(l => l.includes('**Render-only**'));
    expect(renderOnly).toHaveLength(1);
    expect(renderOnly[0]).not.toContain('`templates/**`');
    expect(playbook).toMatch(/servicebay\.schema-version` bump/);
  });
});
