import {
  readdir,
  readFile,
  lstat,
  realpath,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ParsedTask, Task } from "./types.js";
import { isMissing } from "./validation.js";

export const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function parseTasks(text: string, file: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const ids = new Set<string>();
  let phase = "";
  let fenced = false;
  let fenceChar = "";
  let fenceLength = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const delimiter = fence[1]!;
      if (!fenced) {
        fenced = true;
        fenceChar = delimiter[0]!;
        fenceLength = delimiter.length;
      } else if (delimiter[0] === fenceChar && delimiter.length >= fenceLength)
        fenced = false;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6}\s/.test(line)) phase = line.replace(/^#+\s*/, "").trim();
    const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(T\d+)\s+(.+?)\s*$/);
    if (!match) {
      if (/^\s*[-*+]\s+\[[ xX]\]\s+T\d+\b/.test(line))
        throw new Error(`${file}:${index + 1}: empty task description`);
      continue;
    }
    const checkbox = match[1]!;
    const id = match[2]!;
    const body = match[3]!;
    if (ids.has(id))
      throw new Error(`${file}:${index + 1}: duplicate task ${id}`);
    ids.add(id);
    let description = body;
    const parallel = /^\[P\]\s+/.test(description);
    description = description.replace(/^\[P\]\s+/, "");
    const story = description.match(/^\[(US\d+)\]\s+/)?.[1] ?? "";
    description = description.replace(/^\[US\d+\]\s+/, "");
    tasks.push({
      key: `${file}#${id}`,
      id,
      file,
      line: index + 1,
      done: checkbox.toLowerCase() === "x",
      description,
      parallel,
      story,
      phase,
    });
  }
  return tasks;
}

export async function safeFile(
  root: string,
  relative: string,
): Promise<string> {
  const resolvedRoot = await realpath(root);
  const absolute = path.resolve(resolvedRoot, relative);
  if (!absolute.startsWith(resolvedRoot + path.sep))
    throw new Error("Path escapes repository");
  const canonical = await realpath(absolute);
  if (canonical !== absolute || !(await lstat(absolute)).isFile())
    throw new Error(`Symlink or non-file rejected: ${relative}`);
  return absolute;
}

export async function scan(root: string, specsDir = "specs"): Promise<Task[]> {
  root = await realpath(root);
  const directory = path.resolve(root, specsDir);
  if (!directory.startsWith(root + path.sep))
    throw new Error("specsDir must be inside repository");
  if ((await realpath(directory)) !== directory)
    throw new Error("Symlinked specs directory rejected");
  const tasks: Task[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const file = path
      .relative(root, path.join(directory, entry.name, "tasks.md"))
      .split(path.sep)
      .join("/");
    let absolute;
    try {
      absolute = await safeFile(root, file);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const text = await readFile(absolute, "utf8");
    const featureTasks = parseTasks(text, file);
    if (!featureTasks.length)
      throw new Error(`${file}: no Spec Kit tasks found`);
    tasks.push(
      ...featureTasks.map((task) => ({
        ...task,
        feature: entry.name,
        sourceHash: hash(text),
      })),
    );
  }
  if (!tasks.length)
    throw new Error(`No Spec Kit tasks found under ${specsDir}`);
  return tasks;
}

export async function setCheckboxes(
  root: string,
  tasks: Task[],
  changes: { key: string; done: boolean }[],
): Promise<void> {
  const groups = new Map<string, { key: string; done: boolean }[]>();
  for (const change of changes) {
    const file = tasks.find((task) => task.key === change.key)?.file;
    if (!file) throw new Error(`Unknown task ${change.key}`);
    const group = groups.get(file) ?? [];
    group.push(change);
    groups.set(file, group);
  }
  for (const [file, updates] of groups) {
    const absolute = await safeFile(root, file);
    const text = await readFile(absolute, "utf8");
    if (hash(text) !== tasks.find((task) => task.file === file)?.sourceHash)
      throw new Error(`${file} changed during sync; rerun`);
    const lines = text.split("\n");
    for (const change of updates) {
      const task = tasks.find((item) => item.key === change.key)!;
      lines[task.line - 1] = lines[task.line - 1]!.replace(
        /^(\s*[-*+]\s+\[)[ xX](\])/,
        `$1${change.done ? "x" : " "}$2`,
      );
    }
    const temp = `${absolute}.${randomUUID()}.tmp`;
    await writeFile(temp, lines.join("\n"), {
      mode: (await lstat(absolute)).mode,
    });
    await rename(temp, absolute);
  }
}
