# Changelog

All notable changes to `luguo-cli` are documented here. This project follows
[Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/) format.

## [0.1.5-beta.0] - 2026-06-21

> Published on the `beta` npm dist-tag for dev testing (`npm i -g luguo-cli@beta`).
> The stable `0.1.5` will publish to `latest` once the agent endpoints reach production.

### Added
- `login --env dev|prod|local` binds the CLI to a site; the chosen base URL persists in credentials, so every later command targets that same site (dev key → dev, prod key → prod). `--base-url <url>` still works for any other deployment.

### Changed
- **Switched to luma-md.** `publish` now sends a luma-md Markdown lesson to `POST /api/agent/lessons` — the same format the web editor stores — replacing the old `ContentDocument` block tree and the `/api/lessons/import` path.
- A lesson is now one `.md` file with optional `---` frontmatter (`title` / `summary` / `tags` / `visibility` / `language` / `emoji`). `init [dir]` scaffolds `lesson.md` instead of a multi-chapter Book project.
- `validate` lints luma-md locally, then verifies it server-side via `POST /api/agent/validate` (`artifact: "luma_md"`).
- `lessons` replaces `books` (kept as an alias).

### Removed
- Removed the Book-project model (`luguo.yml`, multi-chapter directories), `ContentDocument` JSON publishing, and the local block-tree validators.

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

[0.1.5-beta.0]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.4...v0.1.5-beta.0
[0.1.4]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/yaoshenwang/luguo-cli/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/yaoshenwang/luguo-cli/releases/tag/v0.1.0
