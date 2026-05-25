'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface PendingSkill {
  slug: string;
  description: string | null;
  version: string | null;
  bytes: number;
  createdAt: string | null;
  preview: string;
}

/**
 * Admin-promotion gate for OSCAR's dynamic-skill compiler (#940).
 *
 * OSCAR's `dynamic-skills` skill drafts new SKILL.md files into the
 * pending directory rather than the active one. This panel lists those
 * drafts, lets the admin inspect the generated Markdown, and either
 * promote (move into the active dir + restart Hermes) or reject
 * (delete). Without the gate, a prompt-injected family-member chat
 * session could have OSCAR grant itself arbitrary code execution by
 * writing a malicious skill straight into the loader's scan dir.
 */
export default function PendingSkillsSection() {
  const { addToast } = useToast();
  const [skills, setSkills] = useState<PendingSkill[]>([]);
  const [busy, setBusy] = useState<'load' | 'action' | null>('load');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async () => {
    try {
      const res = await fetch('/api/oscar/pending-skills');
      if (res.ok) {
        const data = await res.json();
        setSkills(Array.isArray(data.skills) ? data.skills : []);
      } else {
        addToast('error', 'Could not load pending skills', `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onPromote = async (slug: string) => {
    if (!window.confirm(`Promote ${slug}? The draft moves into the active skills directory and Hermes is restarted so the loader picks it up. You can roll back by deleting the directory from disk or rejecting before promoting.`)) return;
    setBusy('action');
    try {
      const res = await fetch(`/api/oscar/pending-skills/${encodeURIComponent(slug)}/promote`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.restarted === false) {
          addToast('warning', 'Promoted, but Hermes restart failed', data.restartError ?? 'Restart Hermes from the services page to load the new skill.');
        } else {
          addToast('success', 'Skill promoted', `${slug} is live. Hermes restarted.`);
        }
        await load();
      } else {
        addToast('error', 'Could not promote', data.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const onReject = async (slug: string) => {
    if (!window.confirm(`Reject ${slug}? The draft directory is deleted. No undo.`)) return;
    setBusy('action');
    try {
      const res = await fetch(`/api/oscar/pending-skills/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (res.ok) {
        addToast('success', 'Skill rejected', `${slug} removed from pending.`);
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        addToast('error', 'Could not reject', data.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  const toggleExpand = (slug: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  if (busy === 'load') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading pending OSCAR skills…
      </div>
    );
  }

  return (
    <div id="pending-skills" className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full scroll-mt-24">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg text-amber-600 dark:text-amber-400">
          <ShieldAlert size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">
            Pending OSCAR skills
            {skills.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold text-white bg-amber-500 rounded-full">
                {skills.length}
              </span>
            )}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Drafts written by OSCAR&apos;s dynamic-skills compiler. Inspect the SKILL.md, then <span className="font-medium">Promote</span> to make it live (moves into <span className="font-mono">/opt/data/skills/oscar/</span> and restarts Hermes), or <span className="font-medium">Reject</span> to delete the draft.
          </p>
        </div>
      </div>

      <div className="p-6">
        {skills.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            No pending drafts. OSCAR will list new skill proposals here when its dynamic-skills compiler runs.
          </p>
        ) : (
          <div className="space-y-2">
            {skills.map(skill => {
              const isOpen = expanded.has(skill.slug);
              return (
                <div key={skill.slug} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
                  <div className="p-3 flex items-start gap-3">
                    <button
                      onClick={() => toggleExpand(skill.slug)}
                      className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                      title={isOpen ? 'Collapse' : 'Expand SKILL.md'}
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium text-gray-900 dark:text-white">{skill.slug}</span>
                        {skill.version && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[11px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded">
                            v{skill.version}
                          </span>
                        )}
                        <span className="text-[11px] text-gray-500 dark:text-gray-400">
                          {skill.bytes.toLocaleString()} bytes
                        </span>
                        {skill.createdAt && (
                          <span className="text-[11px] text-gray-500 dark:text-gray-400">
                            · {new Date(skill.createdAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {skill.description && (
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{skill.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onPromote(skill.slug)}
                        disabled={busy === 'action'}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50"
                        title="Move into the active skills dir and restart Hermes"
                      >
                        <Check size={14} /> Promote
                      </button>
                      <button
                        onClick={() => onReject(skill.slug)}
                        disabled={busy === 'action'}
                        className="p-1.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50"
                        title="Delete this draft"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  {isOpen && (
                    <pre className="border-t border-gray-200 dark:border-gray-700 p-3 text-xs font-mono text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-950 overflow-x-auto whitespace-pre-wrap break-words max-h-[420px] overflow-y-auto">
                      {skill.preview}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
