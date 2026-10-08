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
import type { Direction, JiraDescription } from "../src/types.js";

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

test("lost create response resumes the requested completed status", async (t) => {
  const { root, clean } = await fixture("- [x] T001 Already completed\n");
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
  assert.equal(recovered.applied, true);
  assert.equal((await tracker.get("1")).done, true);
  assert.equal(tracker.creates, 1);
});

test("content checkpoint survives a failed concurrent checkbox pull", async (t) => {
  const { root, clean } = await fixture("- [ ] T001 Original\n");
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.issues.get("1")!.done = true;
  await writeFile(path.join(root, tasksFile), "- [ ] T001 Revised\n");
  const update = tracker.update.bind(tracker);
  tracker.update = async (id, patch) => {
    const issue = await update(id, patch);
    await writeFile(path.join(root, tasksFile), "- [ ] T001 Revised again\n");
    return issue;
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /changed during sync/,
  );
  tracker.update = update;
  const resumed = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(resumed.plan.conflicts.length, 0);
  assert.equal(resumed.applied, true);
  assert.match(
    await readFile(path.join(root, tasksFile), "utf8"),
    /\[x\] T001 Revised again/,
  );
  assert.match((await tracker.get("1")).title, /Revised again/);
});

test("nonpersistent mutation responses cannot advance the baseline", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const before = await loadState(root, config);
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 Build checkout in src/checkout.ts\n",
  );
  tracker.update = async (id, patch) => ({
    ...(await tracker.get(id)),
    ...patch,
  });
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /did not retain returned changes/,
  );
  assert.deepEqual(await loadState(root, config), before);
});

test("incorrect create status responses retain the requested initial status on retry", async (t) => {
  const { root, clean } = await fixture("- [x] T001 Already completed\n");
  t.after(clean);
  const tracker = new MemoryTracker();
  const create = tracker.create.bind(tracker);
  tracker.create = async (content) => ({
    ...(await create(content)),
    done: true,
  });
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /did not retain returned changes/,
  );
  tracker.create = create;
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal((await tracker.get("1")).done, true);
  assert.match(await readFile(path.join(root, tasksFile), "utf8"), /\[x\]/);
  assert.equal(tracker.creates, 1);
});

test("remote edits detected before pull leave local checkboxes unchanged", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.issues.get("1")!.done = true;
  const get = tracker.get.bind(tracker);
  let reads = 0;
  tracker.get = async (id) => {
    reads++;
    if (reads === 3) tracker.issues.get(id)!.done = false;
    return get(id);
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /changed before checkbox pull/,
  );
  assert.match(await readFile(path.join(root, tasksFile), "utf8"), /\[ \]/);
});

test("invalid runtime directions fail before tracker access", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.list = async () => {
    throw new Error("Tracker should not be called");
  };
  await assert.rejects(
    sync({
      root,
      target: "gitlab",
      tracker,
      apply: true,
      direction: "pussh" as Direction,
    }),
    /Invalid sync direction/,
  );
  assert.equal(tracker.writes, 0);
});

test("pending creates for removed tasks remain visible as orphaned", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failCreateAfterWrite = true;
  await assert.rejects(sync({ root, target: "gitlab", tracker, apply: true }));
  await writeFile(path.join(root, tasksFile), "- [ ] T002 Replacement\n");
  const preview = await sync({ root, target: "gitlab", tracker });
  assert.deepEqual(preview.plan.orphaned, [`${tasksFile}#T001`]);
});

test("invalid pending create markers are rejected before tracker access", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failCreateAfterWrite = true;
  await assert.rejects(sync({ root, target: "gitlab", tracker, apply: true }));
  const state = await loadState(root, config);
  state.targets.gitlab!.pending[`${tasksFile}#T001`]!.marker =
    "different-marker";
  await saveState(root, state);
  await assert.rejects(
    sync({ root, target: "gitlab", tracker }),
    /Pending marker does not match/,
  );
});

test("duplicate saved issue mappings are rejected before they can overwrite tasks", async (t) => {
  const { root, clean } = await fixture(
    "- [ ] T001 First\n- [ ] T002 Second\n",
  );
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const state = await loadState(root, config);
  state.targets.gitlab!.tasks[`${tasksFile}#T002`]!.issueId = "1";
  await saveState(root, state);
  await assert.rejects(
    sync({ root, target: "gitlab", tracker }),
    /Duplicate saved issue mapping/,
  );
  assert.equal(tracker.writes, 2);
});

