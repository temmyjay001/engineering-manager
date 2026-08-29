import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const VM_STAT_OUTPUT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3817.
Pages active:                            159782.
Pages inactive:                          157051.
Pages speculative:                         1535.
Pages throttled:                              0.
Pages wired down:                        281726.
Pages purgeable:                              2.
"Translation faults":               34515273746.
Pages copy-on-write:                  696554586.
Pages zero filled:                   7057096439.
`;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('availableMemory', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
    execFileSyncMock.mockReset();
    vi.resetModules();
  });

  it('sums free, inactive, and purgeable pages on darwin', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue(VM_STAT_OUTPUT);
    const { availableMemory } = await import('../src/mem');
    const expected = (3817 + 157051 + 2) * 16384;
    expect(availableMemory()).toBe(expected);
  });

  it('falls back to a total-memory heuristic when vm_stat fails', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementation(() => {
      throw new Error('vm_stat not found');
    });
    vi.spyOn(os, 'totalmem').mockReturnValue(16 * 1024 ** 3);
    const { availableMemory } = await import('../src/mem');
    expect(availableMemory()).toBe(16 * 1024 ** 3 - 2 * 1024 ** 3);
  });

  it('falls back to a total-memory heuristic when vm_stat output is unparsable', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValue('unexpected output');
    vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 ** 3);
    const { availableMemory } = await import('../src/mem');
    expect(availableMemory()).toBe(8 * 1024 ** 3 - 2 * 1024 ** 3);
  });

  it('uses os.freemem on non-darwin platforms', async () => {
    setPlatform('linux');
    vi.spyOn(os, 'freemem').mockReturnValue(1234);
    const { availableMemory } = await import('../src/mem');
    expect(availableMemory()).toBe(1234);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
