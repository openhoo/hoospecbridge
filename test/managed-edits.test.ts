import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sync } from "../src/sync.js";
import { paragraph } from "../src/content.js";
import type { Config } from "../src/types.js";
import { fixture, MemoryTracker, tasksFile } from "./helpers.js";

const jiraConfig: Config = {
  version: 1,
  repoId: "rich-edit-repository",
  specsDir: "specs",
  targets: [
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
  ],
};

test("text-identical Jira link edits block automatic overwrite and explicit push preserves outside notes", async (t) => {
  const { root, clean } = await fixture(undefined, jiraConfig);
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "jira", tracker, apply: true });
  const document = tracker.issues.get("1")!.description;
  assert.notEqual(typeof document, "string");
  if (typeof document === "string") throw new Error("Expected ADF");
  const content = document.content[1]!.content;
  assert.ok(Array.isArray(content));
  const text = content[0];
  assert.ok(text && typeof text === "object" && !Array.isArray(text));
  text.marks = [
    { type: "link", attrs: { href: "https://example.com/important-context" } },
  ];
  document.content.push(paragraph("Human context outside the managed block"));

  const before = tracker.writes;
  const unchangedText = await sync({
    root,
    target: "jira",
    tracker,
    apply: true,
  });
  assert.equal(unchangedText.applied, false);
  assert.equal(unchangedText.plan.conflicts.length, 1);
  assert.equal(tracker.writes, before);
  await writeFile(
    path.join(root, tasksFile),
    "- [ ] T001 Revise checkout in src/checkout.ts\n",
  );
  const blocked = await sync({ root, target: "jira", tracker, apply: true });
  assert.equal(blocked.applied, false);
  assert.equal(tracker.writes, before);

  const resolved = await sync({
    root,
    target: "jira",
    tracker,
    apply: true,
    direction: "push",
  });
  assert.equal(resolved.applied, true);
  const updated = tracker.issues.get("1")!.description;
  if (typeof updated === "string") throw new Error("Expected ADF");
  assert.deepEqual(
    updated.content.at(-1),
    paragraph("Human context outside the managed block"),
  );
  assert.equal(JSON.stringify(updated).includes("important-context"), false);
});

test("pull preserves chosen Jira rich content and subsequent unchanged preview stays idle", async (t) => {
  const { root, clean } = await fixture(undefined, jiraConfig);
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "jira", tracker, apply: true });
  const document = tracker.issues.get("1")!.description;
  if (typeof document === "string") throw new Error("Expected ADF");
  document.content.splice(2, 0, {
    type: "mediaSingle",
    content: [{ type: "media", attrs: { id: "human-media", type: "file" } }],
  });
  const before = tracker.writes;
  const pulled = await sync({
    root,
    target: "jira",
    tracker,
    apply: true,
    direction: "pull",
  });
  assert.equal(pulled.applied, true);
  assert.equal(tracker.writes, before);
  assert.ok(
    JSON.stringify(tracker.issues.get("1")!.description).includes(
      "human-media",
    ),
  );
  const next = await sync({ root, target: "jira", tracker });
  assert.equal(next.plan.conflicts.length, 0);
  assert.equal(next.plan.actions.length, 0);
});
