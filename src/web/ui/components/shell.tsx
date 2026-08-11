import type { ReactNode } from 'react';
import { BarChart3, Layers, LayoutGrid, ListTodo, MessagesSquare, Moon, Settings, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ProjectEntry } from '@/lib/api';
import { useTheme } from '@/lib/hooks';
import { navigate, projectHref, useRoute } from '@/lib/router';
import { cn } from '@/lib/utils';

function NavItem({ href, active, icon, label }: { href: string; active: boolean; icon: ReactNode; label: string }) {
  return (
    <a
      href={href}
      className={cn(
        'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </a>
  );
}

export function Shell({
  projects,
  projectId,
  children,
}: {
  projects: ProjectEntry[];
  projectId: string;
  children: ReactNode;
}) {
  const route = useRoute();
  const [dark, toggle] = useTheme();
  const onSettings = route.name === 'settings';
  const onBoard = route.name === 'board' || route.name === 'ticket';
  const onEpics = route.name === 'epics' || route.name === 'epic';

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r px-3 py-4">
        <div className="flex items-center gap-2 px-2 pb-4">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            em
          </div>
          <span className="text-sm font-semibold tracking-tight">Engineering Manager</span>
        </div>

        <Select
          value={projectId}
          onValueChange={(id) => {
            localStorage.setItem('em-last-project', id);
            navigate(projectHref(id));
          }}
        >
          <SelectTrigger className="mb-4">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <nav className="flex flex-col gap-1">
          <NavItem href={projectHref(projectId)} active={onBoard} icon={<LayoutGrid className="size-4" />} label="Board" />
          <NavItem
            href={projectHref(projectId, '/epics')}
            active={onEpics}
            icon={<Layers className="size-4" />}
            label="Epics"
          />
          <NavItem
            href={projectHref(projectId, '/backlog')}
            active={route.name === 'backlog'}
            icon={<ListTodo className="size-4" />}
            label="Backlog"
          />
          <NavItem
            href={projectHref(projectId, '/meetings')}
            active={route.name === 'meetings'}
            icon={<MessagesSquare className="size-4" />}
            label="Meetings"
          />
          <NavItem
            href={projectHref(projectId, '/reports')}
            active={route.name === 'reports'}
            icon={<BarChart3 className="size-4" />}
            label="Reports"
          />
          <NavItem
            href={projectHref(projectId, '/settings')}
            active={onSettings}
            icon={<Settings className="size-4" />}
            label="Settings"
          />
        </nav>

        <div className="mt-auto">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2.5 text-muted-foreground"
            onClick={toggle}
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            {dark ? 'Light mode' : 'Dark mode'}
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
