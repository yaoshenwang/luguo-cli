# Changelog

All notable changes to `luguo-cli` are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/) format.

## [0.1.13] - 2026-07-13

### Added
- `luguo draft login/status/logout` manages a separately pinned human-account
  cookie session. Passwords are accepted only through a hidden prompt or
  explicit stdin, never saved, and auth cookies stay in a mode-`0600` user
  session file instead of project state or command output.
- `luguo draft save <file.md> [--lesson UUID] [--book UUID]` creates or updates
  private human-owned drafts without admission: new content follows the strict
  `POST private book → POST byte-empty chapter → PATCH lesson draft` flow;
  updates read the current draft first and use revision CAS.
- `luguo draft pull` round-trips a private draft into luma-md and refreshes the
  minimal local draft receipt.
- `luguo draft reset <file.md>` explicitly discards only a local recovery
  receipt when the user accepts that an unconfirmed private container may have
  been created remotely.
- Mock HTTP coverage for endpoint allowlisting, private/empty creation payloads,
  cross-process idempotent recovery, title/frontmatter round-trips, HTTP `409`
  fail-closed behavior, host pinning, local receipt minimization, Node 18 cookie
  fallback, size preflight, and credential non-disclosure.

### Security
- Human draft requests have a dedicated method/path/payload allowlist. Agent,
  validate, admission, publish, and ordinary lesson `PATCH` routes are rejected;
  `draft validate` and `draft publish` are hard errors.
- Human cookies are pinned to their login origin and are never sent through the
  existing Bearer-key request helper. Mode-`0600` draft receipts live outside
  source projects and contain only book/lesson IDs, revision, a content
  SHA-256, and a resumable mutation UUID.
- An unconfirmed container mutation is bound to the exact creation fingerprint
  and target book. Content/book changes fail locally until explicit reset;
  replayed chapters are verified against their private parent before CAS write.

## [0.1.12] - 2026-07-13

### Added
- Book projects can set `outline: outline.json` and publish a strict
  Unit → Module → Topic hierarchy. The CLI normalizes and hashes outline v1,
  validates unique stable keys/positions and complete `.md` coverage, binds the
  hash and hierarchy to API writes, and records both in the project receipt.
- Chapter `tags`, `language`, and `emoji` frontmatter now survive book publish;
  omitted values inherit book metadata, while visibility remains book-scoped.

### Fixed
- Private multi-chapter books now run the final atomic publication commit and
  become ready without changing visibility, including claimed-owner workflows.

## [0.1.11] - 2026-07-13

### Fixed
- Owner-delegated lesson updates now remember (or read once from older receipts)
  the current visibility, omit unchanged visibility from the content PATCH, and
  verify the returned authorship receipt. A real delegated visibility change is
  rejected clearly before content is modified; agent-owned scope changes still
  use their separate PATCH treatment.
- `--help` now short-circuits every subcommand, printing help with zero network
  requests or command side effects instead of treating the working directory as
  a publish target.

## [0.1.10] - 2026-07-13

### Changed
- Documented the admission-safe image policy: remote and relative Markdown or
  HTML images become alt-text placeholders before cleaning and semantic review,
  so authors should use descriptive alt text or a `:::explore` visual instead.
- Clarified that admission repair is deterministic metadata cleanup only; the
  server never invents missing quizzes, answers, or teaching metadata.

## [0.1.9] - 2026-07-12

### Added
- **Publish now updates in place.** Republishing a source file whose receipt is
  known sends `PATCH /api/lessons/<id>` (same URL, same `@id` answer history)
  instead of creating a duplicate lesson. `--new` forces a fresh lesson,
  `--lesson ID` retargets explicitly. Content revisions and visibility switches
  are ordered automatically (the server treats them as separate treatments).
- `luguo pull [id|file] [--out FILE|--print] [--force]` — fetch the stored
  luma-md source back from the server (`GET /api/lessons/<id>?format=luma-md`),
  reconstructing frontmatter for a full edit round-trip.
- `luguo delete [id|file] [--yes]` (alias `archive`) — archive a lesson (soft
  delete) with an interactive confirmation and receipt cleanup.
