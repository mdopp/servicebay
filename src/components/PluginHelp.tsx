'use client';

import { useState } from 'react';
import { CircleHelp, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface PluginHelpProps {
  helpId: string;
  label?: string;
  className?: string;
}

export default function PluginHelp({ helpId, label, className }: PluginHelpProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOpen = () => {
    setIsOpen(true);
    if (!content) {
      setLoading(true);
      fetch(`/api/help?id=${helpId}`)
        .then(res => res.json())
        .then(data => {
          if (data.content) {
            setContent(data.content);
          } else {
            setContent('Help content not found.');
          }
        })
        .catch(() => setContent('Failed to load help content.'))
        .finally(() => setLoading(false));
    }
  };

  const iconOnly = !label;
  const buttonClasses = `${iconOnly
    ? 'p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400'
    : 'inline-flex items-center gap-2 px-3 py-1 text-sm font-medium text-blue-600 dark:text-blue-300 hover:underline rounded-full bg-blue-50/60 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40'} ${className ?? ''}`.trim();

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={buttonClasses}
        title={label || 'Help'}
      >
        <CircleHelp size={iconOnly ? 20 : 16} />
        {label && <span>{label}</span>}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col animate-in zoom-in-95 duration-200 border border-gray-200 dark:border-gray-800">
            <div className="flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-bold text-lg flex items-center gap-2">
                <CircleHelp size={20} className="text-blue-500" />
                Plugin Help
              </h3>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto prose dark:prose-invert prose-sm max-w-none">
              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
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
