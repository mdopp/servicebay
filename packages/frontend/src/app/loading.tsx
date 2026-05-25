export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] text-[var(--foreground)]">
      <div className="flex flex-col items-center gap-3">
        <div
          className="w-8 h-8 rounded-full border-2 border-current/20 border-t-blue-500 animate-spin"
          aria-hidden="true"
        />
        <span className="text-sm opacity-60">Loading…</span>
      </div>
    </div>
  );
}
