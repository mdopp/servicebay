import { Suspense } from 'react';
import { RefreshCw } from 'lucide-react';
import OperatePage from './_lib/OperatePage';

export default async function ServiceDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center gap-2 p-8 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading service…
        </div>
      }
    >
      <OperatePage name={name} />
    </Suspense>
  );
}
