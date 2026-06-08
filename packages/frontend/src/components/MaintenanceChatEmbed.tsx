'use client';

/**
 * Maintenance chat = an embed of solilos-chat (`chat.<publicDomain>`), not a
 * bespoke panel (servicebay#1781, supersedes HermesChatPanel).
 *
 * Why an iframe and not a ported component: solilos-chat is already a full,
 * design-matched chat client (streaming, thinking blocks, mermaid, /help,
 * attach/voice, search). Re-implementing those in a second React panel meant
 * perpetual drift; embedding gets every feature with one codebase. The
 * maintenance chat needs exactly ONE session, scoped to a server-enforced
 * "servicebay-maintenance" persona (solbay#229) — not the household Sol.
 *
 * The iframe is authenticated by the shared `*.<publicDomain>` Authelia SSO
 * cookie (no second login), and chat.<domain> opts admin.<domain> in via CSP
 * `frame-ancestors` (solbay#228). We hand solilos the embed contract on the
 * query string:
 *   - `embed=1`                          → focused layout (rail hidden, chat only)
 *   - `persona=servicebay-maintenance`   → locked maintenance persona
 *   - `accent` / `accent2` (hex, no `#`) → ServiceBay's blue palette so the
 *     embedded chat matches the admin UI instead of Sol-orange
 * Dark/light needs no param: the iframe inherits the OS `prefers-color-scheme`,
 * same as the admin shell.
 */

import type { ReactNode } from 'react';
import { useSystemMode } from '@/hooks/useSystemMode';

// ServiceBay accent palette handed to the embedded chat (Tailwind blue-500 /
// blue-600), so it renders in the admin UI's colours, not Sol-orange.
const SB_ACCENT = '3b82f6';
const SB_ACCENT_2 = '2563eb';

// The chat surface is the documented-stable `chat` subdomain (solilos
// HERMES_CHAT_SUBDOMAIN default; kept fixed so family bookmarks don't break).
const CHAT_SUBDOMAIN = 'chat';

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 text-center text-gray-500 dark:text-gray-400">
      <p className="max-w-sm">{children}</p>
    </div>
  );
}

export default function MaintenanceChatEmbed() {
  const mode = useSystemMode();

  // `publicDomain` is null until the box is onboarded with a domain; without it
  // there's no chat host to point at.
  if (mode && !mode.publicDomain) {
    return (
      <Notice>
        The maintenance chat opens once your server has a public domain
        configured. Finish onboarding to enable it.
      </Notice>
    );
  }
  if (!mode?.publicDomain) {
    return <Notice>Loading…</Notice>;
  }

  const src =
    `https://${CHAT_SUBDOMAIN}.${mode.publicDomain}/` +
    `?embed=1&persona=servicebay-maintenance` +
    `&accent=${SB_ACCENT}&accent2=${SB_ACCENT_2}`;

  return (
    <iframe
      src={src}
      title="Maintenance chat"
      className="w-full h-full border-0 rounded-2xl"
      // The chat's attach (camera/upload) + voice features need these.
      allow="clipboard-write; microphone; camera; fullscreen"
    />
  );
}
