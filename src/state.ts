import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  realpath,
  lstat,
  open,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "./tasks.js";
import { marker } from "./content.js";
import type { Baseline, Config, State, Target, TargetState } from "./types.js";
import { isMissing, object, string } from "./validation.js";

export const targetFingerprint = (target: Target): string =>
  hash([target.provider, target.baseUrl.replace(/\/$/, ""), target.project]);
export const emptyTargetState = (target: Target): TargetState => ({
  fingerprint: targetFingerprint(target),
  tasks: Object.create(null) as TargetState["tasks"],
  pending: Object.create(null) as TargetState["pending"],
});
export function statePath(root: string): string {
  return path.join(root, ".hoospecbridge", "state.json");
}

function parseBaseline(value: unknown): Baseline {
  const item = object(value, "task baseline");
  if (
    typeof item.localDone !== "boolean" ||
    typeof item.remoteDone !== "boolean"
  )
    throw new Error("Invalid state completion flags");
  if (
    item.remoteDocument !== undefined &&
    typeof item.remoteDocument !== "string"
  )
    throw new Error("Invalid state remote document hash");
  return {
    issueId: string(item.issueId, "issueId"),
    localDone: item.localDone,
    remoteDone: item.remoteDone,
    localContent: string(item.localContent, "localContent"),
    remoteContent: string(item.remoteContent, "remoteContent"),
    ...(typeof item.remoteDocument === "string"
      ? { remoteDocument: string(item.remoteDocument, "remoteDocument") }
      : {}),
  };
}

export async function loadState(root: string, config: Config): Promise<State> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath(root), "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error))
      return {
        version: 1,
        repoId: config.repoId,
        targets: Object.create(null) as State["targets"],
      };
    throw error;
  }
  const record = object(value, "state");
  if (record.version !== 1 || record.repoId !== config.repoId)
    throw new Error(
      "State version or repository identity differs from configuration",
    );
  const targets: State["targets"] = Object.create(null) as State["targets"];
  for (const [name, raw] of Object.entries(
    object(record.targets, "state targets"),
  )) {
    const item = object(raw, "target state");
    const tasks: TargetState["tasks"] = Object.create(
      null,
    ) as TargetState["tasks"];
    for (const [key, baseline] of Object.entries(
      object(item.tasks, "baselines"),
    ))
      tasks[key] = parseBaseline(baseline);
    const issueIds = new Set<string>();
    for (const baseline of Object.values(tasks)) {
      if (issueIds.has(baseline.issueId))
        throw new Error(`Duplicate saved issue mapping: ${baseline.issueId}`);
      issueIds.add(baseline.issueId);
    }
    const pending: TargetState["pending"] = Object.create(
      null,
    ) as TargetState["pending"];
    for (const [key, value] of Object.entries(
      object(item.pending, "pending creates"),
    )) {
      const journal = object(value, "pending create");
      const savedMarker = string(journal.marker, "pending marker");
      if (savedMarker !== marker(config.repoId, key))
        throw new Error(`Pending marker does not match task ${key}`);
      if (
        journal.desiredDone !== undefined &&
        typeof journal.desiredDone !== "boolean"
      )
        throw new Error("Invalid pending completion flag");
      pending[key] = {
        marker: savedMarker,
        ...(typeof journal.desiredDone === "boolean"
          ? { desiredDone: journal.desiredDone }
          : {}),
      };
    }
    targets[name] = {
      fingerprint: string(item.fingerprint, "target fingerprint"),
      tasks,
      pending,
    };
  }
  return { version: 1, repoId: config.repoId, targets };
}

export async function saveState(root: string, state: State): Promise<void> {
  const destination = statePath(root);
  const temp = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(state, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, destination);
    // Windows does not support opening directories through fs.open. The file
    // itself is flushed there; POSIX also flushes the renamed directory entry.
    if (process.platform !== "win32") {
      const directory = await open(path.dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
}

/** Serialize local writers. A crashed process leaves a lock for deliberate recovery. */
export async function withLock<T>(
  root: string,
  run: () => Promise<T>,
): Promise<T> {
  root = await realpath(root);
  const directory = path.join(root, ".hoospecbridge");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Symlinked state directory rejected");
  const lock = path.join(directory, "lock");
  await mkdir(lock).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "HooSpecBridge is locked. If no sync is running, remove .hoospecbridge/lock and rerun.",
      );
    throw error;
  });
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    return await run();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
