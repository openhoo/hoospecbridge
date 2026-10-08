import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { array, object, string } from "../src/validation.js";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const manifest = object(
  JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as unknown,
  "package manifest",
);
const version = string(manifest.version, "package version");
const temporary = await mkdtemp(path.join(tmpdir(), "hoospecbridge-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function run(
  command: string,
  args: string[],
  cwd = temporary,
): Promise<string> {
  const result = await execute(command, args, {
    cwd,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

try {
  const result = await run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
    repository,
  );
  const packed = object(
    array(JSON.parse(result) as unknown, "pack output")[0],
    "package archive",
  );
  const filename = string(packed.filename, "archive filename");
  await writeFile(
    path.join(temporary, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  await run(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    path.join(temporary, filename),
  ]);

  const installed = path.join(temporary, "node_modules", "hoospecbridge");
  const cli = path.join(installed, "dist", "cli.js");
  assert.equal(await run(process.execPath, [cli, "--version"]), version);
  assert.match(await run(process.execPath, [cli, "--help"]), /Usage:/);
  // Exercise npm's bin mapping too, not only the compiled entry point.
  assert.equal(
    await run(npm, ["exec", "--offline", "--", "hoospecbridge", "--version"]),
    version,
  );
  const scanned = array(
    JSON.parse(
      await run(process.execPath, [
        cli,
        "scan",
        "--root",
        path.join(repository, "examples"),
        "--json",
      ]),
    ) as unknown,
    "scan output",
  );
  assert.equal(scanned.length, 4);
  assert.equal(object(scanned[0], "sample task").done, true);
  await run(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { parseTasks, sync, planSync, GitLab, Jira } from 'hoospecbridge';
    assert.equal(parseTasks('- [ ] T001 Verify package', 'specs/test/tasks.md').length, 1);
    for (const exported of [sync, planSync, GitLab, Jira]) assert.equal(typeof exported, 'function');
  `,
  ]);

  await writeFile(
    path.join(temporary, "consumer.ts"),
    `
    import { sync, parseTasks, type SyncOptions, type Tracker, type IssuePatch } from 'hoospecbridge';
    const options: SyncOptions = { root: '.', target: 'gitlab', direction: 'pull', apply: false };
    const patch: IssuePatch = { done: true };
    export const tasks = parseTasks('- [ ] T001 Verify types', 'specs/test/tasks.md');
    export const preview = () => sync(options);
    export const update = (tracker: Tracker) => tracker.update('1', patch);
  `,
  );
  await run(process.execPath, [
    path.join(repository, "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--noUncheckedIndexedAccess",
    "--module",
    "NodeNext",
    "--target",
    "ES2023",
    "consumer.ts",
  ]);
  for (const name of ["hoospecbridge-usage", "hoospecbridge-development"]) {
    assert.equal(
      await readFile(path.join(installed, "skills", name, "SKILL.md"), "utf8"),
      await readFile(path.join(repository, "skills", name, "SKILL.md"), "utf8"),
    );
  }
  process.stdout.write(
    JSON.stringify({
      version,
      packageInstall: "passed",
      cliBin: "passed",
      sampleTasks: scanned.length,
      libraryExports: "passed",
      consumerTypecheck: "passed",
      bundledSkills: "passed",
    }) + "\n",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
