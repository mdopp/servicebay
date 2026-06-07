'use client';

/**
 * Native maintenance chat panel (#1755, part B of epic #1704).
 *
 * A minimal chat surface for operating / maintaining ServiceBay via Hermes.
 * It talks ONLY to the server-side seam `POST /api/system/hermes/chat`
 * (#1754) — that route holds the Hermes API key, maps the operator to the
 * single "ServiceBay administrator for families" maintenance session, and
 * returns `{ reply }`. The key never reaches the browser.
 *
 * Scope, deliberately small: ONE maintenance session, no session picker, no
 * history browser (the rich multi-session UI is the OSCAR household app, out
 * of scope here). When the route returns 503 (Hermes not installed / not
 * running) we show a calm "Hermes is unavailable" notice rather than
 * crashing or pretending the message went through.
 *
 * On mount the panel loads the session's prior conversation via GET
 * /api/system/hermes/chat (#1760) so leaving and returning to the page shows
 * the history that persists server-side, rather than an empty log. A 503 on
 * that load falls back to the empty/unavailable state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Send, AlertTriangle } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ChatMessage {
  /** Stable key for React; not sent to the server. */
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

let nextMessageId = 1;
function makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: nextMessageId++, role, content };
}

function EmptyState() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 dark:text-gray-400 gap-3">
      <Bot size={40} className="text-blue-500/70" />
      <div className="max-w-sm">
        <p className="font-semibold text-gray-700 dark:text-gray-200">Maintenance assistant</p>
        <p className="text-sm mt-1">
          Ask for help operating or maintaining your ServiceBay. It walks you through changes step
          by step and never touches your data without confirming first.
        </p>
      </div>
    </div>
  );
}

/**
 * Tailwind-styled element overrides for assistant Markdown (#1768). Keeps the
 * bubble readable: tight spacing, formatted headings/lists, inline + fenced
 * code blocks (incl. ```json) with a mono surface and horizontal scroll, and
 * links that open in a new tab with rel="noreferrer".
 */
