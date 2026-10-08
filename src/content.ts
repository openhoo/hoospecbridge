import { hash } from "./tasks.js";
import type {
  Config,
  Content,
  Description,
  Issue,
  JiraDescription,
  JsonObject,
  JsonValue,
  Task,
  Target,
} from "./types.js";

export function marker(repoId: string, key: string): string {
  return `hoospecbridge:${hash([repoId, key]).slice(0, 32)}`;
}
export const begin = (id: string): string => `[${id}:begin]`;
export const end = (id: string): string => `[${id}:end]`;

export function taskContent(task: Task, config: Config): Content {
  const lines = [
    task.description,
    "",
    `Feature: ${task.feature}`,
    `Task: ${task.id}`,
  ];
  if (task.story) lines.push(`Story: ${task.story}`);
  if (task.phase) lines.push(`Phase: ${task.phase}`);
  if (task.parallel) lines.push("Parallelizable: yes");
  lines.push(`Source: ${task.file}:${task.line}`);
  if (config.sourceUrl) {
    const base = config.sourceUrl.replace(/\/$/, "");
    const featurePath = task.file.substring(0, task.file.lastIndexOf("/"));
    lines.push(
      `Tasks: ${base}/${task.file}`,
      `Specification: ${base}/${featurePath}/spec.md`,
      `Plan: ${base}/${featurePath}/plan.md`,
    );
  }
  return {
    title: `[${task.feature}/${task.id}] ${task.description}`.slice(0, 255),
    lines,
  };
}

export const paragraph = (text: string): JsonObject => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});
export function nodeText(node: JsonValue): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  if (typeof node.text === "string") return node.text;
  return Array.isArray(node.content) ? node.content.map(nodeText).join("") : "";
}
export function descriptionText(description: Description): string {
  return typeof description === "string"
    ? description
    : (description?.content ?? []).map(nodeText).join("\n");
}

export function managedText(description: Description, id: string): string {
  const text = descriptionText(description);
  const a = text.indexOf(begin(id));
  const b = text.indexOf(end(id));
  if (
    a < 0 ||
    b <= a ||
    text.indexOf(begin(id), a + 1) >= 0 ||
    text.indexOf(end(id), b + 1) >= 0
  )
    throw new Error(`Missing or ambiguous managed block: ${id}`);
  return text.slice(a + begin(id).length, b).trim();
}

export function replaceBlock(
  description: Description | undefined,
  id: string,
  lines: string[],
  provider: Target["provider"],
): Description {
  if (provider === "gitlab") {
    if (description !== undefined && typeof description !== "string")
      throw new Error("GitLab requires a Markdown description");
    const text = description ?? "";
    const block = [begin(id), ...lines, end(id)].join("\n");
    if (!text) return block;
    managedText(text, id);
    return (
      text.slice(0, text.indexOf(begin(id))) +
      block +
      text.slice(text.indexOf(end(id)) + end(id).length)
    );
  }
  if (typeof description === "string")
    throw new Error("Jira requires an ADF description");
  const nodes = description?.content ?? [];
  let before: JsonObject[] = [];
  let after: JsonObject[] = [];
  if (nodes.length) {
    managedText(description!, id);
    const a = nodes.findIndex((node) => nodeText(node) === begin(id));
    const b = nodes.findIndex((node) => nodeText(node) === end(id));
    if (a < 0 || b <= a)
      throw new Error("Jira managed markers must remain separate paragraphs");
    before = nodes.slice(0, a);
    after = nodes.slice(b + 1);
  }
  const result: JiraDescription = {
    type: "doc",
    version: 1,
    content: [
      ...before,
      ...[begin(id), ...lines, end(id)].map(paragraph),
      ...after,
    ],
  };
  return result;
}

export const contentHash = (
  issue: Pick<Issue, "title" | "description">,
  id: string,
): string => hash([issue.title, managedText(issue.description, id)]);
export const issueHash = (issue: Issue): string =>
  hash([issue.title, issue.description, issue.done]);
