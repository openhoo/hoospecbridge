import test from "node:test";
import assert from "node:assert/strict";
import {
  begin,
  end,
  managedText,
  managedDocumentHash,
  contentHash,
  paragraph,
  replaceBlock,
  taskContent,
} from "../src/content.js";
import { jsonObject } from "../src/validation.js";
import type { Config, JiraDescription, Task } from "../src/types.js";

const id = "hoospecbridge:" + "a".repeat(32);

test("Markdown replacement preserves human notes exactly and rejects injected markers", () => {
  const before = "Human notes\r\n\r\n";
  const after = "\r\nKeep these notes and whitespace.\r\n";
  const original = before + [begin(id), "Old task", end(id)].join("\n") + after;
  assert.equal(
    replaceBlock(original, id, ["Updated task"], "gitlab"),
    before + [begin(id), "Updated task", end(id)].join("\n") + after,
  );
  for (const provider of ["gitlab", "jira"] as const)
    assert.throws(
      () => replaceBlock(undefined, id, ["Task " + end(id)], provider),
      /must not include managed block markers/,
    );
});

test("ADF replacement preserves root metadata and rich human content", () => {
  const note = {
    type: "table",
    attrs: { layout: "default" },
    content: [
      {
        type: "tableRow",
        content: [{ type: "tableCell", content: [paragraph("Human notes")] }],
      },
    ],
  };
  const document: JiraDescription = {
    type: "doc",
    version: 1,
    attrs: { custom: "metadata" },
    content: [
      note,
      paragraph(begin(id)),
      paragraph("Old task"),
      paragraph(end(id)),
      paragraph("After"),
    ],
  };
  const replaced = replaceBlock(document, id, ["Updated task"], "jira");
  assert.deepEqual(replaced, {
    ...document,
    content: [
      note,
      paragraph(begin(id)),
      paragraph("Updated task"),
      paragraph(end(id)),
      paragraph("After"),
    ],
  });
  assert.deepEqual(document.content[2], paragraph("Old task"));
});

test("ADF markers inside rich nodes and mixed inline nodes fail without deleting human content", () => {
  for (const start of [
    { type: "blockquote", content: [paragraph(begin(id))] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: begin(id) },
        { type: "mention", attrs: { id: "human" } },
      ],
    },
  ]) {
    const document: JiraDescription = {
      type: "doc",
      version: 1,
      content: [start, paragraph("Task"), paragraph(end(id))],
    };
    assert.throws(
      () => replaceBlock(document, id, ["Updated"], "jira"),
      /separate paragraphs/,
    );
  }
});

test("duplicate and reversed managed blocks fail closed", () => {
  for (const description of [
    begin(id) + end(id) + begin(id),
    end(id) + begin(id),
  ])
    assert.throws(() => managedText(description, id), /Missing or ambiguous/);
});

test("source links encode path segments while preserving the source URL branch path", () => {
  const task: Task = {
    key: "specs/feature #?/tasks.md:T001",
    file: "specs/feature #?/tasks.md",
    feature: "feature #?",
    id: "T001",
    line: 1,
    description: "Task",
    done: false,
    parallel: false,
    story: "",
    phase: "",
    sourceHash: "hash",
  };
  const config: Config = {
    version: 1,
    repoId: "repo",
    specsDir: "specs",
    targets: [],
    sourceUrl: "https://gitlab.example/group/repo/-/blob/main",
  };
  const content = taskContent(task, config);
  assert.ok(
    content.lines.includes(
      "Tasks: https://gitlab.example/group/repo/-/blob/main/specs/feature%20%23%3F/tasks.md",
    ),
  );
  assert.ok(
    content.lines.includes(
      "Specification: https://gitlab.example/group/repo/-/blob/main/specs/feature%20%23%3F/spec.md",
    ),
  );
});

test("unknown JSON preserves prototype-looking keys as inert own properties", () => {
  const value = jsonObject(
    JSON.parse(
      '{"__proto__":{"rich":"content"},"constructor":"note"}',
    ) as unknown,
  );
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.ok(Object.hasOwn(value, "__proto__"));
  assert.equal(
    JSON.stringify(value),
    '{"__proto__":{"rich":"content"},"constructor":"note"}',
  );
  assert.equal(Object.getPrototypeOf({}).rich, undefined);
});

test("managed document hashing detects rich edits with unchanged logical content", () => {
  const original: JiraDescription = {
    type: "doc",
    version: 1,
    content: [paragraph(begin(id)), paragraph("Task"), paragraph(end(id))],
  };
  const linked = structuredClone(original);
  const linkedText = linked.content[1]!.content as {
    type: string;
    text: string;
    marks?: { type: string; attrs: { href: string } }[];
  }[];
  linkedText[0]!.marks = [
    { type: "link", attrs: { href: "https://example.com/first" } },
  ];
  const changedLink = structuredClone(linked);
  const changedText = changedLink.content[1]!.content as typeof linkedText;
  changedText[0]!.marks![0]!.attrs.href = "https://example.com/second";
  const image = structuredClone(original);
  image.content.splice(2, 0, {
    type: "mediaSingle",
    content: [
      {
        type: "media",
        attrs: { id: "human-image", type: "file", collection: "images" },
      },
    ],
  });
  assert.equal(
    contentHash({ title: "Title", description: original }, id),
    contentHash({ title: "Title", description: linked }, id),
  );
  assert.notEqual(
    managedDocumentHash(original, id),
    managedDocumentHash(linked, id),
  );
  assert.notEqual(
    managedDocumentHash(linked, id),
    managedDocumentHash(changedLink, id),
  );
  assert.notEqual(
    managedDocumentHash(original, id),
    managedDocumentHash(image, id),
  );
});

test("managed document hashing ignores external notes, root metadata and property ordering", () => {
  const original: JiraDescription = {
    type: "doc",
    version: 1,
    content: [paragraph(begin(id)), paragraph("Task"), paragraph(end(id))],
  };
  const withNotes: JiraDescription = {
    ...original,
    attrs: { external: "metadata" },
    content: [
      paragraph("Before notes"),
      ...original.content,
      { type: "table", content: [paragraph("After rich notes")] },
    ],
  };
  assert.equal(
    managedDocumentHash(original, id),
    managedDocumentHash(withNotes, id),
  );
  const reordered: JiraDescription = {
    version: 1,
    type: "doc",
    content: original.content.map((node) => ({
      content: node.content!,
      type: node.type!,
    })),
  };
  assert.equal(
    managedDocumentHash(original, id),
    managedDocumentHash(reordered, id),
  );
  assert.equal(
    managedDocumentHash(
      "Human notes\n" + [begin(id), "Task", end(id)].join("\n"),
      id,
    ),
    managedDocumentHash(
      [begin(id), "Task", end(id)].join("\n") + "\nAfter notes",
      id,
    ),
  );
});
