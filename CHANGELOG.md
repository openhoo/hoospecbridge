# Changelog

## 0.1.1 — October 8, 2026

### Fixed

- Recover completion intent after an interrupted issue create.
- Checkpoint successful content updates when a later checkbox pull fails.
- Verify tracker identity and persisted content/status before advancing sync baselines.
- Recheck source files and remote status before writing local checkboxes.
- Reject invalid runtime direction/apply options before acquiring a lock.
- Validate pending-create journal entries and duplicate saved mappings.
- Preserve Jira document metadata and rich content around managed blocks.
- Read all tracker issue pages and reject malformed or incomplete pagination.
- Reject malformed task metadata and code-fence boundaries that could expose examples as tasks.
- Preflight checkbox batches, reject contradictory changes, and clean up temporary files.
- Report inappropriate CLI flags and invalid configuration fields explicitly.
- Read the CLI version from the installed package metadata.

### Improved

- Human-readable plans show proposed titles and completion changes.
- State journals flush data before remote creates; locks distinguish contention from I/O errors.
- Source links encode feature/task path segments.
- Package verification installs the archive in a fresh project and checks CLI, runtime exports, TypeScript consumer declarations and bundled skills.

## 0.1.0 — October 8, 2026

Initial strict TypeScript CLI/library with Spec Kit task discovery, Jira Cloud and GitLab adapters, preview/apply, push/pull/status reconciliation, managed issue content and agent skills.
