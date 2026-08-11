import type { Ctx } from '../../ctx';
import type { Epic, PlannedSubticket } from '../../domain/types';
import { plannerContract } from '../contracts';
import { invokeRole } from '../invoke';

export interface PlanResult {
  subtickets: PlannedSubticket[];
  summary: string;
  text: string;
}

export async function runPlanner(ctx: Ctx, epic: Epic, activity?: (line: string) => void): Promise<PlanResult> {
  const parts = [
    `Epic ${epic.key}: ${epic.title}`,
    '',
    'Goal:',
    epic.description,
    '',
    'Decompose this epic into an ordered list of subtickets.',
  ];

  if (epic.plan && epic.feedback) {
    parts.push(
      '',
      'Your previous plan:',
      epic.plan,
      '',
      'Revise it to address this feedback specifically:',
      epic.feedback,
    );
  }

  const res = await invokeRole(ctx, {
    role: 'planner',
    prompt: parts.join('\n'),
    cwd: ctx.project.root,
    contract: plannerContract,
    epicId: epic.id,
    onActivity: activity,
  });
  return { subtickets: res.output.subtickets, summary: res.output.summary, text: res.text };
}
