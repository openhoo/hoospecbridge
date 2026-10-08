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

test("fence content cannot close a block with a trailing info string", () => {
  const text =
    "````markdown\n```still code\n- [ ] T001 Example\n````\n- [ ] T001 Actual\n";
  assert.equal(parseTasks(text, tasksFile)[0]?.description, "Actual");
});

test("parses task tags in either order and rejects descriptions made only of tags", () => {
  const task = parseTasks("- [ ] T001 [US2] [P] Add checkout", tasksFile)[0];
  assert.equal(task?.story, "US2");
  assert.equal(task?.parallel, true);
  assert.equal(task?.description, "Add checkout");
  for (const tags of ["[P]", "[US1]", "[P] [US1]"])
    assert.throws(
      () => parseTasks(`- [ ] T001 ${tags}`, tasksFile),
      /empty task description/,
    );
  assert.throws(
    () => parseTasks("- [ ] T001 [US1] [US2] Bad", tasksFile),
    /duplicate story/,
  );
});

test("checkbox batch validates all files before replacing any source", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const { mkdir } = await import("node:fs/promises");
  const second = path.join(root, "specs", "002-other", "tasks.md");
  await mkdir(path.dirname(second));
  await writeFile(second, "- [ ] T001 Another task\n");
  const tasks = await scan(root);
  const original = await readFile(path.join(root, tasksFile), "utf8");
  await writeFile(second, "- [ ] T001 Edited task\n");
  await assert.rejects(
    setCheckboxes(
      root,
      tasks,
      tasks.map((task) => ({ key: task.key, done: true })),
    ),
    /changed during sync/,
  );
  assert.equal(await readFile(path.join(root, tasksFile), "utf8"), original);
});

test("checkbox batch rejects conflicting changes for the same task before writes", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tasks = await scan(root);
  const original = await readFile(path.join(root, tasksFile), "utf8");
  const key = tasks[0]!.key;
  await assert.rejects(
    setCheckboxes(root, tasks, [
      { key, done: true },
      { key, done: false },
    ]),
    /Conflicting checkbox/,
  );
  assert.equal(await readFile(path.join(root, tasksFile), "utf8"), original);
});

test("ignores indented Markdown code while supporting zero to three leading spaces", () => {
  const text = [
    "    - [ ] T001 Example",
    "\t- [ ] T001 Tab example",
    "    - [ ] T002",
    "\t- [ ] T002",
    "- [ ] T001 Root task",
    " - [ ] T002 One space",
    "  * [x] T003 Two spaces",
    "   + [X] T004 Three spaces",
  ].join("\n");
  const tasks = parseTasks(text, tasksFile);
  assert.deepEqual(
    tasks.map((task) => [task.id, task.description]),
    [
      ["T001", "Root task"],
      ["T002", "One space"],
      ["T003", "Two spaces"],
      ["T004", "Three spaces"],
    ],
  );
  assert.deepEqual(
    tasks.map((task) => task.line),
    [5, 6, 7, 8],
  );
  assert.throws(
    () => parseTasks("   - [ ] T005", tasksFile),
    /empty task description/,
  );
});
