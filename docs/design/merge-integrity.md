# Design: Merge Integrity

em runs multiple coding agents against the same repository, in parallel, over the
course of an epic. Each agent works in its own git worktree and finishes with a
branch that passed its pipeline's gates (review, UAT, or custom checks). This
document describes how em turns a gate-passed branch into a landed commit on the
base branch without corrupting the user's checkout, losing work on a crash, or
quietly merging something that no longer builds.

## Why merge-on-green is not enough

The conventional CI pattern is merge-on-green: run checks against a branch, and if
they pass, merge it. That pattern assumes the branch being merged is the branch
that was checked, and that the base it merges into is close to the base it was
checked against. Both assumptions hold reasonably well when one human merges a
handful of PRs a day.

Neither assumption holds for multi-agent code generation. An epic produces several
subtickets whose branches finish their gates around the same time, all built from
the same starting base. Only one of them can actually land first; every other
branch is now green against a base that no longer exists. Re-running the exact
commands that passed on the old base does not tell you whether the branch still
builds against the new one, and agents do not coordinate worktrees the way people
naturally avoid stepping on each other's changes, so both textual and semantic
conflicts between concurrently generated branches are common rather than rare.

Merging on green in this setting means merging on stale information. What em needs
instead is: only one landing attempt touching the base at a time, a check that
runs against the literal tree about to be merged rather than the ticket branch in
isolation, and a base-advance operation that can detect and recover from the base
moving underneath it instead of merging blind.

## Landing states

A ticket's pipeline (developer, then its review/UAT gates) governs whether the
work is correct. It does not by itself put the work on the base branch. Passing
the last gate moves a ticket into one of two landing states instead of directly to
done:

- **`READY_TO_LAND`** — every gate passed. The ticket is queued for integration but
  not yet reflected on the base branch. This state is not terminal: the ticket
  sits here until it lands or fails to land.
- **`NEEDS_INTEGRATION`** — a landing attempt was made and failed: the worktree
  could not be synced with the base without a conflict, or re-verification of
  the merged tree failed. This state is also not terminal. The transition
  carries a human-readable note describing what went wrong and how to retry.
  Under the `pr` merge strategy, a failed push or pull-request creation instead
  leaves the ticket in `READY_TO_LAND` with the failure logged, since nothing
  about the branch itself needs integration work.

A ticket only reaches `DONE` once its work is provably on the base (or a pull
request has been opened, depending on merge strategy). Nothing marks a ticket done
before that is true.

## The landing queue and the integration lock

Landing mutates shared, ordered state: the base branch's tip. Two landings cannot
safely advance that tip at the same time, so em serializes them behind a single
integration lock, implemented as a run record with a unique constraint on one
active run per lock target. Acquiring the lock is a blocking wait, not a queue
rejection: a ticket trying to land polls until the lock is free, then proceeds.

This keeps building and landing decoupled. Multiple subtickets can build in
parallel, up to the project's configured parallelism, and each one lands inline as
soon as it passes its last gate. Whichever ticket acquires the integration lock
first lands first; the others wait their turn rather than racing to update the
base concurrently. The `em land` command, run with no ticket key, drains every
`READY_TO_LAND` ticket through the same lock, one at a time, so a batch of gated
work lands as a sequence of independent, individually verified commits rather
than a single combined merge.

## Worktree synchronization

Each ticket builds in its own worktree, checked out on its own branch, off the
base tip that existed when the worktree was created. By the time a ticket is
ready to land, the base may have advanced, because other tickets landed first.

Landing begins by comparing the worktree's recorded base commit to the base
ref's current tip. If they differ, em merges the new tip into the worktree
(`git merge`, no worktree fast-forward assumed) rather than touching the base or
the user's own checkout. Two outcomes follow:

- The merge succeeds. The worktree's recorded base commit is updated, and landing
  continues using the freshly merged tree.
- The merge conflicts. The merge is aborted immediately, restoring the worktree to
  its pre-merge state, and the ticket transitions to `NEEDS_INTEGRATION` with a
  note pointing at the base commit that conflicts. The queue moves on to the next
  eligible ticket rather than blocking on this one.

The base branch and the user's working tree are never touched during this step.
All conflict resolution happens inside the ticket's own worktree.

## Re-verifying the merged tree

A ticket's gates ran against the base as it existed when the ticket built. If the
base has since moved and the worktree sync above pulled in new changes, those
gates no longer prove anything about the tree that is about to land: two branches
can each be individually correct and still break when combined.

