import { execFileSync } from 'node:child_process';
import os from 'node:os';

function vmStatPages(output: string, label: string): number | null {
  const match = output.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
  return match ? Number(match[1]) : null;
}

function vmStatPageSize(output: string): number | null {
  const match = output.match(/page size of (\d+) bytes/);
  return match ? Number(match[1]) : null;
}

function darwinAvailableMemory(): number | null {
  try {
    const output = execFileSync('vm_stat', [], { encoding: 'utf8' });
    const pageSize = vmStatPageSize(output);
    const free = vmStatPages(output, 'Pages free');
    const inactive = vmStatPages(output, 'Pages inactive');
    const purgeable = vmStatPages(output, 'Pages purgeable');
    if (pageSize === null || free === null || inactive === null || purgeable === null) return null;
    return (free + inactive + purgeable) * pageSize;
  } catch {
    return null;
  }
}

function totalMemoryFallback(): number {
  return Math.max(0, os.totalmem() - 2 * 1024 ** 3);
}

export function availableMemory(): number {
  if (process.platform !== 'darwin') return os.freemem();
  return darwinAvailableMemory() ?? totalMemoryFallback();
}
