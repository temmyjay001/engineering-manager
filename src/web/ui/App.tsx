import { useEffect } from 'react';
import { Shell } from './components/shell';
import { fetchProjects } from './lib/api';
import { useResource } from './lib/hooks';
import { navigate, projectHref, useRoute } from './lib/router';
import { BacklogView } from './views/backlog';
import { BoardView } from './views/board';
import { DraftView } from './views/draft';
import { EpicView } from './views/epic';
import { EpicsView } from './views/epics';
import { MeetingsView } from './views/meetings';
import { ReportsView } from './views/reports';
import { SettingsView } from './views/settings';
import { TicketView } from './views/ticket';

function NoProjects() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold">No projects yet</h1>
        <p className="text-sm text-muted-foreground">
          Run <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">em init</code> inside a git repository,
          then reload. The dashboard shows every project you register.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const { data: projects } = useResource(fetchProjects, []);

  const known = (id?: string) => !!id && !!projects?.some((p) => p.id === id);

  useEffect(() => {
    if (!projects) return;
    if (route.name === 'root' || (route.projectId && !known(route.projectId))) {
      const last = localStorage.getItem('em-last-project');
      const target = projects.find((p) => p.id === last) ?? projects[0];
      if (target) navigate(projectHref(target.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, route.name, route.projectId]);

  if (!projects) return null;
  if (projects.length === 0) return <NoProjects />;
  if (route.name === 'root' || !route.projectId || !known(route.projectId)) return null;

  const projectId = route.projectId;
  return (
    <Shell projects={projects} projectId={projectId}>
      {route.name === 'board' && <BoardView projectId={projectId} />}
      {route.name === 'backlog' && <BacklogView projectId={projectId} />}
      {route.name === 'ticket' && route.key && <TicketView key={route.key} projectId={projectId} keyId={route.key} />}
      {route.name === 'draft' && route.key && <DraftView key={route.key} projectId={projectId} keyId={route.key} />}
      {route.name === 'epics' && <EpicsView projectId={projectId} />}
      {route.name === 'epic' && route.key && <EpicView key={route.key} projectId={projectId} keyId={route.key} />}
      {route.name === 'reports' && <ReportsView projectId={projectId} />}
      {route.name === 'meetings' && <MeetingsView key={route.key ?? 'list'} projectId={projectId} meetingId={route.key} />}
      {route.name === 'settings' && <SettingsView projectId={projectId} />}
      {route.name === 'notfound' && (
        <div className="p-10 text-muted-foreground">
          Not found. <a href={projectHref(projectId)} className="underline">Back to board</a>.
        </div>
      )}
    </Shell>
  );
}
