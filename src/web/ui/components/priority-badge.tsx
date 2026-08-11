import { StatusBadge } from '@/components/status-badge';
import { priorityLabel, priorityTone } from '@/lib/status';

export function PriorityBadge({ priority }: { priority: string }) {
  return <StatusBadge tone={priorityTone(priority)} label={priorityLabel(priority)} />;
}
