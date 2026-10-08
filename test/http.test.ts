import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitLab } from "../src/adapters/gitlab.js";
import { Jira } from "../src/adapters/jira.js";
import { HttpClient } from "../src/adapters/http.js";
import { sync } from "../src/sync.js";
import { object } from "../src/validation.js";
import type {
  Config,
  Description,
  Fetcher,
  GitLabTarget,
  JiraTarget,
} from "../src/types.js";
import { fixture, tasksFile } from "./helpers.js";

interface StoredIssue {
  id: string;
  title: string;
  description: Description;
  done: boolean;
}
interface ApiFixture {
  url: string;
  issues: Map<string, StoredIssue>;
  requests: { method: string; path: string; body: Record<string, unknown> }[];
  close: () => Promise<void>;
}

async function startApi(provider: "jira" | "gitlab"): Promise<ApiFixture> {
  const issues = new Map<string, StoredIssue>();
  const requests: ApiFixture["requests"] = [];
  let base = "";
  const gitlabIssue = (issue: StoredIssue) => ({
    iid: Number(issue.id),
    title: issue.title,
    description: issue.description,
    state: issue.done ? "closed" : "opened",
    web_url: `${base}/issues/${issue.id}`,
  });
  const jiraIssue = (issue: StoredIssue) => ({
    key: issue.id,
    fields: {
      summary: issue.title,
      description: issue.description,
      status: { statusCategory: { key: issue.done ? "done" : "new" } },
    },
  });
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    assert.equal(
      provider === "gitlab"
        ? request.headers["private-token"]
        : request.headers.authorization,
      provider === "gitlab"
        ? "fixture-token"
        : `Basic ${Buffer.from("fixture@example.com:fixture-token").toString("base64")}`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const body = chunks.length
      ? object(
          JSON.parse(Buffer.concat(chunks).toString()) as unknown,
          "request body",
        )
      : {};
    const url = new URL(request.url ?? "/", base);
    const method = request.method ?? "GET";
    requests.push({ method, path: url.pathname, body });
    const send = (data: unknown, status = 200): void => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "x-next-page": "",
      });
      response.end(JSON.stringify(data));
    };
    if (provider === "gitlab") {
      const prefix = "/api/v4/projects/team%2Fcheckout/issues";
      if (url.pathname === prefix && method === "GET") {
        send([...issues.values()].map(gitlabIssue));
        return;
      }
      if (url.pathname === prefix && method === "POST") {
        assert.equal(typeof body.title, "string");
        assert.equal(typeof body.description, "string");
        const issue: StoredIssue = {
          id: String(issues.size + 1),
          title: body.title as string,
          description: body.description as string,
          done: false,
        };
        issues.set(issue.id, issue);
        send(gitlabIssue(issue), 201);
        return;
      }
      const id = url.pathname.substring(prefix.length + 1);
      const issue = issues.get(id);
      if (!issue) {
        send({}, 404);
        return;
      }
      if (method === "PUT") {
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.description === "string")
          issue.description = body.description;
        if (body.state_event) {
          assert.ok(["close", "reopen"].includes(String(body.state_event)));
          issue.done = body.state_event === "close";
        }
      }
      send(gitlabIssue(issue));
      return;
    }
    if (url.pathname === "/rest/api/3/search/jql") {
      assert.equal(method, "POST");
      assert.match(String(body.jql), /project = "APP"/);
      send({ issues: [...issues.values()].map(jiraIssue), isLast: true });
      return;
    }
    if (url.pathname === "/rest/api/3/issue" && method === "POST") {
      const fields = object(body.fields, "fields");
      assert.deepEqual(fields.project, { key: "APP" });
      assert.deepEqual(fields.issuetype, { name: "Task" });
      const description = object(fields.description, "ADF description");
      assert.equal(description.type, "doc");
      assert.equal(description.version, 1);
      const issue: StoredIssue = {
        id: `APP-${issues.size + 1}`,
        title: String(fields.summary),
        description: fields.description as Description,
        done: false,
      };
      issues.set(issue.id, issue);
      send({ key: issue.id, id: String(issues.size) }, 201);
      return;
    }
    const match = url.pathname.match(
      /^\/rest\/api\/3\/issue\/(APP-\d+)(\/transitions)?$/,
    );
    const issue = issues.get(match?.[1] ?? "");
    if (!issue) {
      send({}, 404);
      return;
    }
    if (match?.[2]) {
      if (method === "GET")
        send({
          transitions: [
            {
              id: issue.done ? "11" : "31",
              to: { statusCategory: { key: issue.done ? "new" : "done" } },
            },
          ],
        });
      else {
        issue.done = object(body.transition, "transition").id === "31";
        response.writeHead(204);
        response.end();
      }
      return;
    }
    if (method === "PUT") {
      const fields = object(body.fields, "fields");
      if (typeof fields.summary === "string") issue.title = fields.summary;
      if (fields.description !== undefined)
        issue.description = fields.description as Description;
      response.writeHead(204);
      response.end();
      return;
    }
    send(jiraIssue(issue));
  };
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "fixture error");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    issues,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

