import type {
  CreateIssue,
  Environment,
  Fetcher,
  Issue,
  IssuePatch,
  JiraDescription,
  JiraTarget,
  Tracker,
} from "../types.js";
import { array, jsonObject, object, string } from "../validation.js";
import { HttpClient } from "./http.js";

export class Jira implements Tracker {
  private readonly http: HttpClient;
  constructor(
    private readonly target: JiraTarget,
    env: Environment = process.env,
    fetcher?: Fetcher,
  ) {
    const token = env[target.tokenEnv ?? "JIRA_API_TOKEN"];
    const email = env[target.emailEnv ?? "JIRA_EMAIL"];
    if (!token || !email)
      throw new Error(
        `Set ${target.tokenEnv ?? "JIRA_API_TOKEN"} and ${target.emailEnv ?? "JIRA_EMAIL"}`,
      );
    this.http = new HttpClient(
      target.baseUrl,
      {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
      fetcher,
    );
  }
  private normalize(value: unknown): Issue {
    const data = object(value, "Jira issue");
    const fields = object(data.fields, "Jira fields");
    const status = object(fields.status, "Jira status");
    const category = object(status.statusCategory, "Jira status category");
    const key = string(data.key, "Jira issue key");
    let description: JiraDescription = { type: "doc", version: 1, content: [] };
    if (fields.description !== null && fields.description !== undefined) {
      const doc = object(fields.description, "Jira description");
      if (doc.type !== "doc" || doc.version !== 1)
        throw new Error("Jira description must be ADF v1");
      description = {
        type: "doc",
        version: 1,
        content: array(doc.content, "ADF content").map(jsonObject),
      };
    }
    return {
      id: key,
      title: string(fields.summary, "Jira summary"),
      description,
      done: string(category.key, "Jira status category") === "done",
      url: `${this.http.base}/browse/${encodeURIComponent(key)}`,
    };
  }
  async list(): Promise<Issue[]> {
    const issues: Issue[] = [];
    const seen = new Set<string>();
    let nextPageToken: string | undefined;
    for (let page = 0; page < 10000; page++) {
      const response = await this.http.request(
        "POST",
        "/rest/api/3/search/jql",
        {
          jql: `project = ${JSON.stringify(this.target.project)} ORDER BY key ASC`,
          fields: ["summary", "description", "status"],
          maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      );
      const data = object(response.data, "Jira search response");
      issues.push(
        ...array(data.issues, "Jira issues").map((issue) =>
          this.normalize(issue),
        ),
      );
      if (data.isLast === true || !data.nextPageToken) return issues;
      nextPageToken = string(data.nextPageToken, "Jira page token");
      if (seen.has(nextPageToken))
        throw new Error("Jira pagination token repeated");
      seen.add(nextPageToken);
    }
    throw new Error("Jira pagination limit reached");
  }
  async get(id: string): Promise<Issue> {
    return this.normalize(
      (
        await this.http.request(
          "GET",
          `/rest/api/3/issue/${encodeURIComponent(id)}?fields=summary,description,status`,
        )
      ).data,
    );
  }
  async create(content: CreateIssue): Promise<Issue> {
    if (typeof content.description === "string")
      throw new Error("Jira description must be ADF");
    const response = await this.http.request("POST", "/rest/api/3/issue", {
      fields: {
        project: { key: this.target.project },
        issuetype: { name: this.target.issueType ?? "Task" },
        summary: content.title,
        description: content.description,
      },
    });
    const data = object(response.data, "Jira create response");
    return this.get(string(data.key, "Jira issue key"));
  }
  private async transitionId(id: string, done: boolean): Promise<string> {
    const response = await this.http.request(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
    );
    const data = object(response.data, "Jira transitions response");
    const transitions = array(data.transitions, "Jira transitions").map(
      (value) => {
        const transition = object(value, "Jira transition");
        const to = object(transition.to, "Jira transition destination");
        const category = object(to.statusCategory, "Jira transition category");
        return {
          id: string(transition.id, "Jira transition ID"),
          category: string(category.key, "Jira transition category key"),
        };
      },
    );
    const configured = done
      ? this.target.doneTransition
      : this.target.openTransition;
    if (configured) {
      const choice = transitions.find(
        (transition) => transition.id === configured,
      );
      if (!choice || (choice.category === "done") !== done)
        throw new Error(
          `Configured Jira transition ${configured} is unavailable or has the wrong status category`,
        );
      return choice.id;
    }
    const candidates = transitions.filter(
      (transition) => transition.category === (done ? "done" : "new"),
    );
    if (candidates.length !== 1)
      throw new Error(
        `Configure ${done ? "doneTransition" : "openTransition"}: Jira workflow has ${candidates.length} matching transitions`,
      );
    return candidates[0]!.id;
  }
  async validateStatus(id: string, done: boolean): Promise<void> {
    await this.transitionId(id, done);
  }
  async update(id: string, content: IssuePatch): Promise<Issue> {
    const transition =
      content.done === undefined
        ? undefined
        : await this.transitionId(id, content.done);
    const fields: Record<string, unknown> = {};
    if (content.title !== undefined) fields.summary = content.title;
    if (content.description !== undefined) {
      if (typeof content.description === "string")
        throw new Error("Jira description must be ADF");
      fields.description = content.description;
    }
    if (Object.keys(fields).length)
      await this.http.request(
        "PUT",
        `/rest/api/3/issue/${encodeURIComponent(id)}`,
        { fields },
      );
    if (transition)
      await this.http.request(
        "POST",
        `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
        { transition: { id: transition } },
      );
    return this.get(id);
  }
}
