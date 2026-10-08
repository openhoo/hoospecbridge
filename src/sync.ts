import { readFile } from "node:fs/promises";
import { createTracker, indexIssues } from "./adapters/index.js";
import {
  contentHash,
  issueHash,
  managedDocumentHash,
  marker,
  taskContent,
} from "./content.js";
import { loadConfig } from "./config.js";
import { planSync } from "./planner.js";
import {
  emptyTargetState,
  loadState,
  saveState,
  targetFingerprint,
  withLock,
} from "./state.js";
import { hash, safeFile, scan, setCheckboxes } from "./tasks.js";
import type {
  Baseline,
  Config,
  Direction,
  Environment,
  Issue,
  Plan,
  Target,
  Task,
  Tracker,
} from "./types.js";

export interface SyncOptions {
  root: string;
  target: string;
  direction?: Direction;
  apply?: boolean;
  env?: Environment;
  tracker?: Tracker;
}
export interface SyncResult {
  applied: boolean;
  plan: Plan;
}

function baseline(config: Config, task: Task, issue: Issue): Baseline {
  return {
    issueId: issue.id,
    localDone: task.done,
    remoteDone: issue.done,
    localContent: hash(taskContent(task, config)),
    remoteContent: contentHash(issue, marker(config.repoId, task.key)),
    remoteDocument: managedDocumentHash(
      issue.description,
      marker(config.repoId, task.key),
    ),
  };
}

async function assertSources(root: string, tasks: Task[]): Promise<void> {
  for (const task of [
    ...new Map(tasks.map((task) => [task.file, task])).values(),
  ]) {
    const text = await readFile(await safeFile(root, task.file), "utf8");
    if (hash(text) !== task.sourceHash)
      throw new Error(`${task.file} changed during sync; rerun`);
  }
}

