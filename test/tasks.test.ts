import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { parseTasks, scan, setCheckboxes } from "../src/tasks.js";
import { fixture, tasksFile } from "./helpers.js";

test("parses Spec Kit IDs, story, phase, parallelism and case-insensitive completion", () => {
  const tasks = parseTasks(
    "# Tasks\n## Phase 2\n- [X] T012 [P] [US1] Add user in src/user.ts\n",
    tasksFile,
  );
  assert.deepEqual(tasks, [
    {
      key: `${tasksFile}#T012`,
      file: tasksFile,
      line: 3,
      id: "T012",
      done: true,
      parallel: true,
      story: "US1",
      phase: "Phase 2",
      description: "Add user in src/user.ts",
    },
  ]);
});

test("ignores examples inside both types of fenced code block", () => {
  const text =
    "```markdown\n- [ ] T001 Example\n```\n~~~\n- [ ] T001 Example\n~~~\n- [ ] T001 Real task\n";
  assert.equal(parseTasks(text, tasksFile).length, 1);
});

test("duplicate IDs fail within a feature, but IDs may repeat across features", () => {
  assert.throws(
    () => parseTasks("- [ ] T001 A\n- [x] T001 B", tasksFile),
    /duplicate/,
  );
  assert.notEqual(
    parseTasks("- [ ] T001 A", "specs/a/tasks.md")[0]?.key,
    parseTasks("- [ ] T001 A", "specs/b/tasks.md")[0]?.key,
  );
});

test("pull preserves CRLF, uppercase untouched checkboxes, prose and final newline", async (t) => {
  const text =
    "# My plan\r\n\r\n- [ ] T001 Do it\r\n- [X] T002 Keep it\r\n\r\nNotes remain.\r\n";
  const { root, clean } = await fixture(text);
  t.after(clean);
  const tasks = await scan(root);
  await setCheckboxes(root, tasks, [{ key: `${tasksFile}#T001`, done: true }]);
  assert.equal(
    await readFile(path.join(root, tasksFile), "utf8"),
    text.replace("- [ ] T001", "- [x] T001"),
  );
});

test("pull rejects source edits made after scan", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tasks = await scan(root);
  await writeFile(path.join(root, tasksFile), "- [ ] T001 Changed by editor\n");
  await assert.rejects(
    setCheckboxes(root, tasks, [{ key: `${tasksFile}#T001`, done: true }]),
    /changed during sync/,
  );
});

test("scan rejects symlinked source files", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await writeFile(path.join(root, "outside.md"), "- [ ] T002 Outside\n");
  const { rm } = await import("node:fs/promises");
  await rm(path.join(root, tasksFile));
  await symlink(path.join(root, "outside.md"), path.join(root, tasksFile));
  await assert.rejects(scan(root), /Symlink/);
});
