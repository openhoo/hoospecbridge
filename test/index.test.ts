import test from "node:test";
import assert from "node:assert/strict";
import { indexIssues } from "../src/adapters/index.js";
import { begin, end, marker, managedText } from "../src/content.js";
import type { Issue, Task } from "../src/types.js";
const task = (key: string): Task => ({
  key,
  id: key,
  file: "tasks.md",
  feature: "feature",
  line: 1,
  done: false,
  description: "Task",
  parallel: false,
  story: "",
  phase: "",
  sourceHash: "hash",
});
const issue = (id: string, description: string): Issue => ({
  id,
  description,
  title: "Issue",
  done: false,
  url: "https://tracker.example/issues/1",
});
const block = (key: string) =>
  [begin(marker("repo", key)), "Task", end(marker("repo", key))].join("\n");

test("index refuses an issue shared between two task markers", () => {
  assert.throws(
    () =>
      indexIssues([issue("1", block("one") + "\n" + block("two"))], "repo", [
        task("one"),
        task("two"),
      ]),
    /markers for multiple tasks/,
  );
});
test("index refuses duplicate issue identities and duplicate marker ownership", () => {
  assert.throws(
    () =>
      indexIssues(
        [issue("1", block("one")), issue("1", block("two"))],
        "repo",
        [task("one"), task("two")],
      ),
    /Duplicate remote issue ID/,
  );
  assert.throws(
    () =>
      indexIssues(
        [issue("1", block("one")), issue("2", block("one"))],
        "repo",
        [task("one")],
      ),
    /Duplicate remote issues/,
  );
});
test("repeated markers within one issue remain a managed block conflict", () => {
  const description = block("one") + "\n" + block("one");
  const indexed = indexIssues([issue("1", description)], "repo", [task("one")]);
  assert.equal(indexed.size, 1);
  assert.throws(
    () => managedText(indexed.get("one")!.description, marker("repo", "one")),
    /ambiguous/,
  );
});
test("index ignores other repository markers and unrelated issues", () => {
  const indexed = indexIssues(
    [
      issue("1", block("one")),
      issue("2", block("other")),
      issue("3", "Human notes"),
    ],
    "repo",
    [task("one")],
  );
  assert.equal(indexed.size, 1);
  assert.equal(indexed.get("one")?.id, "1");
});
