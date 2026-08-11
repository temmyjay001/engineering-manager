---
name: em
description: Delegate feature requests and coding tasks to the local em engineering org (PM, architect, developer, reviewer, UAT agents with quality gates). Use when the user asks to "hand this to em", "create a ticket", "let the org build this", mentions an EM-/EP- key, or wants delivery/spend reports for this repo. Requires the em MCP server (em mcp) connected.
---

# Driving the em engineering org

em runs a ticket pipeline in this repository: a PM writes acceptance criteria, a human approves them, then architect, developer, and review gates carry the work to a merged branch. You interact through the em MCP tools.

## Core flow

1. `create_ticket` with the user's request, phrased as the user gave it. Do not pre-decompose; that is the PM's job.
2. `run_ticket`. It stops at AWAIT_APPROVAL with acceptance criteria.
3. Show the criteria to the user and ask for their decision. Never call `approve_ticket` on your own judgment; approval is the human's gate. If they give feedback instead, `reject_ticket` with it verbatim.
4. After approval the run continues unattended through development and review gates. Report the final status, cost, and any BLOCKED reason.
5. If BLOCKED, relay the failure to the user and pass their direction through `unblock_ticket`.

## Epics

For goals too large for one ticket: `create_epic`, then `plan_epic`, show the proposed breakdown, and only `approve_epic` plus `run_epic` after the user accepts the plan.

## Ground rules

- One request, one ticket. Do not fan a single request into several tickets unless the user asked for a breakdown; epics exist for that.
- `run_ticket` and `run_epic` are long-running; tell the user work is in progress rather than polling.
- Do not edit files the org is working on; the developer agent owns the ticket's worktree until it merges.
- Use `status` before creating anything if the user references existing work, and `show_ticket` to answer questions about a specific ticket.
- `report` answers questions about throughput, lead time, defects caught, and spend; it includes cost advice grounded in this repo's own ledger.
