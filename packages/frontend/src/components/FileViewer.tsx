'use client';

import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/themes/prism-tomorrow.css';

interface FileViewerProps {
  content: string;
  language: string;
}

export default function FileViewer({ content, language }: FileViewerProps) {
  return (
    <div className="bg-surface-muted text-text min-h-[500px]">
        <Editor
        value={content}
        onValueChange={() => {}}
        highlight={code => {
            const grammar = Prism.languages[language];
            if (!grammar) {
                // Simple HTML escape for plain text
                return code
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&#39;");
            }
            return Prism.highlight(code, grammar, language);
        }}
        padding={20}
        style={{
            fontFamily: '"Fira code", "Fira Mono", monospace',
            fontSize: 14,
        }}
        className="min-h-[500px]"
        readOnly
        />
    </div>
  );
}
