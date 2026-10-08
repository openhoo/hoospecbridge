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
  const taskMarkers = new Map(
    tasks.map((task) => [marker(repoId, task.key), task.key]),
  );
  const issueIds = new Set<string>();
  for (const issue of issues) {
    if (issueIds.has(issue.id))
      throw new Error(`Duplicate remote issue ID: ${issue.id}`);
    issueIds.add(issue.id);
    const keys = new Set<string>();
    for (const match of descriptionText(issue.description).matchAll(
      /\[(hoospecbridge:[a-f0-9]{32}):begin\]/g,
    )) {
      const key = taskMarkers.get(match[1]!);
      if (key !== undefined) keys.add(key);
    }
    if (keys.size > 1)
      throw new Error(
        `Remote issue ${issue.id} contains markers for multiple tasks: ${[...keys].join(", ")}`,
      );
    for (const key of keys) {
      const previous = result.get(key);
      if (previous)
        throw new Error(
          `Duplicate remote issues for ${key}: ${previous.id}, ${issue.id}`,
        );
      result.set(key, issue);
    }
  }
  return result;
}
