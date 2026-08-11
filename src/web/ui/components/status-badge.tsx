import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StatusTone } from '@/lib/status';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: '',
  active: '',
  attention: '',
  done: '',
  error: '',
};

const TONE_VARIANT: Record<StatusTone, 'default' | 'secondary' | 'outline' | 'muted' | 'destructive'> = {
  neutral: 'outline',
  active: 'secondary',
  attention: 'default',
  done: 'muted',
  error: 'destructive',
};

export function StatusBadge({ tone, label, running }: { tone: StatusTone; label: string; running?: boolean }) {
  return (
    <Badge variant={TONE_VARIANT[tone]} className={cn('gap-1.5', TONE_CLASS[tone])}>
      {running ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {label}
    </Badge>
  );
}
