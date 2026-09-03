import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { getConfig, saveConfig } from '@/lib/config';
import { OnboardingConfigRequestSchema } from '@servicebay/api-client';

export const dynamic = 'force-dynamic';

type Body = z.infer<typeof OnboardingConfigRequestSchema>;

/**
 * POST /api/system/onboarding/config — persist one wizard step's slice of
 * `config.json` (#2745, was the five `save*Config` server actions in
 * `app/actions/onboarding.ts`). One route, one discriminant per step: each
 * branch writes only the keys that step owns.
 */
export const POST = withApiHandler<Body>(
  { body: OnboardingConfigRequestSchema },
  async ({ body }) => {
    const config = await getConfig();

    switch (body.section) {
      case 'gateway':
        config.gateway = {
          type: 'fritzbox',
          host: body.host,
          username: body.username,
          password: body.password,
        };
        break;

      case 'publicDomain': {
        // Empty string means "LAN-only install" — an explicit operator choice.
        // Probes treat an absent publicDomain as not-configured, so clearing it
        // reverts to that state cleanly (#662).
        const cleaned = body.publicDomain.trim().toLowerCase();
        config.reverseProxy = { ...config.reverseProxy, publicDomain: cleaned || undefined };
        break;
      }

      case 'autoUpdate':
        config.autoUpdate = { ...config.autoUpdate, enabled: body.enabled };
        break;

      case 'registries':
        // No default external registry: `lib/registry.ts:getRegistries` already
        // prepends the canonical built-in one, so an empty `items` enables the
        // mechanism without cloning a URL that may not exist (#443).
        config.registries = { enabled: body.enabled, items: config.registries?.items || [] };
        break;

      case 'email':
        if (!config.notifications) config.notifications = {};
        config.notifications.email = {
          enabled: true, // saving the form is the opt-in
          host: body.email.host,
          port: body.email.port,
          secure: body.email.secure,
          user: body.email.user,
          pass: body.email.pass,
          from: body.email.from,
          to: body.email.recipients.split(',').map(s => s.trim()).filter(s => s.length > 0),
        };
        break;
    }

    await saveConfig(config);
    return { success: true as const };
  },
);
