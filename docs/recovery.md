# Recovery

## Conflicting managed content

Review the remote issue and local task. Move notes that should survive to a paragraph outside the marker block. To choose repository content, preview `--direction push` and apply it. To import completion while leaving all descriptions alone, use `--direction pull`.

Preserve both markers. For Jira, markers must stay in their own top-level paragraphs. Missing, duplicated or nested markers cause a conflict.

## Interrupted creates

`.hoospecbridge/state.json` contains a `pending` entry before each create request. If the tracker accepted the issue but the response was lost, a subsequent run finds its marker and adopts it. If search indexing has not caught up, the pending entry prevents a duplicate create.

When a pending create remains unresolved:

1. Stop other writers and inspect the configured tracker project.
2. Search for the marker saved under the pending task key. Allow time for Jira's search indexing.
3. If the issue exists and still contains its marker, rerun the plan. If completion differs, choose a direction explicitly.
4. Only if you have verified that no issue was created, back up `state.json` and remove that task's pending entry. Preview before creating again.

Do not delete the entire state directory to bypass an uncertain create; that removes the duplicate-prevention journal.

## Interrupted updates

Already completed writes stay applied. Rerun `plan` and review tracker state. A create followed by a failed status transition retains its mapping and resumes the transition against the existing issue. Other failures may require an explicit direction if the previous baseline is incomplete.

## Stale lock

Check `.hoospecbridge/lock/owner.json` and confirm the recorded process is no longer syncing. Remove only `.hoospecbridge/lock`. Locks are deliberately not reclaimed based solely on elapsed time.

## Missing / moved issues

A saved issue that cannot be fetched stops the run. Check permissions, deletion, project moves and tracker availability. HooSpecBridge does not automatically recreate a saved issue. When deliberately changing tracker projects, add a new target name so its state is isolated.

## Fresh clones and CI

Commit configuration, including `repoId`. Preserve state between runs for automatic completion reconciliation. If the state is unavailable, markers recover issue identity but an initial status mismatch requires explicit `push` or `pull`. Serialize sync runs across clones and CI jobs.