for (const provider of ["gitlab", "jira"] as const) {
  test(`${provider}: real HTTP create → repeat → push content/status → pull status`, async (t) => {
    const api = await startApi(provider);
    t.after(api.close);
    const target: GitLabTarget | JiraTarget = {
      name: provider,
      provider,
      project: provider === "gitlab" ? "team/checkout" : "APP",
      baseUrl: api.url,
    };
    const configuration: Config = {
      version: 1,
      repoId: "http-repository",
      specsDir: "specs",
      targets: [target],
    };
    const { root, clean } = await fixture(
      "- [ ] T001 Create checkout\n",
      configuration,
    );
    t.after(clean);
    const env = {
      GITLAB_TOKEN: "fixture-token",
      JIRA_API_TOKEN: "fixture-token",
      JIRA_EMAIL: "fixture@example.com",
    };
    const first = await sync({ root, target: provider, env, apply: true });
    assert.equal(first.applied, true);
    assert.equal(api.issues.size, 1);
    const before = api.requests.filter(
      (request) =>
        request.method !== "GET" && !request.path.endsWith("/search/jql"),
    ).length;
    const repeat = await sync({ root, target: provider, env, apply: true });
    assert.equal(repeat.plan.actions.length, 0);
    assert.equal(
      api.requests.filter(
        (request) =>
          request.method !== "GET" && !request.path.endsWith("/search/jql"),
      ).length,
      before,
    );
    await writeFile(
      path.join(root, tasksFile),
      "- [x] T001 Create improved checkout\n",
    );
    const pushed = await sync({ root, target: provider, env, apply: true });
    assert.equal(pushed.plan.conflicts.length, 0);
    const issue = [...api.issues.values()][0]!;
    assert.equal(issue.done, true);
    assert.match(issue.title, /improved/);
    issue.done = false;
    await sync({ root, target: provider, env, apply: true });
    assert.match(
      await readFile(path.join(root, tasksFile), "utf8"),
      /\[ \] T001/,
    );
    assert.equal(api.issues.size, 1);
  });
}

test("GitLab paginates beyond 100 issues and accepts empty unrelated descriptions", async () => {
  let pages = 0;
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    pages++;
    const page = Number(url.searchParams.get("page"));
    const count = page === 1 ? 100 : 1;
    const data = Array.from({ length: count }, (_, i) => ({
      iid: (page - 1) * 100 + i + 1,
      title: "Issue",
      state: "opened",
      description: "",
      web_url: "https://gitlab.example/issues/1",
    }));
    return Response.json(data, {
      headers: { "x-next-page": page === 1 ? "2" : "" },
    });
  };
  const tracker = new GitLab(
    {
      name: "gitlab",
      provider: "gitlab",
      project: "group/project",
      baseUrl: "https://gitlab.example",
    },
    { GITLAB_TOKEN: "fixture" },
    fetcher,
  );
  assert.equal((await tracker.list()).length, 101);
  assert.equal(pages, 2);
});

