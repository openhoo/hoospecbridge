---
name: hoospecbridge-usage
description: Configure and run HooSpecBridge to sync Spec Kit tasks with Jira Cloud or GitLab issues, preview changes, resolve conflicts, and recover interrupted syncs.
---

# Use HooSpecBridge

Check `hoospecbridge --help` in the user's environment. If absent, install from `github:openhoo/hoospecbridge` using npm; Node.js 22+ is required. HooSpecBridge syncs `specs/<feature>/tasks.md` tasks and completion; it does not create epic/story hierarchies or pull issue descriptions into specifications.

Initialize inside the selected Spec Kit repository:

```bash
hoospecbridge init --provider gitlab --project GROUP/PROJECT
hoospecbridge init --provider jira --project KEY --base-url https://TEAM.atlassian.net
```

Choose one init command. An existing config is not overwritten. Keep `repoId` stable and commit `hoospecbridge.config.json`. Use `sourceUrl` for repository blob links, `specsDir` for a custom feature directory, and separate named targets for Jira/GitLab. Credentials belong in `GITLAB_TOKEN`, or `JIRA_EMAIL` / `JIRA_API_TOKEN`; custom environment-variable names can be configured. Never put credentials in config or output.

Use `scan`, then `doctor --target NAME` for read access, then `plan --target NAME --json`. `doctor` does not prove write permissions. `sync` also previews unless `--apply` is supplied. Apply when the user's request authorizes the shown writes; a user who has already requested sync does not need another generic confirmation.

- `both`: push task content, detect managed remote edits, reconcile completion from the side changed since the last baseline.
- `push`: choose repository content and completion, including overwriting edited managed content.
- `pull`: choose tracker completion; preserve descriptions and create no issues.

Any conflict prevents the planned batch from applying. Review edited managed content before choosing explicit push. Keep human notes outside the bracketed HooSpecBridge markers; Jira markers must remain separate top-level paragraphs. An initial/recovered completion mismatch needs explicit direction. Configure workflow-specific `doneTransition` / `openTransition` when Jira offers ambiguous transitions.

Managed Jira links, marks and media are tracked even when text is unchanged. Explicit pull records preserved remote content; unchanged automatic runs retain it until local content changes or push is chosen. New interrupted-create journals retain completion intent and can resume it automatically; older journals may need explicit direction.

Add `.hoospecbridge/` to gitignore and persist it between automated runs. Serialize writers across clones. An interrupted create may have succeeded: preserve its pending journal, wait for tracker indexing and rerun. Remove an individual pending entry only after verifying that no issue was created. A stale lock may be removed only after checking its recorded process is no longer syncing.

Report preview, applied writes, conflicts and live readback separately. Exit `0` is success, `1` conflict, `2` operational/config/API error. Pull edits are local; HooSpecBridge does not commit or push them. A feature path/ID rename changes identity and can create new issues; orphaned remote issues are retained.
