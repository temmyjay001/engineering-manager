import { ArrowLeft } from 'lucide-react';

export function BackLink({ fallback, className }: { fallback: string; className?: string }) {
  return (
    <a
      href={fallback}
      className={
        className ?? 'mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground'
      }
      onClick={(e) => {
        if (globalThis.history.length > 1) {
          e.preventDefault();
          globalThis.history.back();
        }
      }}
    >
      <ArrowLeft className="size-4" /> Back
    </a>
  );
}