- `luguo outline <file.md> [--json]` — local, offline scene/pacing preview that
  mirrors the server's scene rules and warns about missing quiz/keypoints gates.
- `luguo register --name X [--description D] [--open]` — create an agent
  identity from the CLI; when the server requires a logged-in human it guides
  through the browser flow and finishes as a normal login.
- **Named contexts** (kubectl-style): the credentials file now holds multiple
  site+key contexts. `luguo context [list] | use <name> | rm <name>`,
  `luguo logout [--context NAME|--all]`, `LUGUO_CONTEXT` per-run override.
  v1 credential files migrate automatically as the `default` context.
- Interactive hidden-key prompt for `luguo login` when `--key` is omitted.
- `--json` machine-readable output for `status`, `lessons`, `context list`,
  `outline`, and `publish` (update path).
- Lesson template (`luguo init`): worked-example, warn callout, and an
  `:::explore` sample including the new plot `domain` field.

### Changed
- `status`/`whoami` shows the active context name and remaining daily quota.
- Owner-scope note: updates, pulls, and deletes work only on content created
  through this same key (the books continuation rule, now applied to lessons
  server-side); disabling "Allow publishing as me" cuts access immediately.

## [0.1.8] - 2026-07-11

### Fixed
- `luguo open` now follows the CLI's saved site as well as an explicit `LUGUO_BASE_URL`, so a normal production login cannot reopen a stale localhost/dev origin; legacy state without either configuration still preserves its original absolute URL.

## [0.1.7] - 2026-07-11

### Added
- Claimed agents whose key has the owner's explicit **Allow publishing as me** permission can use `publish --as-owner` to create lessons and books in their human owner's Studio while retaining a verified agent authorship receipt; historical claimed keys default to disabled.
- `lessons --as-owner` and `books --as-owner` list only owner content delegated through that same key.
- `open --workspace` / `--edit` opens the human editor or book workspace; `--print` prints without launching a browser.

### Changed
- Owner publishing now performs capability, claim, and per-key permission preflight before any write, sends `X-Luguo-Act-As: owner` through every mutation and durable status poll, and fails closed unless the final authorship receipt matches both agent and owner.
- Owner delegation cannot modify, archive, or delete the human owner's other content; multi-chapter continuation is restricted to books created by the same key.
- Owner mode has a separate idempotency domain while default agent-mode keys remain byte-for-byte compatible with 0.1.6.
- Publish mutations and durable admission/publication polls retry network failures, HTTP 429, and HTTP 5xx up to three times with the same idempotency key, bounded exponential backoff, and `Retry-After` support; HTTP 422 and other 4xx remain terminal.
- `status`, `home`, and `login` show the claimed owner and whether owner publishing is available.
- The npm tag workflow now runs tests, help smoke coverage, and a package dry run before publishing.

### Fixed
- Project state v2 keeps separate receipts for sibling lesson files instead of overwriting one flat `.luguo/state.json`.
- State writes are atomic, v1 state stays readable, and a global last-publish receipt makes plain `luguo open` work after publishing a subdirectory book.
- Owner publications now record and print the correct lesson editor or book workspace URL.
- An explicit `LUGUO_BASE_URL` now rebases saved `open` reader/workspace URLs instead of leaking a stale localhost or other-environment origin into the current workflow.

## [0.1.6] - 2026-07-10

### Changed
- `publish` is now fail-closed on the unified admission gate. A lesson or non-empty chapter is successful only after HTTP `201`, or a polled HTTP `200`, returns a complete `admission` receipt with `status: "ready"`, `teaches >= 1`, and `bindings >= 1`.
- HTTP `202` admissions are now followed through their same-site status URL until ready or rejected; a bounded local timeout never cancels the durable server job, and the stable publish key makes a later rerun resume safely.
- Public/unlisted books now follow the book publication saga through HTTP `202` to a fail-closed `committed` receipt, which is persisted in `.luguo/state.json`.
- `init` and all bundled lesson/book examples now satisfy the production-ready baseline of three quizzes, stable IDs, `@skills`, `@steps`, explanations, and keypoints.
- HTTP `422` output now lists every admission issue with its content path and machine-readable code.
- `.luguo/state.json` now records the full admission receipt for a lesson or for every published book chapter.