async function execute(options: SyncOptions): Promise<SyncResult> {
  const config = await loadConfig(options.root);
  const target: Target | undefined = config.targets.find(
    (target) => target.name === options.target,
  );
  if (!target)
    throw new Error(
      `Unknown target ${options.target}; choose ${config.targets.map((target) => target.name).join(", ")}`,
    );
  const tasks = await scan(options.root, config.specsDir);
  const state = await loadState(options.root, config);
  const targetState = state.targets[target.name] ?? emptyTargetState(target);
  if (targetState.fingerprint !== targetFingerprint(target))
    throw new Error(
      "Tracker URL/project changed under an existing target. Use a new target name and review the new mappings.",
    );
  const tracker = options.tracker ?? createTracker(target, options.env);
  const issues = indexIssues(await tracker.list(), config.repoId, tasks);
  // Direct reads bypass Jira's eventual search indexing for existing mappings.
  for (const task of tasks) {
    const saved = targetState.tasks[task.key];
    if (!saved) continue;
    const issue = await tracker.get(saved.issueId);
    if (issue.id !== saved.issueId)
      throw new Error(
        `Tracker returned issue ${issue.id} for saved mapping ${saved.issueId}`,
      );
    if (issues.has(task.key) && issues.get(task.key)?.id !== issue.id)
      throw new Error(`Duplicate issue mapping for ${task.key}`);
    issues.set(task.key, issue);
  }
  const plan = planSync(
    config,
    target,
    tasks,
    issues,
    targetState,
    options.direction ?? "both",
  );
  // Resolve workflow availability during preview too.
  for (const action of plan.actions) {
    if (action.type !== "update" || action.patch.done === undefined) continue;
    try {
      await tracker.validateStatus?.(action.issue.id, action.patch.done);
    } catch (error) {
      plan.conflicts.push({
        key: action.key,
        reason:
          error instanceof Error
            ? error.message
            : "Status transition unavailable",
      });
    }
  }
  if (!options.apply || plan.conflicts.length) return { applied: false, plan };
  await assertSources(options.root, tasks);
  // Recheck all existing issues before any mutation. APIs lack atomic compare-and-swap;
  // an edit after this check remains a documented race.
  for (const issue of new Map(
    plan.actions
      .filter((action) => action.type !== "create")
      .map((action) => [action.issue.id, action.issue]),
  ).values()) {
    const current = await tracker.get(issue.id);
    if (current.id !== issue.id || issueHash(current) !== issueHash(issue))
      throw new Error(`Issue ${issue.id} changed during planning; rerun`);
  }
  state.targets[target.name] = targetState;
  const affected = new Set<string>();
  for (const action of plan.actions) {
    const task = tasks.find((task) => task.key === action.key)!;
    if (action.type === "pull") continue;
    await assertSources(options.root, [task]);
    let issue: Issue;
    if (action.type === "create") {
      targetState.pending[action.key] = {
        marker: marker(config.repoId, action.key),
        desiredDone: action.done,
      };
      await saveState(options.root, state);
      issue = await tracker.create(action.content);
      // Persist the returned mapping before a possible close/transition request.
      issues.set(task.key, issue);
      targetState.tasks[task.key] = {
        ...baseline(config, task, issue),
        // This is a mapping checkpoint, not acceptance of unverified content.
        remoteContent: contentHash(
          action.content,
          marker(config.repoId, task.key),
        ),
        remoteDocument: managedDocumentHash(
          action.content.description,
          marker(config.repoId, task.key),
        ),
        // Keep the requested status pending until a verified readback. This
        // synthetic baseline makes a failed initial transition retry its intent.
        localDone: !action.done,
        remoteDone: !action.done,
      };
      delete targetState.pending[task.key];
      await saveState(options.root, state);
      if (issue.done !== action.done) {
        const createdId = issue.id;
        issue = await tracker.update(createdId, { done: action.done });
        if (issue.id !== createdId)
          throw new Error(
            `Tracker returned issue ${issue.id} while updating created issue ${createdId}`,
          );
      }
      if (
        issue.done !== action.done ||
        contentHash(issue, marker(config.repoId, task.key)) !==
          contentHash(action.content, marker(config.repoId, task.key)) ||
        managedDocumentHash(
          issue.description,
          marker(config.repoId, task.key),
        ) !==
          managedDocumentHash(
            action.content.description,
            marker(config.repoId, task.key),
          )
      )
        throw new Error(
          `Created issue ${issue.id} did not retain requested content/status; inspect and rerun`,
        );
    } else if (action.type === "update") {
      // Earlier requests may take long enough for a subsequent issue to change.
      // Keep the batch preflight, and check this issue again at its write boundary.
      const current = await tracker.get(action.issue.id);
      if (
        current.id !== action.issue.id ||
        issueHash(current) !== issueHash(action.issue)
      )
        throw new Error(
          `Issue ${action.issue.id} changed before update; rerun`,
        );
      issue = await tracker.update(action.issue.id, action.patch);
      if (issue.id !== action.issue.id)
        throw new Error(
          `Tracker returned issue ${issue.id} while updating issue ${action.issue.id}`,
        );
      if (
        (action.patch.done !== undefined && issue.done !== action.patch.done) ||
        (action.patch.title !== undefined &&
          issue.title !== action.patch.title) ||
        (action.patch.description !== undefined &&
          contentHash(issue, marker(config.repoId, task.key)) !==
            contentHash(
              {
                title: action.patch.title ?? issue.title,
                description: action.patch.description,
              },
              marker(config.repoId, task.key),
            )) ||
        (action.patch.description !== undefined &&
          managedDocumentHash(
            issue.description,
            marker(config.repoId, task.key),
          ) !==
            managedDocumentHash(
              action.patch.description,
              marker(config.repoId, task.key),
            ))
      )
        throw new Error(
          `Issue ${issue.id} did not retain requested changes; rerun after inspecting the tracker`,
        );
    } else issue = action.issue;
    const readback = await tracker.get(issue.id);
    if (readback.id !== issue.id || issueHash(readback) !== issueHash(issue))
      throw new Error(
        `Issue ${issue.id} did not retain returned changes; inspect and rerun`,
      );
    issue = readback;
    issues.set(task.key, issue);
    affected.add(task.key);
    const checkpoint = baseline(config, task, issue);
    if (
      plan.actions.some(
        (candidate) => candidate.type === "pull" && candidate.key === task.key,
      )
    ) {
      // Content writes are complete, but retain the status baseline until the
      // local checkbox is saved. A failed pull can then be retried safely.
      const previous = targetState.tasks[task.key];
      checkpoint.localDone = previous?.localDone ?? task.done;
      checkpoint.remoteDone = previous?.remoteDone ?? task.done;
    }
    targetState.tasks[task.key] = checkpoint;
    delete targetState.pending[task.key];
    await saveState(options.root, state);
  }
  const pulls = plan.actions.filter((action) => action.type === "pull");
  await assertSources(options.root, tasks);
  // Check statuses before changing local files as well as after remote writes.
  for (const pull of pulls) {
    const expected = issues.get(pull.key)!;
    const current = await tracker.get(expected.id);
    if (
      current.id !== expected.id ||
      issueHash(current) !== issueHash(expected)
    )
      throw new Error(
        `Issue ${expected.id} changed before checkbox pull; rerun`,
      );
  }
  await setCheckboxes(options.root, tasks, pulls);
  for (const pull of pulls) {
    tasks.find((task) => task.key === pull.key)!.done = pull.done;
    affected.add(pull.key);
  }
  for (const key of affected) {
    const task = tasks.find((task) => task.key === key)!;
    const issue = await tracker.get(issues.get(key)!.id);
    if (
      issue.id !== issues.get(key)!.id ||
      issueHash(issue) !== issueHash(issues.get(key)!)
    )
      throw new Error(
        `Issue ${issue.id} changed during sync; review local checkbox and rerun`,
      );
    targetState.tasks[key] = baseline(config, task, issue);
    delete targetState.pending[key];
  }
  await saveState(options.root, state);
  return { applied: true, plan };
}

export async function sync(options: SyncOptions): Promise<SyncResult> {
  if (options.apply !== undefined && typeof options.apply !== "boolean")
    throw new Error("Sync apply must be a boolean");
  if (
    options.direction !== undefined &&
    !["push", "pull", "both"].includes(options.direction)
  )
    throw new Error(`Invalid sync direction: ${String(options.direction)}`);
  // Preview requires no filesystem mutations. Applied runs share a local lock.
  return options.apply
    ? withLock(options.root, () => execute(options))
    : execute(options);
}
