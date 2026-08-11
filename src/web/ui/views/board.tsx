import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { PriorityBadge } from '@/components/priority-badge';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { createDraftTicket, createEpic, createTicket, eventsUrl, fetchBoard, type ImageAttachment } from '@/lib/api';
import { useChangeFeed, useResource } from '@/lib/hooks';
import { navigate, projectHref, projectPath } from '@/lib/router';
import {
  BOARD_COLUMNS,
  boardColumns,
  columnFor,
  epicTone,
  priorityRank,
  roleFor,
  stateLabel,
  ticketTone,
  type Column as BoardColumn,
} from '@/lib/status';
import { cn } from '@/lib/utils';
import type { BoardData, Ticket } from '@/lib/types';

interface Row {
  ticket: Ticket;
  epicKey: string | null;
}

function collectRows(board: BoardData): Row[] {
  const rows: Row[] = board.standaloneTickets.map((ticket) => ({ ticket, epicKey: null }));
  for (const epic of board.epics) {
    for (const ticket of epic.subtickets) rows.push({ ticket, epicKey: epic.key });
  }
  return rows;
}

type GroupBy = 'status' | 'epic' | 'role';

const ROLE_ORDER = ['pm', 'architect', 'developer', 'reviewer', 'uat'];

const ROLE_LABEL: Record<string, string> = { pm: 'PM', uat: 'UAT' };

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

function roleSortIndex(role: string): number {
  const idx = ROLE_ORDER.indexOf(role);
  return idx === -1 ? ROLE_ORDER.length : idx;
}

const cardHover =
  'transition-all duration-150 hover:-translate-y-px hover:border-foreground/25 hover:shadow-md';

