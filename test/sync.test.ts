import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sync } from "../src/sync.js";
import {
  contentHash,
  marker,
  paragraph,
  replaceBlock,
} from "../src/content.js";
import { loadState, saveState, withLock } from "../src/state.js";
import { config, fixture, MemoryTracker, tasksFile } from "./helpers.js";
import type { JiraDescription } from "../src/types.js";

test("preview performs zero writes and creates no state directory", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  const result = await sync({ root, target: "gitlab", tracker });
  assert.equal(result.applied, false);
  assert.equal(result.plan.actions[0]?.type, "create");
  assert.equal(tracker.writes, 0);
  await assert.rejects(access(path.join(root, ".hoospecbridge")));
});

test("create, repeat, push, pull and reopen form an idempotent round trip", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(tracker.creates, 1);
  const again = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(again.plan.actions.length, 0);
  assert.equal(tracker.writes, 1);
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 Build checkout in src/checkout.ts\n",
  );
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal((await tracker.get("1")).done, true);
  tracker.issues.get("1")!.done = false;
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.match(
    await readFile(path.join(root, tasksFile), "utf8"),
    /- \[ \] T001/,
  );
  assert.equal(tracker.creates, 1);
});

test("description pushes preserve tracker notes outside the managed block", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const issue = tracker.issues.get("1")!;
  issue.description = `Human notes\n\n${String(issue.description)}\n\nExtra context`;
  await writeFile(
    path.join(root, tasksFile),
    "- [ ] T001 Build updated checkout in src/checkout.ts\n",
  );
  const result = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(result.plan.conflicts.length, 0);
  assert.match(String(tracker.issues.get("1")!.description), /^Human notes/);
  assert.match(String(tracker.issues.get("1")!.description), /Extra context$/);
  assert.match(
    String(tracker.issues.get("1")!.description),
    /updated checkout/,
  );
});

test("one conflicting managed edit prevents all writes in the batch", async (t) => {
  const { root, clean } = await fixture(
    "- [ ] T001 First\n- [ ] T002 Second\n",
  );
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.issues.get("1")!.title = "Remote edit";
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 First\n- [x] T002 Second\n",
  );
  const before = tracker.writes;
  const result = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(result.applied, false);
  assert.equal(result.plan.conflicts.length, 1);
  assert.equal(tracker.writes, before);
  assert.equal(tracker.issues.get("2")!.done, false);
  const resolved = await sync({
    root,
    target: "gitlab",
    tracker,
    apply: true,
    direction: "push",
  });
  assert.equal(resolved.applied, true);
});

test("lost create response is recovered by marker without duplicates", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failCreateAfterWrite = true;
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /lost response/,
  );
  tracker.failCreateAfterWrite = false;
  const recovered = await sync({
    root,
    target: "gitlab",
    tracker,
    apply: true,
  });
  assert.equal(recovered.plan.actions[0]?.type, "adopt");
  assert.equal(tracker.creates, 1);
  assert.deepEqual(
    Object.keys((await loadState(root, config)).targets.gitlab!.pending),
    [],
  );
});

test("uncertain create hidden by eventual indexing blocks a second create", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failCreateAfterWrite = true;
  await assert.rejects(sync({ root, target: "gitlab", tracker, apply: true }));
  tracker.hideFromSearch = true;
  const result = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(result.applied, false);
  assert.match(result.plan.conflicts[0]!.reason, /uncertain outcome/);
  assert.equal(tracker.creates, 1);
});

test("saved mapping bypasses stale tracker search indexing", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.hideFromSearch = true;
  tracker.issues.get("1")!.done = true;
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.match(await readFile(path.join(root, tasksFile), "utf8"), /\[x\]/);
  assert.equal(tracker.creates, 1);
});

test("failed close after create resumes against the saved issue", async (t) => {
  const { root, clean } = await fixture("- [x] T001 Already completed\n");
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failUpdate = true;
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /update failure/,
  );
  tracker.failUpdate = false;
  const result = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(result.applied, true);
  assert.equal((await tracker.get("1")).done, true);
  assert.equal(tracker.creates, 1);
});

test("duplicate remote markers are rejected", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.issues.set("2", { ...(await tracker.get("1")), id: "2" });
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /Duplicate remote issues/,
  );
  assert.equal(tracker.writes, 1);
});

test("pull never creates tasks or issues, and removed tasks never delete remote issues", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({
    root,
    target: "gitlab",
    tracker,
    direction: "pull",
    apply: true,
  });
  assert.equal(tracker.writes, 0);
  await sync({ root, target: "gitlab", tracker, apply: true });
  await writeFile(path.join(root, tasksFile), "- [ ] T002 Replacement\n");
  const result = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.deepEqual(result.plan.orphaned, [`${tasksFile}#T001`]);
  assert.equal(tracker.issues.size, 2);
});

test("changed target project is rejected instead of reusing issue IDs", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const changed = structuredClone(config);
  changed.targets[0]!.project = "different/project";
  await writeFile(
    path.join(root, "hoospecbridge.config.json"),
    JSON.stringify(changed),
  );
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /project changed/,
  );
});

test("local lock rejects overlapping writers", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await withLock(root, async () => {
    await assert.rejects(
      withLock(root, async () => undefined),
      /locked/,
    );
  });
  await withLock(root, async () => undefined);
});

test("Jira ADF keeps rich human content intact", () => {
  const id = marker("repo", "task");
  const human = {
    type: "panel",
    attrs: { panelType: "info" },
    content: [paragraph("Human note")],
  };
  const original = replaceBlock(
    undefined,
    id,
    ["Old content"],
    "jira",
  ) as JiraDescription;
  original.content.unshift(human);
  original.content.push(paragraph("After the managed block"));
  const updated = replaceBlock(
    original,
    id,
    ["New content"],
    "jira",
  ) as JiraDescription;
  assert.deepEqual(updated.content[0], human);
  assert.deepEqual(
    updated.content.at(-1),
    paragraph("After the managed block"),
  );
  assert.notEqual(
    contentHash({ title: "Task", description: updated }, id),
    contentHash({ title: "Task", description: original }, id),
  );
});

test("stale local source prevents remote mutation", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.list = async () => {
    await writeFile(
      path.join(root, tasksFile),
      "- [ ] T001 Edited during read\n",
    );
    return [];
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /changed during sync/,
  );
  assert.equal(tracker.writes, 0);
});

test("state corruption is reported rather than treated as a fresh repository", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await withLock(root, async () =>
    saveState(root, { version: 1, repoId: "wrong-repo", targets: {} }),
  );
  await assert.rejects(
    sync({ root, target: "gitlab", tracker: new MemoryTracker() }),
    /repository identity/,
  );
});
