'use client';

/**
 * Read the install job from `InstallJobProvider` (#2732). Thin wrapper so
 * tests can mock `@/hooks/useInstallJob` the way they mock
 * `@/hooks/useDigitalTwin`.
 */

import { useInstallJobContext, type InstallJobContextValue } from '@/providers/InstallJobProvider';

export type { InstallJobContextValue } from '@/providers/InstallJobProvider';

export function useInstallJob(): InstallJobContextValue {
  return useInstallJobContext();
}
