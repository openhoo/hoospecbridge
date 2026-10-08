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
    const encodedFile = task.file.split("/").map(encodeURIComponent).join("/");
    const featurePath = encodedFile.substring(0, encodedFile.lastIndexOf("/"));
    lines.push(
      `Tasks: ${base}/${encodedFile}`,
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
  if (node.type === "hardBreak") return "\n";
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

function markerParagraph(node: JsonObject, text: string): boolean {
  return (
    node.type === "paragraph" &&
    Array.isArray(node.content) &&
    node.content.every(
      (child) =>
        child !== null &&
        typeof child === "object" &&
        !Array.isArray(child) &&
        child.type === "text" &&
        typeof child.text === "string",
    ) &&
    nodeText(node) === text
  );
}

export function replaceBlock(
  description: Description | undefined,
  id: string,
  lines: string[],
  provider: Target["provider"],
): Description {
  if (
    lines.some(
      (line) =>
        line.includes(begin(id)) ||
        line.includes(end(id)) ||
        /\[hoospecbridge:[a-f0-9]{32}:(?:begin|end)\]/.test(line),
    )
  )
    throw new Error("Task content must not include managed block markers");
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
    const a = nodes.findIndex((node) => markerParagraph(node, begin(id)));
    const b = nodes.findIndex((node) => markerParagraph(node, end(id)));
    if (a < 0 || b <= a)
      throw new Error("Jira managed markers must remain separate paragraphs");
    before = nodes.slice(0, a);
    after = nodes.slice(b + 1);
  }
  const result: JiraDescription = {
    ...description,
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

/** Detect rich edits inside a managed block while ignoring external human notes. */
export function managedDocumentHash(
  description: Description,
  id: string,
): string {
  const text = managedText(description, id);
  if (typeof description === "string") return hash(text);
  const a = description.content.findIndex((node) =>
    markerParagraph(node, begin(id)),
  );
  const b = description.content.findIndex((node) =>
    markerParagraph(node, end(id)),
  );
  if (a < 0 || b <= a)
    throw new Error("Jira managed markers must remain separate paragraphs");
  // JSON object property order is not meaningful, but node/mark array order is.
  return hash(canonicalJson(description.content.slice(a, b + 1)));
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key]!)]),
    );
  return value;
}

export const contentHash = (
  issue: Pick<Issue, "title" | "description">,
  id: string,
): string => hash([issue.title, managedText(issue.description, id)]);
export const issueHash = (issue: Issue): string =>
  hash([issue.title, issue.description, issue.done]);
