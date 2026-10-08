#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { createTracker } from "./adapters/index.js";
import { initConfig, loadConfig } from "./config.js";
import { scan } from "./tasks.js";
import { sync } from "./sync.js";
import type { Direction } from "./types.js";
import { object, string, isMissing } from "./validation.js";
import { renderPlan } from "./presentation.js";

const HELP = `HooSpecBridge — Spec Kit ↔ Jira / GitLab

Usage:
  hoospecbridge init --provider gitlab --project group/project
  hoospecbridge init --provider jira --project APP --base-url https://team.atlassian.net
  hoospecbridge scan [--root path] [--json]
  hoospecbridge doctor --target NAME
  hoospecbridge plan --target NAME [--direction both|push|pull] [--json]
  hoospecbridge sync --target NAME [--direction both|push|pull] [--apply] [--json]

sync previews by default. --apply writes issues, checkboxes and local state.
push: repository content and completion → tracker.
pull: tracker completion → repository checkboxes; creates no issues.
both: repository content → tracker; completion follows the side changed since last sync.

Credentials: GITLAB_TOKEN, or JIRA_EMAIL and JIRA_API_TOKEN.
Configuration: hoospecbridge.config.json. State: .hoospecbridge/state.json.
Common options: --root PATH, --json, --help, --version.
Exit codes: 0 success/preview, 1 conflicts, 2 configuration/API/operational error.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      provider: { type: "string" },
      project: { type: "string" },
      "base-url": { type: "string" },
      target: { type: "string" },
      direction: { type: "string" },
      apply: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    const metadata = object(
      JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ) as unknown,
      "package metadata",
    );
    process.stdout.write(string(metadata.version, "package version") + "\n");
    return;
  }
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length !== 1)
    throw new Error("Expected one command; use --help");
  const commandOptions: Record<string, readonly string[]> = {
    init: ["provider", "project", "base-url"],
    scan: [],
    doctor: ["target"],
    plan: ["target", "direction"],
    sync: ["target", "direction", "apply"],
  };
  const allowed = Object.hasOwn(commandOptions, command)
    ? commandOptions[command]
    : undefined;
  if (!allowed) throw new Error(`Unknown command ${command}; use --help`);
  for (const option of Object.keys(values)) {
    if (!["root", "json", "help", "version", ...allowed].includes(option))
      throw new Error(`--${option} is not supported by ${command}; use --help`);
  }
  const root = await realpath(values.root ?? ".");
  if (command === "init") {
    if (values.provider !== "gitlab" && values.provider !== "jira")
      throw new Error("init requires --provider gitlab or jira");
    if (!values.project) throw new Error("init requires --project");
    if (values.provider === "jira" && !values["base-url"])
      throw new Error(
        "Jira init requires --base-url https://your-team.atlassian.net",
      );
    const config = await initConfig(
      root,
      values.provider,
      values.project,
      values["base-url"],
    );
    process.stdout.write(
      values.json
        ? JSON.stringify(config, null, 2) + "\n"
        : `Created hoospecbridge.config.json. Keep repoId stable and commit this file.\nSet credentials in your environment, then run hoospecbridge plan --target ${values.provider}.\n`,
    );
    return;
  }
  if (command === "scan") {
    let specsDir = "specs";
    try {
      specsDir = (await loadConfig(root)).specsDir;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const tasks = await scan(root, specsDir);
    if (values.json)
      process.stdout.write(JSON.stringify(tasks, null, 2) + "\n");
    else {
      for (const task of tasks)
        process.stdout.write(
          `${task.done ? "[x]" : "[ ]"} ${task.feature}/${task.id} ${task.description}\n`,
        );
      process.stdout.write(
        `${tasks.length} tasks · ${tasks.filter((task) => task.done).length} completed\n`,
      );
    }
    return;
  }
  if (!["doctor", "plan", "sync"].includes(command))
    throw new Error(`Unknown command ${command}`);
  if (!values.target)
    throw new Error("Select a configured target with --target NAME");
  if (command === "doctor") {
    const config = await loadConfig(root);
    const target = config.targets.find(
      (target) => target.name === values.target,
    );
    if (!target) throw new Error(`Unknown target ${values.target}`);
    const tasks = await scan(root, config.specsDir);
    const issues = await createTracker(target).list();
    const result = {
      target: target.name,
      provider: target.provider,
      tasks: tasks.length,
      accessibleIssues: issues.length,
      writable: "not tested",
    };
    process.stdout.write(
      values.json
        ? JSON.stringify(result, null, 2) + "\n"
        : `Connected to ${target.name}: ${tasks.length} local tasks, ${issues.length} accessible issues. Write permissions are not tested.\n`,
    );
    return;
  }
  const direction = values.direction ?? "both";
  if (!["push", "pull", "both"].includes(direction))
    throw new Error("--direction must be push, pull or both");
  const result = await sync({
    root,
    target: values.target,
    direction: direction as Direction,
    apply: command === "sync" && values.apply === true,
  });
  if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(renderPlan(result.plan, result.applied));
  if (result.plan.conflicts.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `HooSpecBridge: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 2;
});
