import { PriorityBadge } from '@/components/priority-badge';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { eventsUrl, fetchBoard } from '@/lib/api';
import { useChangeFeed, useResource } from '@/lib/hooks';
import { projectHref } from '@/lib/router';
import { priorityRank, stateLabel, ticketTone } from '@/lib/status';
import type { BoardData, Ticket } from '@/lib/types';

function backlogTickets(board: BoardData): Ticket[] {
  const all = [...board.standaloneTickets, ...board.epics.flatMap((epic) => epic.subtickets)];
  return all
    .filter((ticket) => ticket.status === 'BACKLOG' || ticket.status === 'DRAFT')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

export function BacklogView({ projectId }: { projectId: string }) {
  const { data, error, reload } = useResource(() => fetchBoard(projectId), [projectId]);
  useChangeFeed(eventsUrl(projectId), reload, false);

  const tickets = data ? backlogTickets(data) : [];

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Backlog</h1>
      {error ? <p className="mt-6 text-sm text-destructive">Failed to load backlog: {error}</p> : null}
      {!data && !error ? (
        <div className="mt-6 space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : null}
      {data && tickets.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No backlog tickets. Everything is scheduled or in flight.</p>
      ) : null}
      {data && tickets.length > 0 ? (
        <div className="mt-6 divide-y overflow-hidden rounded-lg border">
          {tickets.map((ticket) => (
            <a
              key={ticket.key}
              href={projectHref(
                projectId,
                ticket.status === 'DRAFT' ? `/tickets/${ticket.key}/draft` : `/tickets/${ticket.key}`,
              )}
              className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent/40"
            >
              <span className="font-mono text-xs text-muted-foreground">{ticket.key}</span>
              <span className="flex-1 truncate font-medium">{ticket.title || ticket.description}</span>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <StatusBadge tone={ticketTone(ticket.status)} label={stateLabel(ticket.status)} />
                <PriorityBadge priority={ticket.priority} />
                {ticket.labels.map((label) => (
                  <Badge key={label} variant="secondary">
                    {label}
                  </Badge>
                ))}
              </div>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
