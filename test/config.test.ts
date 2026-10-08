import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseConfig,
  loadConfig,
  initConfig,
  CONFIG_FILE,
} from "../src/config.js";
import { config, fixture } from "./helpers.js";

test("config rejects paths that resolve to the repository or are Windows absolute paths", () => {
  for (const specsDir of [
    "./",
    "a/..",
    "C:\\specs",
    "C:specs",
    "c:specs",
    "\\specs",
    " ",
  ])
    assert.throws(() => parseConfig({ ...config, specsDir }), /specsDir/);
});

test("config rejects blank and padded identity and target fields", () => {
  for (const repoId of [" ", " repository "])
    assert.throws(() => parseConfig({ ...config, repoId }), /repoId/);
  for (const project of [" ", " team/project "])
    assert.throws(
      () =>
        parseConfig({
          ...config,
          targets: [{ ...config.targets[0], project }],
        }),
      /project/,
    );
});

test("config errors identify the configuration file", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await writeFile(path.join(root, CONFIG_FILE), "{ bad JSON");
  await assert.rejects(loadConfig(root), /hoospecbridge\.config\.json:/);
  await writeFile(
    path.join(root, CONFIG_FILE),
    JSON.stringify({ ...config, version: 2 }),
  );
  await assert.rejects(
    loadConfig(root),
    /hoospecbridge\.config\.json: Unsupported config version/,
  );
});

test("init never overwrites an existing configuration", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await assert.rejects(initConfig(root, "gitlab", "another/project"), {
    code: "EEXIST",
  });
  assert.deepEqual(await loadConfig(root), config);
});
