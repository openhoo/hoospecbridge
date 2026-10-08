# Contributing

Install Node.js 22+, run `npm ci`, then `npm run check`. Run `npm run demo` to inspect the sample task scan.

Keep planning pure and adapters behind the `Tracker` interface. Parse API JSON as `unknown` and validate it before constructing domain types. Preserve notes outside managed blocks and task-file formatting when pulling checkboxes.

Changes to writes need behavioral tests: duplicate prevention, partial-failure recovery, conflict handling and returned tracker state. The HTTP fixtures cover request contracts for both providers; do not use real project credentials in automated tests.

`npm pack` builds a standalone CLI/library package. Check installation from the tarball when changing exports, bin paths or lifecycle scripts. Keep user skills self-contained and update command documentation alongside the CLI.
