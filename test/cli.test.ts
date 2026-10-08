import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers.js";

const execute = promisify(execFile);
const cli = (args: string[]) =>
  execute(process.execPath, ["--import", "tsx", "src/cli.ts", ...args]);

test("CLI rejects ignored command flags before resolving the repository", async () => {
  for (const args of [
    ["scan", "--apply"],
    ["doctor", "--apply"],
    ["plan", "--apply"],
    ["scan", "--target", "gitlab"],
    ["init", "--direction", "pull"],
  ]) {
    await assert.rejects(
      cli([...args, "--root", "/a-missing-repository"]),
      (error: unknown) => {
        assert.ok(
          error &&
            typeof error === "object" &&
            "code" in error &&
            "stderr" in error,
        );
        assert.equal(error.code, 2);
        assert.match(String(error.stderr), /not supported/);
        return true;
      },
    );
  }
});

test("CLI version matches the installed package metadata", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  assert.equal((await cli(["--version"])).stdout.trim(), metadata.version);
});

test("CLI scan emits parseable JSON and successful exit", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const result = await cli(["scan", "--root", root, "--json"]);
  const tasks = JSON.parse(result.stdout) as { id: string }[];
  assert.equal(tasks[0]?.id, "T001");
  assert.equal(result.stderr, "");
});

test("CLI reports unknown prototype property commands as usage errors", async () => {
  for (const command of ["constructor", "toString", "__proto__"])
    await assert.rejects(cli([command]), (error: unknown) => {
      assert.ok(error && typeof error === "object" && "stderr" in error);
      assert.match(String(error.stderr), /Unknown command/);
      return true;
    });
});
