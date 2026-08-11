import type { Store } from './db/store';
import type { Project } from './project';

export interface Ctx {
  store: Store;
  project: Project;
}
