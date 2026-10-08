# HooSpecBridge

**Keep Spec Kit tasks and Jira / GitLab issues connected.**

HooSpecBridge is a TypeScript CLI and library from OpenHoo. It turns each task in `specs/<feature>/tasks.md` into a linked issue, updates its description as the plan evolves, and brings issue completion back into the repository.

```text
Spec Kit repository                HooSpecBridge              Issue tracker
specs/001-checkout/tasks.md     ── task content ──────────▶    Jira Cloud
- [ ] T003 [US1] Validate ...   ◀─ completion status ─────▶    GitLab
spec.md + plan.md links              preview → apply          one issue per task
```

## What it does

- Parses Spec Kit task IDs, completion checkboxes, `[P]`, `[US1]` and phase headings.
- Creates and updates GitLab issues or Jira Cloud tasks, with specification and plan links.
- Supports repository-to-tracker push, tracker-to-repository status pull, and automatic status reconciliation.
- Previews changes by default. `--apply` saves them.
- Recovers mappings using stable issue markers; keeps local baselines and an interrupted-create journal.
- Preserves human notes outside its managed description block and Jira rich content outside its managed paragraphs.
- Reports conflicts, duplicate markers, orphaned mappings and unavailable Jira transitions.
- Includes a typed library API and installable agent skills.

## Install

Requires Node.js 22 or newer.

From the repository:

```bash
npm ci
npm run check
npm install --global .
hoospecbridge --help
```

From GitHub:

```bash
npm install --global github:openhoo/hoospecbridge
```

There is no npm registry release yet. GitHub installation builds the TypeScript source during `prepare`.

## Quick start: GitLab

Run these commands in your Spec Kit repository:

```bash
hoospecbridge init --provider gitlab --project my-group/my-project
# Set GITLAB_TOKEN through your shell or CI secret store.
hoospecbridge scan
hoospecbridge doctor --target gitlab
hoospecbridge plan --target gitlab
hoospecbridge sync --target gitlab --apply
```

For a self-managed instance, add `--base-url https://gitlab.example.com` to `init`. The token needs access to the project and API write permissions when applying changes.

Example scan output, generated from the included sample repository:

```text
[x] 001-checkout/T001 Create project structure
[ ] 001-checkout/T002 Create basket model in src/basket.ts
[ ] 001-checkout/T003 Validate basket in src/checkout.ts
[ ] 001-checkout/T004 Add checkout tests in test/checkout.test.ts
4 tasks · 1 completed
```

## Quick start: Jira Cloud

```bash
hoospecbridge init --provider jira --project APP \
  --base-url https://my-team.atlassian.net
# Set JIRA_EMAIL and JIRA_API_TOKEN through your shell or CI secret store.
hoospecbridge doctor --target jira
hoospecbridge plan --target jira
hoospecbridge sync --target jira --apply
```

Jira uses ADF descriptions and the Cloud REST v3 enhanced search endpoint. It creates issue type `Task` by default. Your project must allow the issue type and supplied fields; workflows requiring additional create fields are not supported in this version.

For status updates, HooSpecBridge chooses the single available transition into the `done` category, or into `new` when reopening. If the workflow offers multiple possibilities, configure `doneTransition` / `openTransition` explicitly. Existing status changes are validated during preview. Transitions for a newly created issue can only be checked after creation.

## Choose the sync direction

| Direction        | Descriptions and titles                                   | Completion                                        | Creates issues |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------- | -------------- |
| `both` (default) | Repository → tracker; conflicts on edited managed content | Uses the side changed since the last applied sync | Yes            |
| `push`           | Repository wins, including over edited managed content    | Repository wins                                   | Yes            |
| `pull`           | Preserved                                                 | Tracker wins                                      | No             |

```bash
hoospecbridge sync --target gitlab --direction push --apply
hoospecbridge sync --target jira --direction pull --apply
hoospecbridge plan --target gitlab --json
```

If any task conflicts, the entire planned batch is left unapplied. Use explicit `push` or `pull` after reviewing the conflict. `pull` imports only completion; it does not rewrite task descriptions or add remote-only tasks.

