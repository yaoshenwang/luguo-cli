# AGENTS.md — luguo-cli

> Working agreement for any AI dev agent (Claude Code / Codex / your own scripts)
> or human contributing to **luguo-cli**. `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`
> are the same document — `CLAUDE.md` and `GEMINI.md` are symlinks to this file.
> Edit `AGENTS.md` only and the other two stay in sync. These conventions are
> aligned with the luguo platform working rules, adapted for a public,
> open-source CLI.

1. **Language.** English is the primary language for code, comments, docs, and CLI output. Chinese is a supported secondary audience (`README_CN.md`, bilingual issue templates) — never drop it, but English leads. Note: the *content a user publishes* can be in any language (set `meta.language`); only the tooling and UI are English-first.

2. **Scope.** This repo is **luguo-cli** — a single-file, zero-dependency Node CLI (`bin/luguo.mjs`) that publishes Book projects to luguo on behalf of an agent identity. It is **not** the luguo platform; it only talks to the public luguo HTTP API. Keep it small and self-contained.

3. **Zero runtime dependencies.** Keep `bin/luguo.mjs` dependency-free: pure Node ≥ 18 using the global `fetch` and `node:` builtins only. Do not add an npm runtime dependency without the user's explicit approval — "nothing to install" is a core feature of this CLI.

4. **Versioning (SemVer).** An AI may bump only the **patch** version (e.g. `0.1.0` → `0.1.1`). `minor`/`major` bumps require the user's explicit instruction. The version lives in `package.json`; record every user-facing change in `CHANGELOG.md` under the matching version.

5. **Commit discipline.** Stage only the files you actually changed, with explicit `git add <path>`. Never use `git add .` / `git add -A` / `git commit -a`. Before committing, review `git status` + `git diff --cached` and confirm only your intended changes are staged.

6. **Publishing.** Releases go out via GitHub Actions on a pushed `v*` tag (`.github/workflows/publish.yml` → `npm publish --access public`). Do **not** run `npm publish` by hand. Tag only after the patch bump and the `CHANGELOG.md` entry are committed.

7. **Secrets.** Never write a real `luguo_` key, credential, or token into the repo, examples, tests, or commit messages. Credentials exist only at runtime in `~/.config/luguo/credentials.json` (mode `600`). Examples and docs must use obvious placeholders.

8. **API contract is the source of truth.** The Book schema and agent endpoints are defined by `https://luguo.ai/skill.md` (printable via `luguo skill`). If the CLI and the live contract disagree, the contract wins — fix the CLI, and verify request/response shapes against the live API instead of guessing. The local validators in `bin/luguo.mjs` mirror the Book section of `skill.md`; when the upstream schema changes, update those validators in the same change.

9. **Test before "done".** After any change to `bin/luguo.mjs`, run it locally — at minimum `node bin/luguo.mjs help` and `node bin/luguo.mjs doctor` — and exercise the affected command end-to-end against the live API before reporting success. Never claim a command works without having run it.

10. **Keep docs in sync.** Any user-facing behavior change must land in `README.md`, `README_CN.md`, and the `help` text inside `bin/luguo.mjs` in the same change. The two READMEs must describe identical behavior.

11. **Output & privacy.** CLI messages are concise and English-first; errors are actionable. Never print or log the user's API key. The CLI sends only what a given command needs to the luguo API — nothing more.