### Added
- Stable, credential-namespaced `Idempotency-Key` headers for all mutating publish requests, derived from the site, method, endpoint, and canonical payload so unchanged retries do not create duplicates or collide across agents.
- Zero-dependency Node test coverage for help, doctor, validation, admission-ready templates, lesson and book admission, 201/202/422 handling, fail-closed readiness checks, persisted receipts, polling, and idempotent retries.

## [0.1.5] - 2026-07-03

### Changed
- **luma-md only.** Lessons and books are authored as luma-md (Markdown + `:::` teaching fences); all legacy `ContentDocument` conversion and validation code is gone.
- `publish <file.md>` posts one lesson to `/api/agent/lessons` (frontmatter: title/summary/tags/visibility/language/emoji).
- `validate` now validates server-side via `/api/agent/validate` (per chapter for directories).
- `books` now lists your books from `GET /api/books`.

### Added
- **Book publishing**: `publish <dir>` creates a book via `POST /api/books`, adds one chapter per `.md` file via `POST /api/books/<id>/chapters` (filename order or `luguo.yml` `chapters:`), then flips visibility once so the publish cascade covers every chapter.
- `lessons` command (list published lessons), `init` lesson template, `init book` luma-md book template.

### Removed
- `register` command (server requires a logged-in session; create keys at `/settings`), legacy `luguo.yml` Book-project → ContentDocument pipeline, `/api/lessons/import` publishing.

## [0.1.4] - 2026-06-17

### Changed
- `publish` now creates editor-compatible `ContentDocument` lessons through `/api/lessons/import`, matching the current `/books/new` editor.
- Book projects are converted locally into heading/text block trees with lesson overlay metadata.
- `validate` now checks the derived editor `ContentDocument` locally.
- `books` now lists recent editor-format content from the agent home endpoint.

### Added
- Direct publishing for existing editor JSON (`version: "1", blocks, meta`).

### Removed
- Removed legacy Source + learning-path publishing (`publish --as-source`) and old path/source open flags.
- Removed anonymous agent registration from the CLI; create an agent key in luguo settings and use `login`.

## [0.1.3] - 2026-05-30

### Changed
- Replaced the public workflow with Book projects: `init book`, `validate`, `publish`, `books`, and `open`.
- Switched HTTP calls to `/api/agent/books` and the Book-only validation contract.
- Removed `material` and `plan` command paths from the supported surface.
- Added Quarto-lite `luguo.yml` + Markdown chapter examples.

## [0.1.2] - 2026-05-30

### Changed
- Replaced the CLI workflow with `material` and `plan` commands.
- Updated HTTP calls to `/api/agent/materials`, `/api/agent/plans`, and the new validation contract.
- Removed the direct lesson publishing command path from the CLI.
- Renamed examples and docs to the final Material / Plan product language.

## [0.1.1] - 2026-05-30

### Added
- An intermediate structured-material workflow. This was superseded by 0.1.2.

### Changed
- Updated help text and English/Chinese READMEs for the intermediate workflow.

## [0.1.0] - 2026-05-29

First public release.

### Added
- `luguo register` — register an agent identity, receive a `luguo_` API key (written to the credentials file automatically) along with a claim link.
- `luguo login` — log in with an existing key (supports `--key` / stdin / interactive paste, and a `--base-url` override).
- `luguo doctor` / `luguo status` — connectivity self-check and identity inspection.
- `luguo validate <file.json>` — validate agent-created JSON.
- A first publishing workflow for early agent experiments.
- `luguo home` — review plays / feedback / topic gaps for your own content.
- `luguo skill [--save]` — print or save the full agent contract document.
- Zero runtime dependencies (pure Node ≥ 18, using the global `fetch` and `node:` builtins).
- Credentials stored at `~/.config/luguo/credentials.json` with `0600` permissions.

[0.1.13]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.12...v0.1.13
[0.1.7]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yaoshenwang/luguo-cli/releases/tag/v0.1.0
