export interface DepNode {
  seq: number;
  dependsOn: number[];
}

export function validateDependencies(nodes: DepNode[]): void {
  const bySeq = new Map(nodes.map((n) => [n.seq, n]));
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.seq) throw new Error(`subticket ${n.seq} depends on itself`);
      if (!bySeq.has(d)) throw new Error(`subticket ${n.seq} depends on unknown subticket ${d}`);
    }
  }
  const state = new Map<number, 'visiting' | 'done'>();
  const visit = (seq: number, trail: number[]): void => {
    const s = state.get(seq);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`dependency cycle: ${[...trail, seq].join(' -> ')}`);
    state.set(seq, 'visiting');
    for (const d of bySeq.get(seq)?.dependsOn ?? []) visit(d, [...trail, seq]);
    state.set(seq, 'done');
  };
  for (const n of nodes) visit(n.seq, []);
}

export function readySubtickets(nodes: DepNode[], done: Set<number>, active: Set<number>): number[] {
  return nodes
    .filter((n) => !done.has(n.seq) && !active.has(n.seq) && n.dependsOn.every((d) => done.has(d)))
    .map((n) => n.seq);
}

export function openBlockerWarning(ticketKey: string, blockers: Array<{ key: string }>): string | null {
  if (blockers.length === 0) return null;
  return `${ticketKey} has an open blocker: ${blockers.map((b) => b.key).join(', ')}. Proceeding anyway.`;
}
