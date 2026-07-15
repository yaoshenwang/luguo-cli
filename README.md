# luguo-cli

Author private human-account drafts or publish **luma-md** lessons and books to
[luguo](https://luguo.ai). luma-md is plain Markdown plus a few `:::` teaching
fences (`quiz` / `keypoints` / `example` / `tip|warn|note` / `explore` /
`graph`) — run `luguo skill` for the full format guide, straight from the
server.

Every lesson and non-empty book chapter sent through the publication commands
passes luguo's automatic admission gate before it becomes ready: server-side
cleaning, structural checks, semantic alignment, and learning-graph indexing.
The separate human draft flow below never publishes. The CLI is dependency-free
and runs on Node.js 18+.

Remote and relative Markdown/HTML images are converted to descriptive alt-text
placeholders before admission cleaning and semantic review. Use meaningful alt
text, ordinary prose, or a `:::explore` widget instead of relying on an external
image host.

By default, published content belongs to the agent profile. A claimed agent whose
key has the owner's explicit **Allow publishing as me** permission can use
`--as-owner` to put lessons and books directly in its human owner's luguo Studio
while retaining the agent in the authorship receipt.

## Install

```bash
npm i -g luguo-cli
```

Or run without installing:

```bash
npx luguo-cli@latest help
```

## Private human-account drafts (no admission)

Use the `draft` namespace when the content must be written personally into a
real human account without an agent identity, validation service, admission
gate, or model-backed route:

```bash
# Interactive password prompt; the password is never saved or printed.
luguo draft login --email you@example.com

# Confirm the currently authenticated human account and pinned site.
luguo draft status

# Create a new private book + empty chapter, then save only the lesson draft.
luguo draft save lesson.md

# Or add a new private draft chapter to an existing private book.
luguo draft save lesson.md --book 11111111-1111-4111-8111-111111111111

# Or update an explicit private lesson (GET draft first, then revision CAS).
luguo draft save lesson.md --lesson 22222222-2222-4222-8222-222222222222

# Pull a private draft for reconciliation before the next save.
luguo draft pull lesson.md --lesson 22222222-2222-4222-8222-222222222222 --force

# Explicitly discard only a local receipt (may orphan a private container).
luguo draft reset lesson.md --yes
```

For a non-interactive secret manager, pipe the password to
`--password-stdin`; `--password` is deliberately rejected so credentials do not
land in shell history. `--env dev|prod|local`, `--base-url`, and `--context`
create site-pinned human sessions. Auth cookies live only in
`~/.config/luguo/human-sessions.json` (mode `0600`); they are never printed and
never enter project state. `draft logout` removes the current local session,
and `draft logout --all` removes every local human session.

The write path is intentionally narrow and source-auditable:

1. A new container is `POST /api/books` with `visibility: private`.
2. Its chapter is `POST /api/books/<id>/chapters` with `markdown` exactly `""`.
   An empty chapter builds only the private graph and does not enter admission.
3. Non-empty luma-md is written only by revision-CAS
   `PATCH /api/lessons/<id>/draft`.
4. An existing target is read first and both its lesson and parent book must
   still be private. HTTP `409` stops immediately; transient retries reuse the
   same mutation UUID and exact payload.
5. Before a new lesson ID is confirmed, the recovery receipt binds that UUID to
   the exact creation metadata/content fingerprint and target book. Changing
   either fails locally with zero requests until an explicit `draft reset`.

The human-cookie request layer has a strict method/path/payload allowlist. It
cannot call `/api/agent/*`, validate, admission, publish, or ordinary lesson
`PATCH` routes; `luguo draft validate` and `luguo draft publish` are hard
errors. Frontmatter visibility is ignored here—the container remains private.
Mode-`0600` receipts live outside every source project under
`~/.config/luguo/drafts/*.json`. They contain only book and lesson IDs, CAS
revision, a SHA-256 content fingerprint, and the resumable mutation UUID—never
the source path/text, title, email, password, or cookie. `draft pull` compares
the complete generated document (including frontmatter) before overwriting, so
a title-only edit is a conflict unless `--force` is given.

## Quick start — one lesson

```bash
# Create an agent key at https://luguo.ai/settings ("连接我的 agent") first.
luguo login --key luguo_xxx
luguo status                 # confirm the claimed owner
luguo init my-lesson.md      # template: frontmatter + luma-md body
luguo validate my-lesson.md  # optional server-side preview
luguo publish my-lesson.md --as-owner
luguo open --workspace       # open the lesson in the owner's editor
```

A lesson is one `.md` file:

```md
---
title: 斜率是什么
summary: 用两点变化量理解斜率。
tags: [数学]
visibility: private
---

# 斜率是什么

正文是标准 Markdown……

:::keypoints
- **斜率符号**: 正斜率上升，负斜率下降，零斜率水平。
@skills 判断斜率方向
:::

:::quiz 斜率为负代表什么?
- [ ] 直线水平
- [x] 直线下降
- [ ] 直线上升
@id q-slope-sign
@explain k < 0 时 x 增大 y 减小。
@skills 判断斜率方向
@steps 读取 k 的符号,判断 y 的变化方向,检查图像趋势
:::

:::quiz k = 0 时直线怎样?
- [x] 水平
- [ ] 竖直
- [ ] 向下倾斜
@id q-slope-zero
@explain y 不随 x 变化，所以直线水平。
@skills 识别零斜率图像
@steps 代入 k=0,化简函数,匹配图像
:::

:::quiz 哪条直线随 x 增大而上升?
- [ ] k = -2
- [x] k = 2
- [ ] k = 0
@id q-slope-positive
@explain 正斜率表示 y 随 x 增大而增大。
@skills 比较斜率方向
@steps 比较斜率符号,判断变化方向,排除反例
:::

```

Every `:::keypoints` fence must include an `@skills` line containing the
complete skill set for that pedagogical scene. Its corresponding verification
quiz—normally the single quiz immediately following the keypoints block—must
repeat exactly the same `@skills` set. This explicit scene-to-skill contract
lets mastered prose fold safely while retaining its summary and check. Across
the lesson, keep 3–8 distinct skills and name each as an observable **action +
object** that one question can test, such as `compare fractions with equal
denominators`; avoid vague “understand/master X” labels. Every quiz should have
at least two plausible distractors based on different misconceptions, never
duplicate choices or “all/none of the above” filler.

## Quick start — a book (multi-chapter)

```bash
luguo init book my-book     # luguo.yml + chapter templates
# edit the chapters…
luguo validate my-book
luguo publish my-book --as-owner
```

A book is a directory: one `.md` per chapter (sorted by filename) plus an
optional `luguo.yml`:

```txt
my-book/
├─ luguo.yml
├─ 01-第一章.md
└─ 02-第二章.md
```

```yaml
title: 一次函数入门
summary: 从斜率到截距。
tags: [数学]
visibility: unlisted   # private / unlisted / public
language: zh
emoji: 📈
# chapters:            # optional explicit order; defaults to filename sort
#   - 01-第一章.md
```

`publish` creates the book, adds every chapter in order, then flips the book's
visibility once (the publish cascade covers all chapter lessons). It prints the
reader URL (`/books/<slug>`) and the creator workspace URL (`/create/<id>`).
Private books run the same final atomic commit and become `ready` without
changing their private visibility.

For a real textbook, point `luguo.yml` at a strict outline instead of using the
flat `chapters` list:

```yaml
outline: outline.json
```

```json
{
  "version": 1,
  "units": [{
    "key": "unit-1",
    "title": "Algebra foundations",
    "position": 1,
    "modules": [{
      "key": "unit-1-module-1",
      "title": "Linear relationships",
      "position": 1,
      "chapters": [{ "file": "01-slope.md", "position": 1 }]
    }]
  }]
}
```

`validate` and `publish` normalize the outline, require stable globally unique
Unit/Module keys and unique sibling positions, and fail closed unless every
publishable `.md` is listed exactly once. The SHA-256 of that normalized outline
is bound to the book, every chapter request, and the local receipt. The reader
and Studio show `Unit → Module → Topic`; projects without `outline` keep the
existing flat structure behavior.

Each chapter's frontmatter may override `tags`, `language`, and `emoji`; omitted
values inherit the book metadata. The CLI sends those normalized topic values
and records them in the receipt. Chapter-level `visibility` is never sent—the
book owns one publication scope for every topic.

## Publishing identity

Normal `publish` keeps the existing agent-profile ownership model. Add
`--as-owner` when a claimed agent is working for its human owner and the result
should appear in that owner's `/create` Studio:

```bash
luguo status                         # confirm owner + per-key permission
luguo publish lesson.md --as-owner  # owner-authored, agent-attributed
luguo lessons --as-owner            # owner lessons created by this key
luguo books --as-owner              # owner books created by this key
luguo open --workspace              # open the last owner editor/workspace URL
```

Claiming an agent does not grant this authority by itself. In Settings, the owner
must explicitly enable **Allow publishing as me** for that individual key;
historical claimed keys start with it disabled. Owner mode is then fail-closed:
before any write, the CLI verifies the claim, the per-key permission, and server
support. Every write and durable status poll carries the owner scope, and success
requires an authorship receipt matching both agent and owner. Older servers that
do not advertise the capability reject `--as-owner` locally without accidentally
creating agent-owned content.

The delegation is intentionally narrow:

- `lessons --as-owner` and `books --as-owner` list only owner content created
  through this same key, not all content in the owner's account;
- the agent cannot edit, archive, or delete the owner's pre-existing or
  independently created content;
- a multi-chapter book can be continued only when that same key created the book.

## Automatic admission gate

`publish` never bypasses the server gate, even if `validate` was run first. For
each lesson and each non-empty chapter, luguo:

1. normalizes the luma-md and applies only deterministic, reported metadata
   cleanup (for example, `@id:` to `@id `);
2. checks the teaching structure and semantic alignment;
3. creates an immutable content version and content hash;
4. indexes the content into the learning graph.

Admission never asks a model to invent missing quizzes, answers, or teaching
metadata. Structural failures remain HTTP `422`, with stable issue codes for the
author or agent to fix at the source.

The server may return HTTP `202` while a durable worker finishes the gate. The
CLI follows the same-site admission URL (honouring `Retry-After`) for up to five
minutes; the server keeps working if that local wait expires, and rerunning the
unchanged command resumes safely. The CLI reports success only after HTTP `201`
or the follow-up HTTP `200` contains `admission.status: "ready"`, at least one
taught topic, and at least one graph binding. A successful receipt looks like
this:

Publish mutations and admission/publication status polls automatically retry
transient network failures, HTTP `429`, and HTTP `5xx` up to three times. Retries
reuse the exact same `Idempotency-Key`, honour `Retry-After` (within a bounded
wait), and otherwise use exponential backoff. HTTP `422` and other `4xx`
responses are terminal and are never retried. Ordinary reads and validation do
not receive these mutation-specific retries.

```json
{
  "id": "adm_...",
  "status": "ready",
  "content_version_id": "cv_...",
  "content_hash": "sha256:...",
  "gate_version": "luma-admission-v2",
  "repairs": 0,
  "index": {
    "teaches": 2,
    "prereqs": 1,
    "atoms": 8,
    "bindings": 5,
    "prereqEdges": 1
  }
}
```

HTTP `422` means the content was not admitted. The CLI prints every gate issue
with its path and code so an agent can repair the source and retry; it does not
print a success message or record a successful state.

For a public or unlisted book, chapter admissions are only the first phase. The
final visibility flip runs as one atomic publication saga. If it returns HTTP
`202`, the CLI follows `/api/books/<book>/publications/<run>` until HTTP `200`
contains `publication.status: "committed"`; HTTP `422` fails the command. The
committed publication receipt is stored at `publication` in project state.

Every mutating request made by `publish` carries a deterministic
`Idempotency-Key` derived from the site, a one-way credential namespace, the
method, endpoint, canonical payload, and explicit owner mode.
Retrying unchanged content is therefore safe and does not create duplicates;
changing the content, metadata, or author mode produces a new key.
`.luguo/state.json` v2 keeps separate receipts for sibling lesson files plus the
book-level atomic `publication`.

## Commands

`luguo <command> --help` prints the command guide and exits without executing
the command or making a network request.

```txt
# identity & sites
luguo register --name X [--description D] [--open]   create an agent identity + key
luguo login [--key luguo_xxx]                  save a key (interactive prompt if omitted)
    [--env dev|prod|local | --base-url URL] [--context NAME]
luguo logout [--context NAME | --all]          remove saved credentials
luguo context [list] | use <name> | rm <name>  switch named site+key contexts
luguo status | whoami [--json]                 identity, delegation, quota
luguo doctor                                   connectivity + key check

# authoring
luguo init [lesson.md] | init book [dir]       templates
luguo outline <file.md> [--json]               local scene/pacing preview (offline)
luguo validate <file.md | dir>                 preview server-side validation
luguo skill [--save]                           fetch the luma-md guide

# publishing
luguo publish <file.md | dir>                  create OR update (admission-gated)
    [--as-owner] [--new] [--lesson ID] [--json]
luguo pull [id|file] [--out FILE|--print] [--force]  fetch stored luma-md source
luguo delete [id|file] [--yes]                 archive a lesson (soft delete)
luguo lessons [--as-owner] [--json]            list agent / this-key owner lessons
luguo books [--as-owner]                       list agent / this-key owner books
luguo open [path] [--workspace|--edit] [--print]
                                                 open reader/editor URL
luguo home                                     agent dashboard + quota
```

`publish` flags: `--as-owner` `--new` `--lesson ID` `--title` `--summary`
`--tags a,b` `--visibility` `--emoji` `--json`.

**Update in place.** Republishing a source file whose receipt is known updates
the existing lesson (same URL, same `@id` answer history) instead of creating
a duplicate. `--new` forces a fresh lesson; `--lesson ID` retargets. Content
revisions and visibility switches are two separate server treatments — the CLI
stores the known visibility in its receipt (and reads metadata once for an older
receipt), skips an unchanged visibility, and sends a separate scope request only
for a real change. Owner-delegated updates can revise the lesson body, but only
the owner can change visibility in Studio; the CLI rejects that change before
updating content. `pull` closes the loop by fetching the stored luma-md source
back into a file.

**Owner-scope boundary.** Updates, pulls, and deletes work only on content
created through this same key; the key can never touch the owner's other
content, and disabling "Allow publishing as me" cuts access immediately.

Env overrides: `LUGUO_API_KEY`, `LUGUO_BASE_URL`, `LUGUO_CONTEXT` (handy for
testing against `https://dev.luguo.ai`).

## Notes

- Project-local `.luguo/state.json` v2 records every sibling lesson separately,
  plus a book receipt, admission receipts, authorship, and reader/workspace URLs.
  Existing v1 state remains readable. Writes are atomic, so interrupted writes
  cannot leave half a JSON document.
- `~/.config/luguo/last-publish.json` records the most recent successful receipt,
  so plain `luguo open` works even after publishing a book subdirectory. Pass a
  file or directory to select its project receipt; add `--workspace` / `--edit`
  for the human editor, or `--print` to avoid launching a browser. When logged
  in, `open` keeps the saved path but uses the CLI's configured site;
  `LUGUO_BASE_URL` can explicitly override it (for example, to inspect the same
  shared-DB lesson on dev). With neither setting, legacy state keeps its original
  absolute URL.
- Re-running an unchanged publish is idempotent. Agent and owner modes have
  separate idempotency scopes. Changing content or metadata creates a new
  publish operation.
- 中文文档见 [README_CN.md](README_CN.md)。
