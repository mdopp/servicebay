/**
 * Template + install MCP tools (#2384 extraction): browsing the template
 * registry and driving the same wizard install flow the UI uses.
 */
import { z } from 'zod';
import { getTemplates, getReadme, getTemplateYaml, getTemplateVariables } from '@/lib/registry';
import { assembleManifest, applyVariableDefaults } from '@/lib/install/manifestAssembler';
import {
  createJob,
  getJob,
  readLog,
  getCurrentJob,
  InstallInProgressError,
  type JobInput,
  type WipeMode,
} from '@/lib/install/jobStore';
import { startJob } from '@/lib/install/runner';
import { redactLogText } from '../redact';
import { nodeParam, textResult, errorResult, type ToolRegistration } from './context';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerTemplateTools({ server }: ToolRegistration) {
  // --- List Templates ---
  server.tool('list_templates', 'List available deployment templates', {}, async () => {
    const templates = await getTemplates();
    return textResult(templates);
  });

  // --- Get Template Artifact (#2324) — one read-scoped tool with an
  // `artifact` discriminator. Replaces get_template_readme / get_template_yaml
  // / get_template_variables. ---
  server.tool(
    'get_template_artifact',
    'Get one artifact of a deployment template via `artifact`: "readme" (README/docs), "yaml" (the kube YAML), or "variables" (configurable variables).',
    {
      artifact: z.enum(['readme', 'yaml', 'variables']).describe('Which template artifact to fetch.'),
      name: z.string().describe('Template name'),
      type: z.enum(['template', 'stack']).optional().describe('Template type (default: template) — only used for artifact="readme".'),
      source: z.string().optional().describe('Registry source'),
    },
    async ({ artifact, name, type, source }) => {
      if (artifact === 'readme') {
        const readme = await getReadme(name, type ?? 'template', source);
        if (!readme) return errorResult(`No README found for template "${name}"`);
        return textResult(readme);
      }
      if (artifact === 'yaml') {
        const yaml = await getTemplateYaml(name, source);
        if (!yaml) return errorResult(`No YAML found for template "${name}"`);
        return textResult(yaml);
      }
      const vars = await getTemplateVariables(name, source);
      if (!vars) return errorResult(`No variables found for template "${name}"`);
      return textResult(vars);
    },
  );

  // --- Install Template (#2141) ---
  // Wraps the wizard's server-side flow — assembleManifest → createJob →
  // startJob — so an MCP client gets the FULL template deploy (variable
  // assembly, global injection, secret gen, subdomain→NPM proxy host, Authelia
  // wiring, dependency ordering, migrations), not the raw-YAML deploy_service
  // shortcut. Returns a jobId; poll get_install_progress for phase + logs +
  // deployed names. Mirrors POST /api/install/assemble + /api/install/start
  // by calling the same lib functions directly (no HTTP hop).
  server.tool(
    'install_template',
    'Install one or more templates the way the setup wizard does: assembles the manifest (variable defaults, global injection, secret generation), then starts the deploy job (subdomain→NPM proxy host, Authelia wiring, dependency ordering, migrations all included). Returns a jobId — poll get_install_progress to watch phase/logs and read the deployed service names. Use this instead of deploy_service when you want the full template flow (SSO/cert/proxy wiring), not a raw-YAML deploy.',
    {
      names: z.array(z.string().min(1)).min(1).describe('Template/stack name(s) to install, e.g. ["vaultwarden"].'),
      templateSource: z.string().optional().describe('Where to resolve the templates from: "Built-in", "Local", a registry name, or omit to walk all sources.'),
      variables: z.record(z.string(), z.string()).optional().describe('Variable overrides (name→value); win over template defaults. e.g. { SUBDOMAIN_TOR: "tor" }.'),
      wipeMode: z.enum(['install', 'wipe-config', 'wipe-all']).optional().describe('install (default, keep data) | wipe-config | wipe-all (destructive).'),
      node: nodeParam,
    },
    async ({ names, templateSource, variables, wipeMode, node }) => {
      try {
        const active = await getCurrentJob();
        if (active) {
          return errorResult(`An install job is already in progress (jobId=${active.id}, phase=${active.phase}). Wait for it to finish (poll get_install_progress) or abort it before starting another.`);
        }
        const assembled = await assembleManifest({
          items: names.map((name: string) => ({ name, checked: true })),
          prefilled: variables,
          templateSource,
        });
        const input: JobInput = {
          items: assembled.items,
          variables: assembled.variables,
          templateSource: templateSource ?? 'Built-in',
          host: 'localhost',
          wipeMode: (wipeMode as WipeMode | undefined) ?? 'install',
          ...(node ? { node } : {}),
        };
        const withDefaults = await applyVariableDefaults(input, templateSource);
        const job = await createJob({ source: 'mcp', input: withDefaults });
        startJob(job.id);
        return textResult({
          jobId: job.id,
          phase: job.phase,
          note: `Install started. Poll get_install_progress(jobId="${job.id}") for phase, logs, and deployed service names.`,
        });
      } catch (e) {
        if (e instanceof InstallInProgressError) {
          return errorResult(`An install job is already in progress (jobId=${e.existingJobId}). Poll get_install_progress or abort it first.`);
        }
        return errorResult(`Error starting install: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // --- Get Install Progress (#2141) ---
  server.tool(
    'get_install_progress',
    'Poll an install job (started via install_template) by jobId. Returns phase (running | needs_credentials | done | error | aborted | crashed), whether it is still active, the deployed service names so far, any error, and new log lines. Pass logsSince (the previous call\'s logsOffset) to fetch only newer lines.',
    {
      jobId: z.string().min(1).describe('The jobId returned by install_template.'),
      logsSince: z.number().int().min(0).optional().describe('Byte offset from a previous call (logsOffset) — returns only log lines added since then.'),
    },
    async ({ jobId, logsSince }) => {
      const job = await getJob(jobId);
      if (!job) return errorResult(`No install job found with id "${jobId}".`);
      const { content, nextOffset } = await readLog(jobId, logsSince);
      const active = job.phase === 'running' || job.phase === 'needs_credentials';
      return textResult({
        jobId: job.id,
        phase: job.phase,
        active,
        currentItem: job.progress.currentItem,
        deployedNames: job.progress.deployedNames,
        totalCount: job.progress.totalCount,
        needsCredentials: job.phase === 'needs_credentials',
        error: job.error,
        logs: redactLogText(content),
        logsOffset: nextOffset,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        endedAt: job.endedAt,
      });
    },
  );
}
