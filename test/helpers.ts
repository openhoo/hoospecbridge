import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Config,
  CreateIssue,
  Issue,
  IssuePatch,
  Tracker,
} from "../src/types.js";
import { parseConfig } from "../src/config.js";

export const config: Config = parseConfig({
  version: 1,
  repoId: "test-repository",
  specsDir: "specs",
  targets: [
    {
      name: "gitlab",
      provider: "gitlab",
      project: "team/project",
      baseUrl: "https://gitlab.example.com",
    },
  ],
});
export const tasksFile = "specs/001-checkout/tasks.md";
export const clone = <T>(value: T): T => structuredClone(value);

export async function fixture(
  text = "- [ ] T001 Build checkout in src/checkout.ts\n",
  configuration = config,
): Promise<{ root: string; clean: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "hoospecbridge-"));
  await mkdir(path.join(root, "specs", "001-checkout"), { recursive: true });
  await writeFile(path.join(root, tasksFile), text);
  await writeFile(
    path.join(root, "hoospecbridge.config.json"),
    JSON.stringify(configuration),
  );
  return { root, clean: () => rm(root, { recursive: true, force: true }) };
}

export class MemoryTracker implements Tracker {
  readonly issues = new Map<string, Issue>();
  writes = 0;
  creates = 0;
  failCreateAfterWrite = false;
  failUpdate = false;
  hideFromSearch = false;
  async list(): Promise<Issue[]> {
    return this.hideFromSearch ? [] : [...this.issues.values()].map(clone);
  }
  async get(id: string): Promise<Issue> {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`Issue ${id} not found`);
    return clone(issue);
  }
  async create(content: CreateIssue): Promise<Issue> {
    this.writes++;
    this.creates++;
    const id = String(this.issues.size + 1);
    const issue: Issue = {
      ...clone(content),
      id,
      done: false,
      url: `https://tracker.example/issues/${id}`,
    };
    this.issues.set(id, issue);
    if (this.failCreateAfterWrite) throw new Error("Simulated lost response");
    return clone(issue);
  }
  async update(id: string, patch: IssuePatch): Promise<Issue> {
    if (this.failUpdate) throw new Error("Simulated update failure");
    this.writes++;
    const issue = await this.get(id);
    const updated = { ...issue, ...clone(patch) };
    this.issues.set(id, updated);
    return clone(updated);
  }
}
