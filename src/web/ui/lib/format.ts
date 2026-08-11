export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function timestamp(sqliteUtc: string): string {
  const date = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
