import { useCallback, useEffect, useRef, useState } from 'react';

export function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem('em-theme');
    if (saved) return saved === 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('em-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

// Subscribe to the server change feed; invoke onChange (debounced) whenever
// the board revision moves. Pausing is used while a run panel is streaming.
export function useChangeFeed(url: string, onChange: () => void, paused: boolean): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    const source = new EventSource(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = (event) => {
      let data: { type?: string };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== 'change' || pausedRef.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pausedRef.current) cb.current();
      }, 300);
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [url]);
}

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useResource<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    let active = true;
    loadRef
      .current()
      .then((d) => {
        if (active) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}
