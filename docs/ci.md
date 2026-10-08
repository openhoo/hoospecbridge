# CI integration

Use `plan --json` as a read-only CI check. Supply the tracker credentials through protected CI variables, and store the plan as an artifact. Apply changes only from a trusted branch/job: repository configuration controls the destination of authenticated requests, so do not give tracker credentials to untrusted pull-request code.

```bash
hoospecbridge plan --target gitlab --direction both --json > sync-plan.json
```

For an applied job:

```bash
hoospecbridge sync --target gitlab --direction push --apply --json > sync-result.json
```

`push` is useful when the repository is the completion source of truth and a fresh runner has no baseline. Use `both` only when you preserve the previous `.hoospecbridge/` state or deliberately reconcile initial status mismatches.

Use a concurrency/resource-group lock shared by all sync jobs for the repository. A local HooSpecBridge lock cannot serialize separate runners. Persist state after failed jobs too, because it may contain an uncertain-create journal or successful partial writes.

Status pulls edit `tasks.md` locally. Your CI must retain those changes as an artifact or use your existing authorized commit workflow. HooSpecBridge never commits or pushes repository changes by itself.

An operational failure exits `2`; conflicts exit `1`. Do not treat an empty JSON file after a failed command as a successful plan.
