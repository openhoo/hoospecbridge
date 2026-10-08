---
name: hoospecbridge-development
description: Implement and review HooSpecBridge TypeScript parser, sync planner, Jira/GitLab adapters, CLI, persistence and packaging in the source repository.
---

# Develop HooSpecBridge

Read `AGENTS.md` and the relevant source module. Runtime models are in `src/types.ts`; the pure planner is `src/planner.ts`; persistence and orchestration are `src/state.ts` / `src/sync.ts`; HTTP adapters are under `src/adapters/`.

Run `npm ci` and `npm run check`. Source and tests are strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Validate unknown API/state JSON at module boundaries. Keep the runtime free of third-party dependencies unless there is a concrete need.

Protect these contracts:

- Task identity uses repoId + feature-relative tasks.md path + task ID. Duplicate IDs within a feature and duplicate remote markers are errors.
- Preview must write neither tracker nor local state. Any plan conflict blocks the whole batch.
- Content flows from tasks to issues. Pull changes completion only. Remote notes outside managed blocks and Jira rich nodes are preserved.
- Create requests have a durable pending entry first. A lost response must not trigger another blind create. Save mappings before a follow-up transition.
- Remote updates and multiple task files cannot share a transaction. Checkpoint completed mutations and verify readback; never claim rollback of API writes.

Exercise changed behavior with task/source fixtures, planner tests or the local HTTP integration fixtures. Add meaningful failure/recovery cases for mutations. Do not use live tracker credentials in automated tests. API fixture success and live project acceptance are distinct.

For packaging changes, run `npm pack` and install the tarball in a fresh directory; verify the CLI bin and typed library exports. Keep user skill commands and README examples aligned. Use the user's documentation workflow when API contracts or dependencies change.
