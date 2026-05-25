import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12 bg-[var(--background)] text-[var(--foreground)]">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-6xl font-mono opacity-40">404</div>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="opacity-70 text-sm">
          The page you’re looking for doesn’t exist or has been moved.
        </p>
        <div className="pt-2">
          <Link
            href="/"
            className="inline-block px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm transition"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
