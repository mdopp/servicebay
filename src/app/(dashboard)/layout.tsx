import Sidebar from '@/components/Sidebar';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import OnboardingWizard from '@/components/OnboardingWizard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-gray-100 dark:bg-black overflow-hidden md:p-4 md:gap-4">
      <OnboardingWizard />
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
