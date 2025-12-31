import Sidebar from '@/components/Sidebar';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full bg-gray-100 dark:bg-black overflow-hidden p-4 gap-4">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-sm">
        {children}
      </main>
    </div>
  );
}