## Configuration

Commit `hoospecbridge.config.json`. Keep its generated `repoId` stable across clones. It is used with the feature path and task ID to identify remote issues.

```json
{
  "version": 1,
  "repoId": "a-stable-repository-identity",
  "specsDir": "specs",
  "sourceUrl": "https://gitlab.example.com/my-group/my-project/-/blob/main",
  "targets": [
    {
      "name": "gitlab",
      "provider": "gitlab",
      "baseUrl": "https://gitlab.example.com",
      "project": "my-group/my-project",
      "tokenEnv": "GITLAB_TOKEN"
    },
    {
      "name": "jira",
      "provider": "jira",
      "baseUrl": "https://my-team.atlassian.net",
      "project": "APP",
      "issueType": "Task",
      "emailEnv": "JIRA_EMAIL",
      "tokenEnv": "JIRA_API_TOKEN",
      "doneTransition": "31",
      "openTransition": "11"
    }
  ]
}
```

The transition IDs above are examples; use the IDs from your workflow. `sourceUrl` is a repository blob prefix including the branch. Task source paths are appended to it. Credentials are supplied only through named environment variables.

One target is selected per command. Target names have separate mappings and baselines; when connecting the same repository to both trackers, decide which target supplies completion before running them sequentially.

## State and recovery

Add `.hoospecbridge/` to your Spec Kit repository's `.gitignore`. It contains issue mappings, last synced completion/content fingerprints, and pending creates. Persist this directory between CI runs when you want automatic reconciliation against the previous baseline. Without it, matching issue markers recover identity; a completion mismatch requires explicit direction.

Task identity is `repoId + relative tasks.md path + task ID`. Renaming a feature directory or renumbering an ID creates a new identity. Deleted tasks are reported as orphaned; their remote issues are retained.

Each create is journaled before the request. An interrupted request that does not appear in tracker search blocks another create. Wait for indexing and rerun, or inspect the project and reconcile the pending entry as described in [recovery](docs/recovery.md).

Applied runs use a local lock, source fingerprints, remote rechecks and atomic local file replacement. Tracker APIs do not offer an atomic transaction across all issues or a compare-and-swap operation. Writes already completed before an API failure remain recorded. Run a single sync writer per repository across machines and review any interrupted batch before retrying.

## Library API

```typescript
import { sync, type SyncResult } from "hoospecbridge";

const result: SyncResult = await sync({
  root: process.cwd(),
  target: "gitlab",
  direction: "both",
  apply: false,
});

console.log(result.plan.actions, result.plan.conflicts);
```

`planSync` is a pure function for integrations that already have task/issue snapshots. `Tracker` is the typed adapter interface for custom integrations and testing. `parseTasks`, `scan`, config helpers, and the GitLab/Jira adapters are also exported.

## Agent skills

Two separate skills are bundled:

- `hoospecbridge-usage`: configure and run syncs in a Spec Kit repository.
- `hoospecbridge-development`: work on the parser, planner and adapters.

```bash
npx skills add openhoo/hoospecbridge --skill hoospecbridge-usage
```

## Development and CI

```bash
npm ci
npm run check
npm run demo
npm pack
```

Source and tests use strict TypeScript, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. The runtime has no third-party dependencies. Tests exercise round trips through local HTTP servers for both APIs, source preservation, conflict handling, pagination and interrupted-write recovery. These fixtures do not prove access to your Jira or GitLab project; `doctor` checks read access and an applied sync verifies the writes.

See [architecture](docs/architecture.md), [recovery](docs/recovery.md), [CI integration](docs/ci.md), and [contributing](CONTRIBUTING.md).

Exit codes: `0` successful preview/apply, `1` conflicts, `2` configuration, API or operational error. JSON output goes to stdout; operational errors go to stderr.

## Scope

This first release syncs tasks from `specs/<feature>/tasks.md`. `spec.md` and `plan.md` are linked as context. Epic/story hierarchy creation, assignees, milestones, dependencies, Jira Data Center and webhook daemons are not implemented.

## License

Apache-2.0. See [LICENSE](LICENSE).
