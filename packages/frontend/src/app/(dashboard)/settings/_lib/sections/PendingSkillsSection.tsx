'use client';

import { useEffect, useState, useRef } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import ConfirmModal from '@/components/ConfirmModal';
import ReactMarkdown from 'react-markdown';

interface PendingSkill {
  slug: string;
  description: string | null;
  version: string | null;
  bytes: number;
  createdAt: string | null;
  preview: string;
}

interface PendingSkillCardProps {
  skill: PendingSkill;
  busy: 'load' | 'action' | null;
  onPromoteClick: (slug: string) => void;
  onRejectClick: (slug: string) => void;
}

function PendingSkillCard({ skill, busy, onPromoteClick, onRejectClick }: PendingSkillCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | string>(0);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      if (isOpen) {
        setHeight(previewRef.current?.scrollHeight ?? 'auto');
      } else {
        setHeight(0);
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [isOpen]);

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-colors">
      <div className="p-3 flex items-start gap-3">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
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
            onClick={() => onPromoteClick(skill.slug)}
            disabled={busy === 'action'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50 transition-colors"
            title="Move into the active skills dir and restart Hermes"
          >
            <Check size={14} /> Promote
          </button>
          <button
            onClick={() => onRejectClick(skill.slug)}
            disabled={busy === 'action'}
            className="p-1.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg disabled:opacity-50 transition-colors"
            title="Delete this draft"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      
      <div
        ref={previewRef}
        className="overflow-hidden"
        style={{
          maxHeight: isOpen ? (height === 'auto' ? 'auto' : `${height}px`) : '0px',
          opacity: isOpen ? 1 : 0,
          transition: 'max-height 350ms cubic-bezier(0.16, 1, 0.3, 1), opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-gray-50 dark:bg-gray-950/80 max-h-[420px] overflow-y-auto">
          <ReactMarkdown
            components={{
              h1: ({children}) => <h1 className="text-sm font-extrabold text-gray-900 dark:text-white mt-4 mb-2 first:mt-0 pb-1 border-b border-gray-200/50 dark:border-white/5">{children}</h1>,
              h2: ({children}) => <h2 className="text-xs font-bold text-gray-900 dark:text-white mt-3 mb-1.5">{children}</h2>,
              h3: ({children}) => <h3 className="text-xs font-semibold text-gray-800 dark:text-gray-200 mt-2 mb-1">{children}</h3>,
              p: ({children}) => <p className="text-xs text-gray-600 dark:text-gray-400 mb-2 leading-relaxed">{children}</p>,
              ul: ({children}) => <ul className="list-disc pl-4 mb-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">{children}</ul>,
              ol: ({children}) => <ol className="list-decimal pl-4 mb-2 space-y-1 text-xs text-gray-600 dark:text-gray-400">{children}</ol>,
              li: ({children}) => <li className="text-xs">{children}</li>,
              code: ({node, className, children, ...props}) => {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match;
                return isInline ? (
                  <code className="px-1.5 py-0.5 rounded bg-gray-200 dark:bg-white/5 font-mono text-[11px] text-pink-600 dark:text-pink-400 font-medium" {...props}>
                    {children}
                  </code>
                ) : (
                  <pre className="p-3 my-2 rounded-xl bg-gray-100 dark:bg-black/45 border border-gray-250 dark:border-white/5 overflow-x-auto text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                    <code className={className} {...props}>{children}</code>
                  </pre>
                );
              }
            }}
          >
            {skill.preview}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
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
  const { addToast, updateToast } = useToast();
  const [skills, setSkills] = useState<PendingSkill[]>([]);
  const [busy, setBusy] = useState<'load' | 'action' | null>('load');
  const [confirmPromoteSlug, setConfirmPromoteSlug] = useState<string | null>(null);
  const [confirmRejectSlug, setConfirmRejectSlug] = useState<string | null>(null);

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

  const executePromote = async (slug: string) => {
    setBusy('action');
    const toastId = addToast('info', 'Promoting skill...', `Deploying draft ${slug} into the active dynamic-skills directory.`);
    
    try {
      updateToast(toastId, 'info', 'Restarting Hermes Agent...', 'Initiating Hermes dynamic reload sequence. Active sessions may briefly disconnect.');
      
      const res = await fetch(`/api/oscar/pending-skills/${encodeURIComponent(slug)}/promote`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      
      if (res.ok) {
        if (data.restarted === false) {
          updateToast(toastId, 'warning', 'Promoted, but Hermes restart failed', data.restartError ?? 'Restart Hermes from the services page to load the new skill.');
        } else {
          updateToast(toastId, 'info', 'Verifying Hermes reboot status...', 'Polling container health check to verify successful launch.');
          
          let hermesActive = false;
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
              const statusRes = await fetch('/api/services/hermes/status');
              if (statusRes.ok) {
                const statusData = await statusRes.json();
                if (statusData.status === 'active' || statusData.status === 'running') {
                  hermesActive = true;
                  break;
                }
              }
            } catch (e) {
              // ignore fetch failures during container reboot
            }
          }
          
          if (hermesActive) {
            updateToast(toastId, 'success', 'Skill promoted & Hermes online', `${slug} is live and Hermes agent has successfully restarted.`);
          } else {
            updateToast(toastId, 'warning', 'Skill promoted, Hermes slow to respond', `${slug} deployed. Hermes container was restarted but is taking longer than expected to report active status.`);
          }
        }
        await load();
      } else {
        updateToast(toastId, 'error', 'Could not promote skill', data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      updateToast(toastId, 'error', 'Could not promote skill', e instanceof Error ? e.message : 'Network error during promotion.');
    } finally {
      setBusy(null);
    }
  };

  const executeReject = async (slug: string) => {
    setBusy('action');
    const toastId = addToast('info', 'Rejecting skill...', `Deleting pending draft skill ${slug}.`);
    try {
      const res = await fetch(`/api/oscar/pending-skills/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (res.ok) {
        updateToast(toastId, 'success', 'Skill rejected', `${slug} removed from pending.`);
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        updateToast(toastId, 'error', 'Could not reject skill', data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      updateToast(toastId, 'error', 'Could not reject skill', e instanceof Error ? e.message : 'Network error during rejection.');
    } finally {
      setBusy(null);
    }
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
            {skills.map(skill => (
              <PendingSkillCard
                key={skill.slug}
                skill={skill}
                busy={busy}
                onPromoteClick={setConfirmPromoteSlug}
                onRejectClick={setConfirmRejectSlug}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmPromoteSlug !== null}
        title={`Promote Skill: ${confirmPromoteSlug}`}
        message={
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              You are about to promote the dynamic skill <strong className="text-gray-900 dark:text-white">{confirmPromoteSlug}</strong>.
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              This will move the draft directory into the active skills directory and restart the **Hermes** container so the skill becomes active.
            </p>
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
              ℹ️ <strong>Deployment Notice:</strong> During the Hermes agent reload sequence, active conversational sessions may temporarily experience a brief 5-10s disconnect as the container reboots.
            </div>
          </div>
        }
        confirmText="Promote & Restart"
        onConfirm={() => {
          if (confirmPromoteSlug) {
            void executePromote(confirmPromoteSlug);
          }
          setConfirmPromoteSlug(null);
        }}
        onCancel={() => setConfirmPromoteSlug(null)}
      />

      <ConfirmModal
        isOpen={confirmRejectSlug !== null}
        title={`Reject Skill: ${confirmRejectSlug}`}
        message={
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Are you sure you want to reject the dynamic skill <strong className="text-gray-900 dark:text-white">{confirmRejectSlug}</strong>?
            </p>
            <p className="text-sm font-semibold text-red-600 dark:text-red-400">
              This will permanently delete the pending draft directory and all its contents. This action cannot be undone.
            </p>
          </div>
        }
        confirmText="Permanently Reject"
        isDestructive
        onConfirm={() => {
          if (confirmRejectSlug) {
            void executeReject(confirmRejectSlug);
          }
          setConfirmRejectSlug(null);
        }}
        onCancel={() => setConfirmRejectSlug(null)}
      />
    </div>
  );
}