To close that gap, em re-runs a single configured `verifyCommand` (for example,
a typecheck-and-test invocation) inside the ticket worktree, after the sync, using
the exact tree that will become the landed commit. This is a command, not a
re-dispatch of the reviewer or UAT agents: re-running full agent review on every
landing attempt would multiply cost and latency for a check whose job is narrower,
catching build and test breakage introduced by combining branches, not
re-litigating design decisions.

If `verifyCommand` fails, its output is stored as an artifact on the ticket and
the ticket transitions to `NEEDS_INTEGRATION` with a note describing the failure.
If `verifyCommand` is not configured, this step is skipped and landing proceeds on
the strength of the textual merge alone.

## Building the squash candidate

Once the worktree holds a synced, verified tree, em builds the commit that will
actually land using `git commit-tree` directly against that tree, with the base
commit used for the sync as its single parent. The candidate commit's tree is
therefore bit-for-bit identical to the tree that was just verified, regardless of
how many intermediate commits exist on the ticket's branch. The result is one
squash commit per landed ticket, with a message derived from the ticket's key and
title, giving the base branch a linear, one-commit-per-ticket history.

## Advancing the base

Building the candidate does not move the base; that is a separate, final step,
and it depends on how the base branch is currently checked out:

- **Not checked out anywhere.** The base advances with `git update-ref`, passing
  both the new candidate and the expected current tip as arguments. Git only
  performs the update if the ref's current value still matches the expected tip;
  this is a compare-and-swap, so a base that moved between when it was read and
  when the update is attempted causes the update to fail cleanly rather than
  silently overwrite a newer commit.
- **Checked out in the project's root working tree.** The base advances with
  `git merge --ff-only`, which only succeeds if the candidate is a descendant of
  the current tip, after confirming the working tree is clean. This keeps the
  index and working tree of the user's own checkout in sync with the ref, since a
  bare ref update would desynchronize them.
- **Checked out in some other worktree.** Landing refuses outright rather than
  mutate a checkout it does not own; the ticket stays `READY_TO_LAND` with a note
  explaining that the base needs to be freed.

In every case, the base only ever moves to a commit whose exact tree was already
verified, and it only ever moves forward. If either the compare-and-swap or the
fast-forward fails because the tip moved during the attempt, em treats that as a
race, not a failure: it re-syncs the worktree, re-verifies, rebuilds the candidate
against the new tip, and retries, up to a bounded number of attempts before
parking the ticket for a manual `em land` retry.

## Crash recovery with pending refs

Between building the candidate commit and successfully advancing the base, there
is a narrow window during which a crash could leave the system in an ambiguous
state. em closes that window by anchoring the candidate before attempting to
advance the base: immediately after `commit-tree` produces the candidate, its
sha is recorded at `refs/em/pending/<ticket-key>` with `git update-ref`.

Because the candidate is already a complete, valid commit object, and because the
pending ref keeps it reachable, a crash during base advancement leaves behind a
concrete, inspectable pointer to the exact tree that was about to land, rather
than an unreachable object subject to garbage collection. The ref is deleted once
the landing attempt finishes, whether it succeeds or is abandoned in favor of a
retry, so its presence at rest signals nothing in flight; its persistence across a
process exit is the one condition worth noticing during recovery.

## The `em land` command

`em land [<ticket-key>]` is the entry point for landing, both for retrying stuck
work and for draining the queue by hand:

- With a ticket key, it lands that ticket if it is `READY_TO_LAND`. If the ticket
  is `NEEDS_INTEGRATION`, it first moves the ticket back to `READY_TO_LAND` and
  then attempts to land it again, which guarantees the retry re-syncs against the
  current base tip and rebuilds the candidate from scratch rather than reusing
  anything left over from the failed attempt. Any other ticket state is refused.
- With no key, it lands every `READY_TO_LAND` ticket in turn, acquiring the
  integration lock for each one.

Landing is also invoked without any explicit `em land` call: when a ticket's
normal run reaches `READY_TO_LAND`, the same landing routine runs inline as the
next step of that run, so driving a ticket or an epic to completion lands the
work rather than stopping at "gates passed." `em land` exists for the cases where
that inline attempt failed and needs a fresh try, or where a batch of tickets
that reached `READY_TO_LAND` independently needs to be drained explicitly.
