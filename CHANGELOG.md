# Changelog

All notable changes to `luguo-cli` are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/) format.

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

[0.1.4]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yaoshenwang/luguo-cli/releases/tag/v0.1.0