test("invalid pending completion flags are rejected", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  tracker.failCreateAfterWrite = true;
  await assert.rejects(sync({ root, target: "gitlab", tracker, apply: true }));
  const state = await loadState(root, config);
  const serialized = JSON.parse(JSON.stringify(state)) as {
    targets: { gitlab: { pending: Record<string, { desiredDone: unknown }> } };
  };
  serialized.targets.gitlab.pending[`${tasksFile}#T001`]!.desiredDone = "true";
  await writeFile(
    path.join(root, ".hoospecbridge", "state.json"),
    JSON.stringify(serialized),
  );
  await assert.rejects(
    sync({ root, target: "gitlab", tracker }),
    /Invalid pending completion flag/,
  );
});

test("truthy nonboolean apply values never authorize writes or a lock", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await assert.rejects(
    sync({
      root,
      target: "gitlab",
      tracker,
      apply: "false" as unknown as boolean,
    }),
    /apply must be a boolean/,
  );
  assert.equal(tracker.writes, 0);
  await assert.rejects(access(path.join(root, ".hoospecbridge")));
});

test("invalid directions create no state directory", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  await assert.rejects(
    sync({
      root,
      target: "gitlab",
      tracker: new MemoryTracker(),
      apply: true,
      direction: "pussh" as Direction,
    }),
    /Invalid sync direction/,
  );
  await assert.rejects(access(path.join(root, ".hoospecbridge")));
});

test("changed issue identity is rejected during preflight even when content matches", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 Build checkout in src/checkout.ts\n",
  );
  const get = tracker.get.bind(tracker);
  let reads = 0;
  tracker.get = async (id) => {
    const issue = await get(id);
    reads++;
    return reads === 2 ? { ...issue, id: "wrong-issue" } : issue;
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /changed during planning/,
  );
  assert.equal(tracker.writes, 1);
});

test("update responses cannot silently switch a saved issue mapping", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 Build checkout in src/checkout.ts\n",
  );
  const update = tracker.update.bind(tracker);
  tracker.update = async (id, patch) => {
    const issue = { ...(await update(id, patch)), id: "wrong-issue" };
    tracker.issues.set(issue.id, issue);
    return issue;
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /while updating issue 1/,
  );
  assert.equal(
    (await loadState(root, config)).targets.gitlab!.tasks[`${tasksFile}#T001`]!
      .issueId,
    "1",
  );
});

test("initial status updates cannot switch the durable create mapping", async (t) => {
  const { root, clean } = await fixture("- [x] T001 Already completed\n");
  t.after(clean);
  const tracker = new MemoryTracker();
  const update = tracker.update.bind(tracker);
  tracker.update = async (id, patch) => {
    const issue = { ...(await update(id, patch)), id: "wrong-issue" };
    tracker.issues.set(issue.id, issue);
    return issue;
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /while updating created issue 1/,
  );
  assert.equal(
    (await loadState(root, config)).targets.gitlab!.tasks[`${tasksFile}#T001`]!
      .issueId,
    "1",
  );
});

test("edits to later issues during earlier writes prevent stale updates", async (t) => {
  const { root, clean } = await fixture(
    "- [ ] T001 First\n- [ ] T002 Second\n",
  );
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  await writeFile(
    path.join(root, tasksFile),
    "- [x] T001 First\n- [x] T002 Second\n",
  );
  const update = tracker.update.bind(tracker);
  tracker.update = async (id, patch) => {
    const issue = await update(id, patch);
    if (id === "1")
      tracker.issues.get("2")!.title = "Human edit during first update";
    return issue;
  };
  await assert.rejects(
    sync({ root, target: "gitlab", tracker, apply: true }),
    /Issue 2 changed before update/,
  );
  assert.equal((await tracker.get("1")).done, true);
  assert.equal((await tracker.get("2")).done, false);
  assert.equal(
    (await tracker.get("2")).title,
    "Human edit during first update",
  );
  assert.equal(
    (await loadState(root, config)).targets.gitlab!.tasks[`${tasksFile}#T001`]!
      .remoteDone,
    true,
  );
});

