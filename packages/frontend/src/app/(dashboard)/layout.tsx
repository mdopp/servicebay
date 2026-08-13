import Sidebar from '@/components/Sidebar';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import OnboardingWizard from '@/components/OnboardingWizard';
import CredentialHandoverGate from '@/components/CredentialHandoverGate';
import RestoreStatusBanner from '@/components/RestoreStatusBanner';
import CoreHealthBanner from '@/components/CoreHealthBanner';
import OfflineBanner from '@/components/OfflineBanner';
import { PageFrame } from '@/components/ui';

// Dashboard pages depend on the live Digital Twin state and SSH-pool
// connectivity; never try to pre-render them at build time.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row h-dvh w-full bg-background dark:bg-background overflow-hidden md:p-4 md:gap-4">
      <OnboardingWizard />
      {/* #2560 — stands in front of everything until the passwords an
          install generated have been handed over. Mounted here, not in the
          install screen, so a headless install is covered too. */}
      <CredentialHandoverGate />
      <OfflineBanner />
      <RestoreStatusBanner />
      <CoreHealthBanner />
      <div className="hidden md:flex h-full shrink-0">
        <Sidebar />
      </div>
      
      <MobileTopBar />
      
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-surface border border-border/60 dark:border-white/5 rounded-2xl shadow-xl relative">
        {/* The single place a dashboard page's content width is decided (#2548).
            Pages must not set their own — see components/ui/PageFrame.tsx. */}
        <PageFrame>{children}</PageFrame>
      </main>

      <MobileBottomBar />
    </div>
  );
}
