import Sidebar from '@/components/Sidebar';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import OnboardingWizard from '@/components/OnboardingWizard';
import RestoreStatusBanner from '@/components/RestoreStatusBanner';
import CoreHealthBanner from '@/components/CoreHealthBanner';
import OfflineBanner from '@/components/OfflineBanner';

// Dashboard pages depend on the live Digital Twin state and SSH-pool
// connectivity; never try to pre-render them at build time.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row h-dvh w-full bg-gray-50 dark:bg-[#070709] overflow-hidden md:p-4 md:gap-4">
      <OnboardingWizard />
      <OfflineBanner />
      <RestoreStatusBanner />
      <CoreHealthBanner />
      <div className="hidden md:flex h-full shrink-0">
        <Sidebar />
      </div>
      
      <MobileTopBar />
      
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-[#0c0c0e] border border-gray-200/60 dark:border-white/5 rounded-2xl shadow-xl relative">
        {children}
      </main>

      <MobileBottomBar />
    </div>
  );
}
