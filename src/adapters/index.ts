import { descriptionText, marker } from "../content.js";
import type {
  Environment,
  Fetcher,
  Issue,
  Target,
  Task,
  Tracker,
} from "../types.js";
import { GitLab } from "./gitlab.js";
import { Jira } from "./jira.js";

export function createTracker(
  target: Target,
  env?: Environment,
  fetcher?: Fetcher,
): Tracker {
  return target.provider === "gitlab"
    ? new GitLab(target, env, fetcher)
    : new Jira(target, env, fetcher);
}
export function indexIssues(
  issues: Issue[],
  repoId: string,
  tasks: Task[],
): Map<string, Issue> {
  const result = new Map<string, Issue>();
  for (const task of tasks) {
    const id = marker(repoId, task.key);
    const matches = issues.filter((issue) =>
      descriptionText(issue.description).includes(`[${id}:begin]`),
    );
    if (matches.length > 1)
      throw new Error(
        `Duplicate remote issues for ${task.key}: ${matches.map((issue) => issue.id).join(", ")}`,
      );
    if (matches[0]) result.set(task.key, matches[0]);
  }
  return result;
}
