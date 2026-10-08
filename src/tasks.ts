import {
  readdir,
  readFile,
  lstat,
  realpath,
  writeFile,
  rename,
  rm,
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
    if (fenced) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (closing?.[0] === fenceChar && closing.length >= fenceLength)
        fenced = false;
      continue;
    }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      fenced = true;
      fenceChar = fence[1]![0]!;
      fenceLength = fence[1]!.length;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) phase = line.replace(/^#+\s*/, "").trim();
    const match = line.match(/^ {0,3}[-*+]\s+\[([ xX])\]\s+(T\d+)\s+(.+?)\s*$/);
    if (!match) {
      if (/^ {0,3}[-*+]\s+\[[ xX]\]\s+T\d+\b/.test(line))
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
    let parallel = false;
    let story = "";
    for (;;) {
      const tag = description.match(/^\[(P|US\d+)\](?:\s+|$)/);
      if (!tag) break;
      if (tag[1] === "P") {
        if (parallel)
          throw new Error(`${file}:${index + 1}: duplicate [P] tag`);
        parallel = true;
      } else {
        if (story) throw new Error(`${file}:${index + 1}: duplicate story tag`);
        story = tag[1]!;
      }
      description = description.slice(tag[0].length);
    }
    if (!description)
      throw new Error(`${file}:${index + 1}: empty task description`);
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
  const taskByKey = new Map(tasks.map((task) => [task.key, task]));
  const groups = new Map<string, { key: string; done: boolean }[]>();
  const seen = new Map<string, boolean>();
  for (const change of changes) {
    const task = taskByKey.get(change.key);
    if (!task) throw new Error(`Unknown task ${change.key}`);
    if (seen.has(change.key)) {
      if (seen.get(change.key) !== change.done)
        throw new Error(`Conflicting checkbox changes for ${change.key}`);
      continue;
    }
    seen.set(change.key, change.done);
    const group = groups.get(task.file) ?? [];
    group.push(change);
    groups.set(task.file, group);
  }
  const prepared: {
    absolute: string;
    text: string;
    updated: string;
    mode: number;
  }[] = [];
  // Validate every source before replacing any file. Filesystem writes still
  // cannot form a transaction; recheck each source immediately before its write.
  for (const [file, updates] of groups) {
    const absolute = await safeFile(root, file);
    const text = await readFile(absolute, "utf8");
    if (hash(text) !== tasks.find((task) => task.file === file)?.sourceHash)
      throw new Error(`${file} changed during sync; rerun`);
    const lines = text.split("\n");
    for (const change of updates) {
      const task = taskByKey.get(change.key)!;
      const line = lines[task.line - 1];
      if (
        line === undefined ||
        !parseTasks(line, file).some((parsed) => parsed.id === task.id)
      )
        throw new Error(`${file}: task location changed for ${task.id}; rerun`);
      lines[task.line - 1] = line.replace(
        /^(\s*[-*+]\s+\[)[ xX](\])/,
        `$1${change.done ? "x" : " "}$2`,
      );
    }
    prepared.push({
      absolute,
      text,
      updated: lines.join("\n"),
      mode: (await lstat(absolute)).mode,
    });
  }
  for (const { absolute, text, updated, mode } of prepared) {
    if (updated === text) continue;
    if ((await readFile(absolute, "utf8")) !== text)
      throw new Error(`${absolute} changed during sync; rerun`);
    const temp = `${absolute}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, updated, { mode, flag: "wx" });
      await rename(temp, absolute);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
