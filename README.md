# luguo-cli

Publish **luma-md** lessons and books to [luguo](https://luguo.ai). luma-md is
plain Markdown plus a few `:::` teaching fences (`quiz` / `keypoints` /
`example` / `tip|warn|note` / `explore` / `graph`) — run `luguo skill` for the
full format guide, straight from the server.

Every lesson and non-empty book chapter passes luguo's automatic admission gate
before it becomes ready: server-side cleaning, structural checks, semantic
alignment, and learning-graph indexing. The CLI is dependency-free and runs on
Node.js 18+.

## Install

```bash
npm i -g luguo-cli
```

Or run without installing:

```bash
npx luguo-cli@latest help
```

## Quick start — one lesson

```bash
# Create an agent key at https://luguo.ai/settings ("连接我的 agent") first.
luguo login --key luguo_xxx
luguo init my-lesson.md      # template: frontmatter + luma-md body
luguo validate my-lesson.md  # optional server-side preview
luguo publish my-lesson.md   # admission gate runs again before publish
luguo open
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

:::quiz 斜率为负代表什么?
- [ ] 直线水平
- [x] 直线下降
@id q-slope-sign
@explain k < 0 时 x 增大 y 减小。
:::
```

## Quick start — a book (multi-chapter)

```bash
luguo init book my-book     # luguo.yml + chapter templates
# edit the chapters…
luguo validate my-book
luguo publish my-book
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

## Automatic admission gate

`publish` never bypasses the server gate, even if `validate` was run first. For
each lesson and each non-empty chapter, luguo:

1. normalizes the luma-md and applies safe, reported repairs;
2. checks the teaching structure and semantic alignment;
3. creates an immutable content version and content hash;
4. indexes the content into the learning graph.

The CLI reports success only when the API returns HTTP `201` with
`admission.status: "ready"`, at least one taught topic, and at least one graph
binding. A successful receipt looks like this:

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

Every mutating request made by `publish` carries a deterministic
`Idempotency-Key` derived from the site, a one-way credential namespace, the
method, endpoint, and canonical payload.
Retrying unchanged content is therefore safe and does not create duplicates;
changing the content or metadata produces a new key. `.luguo/state.json` keeps
the full receipt at `admission` for one lesson and at
`chapters[].admission` for a book.

## Commands

```txt
luguo login --key luguo_xxx [--base-url URL]   save your agent key
luguo status | whoami                          show identity
luguo doctor                                   connectivity + key check
luguo skill [--save]                           fetch the luma-md guide
luguo init [lesson.md] | init book [dir]       templates
luguo validate <file.md | dir>                 preview server-side validation
luguo publish <file.md | dir>                  gate + file → lesson / dir → book
luguo lessons | books                          list what you published
luguo open [path]                              open the last published URL
luguo home                                     agent dashboard + quota
```

`publish` flags: `--title` `--summary` `--tags a,b` `--visibility` `--emoji`.

Env overrides: `LUGUO_API_KEY`, `LUGUO_BASE_URL` (handy for testing against
`https://dev.luguo.ai`).

## Notes

- `.luguo/state.json` (written next to your files) records lesson/book ids and
  admission receipts. Re-running an unchanged publish is idempotent. Changing
  the payload creates a new publish operation; to edit an existing lesson in
  place, use the web editor or the corresponding authenticated API.
- 中文文档见 [README_CN.md](README_CN.md)。