function TicketCard({ projectId, row }: { projectId: string; row: Row }) {
  const { ticket, epicKey } = row;
  return (
    <a
      href={projectHref(projectId, `/tickets/${ticket.key}`)}
      className={cn('block rounded-lg border bg-card p-2.5 shadow-sm', cardHover)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{ticket.key}</span>
        <div className="flex items-center gap-1.5">
          {ticket.attempt > 0 ? (
            <span className="text-[11px] text-muted-foreground">retry {ticket.attempt}</span>
          ) : null}
          {ticket.hasUi ? <span className="text-[11px] font-medium text-muted-foreground">UI</span> : null}
        </div>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug">
        {ticket.title || ticket.description}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge tone={ticketTone(ticket.status)} label={stateLabel(ticket.status)} />
        {ticket.interrupted ? (
          <StatusBadge tone="attention" label={`Interrupted at ${stateLabel(ticket.status)}`} />
        ) : null}
        <PriorityBadge priority={ticket.priority} />
        {ticket.labels.map((label) => (
          <Badge key={label} variant="secondary">
            {label}
          </Badge>
        ))}
        {epicKey ? (
          <a
            href={projectHref(projectId, `/epics/${epicKey}`)}
            onClick={(e) => e.stopPropagation()}
            className="rounded font-mono text-[11px] text-muted-foreground hover:text-foreground"
          >
            {epicKey}
          </a>
        ) : null}
      </div>
    </a>
  );
}

function Column({
  label,
  count,
  countNote,
  emphasize,
  children,
}: {
  label: string;
  count: number;
  countNote?: string | null;
  emphasize?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex w-[280px] min-w-[280px] shrink-0 flex-col rounded-xl border bg-muted/30',
        emphasize && count > 0 && 'border-foreground/25 bg-muted/60',
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span className="text-[13px] font-semibold tracking-tight">{label}</span>
        <span className="rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
        {countNote ? <span className="text-[11px] text-muted-foreground">{countNote}</span> : null}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {count === 0 ? (
          <div className="flex h-16 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground/50">
            Empty
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function StatusColumns({
  projectId,
  rows,
  columns,
  className,
}: {
  projectId: string;
  rows: Row[];
  columns: BoardColumn[];
  className?: string;
}) {
  return (
    <div className={cn('flex gap-3', className)}>
      {columns.map((column) => {
        const cards = rows
          .filter((r) => columnFor(r.ticket.status) === column.id)
          .sort((a, b) => priorityRank(a.ticket.priority) - priorityRank(b.ticket.priority));
        const closed = column.id === 'done' ? cards.filter((r) => r.ticket.status === 'CLOSED').length : 0;
        return (
          <Column
            key={column.id}
            label={column.label}
            count={cards.length - closed}
            countNote={closed > 0 ? `+${closed} closed` : null}
            emphasize={column.id === 'approval'}
          >
            {cards.map((row) => (
              <TicketCard key={row.ticket.key} projectId={projectId} row={row} />
            ))}
          </Column>
        );
      })}
    </div>
  );
}

function Swimlane({
  label,
  sublabel,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  sublabel?: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        {collapsed ? (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        )}
        {sublabel ? <span className="font-mono text-xs text-muted-foreground">{sublabel}</span> : null}
        <span className="text-sm font-semibold tracking-tight">{label}</span>
        <span className="ml-auto rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {count}
        </span>
      </button>
      {!collapsed ? <div className="px-3 pb-3">{children}</div> : null}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <div className="h-full overflow-x-auto">
      <div className="flex h-full gap-3">
        {BOARD_COLUMNS.map((c) => (
          <div key={c.id} className="flex w-[280px] min-w-[280px] shrink-0 flex-col rounded-xl border bg-muted/30">
            <div className="shrink-0 px-3 py-2.5">
              <Skeleton className="h-4 w-20" />
            </div>
            <div className="space-y-2 px-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function readImages(files: FileList | null): Promise<ImageAttachment[]> {
  if (!files) return [];
  const next: ImageAttachment[] = [];
  for (const file of [...files].slice(0, 5)) {
    if (!file.type.startsWith('image/')) continue;
    const dataBase64 = await new Promise<string>((resolvePromise, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolvePromise(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(new Error(`could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
    next.push({ name: file.name, mime: file.type, dataBase64 });
  }
  return next;
}

function ImageAttachField({ images, onPick }: { images: ImageAttachment[]; onPick: (images: ImageAttachment[]) => void }) {
  return (
    <div className="space-y-1.5">
      <input
        type="file"
        accept="image/*"
        multiple
        className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-transparent file:px-2.5 file:py-1 file:text-xs file:text-foreground"
        onChange={(e) => void readImages(e.target.files).then(onPick)}
      />
      {images.length ? (
        <p className="text-xs text-muted-foreground">
          Attached: {images.map((i) => i.name).join(', ')} (the PM and developer will see them)
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Optionally attach screenshots or mockups (up to 5, 2MB each)</p>
      )}
    </div>
  );
}

type DialogTab = 'quick' | 'draft';

export function NewItemDialog({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DialogTab>('quick');
  const [mode, setMode] = useState<'ticket' | 'epic'>('ticket');
  const [quickText, setQuickText] = useState('');
  const [quickImages, setQuickImages] = useState<ImageAttachment[]>([]);
  const [draftIdea, setDraftIdea] = useState('');
  const [draftImages, setDraftImages] = useState<ImageAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setTab('quick');
      setError(null);
    }
  };

  const resetForm = () => {
    setQuickText('');
    setQuickImages([]);
    setDraftIdea('');
    setDraftImages([]);
  };

  const submitQuick = async () => {
    const value = quickText.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'ticket') {
        const { key } = await createTicket(projectId, value, quickImages);
        setOpen(false);
        resetForm();
        onCreated();
        navigate(projectPath(projectId, `/tickets/${key}`));
      } else {
        const { key } = await createEpic(projectId, value);
        setOpen(false);
        resetForm();
        onCreated();
        navigate(projectPath(projectId, `/epics/${key}`));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitDraft = async () => {
    const value = draftIdea.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { key } = await createDraftTicket(projectId, value, draftImages);
      setOpen(false);
      resetForm();
      onCreated();
      navigate(projectPath(projectId, `/tickets/${key}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = tab === 'quick' ? !!quickText.trim() : !!draftIdea.trim();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> New
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create work</DialogTitle>
          <DialogDescription>
            {tab === 'quick'
              ? 'A ticket is one unit of work. An epic is a goal the planner breaks into subtickets.'
              : 'Describe the idea and the PM will work with you to turn it into a fully-specified ticket.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {([
            { id: 'quick', label: 'Quick create' },
            { id: 'draft', label: 'Draft with PM' },
          ] as const).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t.id ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'quick' ? (
          <>
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              {(['ticket', 'epic'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                    mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground',
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <Textarea
              autoFocus
              rows={4}
              value={quickText}
              onChange={(e) => setQuickText(e.target.value)}
              placeholder={
                mode === 'ticket'
                  ? 'Add a dark mode toggle to the settings page'
                  : 'Build a reporting module with CSV export'
              }
            />
            {mode === 'ticket' ? <ImageAttachField images={quickImages} onPick={setQuickImages} /> : null}
          </>
        ) : (
          <>
            <Textarea
              autoFocus
              rows={4}
              value={draftIdea}
              onChange={(e) => setDraftIdea(e.target.value)}
              placeholder="I want a way for users to export their data as CSV"
            />
            <ImageAttachField images={draftImages} onPick={setDraftImages} />
          </>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={tab === 'quick' ? submitQuick : submitDraft} disabled={busy || !canSubmit}>
            {busy ? 'Creating…' : tab === 'quick' ? `Create ${mode}` : 'Start draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SHOW_BACKLOG_KEY = 'em-board-show-backlog';

export function BoardView({ projectId }: { projectId: string }) {
  const { data, error, reload } = useResource(() => fetchBoard(projectId), [projectId]);
  useChangeFeed(eventsUrl(projectId), reload, false);
  const [groupBy, setGroupBy] = useState<GroupBy>('status');
  const [collapsedLanes, setCollapsedLanes] = useState<Record<string, boolean>>({});
  const toggleLane = (key: string) => setCollapsedLanes((prev) => ({ ...prev, [key]: !prev[key] }));
  const [showBacklog, setShowBacklog] = useState(() => localStorage.getItem(SHOW_BACKLOG_KEY) === 'true');

  const toggleShowBacklog = () => {
    setShowBacklog((prev) => {
      const next = !prev;
      localStorage.setItem(SHOW_BACKLOG_KEY, String(next));
      return next;
    });
  };

  const rows = data ? collectRows(data) : [];
  const total = rows.length + (data?.epics.length ?? 0);
  const awaiting = rows.filter((r) => r.ticket.status === 'AWAIT_APPROVAL').length;
  const columns = data ? boardColumns(data.pipeline, showBacklog) : [];
  const standaloneRows = rows.filter((r) => r.epicKey === null);

  const roleGroups = data
    ? rows.reduce(
        (acc, row) => {
          const role = roleFor(data.pipeline, row.ticket);
          if (role === null) {
            acc.none.push(row);
          } else {
            const list = acc.byRole.get(role) ?? [];
            list.push(row);
            acc.byRole.set(role, list);
          }
          return acc;
        },
        { byRole: new Map<string, Row[]>(), none: [] as Row[] },
      )
    : null;
  const roles = roleGroups
    ? [...roleGroups.byRole.keys()].sort((a, b) => roleSortIndex(a) - roleSortIndex(b) || a.localeCompare(b))
    : [];

  const context = data
    ? [
        `${rows.length} ${rows.length === 1 ? 'ticket' : 'tickets'}`,
        data.epics.length ? `${data.epics.length} ${data.epics.length === 1 ? 'epic' : 'epics'}` : null,
        awaiting ? `${awaiting} awaiting you` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3.5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Board</h1>
          {context ? <p className="mt-0.5 text-xs text-muted-foreground">{context}</p> : null}
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showBacklog}
              onChange={toggleShowBacklog}
              className="size-3.5 accent-primary"
            />
            Show backlog column
          </label>
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="status">Status</SelectItem>
              <SelectItem value="epic">Epic</SelectItem>
              <SelectItem value="role">Role</SelectItem>
            </SelectContent>
          </Select>
          <NewItemDialog projectId={projectId} onCreated={reload} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden p-5">
        {error ? <p className="text-sm text-destructive">Failed to load board: {error}</p> : null}
        {!data && !error ? <BoardSkeleton /> : null}
        {data && total === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">No work yet. Create the first ticket or epic.</p>
            <NewItemDialog projectId={projectId} onCreated={reload} />
          </div>
        ) : null}
        {data && total > 0 ? (
          <div className="flex h-full flex-col">
            {groupBy === 'status' ? (
              <div className="min-h-0 flex-1 overflow-x-auto">
                <StatusColumns projectId={projectId} rows={rows} columns={columns} className="h-full" />
              </div>
            ) : null}
            {groupBy === 'epic' ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {data.epics.map((epic) => {
                  const laneRows = rows.filter((r) => r.epicKey === epic.key);
                  const laneKey = `epic:${epic.key}`;
                  return (
                    <Swimlane
                      key={laneKey}
                      label={epic.title}
                      sublabel={epic.key}
                      count={laneRows.length}
                      collapsed={!!collapsedLanes[laneKey]}
                      onToggle={() => toggleLane(laneKey)}
                    >
                      <StatusColumns projectId={projectId} rows={laneRows} columns={columns} className="h-64 overflow-x-auto" />
                    </Swimlane>
                  );
                })}
                {standaloneRows.length > 0 ? (
                  <Swimlane
                    label="No Epic"
                    count={standaloneRows.length}
                    collapsed={!!collapsedLanes['epic:none']}
                    onToggle={() => toggleLane('epic:none')}
                  >
                    <StatusColumns projectId={projectId} rows={standaloneRows} columns={columns} className="h-64 overflow-x-auto" />
                  </Swimlane>
                ) : null}
              </div>
            ) : null}
            {groupBy === 'role' && roleGroups ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {roles.map((role) => {
                  const laneRows = roleGroups.byRole.get(role) ?? [];
                  const laneKey = `role:${role}`;
                  return (
                    <Swimlane
                      key={laneKey}
                      label={roleLabel(role)}
                      count={laneRows.length}
                      collapsed={!!collapsedLanes[laneKey]}
                      onToggle={() => toggleLane(laneKey)}
                    >
                      <StatusColumns projectId={projectId} rows={laneRows} columns={columns} className="h-64 overflow-x-auto" />
                    </Swimlane>
                  );
                })}
                <Swimlane
                  label="None"
                  count={roleGroups.none.length}
                  collapsed={!!collapsedLanes['role:none']}
                  onToggle={() => toggleLane('role:none')}
                >
                  <StatusColumns projectId={projectId} rows={roleGroups.none} columns={columns} className="h-64 overflow-x-auto" />
                </Swimlane>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
