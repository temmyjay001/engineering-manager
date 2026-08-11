import { z } from 'zod';

export const plannerContract = z.object({
  summary: z.string().describe('One sentence describing the decomposition'),
  subtickets: z
    .array(
      z.object({
        title: z.string().describe('Short imperative title'),
        description: z.string().describe('One paragraph request for the PM'),
        dependsOn: z
          .array(z.number().int().positive())
          .default([])
          .describe('1-based positions of earlier subtickets this one requires; empty if it can build in parallel'),
      }),
    )
    .min(1),
});

export const pmContract = z.object({
  title: z.string().describe('Short imperative ticket title'),
  hasUi: z.boolean().describe('True if any acceptance criterion is UI-facing'),
  runCommand: z.string().nullable().describe('Command that starts the app, or null'),
  appUrl: z.string().nullable().describe('URL where the app is served, or null'),
  acceptanceCriteria: z
    .array(
      z.object({
        text: z.string().describe('A precise, atomic, testable statement'),
        isUi: z.boolean().describe('True if only confirmable through a rendered interface'),
      }),
    )
    .min(1),
  summary: z.string().describe('One sentence describing the ticket'),
});

export const pmDraftContract = z.object({
  title: z.string().describe('Short imperative ticket title'),
  acceptanceCriteria: z.array(z.string().describe('A precise, atomic, testable statement')).min(1),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).describe('How urgently this should be worked'),
  labels: z.array(z.string()).describe('Short tags for the ticket; empty if none apply'),
  reply: z.string().describe('Clarifying questions for the stakeholder, or an empty string if there are none'),
});

export const architectContract = z.object({
  verdict: z.enum(['PASS', 'FAIL']).describe('FAIL only if the ticket is genuinely infeasible as written'),
  summary: z.string().describe('One sentence on the chosen approach'),
  blockers: z.array(z.string()).default([]).describe('Concrete blockers when verdict is FAIL'),
});

export const developerContract = z.object({
  verdict: z.enum(['PASS', 'FAIL']).describe('FAIL only if genuinely blocked'),
  summary: z.string().describe('One sentence on what was implemented'),
  notes: z.string().default('').describe('Deviations from the plan, or empty string'),
});

export const customGateContract = z.object({
  verdict: z.enum(['PASS', 'FAIL']).describe('PASS only if the change satisfies this gate'),
  summary: z.string().describe('One sentence overall judgment'),
  findings: z
    .array(z.string().describe('Specific, actionable problem the developer must fix'))
    .default([])
    .describe('Concrete problems when the verdict is FAIL'),
});

export const reviewerContract = z.object({
  verdict: z.enum(['PASS', 'FAIL']).describe('PASS only if every criterion is satisfied and no blocker/major issues'),
  summary: z.string().describe('One sentence overall judgment'),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']).default('major'),
        file: z.string().default(''),
        detail: z.string().describe('Specific, actionable problem'),
      }),
    )
    .default([]),
});

export const uatContract = z.object({
  verdict: z.enum(['PASS', 'FAIL']).describe('PASS only if every acceptance criterion was observed to pass'),
  summary: z.string().describe('One sentence overall result'),
  results: z
    .array(
      z.object({
        idx: z.number().int().describe('Acceptance criterion index'),
        met: z.boolean(),
        evidence: z.string().default('').describe('What was done and observed'),
      }),
    )
    .default([]),
});

export type PlannerOutput = z.infer<typeof plannerContract>;
export type PmOutput = z.infer<typeof pmContract>;
export type PmDraftOutput = z.infer<typeof pmDraftContract>;
export type ArchitectOutput = z.infer<typeof architectContract>;
export type DeveloperOutput = z.infer<typeof developerContract>;
export type ReviewerOutput = z.infer<typeof reviewerContract>;
export type UatOutput = z.infer<typeof uatContract>;
