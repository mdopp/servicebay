import Sidebar from '@/components/Sidebar';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import OnboardingWizard from '@/components/OnboardingWizard';
import RestoreStatusBanner from '@/components/RestoreStatusBanner';
import CoreHealthBanner from '@/components/CoreHealthBanner';

// Dashboard pages depend on the live Digital Twin state and SSH-pool
// connectivity; never try to pre-render them at build time.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row h-dvh w-full bg-gray-100 dark:bg-black overflow-hidden md:p-4 md:gap-4">
      <OnboardingWizard />
      <RestoreStatusBanner />
      <CoreHealthBanner />
      <div className="hidden md:flex h-full shrink-0">
        <Sidebar />
      </div>
      
      <MobileTopBar />
      
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-sm relative">
        {children}
      </main>

      <MobileBottomBar />
    </div>
  );
}