test("legacy baselines without document hashes are adopted without changing tracker content", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const state = await loadState(root, config);
  delete state.targets.gitlab!.tasks[`${tasksFile}#T001`]!.remoteDocument;
  await saveState(root, state);
  const recovered = await sync({
    root,
    target: "gitlab",
    tracker,
    apply: true,
  });
  assert.equal(recovered.plan.actions[0]?.type, "adopt");
  assert.equal(tracker.writes, 1);
  assert.equal(
    typeof (await loadState(root, config)).targets.gitlab!.tasks[
      `${tasksFile}#T001`
    ]!.remoteDocument,
    "string",
  );
});

test("invalid recorded remote document hashes fail state validation", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  const state = await loadState(root, config);
  const serialized = JSON.parse(JSON.stringify(state)) as {
    targets: { gitlab: { tasks: Record<string, { remoteDocument: unknown }> } };
  };
  serialized.targets.gitlab.tasks[`${tasksFile}#T001`]!.remoteDocument = 42;
  await writeFile(
    path.join(root, ".hoospecbridge", "state.json"),
    JSON.stringify(serialized),
  );
  await assert.rejects(
    sync({ root, target: "gitlab", tracker }),
    /Invalid state remote document hash/,
  );
});

test("pull records remote managed content without authorizing a subsequent automatic overwrite", async (t) => {
  const { root, clean } = await fixture();
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "gitlab", tracker, apply: true });
  tracker.issues.get("1")!.title = "Chosen remote title";
  tracker.issues.get("1")!.description = String(
    tracker.issues.get("1")!.description,
  ).replace("Build checkout", "Chosen remote checkout");
  await sync({
    root,
    target: "gitlab",
    tracker,
    apply: true,
    direction: "pull",
  });
  const again = await sync({ root, target: "gitlab", tracker, apply: true });
  assert.equal(again.plan.conflicts.length, 0);
  assert.equal(again.plan.actions.length, 0);
  assert.equal((await tracker.get("1")).title, "Chosen remote title");
  assert.equal(tracker.writes, 1);
  await writeFile(
    path.join(root, tasksFile),
    "- [ ] T001 Newly revised repository content\n",
  );
  await sync({ root, target: "gitlab", tracker, apply: true });
  assert.match(
    (await tracker.get("1")).title,
    /Newly revised repository content/,
  );
});

test("explicit push cannot report success if Jira rich edits survive the requested replacement", async (t) => {
  const configuration = structuredClone(config);
  configuration.targets = [
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
  ];
  const { root, clean } = await fixture(undefined, configuration);
  t.after(clean);
  const tracker = new MemoryTracker();
  await sync({ root, target: "jira", tracker, apply: true });
  const issue = tracker.issues.get("1")!;
  if (typeof issue.description === "string") throw new Error("Expected ADF");
  const richParagraph = issue.description.content[1]!;
  richParagraph.attrs = { altered: "human-rich-edit" };
  const before = await loadState(root, configuration);
  tracker.update = async (id) => tracker.get(id);
  await assert.rejects(
    sync({ root, target: "jira", tracker, apply: true, direction: "push" }),
    /did not retain requested changes/,
  );
  assert.deepEqual(await loadState(root, configuration), before);
});

test("unexpected rich content returned by create is rejected and stays unaccepted on retry", async (t) => {
  const configuration = structuredClone(config);
  configuration.targets = [
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
  ];
  const { root, clean } = await fixture(undefined, configuration);
  t.after(clean);
  const tracker = new MemoryTracker();
  const create = tracker.create.bind(tracker);
  tracker.create = async (content) => {
    const issue = await create(content);
    const stored = tracker.issues.get(issue.id)!;
    if (typeof stored.description === "string") throw new Error("Expected ADF");
    stored.description.content[1]!.attrs = { unexpected: "server-rich-change" };
    return tracker.get(issue.id);
  };
  await assert.rejects(
    sync({ root, target: "jira", tracker, apply: true }),
    /did not retain requested content/,
  );
  const retry = await sync({ root, target: "jira", tracker, apply: true });
  assert.equal(retry.applied, false);
  assert.match(retry.plan.conflicts[0]!.reason, /rich content changed/);
  assert.equal(tracker.creates, 1);
  await sync({ root, target: "jira", tracker, apply: true, direction: "push" });
  assert.equal(tracker.creates, 1);
});
