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
- Track rich managed structure separately from text. Link/media edits must conflict before replacement, while JSON key ordering and external notes must not create structural conflicts. Pull-preserved content stays until new local edits or explicit push.
- Create requests have a durable pending entry first. A lost response must not trigger another blind create. Save mappings before a follow-up transition.
- Remote updates and multiple task files cannot share a transaction. Checkpoint completed mutations and verify readback; never claim rollback of API writes.

Exercise changed behavior with task/source fixtures, planner tests or the local HTTP integration fixtures. Add meaningful failure/recovery cases for mutations. Do not use live tracker credentials in automated tests. API fixture success and live project acceptance are distinct.

For packaging changes, build and run `npm run verify:package`; it installs the tarball in a fresh directory and checks the CLI bin, strict consumer declarations, runtime exports and bundled skills. Keep user skill commands and README examples aligned. Use the user's documentation workflow when API contracts or dependencies change.
