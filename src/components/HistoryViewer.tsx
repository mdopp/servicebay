'use client';

import { useState, useEffect } from 'react';
import { HistoryEntry } from '@/lib/history';
import { Loader2, RotateCcw, Clock } from 'lucide-react';
import * as Diff from 'diff';

interface HistoryViewerProps {
  filename: string;
  currentContent: string;
  onRestore: (content: string) => void;
}

export default function HistoryViewer({ filename, currentContent, onRestore }: HistoryViewerProps) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionContent, setVersionContent] = useState<string | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);

  useEffect(() => {
    fetch(`/api/history/${filename}`)
      .then(res => res.json())
      .then(data => {
        setHistory(data);
        setLoading(false);
      });
  }, [filename]);

  const handleSelectVersion = async (timestamp: string) => {
    setSelectedVersion(timestamp);
    setLoadingVersion(true);
    try {
      const res = await fetch(`/api/history/${filename}?timestamp=${timestamp}`);
      const content = await res.text();
      setVersionContent(content);
    } finally {
      setLoadingVersion(false);
    }
  };

  const renderDiff = () => {
    if (!versionContent) return null;
    
    // Compare old (versionContent) with new (currentContent)
    // We want to see what changed FROM versionContent TO currentContent?
    // Or rather, we want to see what the difference is.
    // Usually "Diff" shows how to get from A to B.
    // If we want to see what was in the old version compared to now:
    // We can just show the diff.
    
    const diff = Diff.diffLines(versionContent, currentContent);
    
    return (
      <div className="font-mono text-xs md:text-sm whitespace-pre-wrap">
        {diff.map((part, index) => {
          // Added means present in current but not in old
          // Removed means present in old but not in current
          const color = part.added ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200' :
                        part.removed ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200' :
                        'text-gray-600 dark:text-gray-400';
          const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
          
          // Don't render empty parts
          if (!part.value) return null;

          return (
            <span key={index} className={`block ${color}`}>
              {part.value.split('\n').map((line, i) => {
                 // Skip the last empty line split often creates
                 if (i === part.value.split('\n').length - 1 && line === '') return null;
                 return <span key={i} className="block px-2">{prefix}{line}</span>;
              })}
            </span>
          );
        })}
      </div>
    );
  };

  if (loading) return <div className="flex justify-center p-8"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="flex h-full gap-4">
      <div className="w-64 border-r border-gray-200 dark:border-gray-800 overflow-y-auto shrink-0">
        <h3 className="font-bold mb-2 flex items-center gap-2 text-gray-700 dark:text-gray-300"><Clock size={16}/> History</h3>
        {history.length === 0 ? (
            <div className="text-gray-500 text-sm italic">No history available.</div>
        ) : (
            <div className="space-y-1 pr-2">
                {history.map(entry => (
                    <button
                        type="button"
                        key={entry.timestamp}
                        onClick={() => handleSelectVersion(entry.timestamp)}
                        className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                            selectedVersion === entry.timestamp 
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium' 
                            : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
                        }`}
                    >
                        {entry.displayDate}
                    </button>
                ))}
            </div>
        )}
      </div>
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {selectedVersion && versionContent ? (
            <>
                <div className="flex justify-between items-center mb-4 shrink-0">
                    <h3 className="font-bold text-gray-700 dark:text-gray-300">
                        Comparing: <span className="text-blue-600 dark:text-blue-400">{selectedVersion}</span> vs Current
                    </h3>
                    <button 
                        type="button"
                        onClick={() => onRestore(versionContent)}
                        className="flex items-center gap-2 bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1.5 rounded text-sm font-medium shadow-sm transition-colors"
                    >
                        <RotateCcw size={16} /> Restore this version
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-950 p-4 shadow-inner">
                    {loadingVersion ? <Loader2 className="animate-spin mx-auto" /> : renderDiff()}
                </div>
            </>
        ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-600">
                <Clock size={48} className="mb-4 opacity-20" />
                <p>Select a version from the left to compare</p>
            </div>
        )}
      </div>
    </div>
  );
}
