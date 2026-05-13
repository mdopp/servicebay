/**
 * Welcome / "your account is ready" email composer (#418, follow-up
 * to #407). Used both right after access-request approval and from
 * the resend button in Settings → Integrations → Access Requests so
 * the message stays consistent.
 *
 * The portal URL prefers the bare apex (`https://<publicDomain>/`)
 * because that's the family-facing entry point — NPM rewrites the
 * apex to ServiceBay's /portal. Falls back to the LAN domain for
 * `lan`-mode installs, and to admin.<domain> only when nothing else
 * is configured.
 */
import { getConfig } from '@/lib/config';

export interface WelcomeEmailUrls {
  portalUrl: string | null;
  authUrl: string | null;
}

export async function getWelcomeEmailUrls(): Promise<WelcomeEmailUrls> {
  const config = await getConfig();
  const publicDomain = config.reverseProxy?.publicDomain;
  const lanDomain = config.reverseProxy?.lanDomain;
  if (publicDomain) {
    return {
      portalUrl: `https://${publicDomain}/`,
      authUrl: `https://auth.${publicDomain}/`,
    };
  }
  if (lanDomain) {
    return {
      portalUrl: `http://${lanDomain}/`,
      authUrl: `http://auth.${lanDomain}/`,
    };
  }
  return { portalUrl: null, authUrl: null };
}

export function composeWelcomeEmail(opts: {
  greetingName: string;
  username: string;
  portalUrl: string | null;
  authUrl: string | null;
}): { subject: string; body: string } {
  const lines: string[] = [
    `Hi ${opts.greetingName},`,
    ``,
    `Your account on our home server is ready. Your username is "${opts.username}".`,
    ``,
  ];
  if (opts.portalUrl) {
    lines.push(`Open the family portal: ${opts.portalUrl}`, ``);
  }
  lines.push(`First time signing in? You'll need to set your password:`);
  if (opts.authUrl) {
    lines.push(`  1. Go to ${opts.authUrl}`);
    lines.push(`  2. Click "Forgot password"`);
    lines.push(`  3. Enter your email — you'll get a link to set your password`);
  } else {
    lines.push(`  Click "Forgot password" on the login page — you'll get an email`);
    lines.push(`  with a link to set your password.`);
  }
  lines.push(``, `Have fun!`);

  return {
    subject: 'Your home server account is ready',
    body: lines.join('\n'),
  };
}
