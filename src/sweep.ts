import { execFileSync } from 'node:child_process';

const ORPHAN_PATTERNS = [/playwright-mcp/, /@playwright\/mcp/];

export function sweepOrphans(): number {
  let listing: string;
  try {
    listing = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3]!;
    if (ppid !== 1) continue;
    if (!ORPHAN_PATTERNS.some((p) => p.test(command))) continue;
    try {
      process.kill(pid, 'SIGKILL');
      reaped += 1;
    } catch {
      /* already gone or not ours to kill */
    }
  }
  return reaped;
}
