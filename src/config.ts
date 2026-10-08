import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config, Target } from "./types.js";
import { array, object, string } from "./validation.js";

export const CONFIG_FILE = "hoospecbridge.config.json";
const configString = (value: unknown, context: string): string => {
  const result = string(value, context);
  if (result.trim() !== result || !result.trim())
    throw new Error(
      `Invalid ${context}: expected a nonempty string without surrounding whitespace`,
    );
  return result;
};

const optionalString = (
  record: Record<string, unknown>,
  key: string,
): string | undefined =>
  record[key] === undefined ? undefined : configString(record[key], key);

export function parseConfig(value: unknown): Config {
  const record = object(value, "configuration");
  if (record.version !== 1)
    throw new Error("Unsupported config version; expected 1");
  const targets = array(record.targets, "targets").map((item): Target => {
    const target = object(item, "target");
    const name = configString(target.name, "target name");
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      ["constructor", "prototype"].includes(name)
    )
      throw new Error(
        "Target names must use lowercase letters, numbers and hyphens",
      );
    const base = {
      name,
      project: configString(target.project, "project"),
      baseUrl: configString(target.baseUrl, "baseUrl"),
    };
    const tokenEnv = optionalString(target, "tokenEnv");
    if (tokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv))
      throw new Error("tokenEnv must be an environment variable name");
    const common = { ...base, ...(tokenEnv === undefined ? {} : { tokenEnv }) };
    const url = new URL(base.baseUrl);
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
    if (target.provider === "gitlab") return { ...common, provider: "gitlab" };
    if (target.provider !== "jira")
      throw new Error(`Unknown provider for ${name}`);
    const jira: Target = { ...common, provider: "jira" };
    for (const key of [
      "emailEnv",
      "issueType",
      "doneTransition",
      "openTransition",
    ] as const) {
      const value = optionalString(target, key);
      if (value !== undefined) jira[key] = value;
    }
    if (
      jira.emailEnv !== undefined &&
      !/^[A-Z_][A-Z0-9_]*$/.test(jira.emailEnv)
    )
      throw new Error("emailEnv must be an environment variable name");
    return jira;
  });
  if (
    !targets.length ||
    new Set(targets.map((target) => target.name)).size !== targets.length
  )
    throw new Error("Configure at least one target with unique names");
  const specsDir =
    record.specsDir === undefined
      ? "specs"
      : configString(record.specsDir, "specsDir");
  if (
    path.isAbsolute(specsDir) ||
    path.win32.isAbsolute(specsDir) ||
    /^[a-z]:/i.test(specsDir) ||
    specsDir.split(/[\\/]/).includes("..") ||
    path.posix.normalize(specsDir.replace(/\\/g, "/")).replace(/\/$/, "") ===
      "."
  )
    throw new Error(
      "specsDir must be a relative directory inside the repository",
    );
  const sourceUrl = optionalString(record, "sourceUrl");
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "sourceUrl must be an HTTPS repository blob URL without credentials, query or fragment",
      );
  }
  return {
    version: 1,
    repoId: configString(record.repoId, "repoId"),
    specsDir,
    targets,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

export async function loadConfig(root: string): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  const text = await readFile(file, "utf8");
  try {
    return parseConfig(JSON.parse(text) as unknown);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE}: ${error instanceof Error ? error.message : "Invalid configuration"}`,
      { cause: error },
    );
  }
}

export async function initConfig(
  root: string,
  provider: "gitlab" | "jira",
  project: string,
  baseUrl?: string,
): Promise<Config> {
  const config: Config = {
    version: 1,
    repoId: randomUUID(),
    specsDir: "specs",
    targets: [
      {
        name: provider,
        provider,
        project,
        baseUrl:
          baseUrl ??
          (provider === "gitlab"
            ? "https://gitlab.com"
            : "https://your-team.atlassian.net"),
      },
    ],
  };
  const valid = parseConfig(config);
  await writeFile(
    path.join(root, CONFIG_FILE),
    JSON.stringify(valid, null, 2) + "\n",
    { flag: "wx" },
  );
  return valid;
}
