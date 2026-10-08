import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  realpath,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hash } from "./tasks.js";
import type { Baseline, Config, State, Target, TargetState } from "./types.js";
import { isMissing, object, string } from "./validation.js";

export const targetFingerprint = (target: Target): string =>
  hash([target.provider, target.baseUrl.replace(/\/$/, ""), target.project]);
export const emptyTargetState = (target: Target): TargetState => ({
  fingerprint: targetFingerprint(target),
  tasks: {},
  pending: {},
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
  return {
    issueId: string(item.issueId, "issueId"),
    localDone: item.localDone,
    remoteDone: item.remoteDone,
    localContent: string(item.localContent, "localContent"),
    remoteContent: string(item.remoteContent, "remoteContent"),
  };
}

export async function loadState(root: string, config: Config): Promise<State> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath(root), "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error))
      return { version: 1, repoId: config.repoId, targets: {} };
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
    const pending: TargetState["pending"] = Object.create(
      null,
    ) as TargetState["pending"];
    for (const [key, value] of Object.entries(
      object(item.pending, "pending creates"),
    ))
      pending[key] = {
        marker: string(
          object(value, "pending create").marker,
          "pending marker",
        ),
      };
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
    await writeFile(temp, JSON.stringify(state, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, destination);
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
  await mkdir(lock).catch(() => {
    throw new Error(
      "HooSpecBridge is locked. If no sync is running, remove .hoospecbridge/lock and rerun.",
    );
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
