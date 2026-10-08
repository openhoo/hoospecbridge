import type {
  CreateIssue,
  Environment,
  Fetcher,
  GitLabTarget,
  Issue,
  IssuePatch,
  Tracker,
} from "../types.js";
import { array, object, string } from "../validation.js";
import { HttpClient } from "./http.js";

export class GitLab implements Tracker {
  private readonly http: HttpClient;
  private readonly prefix: string;
  constructor(
    target: GitLabTarget,
    env: Environment = process.env,
    fetcher?: Fetcher,
  ) {
    const token = env[target.tokenEnv ?? "GITLAB_TOKEN"];
    if (!token)
      throw new Error(
        `Missing environment variable ${target.tokenEnv ?? "GITLAB_TOKEN"}`,
      );
    this.http = new HttpClient(
      target.baseUrl,
      { "PRIVATE-TOKEN": token },
      fetcher,
    );
    this.prefix = `/api/v4/projects/${encodeURIComponent(target.project)}/issues`;
  }
  private normalize(value: unknown): Issue {
    const data = object(value, "GitLab issue");
    if (
      !Number.isInteger(data.iid) ||
      (data.state !== "opened" && data.state !== "closed")
    )
      throw new Error("Invalid GitLab issue response");
    if (
      data.description !== undefined &&
      data.description !== null &&
      typeof data.description !== "string"
    )
      throw new Error("Invalid GitLab description");
    return {
      id: String(data.iid),
      title: string(data.title, "issue title"),
      description: data.description ?? "",
      done: data.state === "closed",
      url: string(data.web_url, "issue URL"),
    };
  }
  async list(): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (let page = 1; page <= 10000; page++) {
      const { data, headers } = await this.http.request(
        "GET",
        `${this.prefix}?scope=all&state=all&per_page=100&page=${page}`,
      );
      const items = array(data, "GitLab issue list");
      issues.push(...items.map((item) => this.normalize(item)));
      const next = headers.get("x-next-page");
      if (next === "" || items.length < 100) return issues;
    }
    throw new Error("GitLab pagination limit reached");
  }
  async get(id: string): Promise<Issue> {
    return this.normalize(
      (
        await this.http.request(
          "GET",
          `${this.prefix}/${encodeURIComponent(id)}`,
        )
      ).data,
    );
  }
  async create(content: CreateIssue): Promise<Issue> {
    if (typeof content.description !== "string")
      throw new Error("GitLab description must be Markdown");
    return this.normalize(
      (
        await this.http.request("POST", this.prefix, {
          title: content.title,
          description: content.description,
        })
      ).data,
    );
  }
  async update(id: string, content: IssuePatch): Promise<Issue> {
    const body: Record<string, unknown> = {};
    if (content.title !== undefined) body.title = content.title;
    if (content.description !== undefined) {
      if (typeof content.description !== "string")
        throw new Error("GitLab description must be Markdown");
      body.description = content.description;
    }
    if (content.done !== undefined)
      body.state_event = content.done ? "close" : "reopen";
    return this.normalize(
      (
        await this.http.request(
          "PUT",
          `${this.prefix}/${encodeURIComponent(id)}`,
          body,
        )
      ).data,
    );
  }
}
