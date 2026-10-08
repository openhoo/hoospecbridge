export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export interface JiraDescription {
  type: "doc";
  version: 1;
  content: JsonObject[];
}
export type Description = string | JiraDescription;
export type Direction = "push" | "pull" | "both";

interface TargetBase {
  name: string;
  project: string;
  baseUrl: string;
  tokenEnv?: string;
}
export interface GitLabTarget extends TargetBase {
  provider: "gitlab";
}
export interface JiraTarget extends TargetBase {
  provider: "jira";
  emailEnv?: string;
  issueType?: string;
  doneTransition?: string;
  openTransition?: string;
}
export type Target = GitLabTarget | JiraTarget;
export interface Config {
  version: 1;
  repoId: string;
  specsDir: string;
  sourceUrl?: string;
  targets: Target[];
}

export interface ParsedTask {
  key: string;
  id: string;
  file: string;
  line: number;
  done: boolean;
  description: string;
  parallel: boolean;
  story: string;
  phase: string;
}
export interface Task extends ParsedTask {
  feature: string;
  sourceHash: string;
}
export interface Issue {
  id: string;
  title: string;
  description: Description;
  done: boolean;
  url: string;
}
export interface Content {
  title: string;
  lines: string[];
}
export interface CreateIssue {
  title: string;
  description: Description;
}
export interface IssuePatch {
  title?: string;
  description?: Description;
  done?: boolean;
}
export interface Tracker {
  list(): Promise<Issue[]>;
  get(id: string): Promise<Issue>;
  create(content: CreateIssue): Promise<Issue>;
  update(id: string, patch: IssuePatch): Promise<Issue>;
  validateStatus?(id: string, done: boolean): Promise<void>;
}
export interface Baseline {
  issueId: string;
  localDone: boolean;
  remoteDone: boolean;
  localContent: string;
  remoteContent: string;
}
export interface TargetState {
  fingerprint: string;
  tasks: Record<string, Baseline>;
  pending: Record<string, { marker: string }>;
}
export interface State {
  version: 1;
  repoId: string;
  targets: Record<string, TargetState>;
}

interface ActionBase {
  key: string;
}
export interface CreateAction extends ActionBase {
  type: "create";
  content: CreateIssue;
  done: boolean;
}
export interface UpdateAction extends ActionBase {
  type: "update";
  issue: Issue;
  patch: IssuePatch;
}
export interface PullAction extends ActionBase {
  type: "pull";
  issue: Issue;
  done: boolean;
}
export interface AdoptAction extends ActionBase {
  type: "adopt";
  issue: Issue;
}
export type Action = CreateAction | UpdateAction | PullAction | AdoptAction;
export interface Conflict {
  key: string;
  reason: string;
}
export interface Plan {
  target: string;
  direction: Direction;
  actions: Action[];
  conflicts: Conflict[];
  unchanged: number;
  orphaned: string[];
}
export type Environment = Record<string, string | undefined>;
export type Fetcher = typeof fetch;
