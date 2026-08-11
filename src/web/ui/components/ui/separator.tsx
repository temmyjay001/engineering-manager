import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Separator({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('h-px w-full shrink-0 bg-border', className)} {...props} />;
}
