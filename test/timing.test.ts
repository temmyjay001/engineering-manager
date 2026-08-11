import { describe, expect, it } from 'vitest';
import { epicLeadTimeMs, humanDuration, parseDbDate, ticketLeadTimeMs } from '../src/domain/timing';
import type { Transition } from '../src/domain/types';

function tr(toState: Transition['toState'], createdAt: string): Transition {
  return {
    id: 1,
    ticketId: 1,
    fromState: 'UAT',
    toState,
    role: null,
    verdict: null,
    note: null,
    createdAt,
  };
}

describe('parseDbDate', () => {
  it('reads sqlite timestamps as UTC', () => {
    expect(parseDbDate('2026-07-05 12:00:00')).toBe(Date.UTC(2026, 6, 5, 12, 0, 0));
  });
});

describe('ticketLeadTimeMs', () => {
  it('is null while the ticket is not DONE', () => {
    const ticket = { createdAt: '2026-07-05 12:00:00', status: 'UAT' };
    expect(ticketLeadTimeMs(ticket, [tr('DONE', '2026-07-05 13:00:00')])).toBeNull();
  });

  it('measures creation to the DONE transition', () => {
    const ticket = { createdAt: '2026-07-05 12:00:00', status: 'DONE' };
    const transitions = [tr('IN_REVIEW', '2026-07-05 12:10:00'), tr('DONE', '2026-07-05 13:30:00')];
    expect(ticketLeadTimeMs(ticket, transitions)).toBe(90 * 60 * 1000);
  });

  it('uses the latest DONE transition after rework loops', () => {
    const ticket = { createdAt: '2026-07-05 12:00:00', status: 'DONE' };
    const transitions = [tr('DONE', '2026-07-05 12:30:00'), tr('DONE', '2026-07-05 14:00:00')];
    expect(ticketLeadTimeMs(ticket, transitions)).toBe(2 * 60 * 60 * 1000);
  });

  it('is null when DONE status has no matching transition', () => {
    const ticket = { createdAt: '2026-07-05 12:00:00', status: 'DONE' };
    expect(ticketLeadTimeMs(ticket, [])).toBeNull();
  });
});

describe('epicLeadTimeMs', () => {
  it('is null until the epic is DONE', () => {
    expect(
      epicLeadTimeMs({ createdAt: '2026-07-05 12:00:00', updatedAt: '2026-07-05 13:00:00', status: 'BUILDING' }),
    ).toBeNull();
  });

  it('measures creation to the last update once DONE', () => {
    expect(
      epicLeadTimeMs({ createdAt: '2026-07-05 12:00:00', updatedAt: '2026-07-05 15:00:00', status: 'DONE' }),
    ).toBe(3 * 60 * 60 * 1000);
  });
});

describe('humanDuration', () => {
  it('formats across magnitudes', () => {
    expect(humanDuration(300)).toBe('<1s');
    expect(humanDuration(4_000)).toBe('4s');
    expect(humanDuration(59_400)).toBe('59s');
    expect(humanDuration(60_000)).toBe('1m 0s');
    expect(humanDuration(154_000)).toBe('2m 34s');
    expect(humanDuration(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(humanDuration(26 * 3600_000)).toBe('1d 2h');
  });
});
