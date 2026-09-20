/**
 * Start a template install the way the setup wizard does — ONE implementation.
 *
 * `assembleManifest → applyVariableDefaults → createJob → startJob` is the
 * install pipeline's entry sequence, and it had grown three hand-kept copies:
 * the MCP tool `install_template`, the approved-install-request executor in
 * `installRequests.ts`, and (as of #2990) the REST route the agent CLI speaks.
 * Three copies of a four-call sequence is how one of them quietly stops
 * applying variable defaults. This is that sequence, once.
 *
 * It deliberately does NOT decide policy: the "is a job already running"
 * refusal, the scope gate and the wording of errors belong to each caller,
 * because each answers to a different audience (an MCP client, an operator
 * approval, a shell). What is shared is only the mechanics.
 */
import { assembleManifest, applyVariableDefaults } from './manifestAssembler';
import { createJob } from './jobStore';
import { startJob } from './runner';
import type { JobInput, WipeMode } from './jobStore';

export interface TemplateInstallStart {
  /** Template/stack names, e.g. `['vaultwarden']`. The installed service is
   *  named after the template — there is no per-install rename here. */
  names: string[];
  /** `'Built-in'`, `'Local'`, a registry name, or omitted to walk them all. */
  templateSource?: string;
  /** Variable overrides (name → value); they win over template defaults. */
  variables?: Record<string, string>;
  /** ADR 0004: default `install` — additive, keeps data. */
  wipeMode?: WipeMode;
  node?: string;
}

export interface StartedTemplateInstall {
  jobId: string;
  phase: string;
}

export async function startTemplateInstall(start: TemplateInstallStart): Promise<StartedTemplateInstall> {
  const assembled = await assembleManifest({
    items: start.names.map(name => ({ name, checked: true })),
    prefilled: start.variables,
    templateSource: start.templateSource,
  });
  const input: JobInput = {
    items: assembled.items,
    variables: assembled.variables,
    templateSource: start.templateSource ?? 'Built-in',
    host: 'localhost',
    wipeMode: start.wipeMode ?? 'install',
    ...(start.node ? { node: start.node } : {}),
  };
  const withDefaults = await applyVariableDefaults(input, start.templateSource);
  const job = await createJob({ source: 'mcp', input: withDefaults });
  startJob(job.id);
  return { jobId: job.id, phase: job.phase };
}