test("Jira enhanced search follows opaque page tokens", async () => {
  let calls = 0;
  const fetcher: Fetcher = async (_input, init) => {
    const body = object(JSON.parse(String(init?.body)) as unknown, "body");
    calls++;
    if (calls === 1) {
      assert.equal(body.nextPageToken, undefined);
      return Response.json({
        issues: [],
        nextPageToken: "opaque",
        isLast: false,
      });
    }
    assert.equal(body.nextPageToken, "opaque");
    return Response.json({ issues: [], isLast: true });
  };
  const tracker = new Jira(
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
    { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture" },
    fetcher,
  );
  assert.deepEqual(await tracker.list(), []);
  assert.equal(calls, 2);
});

test("Jira ambiguous transitions are rejected before any write", async () => {
  const methods: string[] = [];
  const fetcher: Fetcher = async (_input, init) => {
    methods.push(init?.method ?? "GET");
    return Response.json({
      transitions: [
        { id: "31", to: { statusCategory: { key: "done" } } },
        { id: "41", to: { statusCategory: { key: "done" } } },
      ],
    });
  };
  const tracker = new Jira(
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
    { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture" },
    fetcher,
  );
  await assert.rejects(
    tracker.update("APP-1", { title: "New", done: true }),
    /Configure doneTransition/,
  );
  assert.deepEqual(methods, ["GET"]);
});

test("HTTP errors suppress tracker bodies and never retry writes", async () => {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls++;
    return new Response("sensitive-server-body", { status: 429 });
  };
  const http = new HttpClient("https://gitlab.example", {}, fetcher);
  await assert.rejects(
    http.request("POST", "/issues", {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /429/);
      assert.ok(!error.message.includes("sensitive-server-body"));
      return true;
    },
  );
  assert.equal(calls, 1);
});

function gitlabFixture(fetcher: Fetcher): GitLab {
  return new GitLab(
    {
      name: "gitlab",
      provider: "gitlab",
      project: "group/project",
      baseUrl: "https://gitlab.example",
    },
    { GITLAB_TOKEN: "fixture" },
    fetcher,
  );
}
function jiraFixture(fetcher: Fetcher): Jira {
  return new Jira(
    {
      name: "jira",
      provider: "jira",
      project: "APP",
      baseUrl: "https://team.atlassian.net",
    },
    { JIRA_EMAIL: "fixture@example.com", JIRA_API_TOKEN: "fixture" },
    fetcher,
  );
}
const gitlabRecord = (iid = 1) => ({
  iid,
  title: "Issue",
  state: "opened",
  description: "",
  web_url: "https://gitlab.example/issues/1",
});

test("GitLab follows explicit next pages even for short pages", async () => {
  const pages: string[] = [];
  const tracker = gitlabFixture(async (input) => {
    const page = new URL(String(input)).searchParams.get("page") ?? "";
    pages.push(page);
    return Response.json([gitlabRecord(Number(page))], {
      headers: { "x-next-page": page === "1" ? "3" : "" },
    });
  });
  assert.equal((await tracker.list()).length, 2);
  assert.deepEqual(pages, ["1", "3"]);
});

test("GitLab refuses malformed, repeated pagination and duplicate issue identities", async () => {
  for (const next of ["1", "0", "-1", "wat", "2.5", "9007199254740992"])
    await assert.rejects(
      gitlabFixture(async () =>
        Response.json([gitlabRecord()], { headers: { "x-next-page": next } }),
      ).list(),
      /Invalid GitLab next page/,
    );
  let calls = 0;
  await assert.rejects(
    gitlabFixture(async () =>
      Response.json([gitlabRecord()], {
        headers: { "x-next-page": ++calls === 1 ? "2" : "" },
      }),
    ).list(),
    /duplicate issue/,
  );
});

test("GitLab refuses unsafe or nonpositive issue identifiers", async () => {
  for (const iid of [0, -1, 1.5, 9007199254740992])
    await assert.rejects(
      gitlabFixture(async () => Response.json(gitlabRecord(iid))).get("1"),
      /Invalid GitLab issue response/,
    );
});

test("Jira refuses incomplete, malformed and repeated pagination", async () => {
  for (const pagination of [
    { isLast: false },
    { isLast: "false" },
    { isLast: false, nextPageToken: "" },
  ])
    await assert.rejects(
      jiraFixture(async () =>
        Response.json({ issues: [], ...pagination }),
      ).list(),
      /pagination|page token/,
    );
  await assert.rejects(
    jiraFixture(async () =>
      Response.json({ issues: [], isLast: false, nextPageToken: "same" }),
    ).list(),
    /token repeated/,
  );
});

test("Jira supports reopening directly into In Progress", async () => {
  const methods: string[] = [];
  const tracker = jiraFixture(async (input, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (String(input).endsWith("/transitions")) {
      if (method === "GET")
        return Response.json({
          transitions: [
            { id: "21", to: { statusCategory: { key: "indeterminate" } } },
          ],
        });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        transition: { id: "21" },
      });
      return new Response(null, { status: 204 });
    }
    return Response.json({
      key: "APP-1",
      fields: {
        summary: "Issue",
        description: {
          type: "doc",
          version: 1,
          attrs: { custom: "preserved" },
          content: [],
        },
        status: { statusCategory: { key: "indeterminate" } },
      },
    });
  });
  const issue = await tracker.update("APP-1", { done: false });
  assert.equal(issue.done, false);
  assert.deepEqual(
    typeof issue.description === "object" ? issue.description.attrs : undefined,
    { custom: "preserved" },
  );
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
});

test("GitLab supports Link-only pagination with the server's actual page size", async () => {
  const pages: string[] = [];
  const tracker = gitlabFixture(async (input) => {
    const url = new URL(String(input));
    const page = url.searchParams.get("page") ?? "";
    pages.push(page);
    if (page === "1")
      return Response.json([gitlabRecord()], {
        headers: {
          link: '<https://gitlab.example/api/v4/projects/group%2Fproject/issues?page=2&per_page=1>; rel="next"',
        },
      });
    assert.equal(url.searchParams.get("per_page"), "1");
    return Response.json([gitlabRecord(2)], { headers: { "x-next-page": "" } });
  });
  assert.equal((await tracker.list()).length, 2);
  assert.deepEqual(pages, ["1", "2"]);
});

test("GitLab refuses pagination links targeting a different project or origin", async () => {
  for (const url of [
    "https://attacker.example/issues?page=2",
    "https://gitlab.example/api/v4/projects/other/issues?page=2",
  ])
    await assert.rejects(
      gitlabFixture(async () =>
        Response.json([gitlabRecord()], {
          headers: { link: `<${url}>; rel="next"` },
        }),
      ).list(),
      /Invalid GitLab pagination link/,
    );
});
