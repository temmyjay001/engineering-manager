import { useState } from 'react';
import { Clock, Plus } from 'lucide-react';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { createEpic, eventsUrl, fetchBoard } from '@/lib/api';
import { duration, money } from '@/lib/format';
import { useChangeFeed, useResource } from '@/lib/hooks';
import { navigate, projectHref, projectPath } from '@/lib/router';
import { epicTone } from '@/lib/status';
import type { BoardData } from '@/lib/types';

type EpicRow = BoardData['epics'][number];

function NewEpicDialog({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { key } = await createEpic(projectId, value);
      setOpen(false);
      setText('');
      onCreated();
      navigate(projectPath(projectId, `/epics/${key}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> New epic
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create epic</DialogTitle>
          <DialogDescription>An epic is a goal the planner breaks into subtickets.</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Build a reporting module with CSV export"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={submit} disabled={busy || !text.trim()}>
            {busy ? 'Creating…' : 'Create epic'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EpicRowItem({ projectId, epic }: { projectId: string; epic: EpicRow }) {
  const total = epic.subtickets.length;
  const done = epic.subtickets.filter((s) => s.status === 'DONE').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <a
      href={projectHref(projectId, `/epics/${epic.key}`)}
      className="flex items-center gap-4 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{epic.key}</span>
          <StatusBadge tone={epicTone(epic.status)} label={epic.status} />
        </div>
        <p className="mt-0.5 truncate font-medium">{epic.title}</p>
      </div>
      <div className="w-40 shrink-0">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{done}/{total} done</span>
          <span>{pct}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="flex w-24 shrink-0 justify-end">
        <Badge variant="muted">{money(epic.costUsd)}</Badge>
      </div>
      <div className="flex w-28 shrink-0 justify-end">
        {epic.leadTimeMs !== null ? (
          <Badge variant="muted">
            <Clock className="size-3" /> {duration(epic.leadTimeMs)}
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </a>
  );
}

function EpicsSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

export function EpicsView({ projectId }: { projectId: string }) {
  const { data, error, reload } = useResource(() => fetchBoard(projectId), [projectId]);
  useChangeFeed(eventsUrl(projectId), reload, false);

  const epics = data?.epics ?? [];

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Epics</h1>
        <NewEpicDialog projectId={projectId} onCreated={reload} />
      </div>
      {error ? <p className="mt-6 text-sm text-destructive">Failed to load epics: {error}</p> : null}
      {!data && !error ? <div className="mt-6"><EpicsSkeleton /></div> : null}
      {data && epics.length === 0 ? (
        <div className="mt-16 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">No epics yet. Create one to break a goal into subtickets.</p>
          <NewEpicDialog projectId={projectId} onCreated={reload} />
        </div>
      ) : null}
      {data && epics.length > 0 ? (
        <div className="mt-6 divide-y overflow-hidden rounded-lg border">
          {epics.map((epic) => (
            <EpicRowItem key={epic.key} projectId={projectId} epic={epic} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