const markdownComponents: Components = {
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="text-base font-semibold mt-2 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold mt-2 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="marker:text-gray-400">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  code: ({ node: _node, className, children, ...props }) => {
    // react-markdown gives inline code no language className; fenced blocks get
    // `language-*`. Render inline code as a small chip, fenced code is handled
    // by `pre` below (this just styles the inner <code>).
    const isBlock = typeof className === 'string' && className.startsWith('language-');
    if (isBlock) {
      return (
        <code className={`${className} font-mono text-xs`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="font-mono text-[0.85em] px-1 py-0.5 rounded bg-black/5 dark:bg-white/10"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1.5 p-3 rounded-lg overflow-x-auto bg-gray-900/90 dark:bg-black/40 text-gray-100 text-xs">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-gray-300 dark:border-white/20 pl-3 my-1 italic">
      {children}
    </blockquote>
  ),
};

/**
 * Assistant content rendered as Markdown (#1768). react-markdown is safe by
 * default — it does NOT parse raw HTML (no rehype-raw here), so model output
 * cannot inject markup; no dangerouslySetInnerHTML. remark-gfm adds tables,
 * task lists, autolinks. Plain text passes through unchanged.
 */
function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div
      data-testid={`hermes-msg-${message.role}`}
      className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[78%] px-4 py-2.5 rounded-2xl break-words text-sm ${
          isUser
            ? 'bg-blue-600 text-white rounded-tr-sm whitespace-pre-wrap'
            : 'bg-gray-100 dark:bg-white/[0.04] text-gray-800 dark:text-gray-100 rounded-tl-sm'
        }`}
      >
        {isUser ? message.content : <AssistantMarkdown content={message.content} />}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div data-testid="hermes-typing" className="flex gap-2.5">
      <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-gray-100 dark:bg-white/5 text-gray-600 dark:text-gray-300">
        <Bot size={16} />
      </div>
      <div className="px-4 py-3 rounded-2xl rounded-tl-sm bg-gray-100 dark:bg-white/[0.04] flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce [animation-delay:-0.3s]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce [animation-delay:-0.15s]" />
        <span className="w-2 h-2 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" />
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      data-testid="hermes-loading"
      className="h-full flex flex-col items-center justify-center text-center text-gray-500 dark:text-gray-400 gap-3"
    >
      <Bot size={40} className="text-blue-500/70 animate-pulse" />
      <p className="text-sm">Loading your conversation…</p>
    </div>
  );
}

function UnavailableNotice({ message }: { message: string }) {
  return (
    <div
      data-testid="hermes-unavailable"
      role="alert"
      className="flex items-start gap-2.5 px-4 py-3 rounded-2xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300 text-sm"
    >
      <AlertTriangle size={18} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

function Composer({
  value,
  disabled,
  onChange,
  onKeyDown,
  onSend,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
}) {
  return (
    <div className="flex items-end gap-2 rounded-2xl border border-gray-200/70 dark:border-white/5 bg-white/60 dark:bg-white/[0.02] backdrop-blur p-2">
      <textarea
        data-testid="hermes-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask the maintenance assistant…"
        aria-label="Message the maintenance assistant"
        className="flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none max-h-40"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled}
        aria-label="Send message"
        data-testid="hermes-send"
        className="shrink-0 p-2.5 rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Send size={18} />
      </button>
    </div>
  );
}

/** One persisted turn as returned by GET /api/system/hermes/chat. */
interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * On mount, restore the prior conversation that persists server-side (#1760)
 * via GET /api/system/hermes/chat. A 503 (Hermes down) falls back to the empty
 * state; a transport failure does too — never crash, never fabricate. Runs
 * once. `setMessages` populates the log; `setLoading(false)` ends the spinner.
 */
function useLoadHistory(setMessages: (m: ChatMessage[]) => void, setLoading: (v: boolean) => void) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/hermes/chat', { method: 'GET' });
        if (cancelled || res.status === 503) return;
        const body = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        const history: HistoryMessage[] = Array.isArray(body?.messages) ? body.messages : [];
        if (history.length > 0) setMessages(history.map((m) => makeMessage(m.role, m.text)));
      } catch {
        // Could not reach our own route — fall back to empty, don't crash.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Drives the conversation state + the call to the server-side chat seam. */
function useHermesChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  // True while the mount-time history load is in flight (before any send).
  const [loading, setLoading] = useState(true);
  // When the route reports 503 the assistant is unavailable — we surface a
  // banner rather than fabricating a reply (memory feedback_dont_mask_failures).
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useLoadHistory(setMessages, setLoading);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setMessages((prev) => [...prev, makeMessage('user', trimmed)]);
      setSending(true);
      setUnavailable(null);
      try {
        const res = await fetch('/api/system/hermes/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: trimmed }),
        });
        const body = await res.json().catch(() => ({}));
        const errorText = typeof body?.error === 'string' ? body.error : null;

        if (res.status === 503) {
          setUnavailable(errorText ?? 'Hermes is unavailable. Is the Hermes service running?');
        } else if (!res.ok) {
          setMessages((prev) => [
            ...prev,
            makeMessage(
              'assistant',
              errorText
                ? `Sorry — ${errorText}`
                : 'Sorry — something went wrong sending that message. Please try again.',
            ),
          ]);
        } else {
          const reply = typeof body?.reply === 'string' ? body.reply : '';
          setMessages((prev) => [
            ...prev,
            makeMessage('assistant', reply || '(Hermes returned an empty reply.)'),
          ]);
        }
      } catch {
        // Failure reaching our own route — treat like unavailable, don't crash.
        setUnavailable('Could not reach the chat service. Please try again.');
      } finally {
        setSending(false);
      }
    },
    [sending],
  );

  return { messages, sending, loading, unavailable, send };
}

export default function HermesChatPanel() {
  const { messages, sending, loading, unavailable, send } = useHermesChat();
  const [input, setInput] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const submit = useCallback(() => {
    const text = input;
    setInput('');
    void send(text);
  }, [input, send]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const showLoading = loading && messages.length === 0;
  const showEmptyState = !showLoading && messages.length === 0 && !sending && !unavailable;

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      <div
        ref={logRef}
        data-testid="hermes-chat-log"
        className="flex-1 min-h-0 overflow-y-auto rounded-2xl border border-gray-200/70 dark:border-white/5 bg-white/60 dark:bg-white/[0.02] backdrop-blur p-4 space-y-4"
      >
        {showLoading && <LoadingState />}
        {showEmptyState && <EmptyState />}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {sending && <TypingIndicator />}
      </div>

      {unavailable && <UnavailableNotice message={unavailable} />}

      <Composer
        value={input}
        disabled={sending || input.trim().length === 0}
        onChange={setInput}
        onKeyDown={onKeyDown}
        onSend={submit}
      />
    </div>
  );
}
