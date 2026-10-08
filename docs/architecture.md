# Architecture

HooSpecBridge has a small dependency-free runtime. Node supplies filesystem, HTTP, argument parsing and cryptography.

| Module                       | Responsibility                                                       |
| ---------------------------- | -------------------------------------------------------------------- |
| `types.ts`                   | Public discriminated models for tasks, targets, plans and adapters   |
| `validation.ts`, `config.ts` | Runtime validation of untrusted JSON and configuration               |
| `tasks.ts`                   | Spec Kit discovery, parsing and minimal checkbox edits               |
| `content.ts`                 | Stable markers and managed Markdown / ADF blocks                     |
| `adapters/`                  | HTTP transport and Jira / GitLab request/response translation        |
| `planner.ts`                 | Pure snapshot comparison and actionable conflicts                    |
| `state.ts`                   | Baselines, pending-create journal, atomic persistence and local lock |
| `sync.ts`                    | Preview/apply orchestration and mutation verification                |
| `cli.ts`                     | Human/JSON output and exit codes                                     |

## Flow

1. Read configuration, tasks and the previous target baseline.
2. List project issues and match deterministic markers; directly read saved issue IDs to bypass eventual search indexing.
3. Plan content updates and completion reconciliation without side effects.
4. Validate existing Jira status transitions. Any conflict prevents application of the whole plan.
5. Before applying, verify source fingerprints and re-read existing issues.
6. Journal each create before its request and save mappings immediately after receiving a created issue.
7. Apply remote changes, then local checkbox edits. Read back affected remote issues before recording final baselines.

## Ownership

Repository descriptions are authoritative. Automatic mode detects edits to titles and the managed description block; notes outside the block remain owned by humans. Pull updates completion only.

Completion uses separate local and remote baseline flags. In `both`, a changed local flag pushes while a changed remote flag pulls. A recovered issue without a baseline must agree with local completion or be reconciled explicitly.

The issue marker depends on stable repository identity, feature file path and task ID. Identical task IDs in separate features are independent. Markers do not depend on the issue title or filesystem checkout path.

## Limits of transactional behavior

Local locks protect one checkout. Remote APIs and multiple local files cannot participate in a shared transaction. The journal prevents blind create retries in the same checkout, and successful updates are checkpointed. It does not provide distributed locking across unrelated clones.

Remote rechecks detect edits between planning and application, but a concurrent edit after the final check can race with a write. Use one writer and schedule sync outside collaborative editing windows when overwrites would be consequential.

## API references

Implementation was checked against the official Spec Kit task template, GitLab issues API, and Jira Cloud REST v3 issue/search/transition documentation on October 8, 2026. Context7 resolution for the generic Jira API returned Data Center material, so the Cloud v3 endpoints were verified against Atlassian's Cloud documentation directly.

- Spec Kit: `github/spec-kit`, `templates/commands/tasks.md`
- GitLab: issues API, `/api/v4/projects/:id/issues`, `state_event`
- Jira Cloud: `/rest/api/3/search/jql`, `/rest/api/3/issue`, `/rest/api/3/issue/:key/transitions`
