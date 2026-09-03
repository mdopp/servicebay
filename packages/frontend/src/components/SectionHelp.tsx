'use client';

import { useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { fetchHelpContent, TypedFetchError } from '@servicebay/api-client';

interface SectionHelpProps {
  helpId: string;
  label?: string;
  className?: string;
  /** Modal title. Defaults to "Section Help". */
  title?: string;
  /** Optional icon override for the trigger button. */
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}

export default function SectionHelp({ helpId, label, className, title = 'Section Help', icon: Icon = CircleHelp }: SectionHelpProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOpen = () => {
    setIsOpen(true);
    if (!content) {
      setLoading(true);
      fetchHelpContent(helpId)
        .then(data => {
          setContent(data.content || 'Help content not found.');
        })
        .catch((error: unknown) => {
          const status = error instanceof TypedFetchError ? error.status : undefined;
          setContent(status === 404 ? 'Help content not found.' : 'Failed to load help content.');
        })
        .finally(() => setLoading(false));
    }
  };

  const iconOnly = !label;
  const buttonClasses = `${iconOnly
    ? 'p-2 hover:bg-surface-2 rounded-full transition-colors text-text-subtle hover:text-accent-strong dark:hover:text-status-info'
    : 'inline-flex items-center gap-2 px-3 py-1 text-sm font-medium text-accent-strong hover:underline rounded-full bg-accent/10 border border-accent/20'} ${className ?? ''}`.trim();

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={buttonClasses}
        title={label || title}
      >
        <Icon size={iconOnly ? 20 : 16} />
        {label && <span>{label}</span>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:p-6 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-surface rounded-none sm:rounded-2xl shadow-2xl w-full h-full sm:h-auto sm:max-h-[85vh] max-w-none sm:max-w-[1024px] flex flex-col animate-in zoom-in-95 duration-200 border border-border">
            <div className="flex justify-between items-center p-4 border-b border-border">
              <h3 className="font-bold text-lg flex items-center gap-2">
                <Icon size={20} className="text-accent" />
                {title}
              </h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-surface-2 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto prose dark:prose-invert prose-sm max-w-none">
              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent"></div>
                </div>
              ) : (
                <ReactMarkdown>{content || ''}</ReactMarkdown>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
