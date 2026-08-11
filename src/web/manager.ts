import type { Ctx } from '../ctx';
import { Store } from '../db/store';
import { projectAt } from '../project';
import { findProjectEntry, listProjects, type ProjectEntry } from '../registry';

interface Opened {
  ctx: Ctx;
  root: string;
}

export class ProjectManager {
  private readonly opened = new Map<string, Opened>();

  list(): ProjectEntry[] {
    return listProjects();
  }

  ctxFor(id: string): Ctx | undefined {
    const cached = this.opened.get(id);
    if (cached) return cached.ctx;
    const entry = findProjectEntry(id);
    if (!entry) return undefined;
    const project = projectAt(entry.root);
    const store = new Store(project.dbPath, {
      ticketPrefix: project.config.ticketPrefix,
      epicPrefix: project.config.epicPrefix,
    });
    const ctx: Ctx = { store, project };
    this.opened.set(id, { ctx, root: entry.root });
    return ctx;
  }

  close(): void {
    for (const { ctx } of this.opened.values()) ctx.store.close();
    this.opened.clear();
  }
}
