import type { PipelineRole } from '../config';
import type { Ctx } from '../ctx';
import type { GateResult, Ticket } from '../domain/types';
import { runArchitect } from './roles/architect';
import { runDeveloper } from './roles/developer';
import { runPm } from './roles/pm';
import { runReviewer } from './roles/reviewer';
import { runUat } from './roles/uat';

export type RoleActivity = (line: string) => void;

export type RoleRunner = (
  ctx: Ctx,
  ticket: Ticket,
  signal?: AbortSignal,
  activity?: RoleActivity,
) => Promise<GateResult>;

export const RUNNERS: Record<PipelineRole, RoleRunner> = {
  pm: runPm,
  architect: runArchitect,
  developer: runDeveloper,
  reviewer: runReviewer,
  uat: runUat,
};
