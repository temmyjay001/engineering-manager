const controllers = new Map<string, AbortController>();

export interface RunControl {
  signal: AbortSignal;
  aborted(): boolean;
}

export function registerRun(target: string, controller: AbortController): void {
  controllers.set(target, controller);
}

export function unregisterRun(target: string): void {
  controllers.delete(target);
}

export function abortLocalRun(target: string): boolean {
  const controller = controllers.get(target);
  if (!controller) return false;
  controller.abort();
  return true;
}
