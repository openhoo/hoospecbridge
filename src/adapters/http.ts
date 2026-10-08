import type { Fetcher } from "../types.js";

export class HttpClient {
  readonly base: string;
  constructor(
    baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly fetcher: Fetcher = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        "baseUrl must not include credentials, query or fragment",
      );
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("HTTPS required except for localhost");
    this.base = url.toString().replace(/\/$/, "");
  }
  async request(
    method: "GET" | "POST" | "PUT",
    route: string,
    body?: unknown,
  ): Promise<{ data: unknown; headers: Headers }> {
    const readOnly =
      method === "GET" ||
      (method === "POST" && route === "/rest/api/3/search/jql");
    let response: Response;
    try {
      response = await this.fetcher(this.base + route, {
        method,
        headers: {
          ...this.headers,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      });
    } catch {
      throw new Error(
        `${method} request failed or timed out. ${readOnly ? "Check network and tracker availability." : "A write may have succeeded; inspect the issue before retrying."}`,
      );
    }
    if (!response.ok)
      throw new Error(
        `${method} request returned HTTP ${response.status}. ${statusHint(response.status)}`,
      );
    if (response.status === 204)
      return { data: null, headers: response.headers };
    try {
      return { data: await response.json(), headers: response.headers };
    } catch {
      throw new Error(
        `Invalid JSON response from issue tracker.${readOnly ? "" : " A write may have succeeded; inspect the issue before retrying."}`,
      );
    }
  }
}

function statusHint(status: number): string {
  if (status === 401)
    return "Check the configured credential environment variables and authentication.";
  if (status === 403)
    return "The credential lacks access. Check project and issue permissions.";
  if (status === 404)
    return "Check the tracker URL, project, issue ID and access permissions.";
  if (status === 400 || status === 422)
    return "The tracker rejected the request. Check issue type, required fields and workflow configuration.";
  if (status === 429) return "Rate limited; retry later.";
  if (status >= 500)
    return "The tracker is unavailable. Inspect any attempted write before retrying.";
  return "Check tracker permissions and configuration.";
}
