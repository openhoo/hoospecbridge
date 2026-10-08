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
      !Number.isSafeInteger(data.iid) ||
      (data.iid as number) <= 0 ||
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
    let page = 1;
    let perPage = 100;
    const seen = new Set<string>();
    for (let request = 0; request < 10000; request++) {
      const { data, headers } = await this.http.request(
        "GET",
        `${this.prefix}?scope=all&state=all&order_by=created_at&sort=asc&per_page=${perPage}&page=${page}`,
      );
      const items = array(data, "GitLab issue list");
      for (const item of items) {
        const issue = this.normalize(item);
        if (seen.has(issue.id))
          throw new Error("GitLab pagination returned a duplicate issue");
        seen.add(issue.id);
        issues.push(issue);
      }
      let next = headers.get("x-next-page");
      const links = [
        ...(headers.get("link") ?? "").matchAll(
          /<([^>]+)>\s*;\s*rel="?next"?(?=\s*(?:,|;|$))/g,
        ),
      ];
      if (links.length > 1) throw new Error("Invalid GitLab pagination links");
      if (links[0]) {
        let link: URL;
        try {
          link = new URL(links[0][1]!);
        } catch {
          throw new Error("Invalid GitLab pagination link");
        }
        const expected = new URL(this.http.base + this.prefix);
        const linkedPage = link.searchParams.get("page");
        if (
          link.origin !== expected.origin ||
          link.pathname !== expected.pathname ||
          link.username ||
          link.password ||
          link.hash ||
          !linkedPage ||
          (next !== null && next !== linkedPage)
        )
          throw new Error("Invalid GitLab pagination link");
        next = linkedPage;
        const linkedSize = link.searchParams.get("per_page");
        if (linkedSize !== null) {
          if (!/^[1-9]\d*$/.test(linkedSize) || Number(linkedSize) > 100)
            throw new Error("Invalid GitLab pagination page size");
          perPage = Number(linkedSize);
        }
      }
      if (next === "") return issues;
      if (next !== null) {
        const nextPage = Number(next);
        if (
          !/^[1-9]\d*$/.test(next) ||
          !Number.isSafeInteger(nextPage) ||
          nextPage <= page
        )
          throw new Error("Invalid GitLab next page");
        page = nextPage;
      } else {
        if (items.length < perPage) return issues;
        page++;
      }
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
