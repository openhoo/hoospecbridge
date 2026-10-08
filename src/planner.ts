import {
  contentHash,
  managedDocumentHash,
  marker,
  replaceBlock,
  taskContent,
} from "./content.js";
import { hash } from "./tasks.js";
import type {
  Config,
  Direction,
  Issue,
  IssuePatch,
  Plan,
  Target,
  TargetState,
  Task,
} from "./types.js";

/** Pure planning: no network or disk writes. Content flows from the repository; status may flow either way. */
export function planSync(
  config: Config,
  target: Target,
  tasks: Task[],
  issues: Map<string, Issue>,
  state: TargetState,
  direction: Direction,
): Plan {
  if (!["push", "pull", "both"].includes(direction))
    throw new Error(`Invalid sync direction: ${String(direction)}`);
  const plan: Plan = {
    target: target.name,
    direction,
    actions: [],
    conflicts: [],
    unchanged: 0,
    orphaned: [
      ...new Set([...Object.keys(state.tasks), ...Object.keys(state.pending)]),
    ].filter((key) => !tasks.some((task) => task.key === key)),
  };
  for (const task of tasks) {
    const issue = issues.get(task.key);
    const baseline = state.tasks[task.key];
    const id = marker(config.repoId, task.key);
    const content = taskContent(task, config);
    if (!issue) {
      if (state.pending[task.key])
        plan.conflicts.push({
          key: task.key,
          reason:
            "A previous create has an uncertain outcome. Wait for tracker indexing or inspect the project and reconcile the pending entry before retrying.",
        });
      else if (baseline)
        plan.conflicts.push({
          key: task.key,
          reason: `Mapped issue ${baseline.issueId} is missing; do not recreate automatically.`,
        });
      else if (direction !== "pull")
        plan.actions.push({
          type: "create",
          key: task.key,
          done: task.done,
          content: {
            title: content.title,
            description: replaceBlock(
              undefined,
              id,
              content.lines,
              target.provider,
            ),
          },
        });
      else plan.unchanged++;
      continue;
    }
    try {
      const remoteContent = contentHash(issue, id);
      const remoteDocument = managedDocumentHash(issue.description, id);
      const desiredDescription = replaceBlock(
        undefined,
        id,
        content.lines,
        target.provider,
      );
      const desiredDocument = managedDocumentHash(desiredDescription, id);
      if (
        direction === "both" &&
        baseline?.remoteDocument !== undefined &&
        remoteDocument !== baseline.remoteDocument &&
        remoteDocument !== desiredDocument
      ) {
        plan.conflicts.push({
          key: task.key,
          reason:
            "Remote managed description formatting or rich content changed. Review it and use --direction push to choose repository content.",
        });
        continue;
      }
      const desiredContent = contentHash(
        {
          title: content.title,
          description: desiredDescription,
        },
        id,
      );
      const patch: IssuePatch = {};
      let pullDone: boolean | undefined;
      if (
        direction !== "pull" &&
        (desiredContent !== remoteContent ||
          (direction === "push" && desiredDocument !== remoteDocument)) &&
        // A pull deliberately accepts remote content without changing the
        // repository. Keep that choice until repository content changes.
        (direction === "push" ||
          !baseline ||
          baseline.localContent !== hash(content) ||
          baseline.remoteContent !== remoteContent)
      ) {
        if (
          direction === "both" &&
          (!baseline || remoteContent !== baseline.remoteContent)
        ) {
          plan.conflicts.push({
            key: task.key,
            reason:
              "Remote title or managed description changed. Review it and use --direction push to choose repository content.",
          });
          continue;
        }
        patch.title = content.title;
        patch.description = replaceBlock(
          issue.description,
          id,
          content.lines,
          target.provider,
        );
      }
      if (task.done !== issue.done) {
        if (direction === "push") patch.done = task.done;
        else if (direction === "pull") pullDone = issue.done;
        else if (
          !baseline &&
          state.pending[task.key]?.desiredDone === task.done
        ) {
          // Complete a journaled create recovered through its marker.
          patch.done = task.done;
        } else if (!baseline) {
          plan.conflicts.push({
            key: task.key,
            reason:
              "No status baseline and completion differs. Choose --direction push or pull for initial reconciliation.",
          });
          continue;
        } else {
          const localChanged = task.done !== baseline.localDone;
          const remoteChanged = issue.done !== baseline.remoteDone;
          if (localChanged && !remoteChanged) patch.done = task.done;
          else if (remoteChanged && !localChanged) pullDone = issue.done;
          else {
            plan.conflicts.push({
              key: task.key,
              reason:
                "Completion diverged. Choose --direction push or pull after review.",
            });
            continue;
          }
        }
      }
      if (Object.keys(patch).length)
        plan.actions.push({ type: "update", key: task.key, issue, patch });
      if (pullDone !== undefined)
        plan.actions.push({
          type: "pull",
          key: task.key,
          issue,
          done: pullDone,
        });
      if (!Object.keys(patch).length && pullDone === undefined) {
        if (
          !baseline ||
          state.pending[task.key] ||
          baseline.localContent !== hash(content) ||
          baseline.remoteContent !== remoteContent ||
          baseline.remoteDocument !== remoteDocument ||
          baseline.localDone !== task.done ||
          baseline.remoteDone !== issue.done
        )
          plan.actions.push({ type: "adopt", key: task.key, issue });
        else plan.unchanged++;
      }
    } catch (error) {
      plan.conflicts.push({
        key: task.key,
        reason:
          error instanceof Error
            ? error.message
            : "Invalid managed issue content",
      });
    }
  }
  return plan;
}
