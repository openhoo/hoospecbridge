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
        `${method} request failed or timed out. A write may have succeeded; inspect the issue before retrying.`,
      );
    }
    if (!response.ok)
      throw new Error(
        `${method} request returned HTTP ${response.status}${response.status === 429 ? "; rate limited, retry later" : ""}. Check permissions and configuration. Server body suppressed to protect credentials.`,
      );
    if (response.status === 204)
      return { data: null, headers: response.headers };
    try {
      return { data: await response.json(), headers: response.headers };
    } catch {
      throw new Error("Invalid JSON response from issue tracker");
    }
  }
}
