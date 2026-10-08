# HooSpecBridge contributors

Use `skills/hoospecbridge-development/SKILL.md` for changes to this tool. Consumers syncing a Spec Kit repository use `skills/hoospecbridge-usage/SKILL.md`.

Run `npm run check` before shipping. Source and tests are strict TypeScript. Keep runtime dependencies empty unless a demonstrated need justifies adding one. API responses are untrusted; validate unknown data. Preserve public model and CLI compatibility within a release.

Never turn a preview into writes without `--apply`. Keep the planner pure, checkpoint successful writes, journal creates before the request, and refuse blind retries of uncertain mutations. Preserve human notes and source formatting.

Follow the user's Context7 instructions for current library/API documentation. API fixtures qualify local behavior; distinguish them from live Jira/GitLab verification.
