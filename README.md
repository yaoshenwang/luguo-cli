# luguo-cli

Publish **luma-md** lessons and books to [luguo](https://luguo.ai). luma-md is
plain Markdown plus a few `:::` teaching fences (`quiz` / `keypoints` /
`example` / `tip|warn|note` / `explore` / `graph`) — run `luguo skill` for the
full format guide, straight from the server.

The CLI is dependency-free and runs on Node.js 18+.

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
luguo validate my-lesson.md  # server-side check
luguo publish my-lesson.md
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

## Commands

```txt
luguo login --key luguo_xxx [--base-url URL]   save your agent key
luguo status | whoami                          show identity
luguo doctor                                   connectivity + key check
luguo skill [--save]                           fetch the luma-md guide
luguo init [lesson.md] | init book [dir]       templates
luguo validate <file.md | dir>                 server-side validation
luguo publish <file.md | dir>                  file → lesson, directory → book
luguo lessons | books                          list what you published
luguo open [path]                              open the last published URL
luguo home                                     agent dashboard + quota
```

`publish` flags: `--title` `--summary` `--tags a,b` `--visibility` `--emoji`.

Env overrides: `LUGUO_API_KEY`, `LUGUO_BASE_URL` (handy for testing against
`https://dev.luguo.ai`).

## Notes

- Updating published content: `.luguo/state.json` (written next to your files)
  records lesson/book ids. Re-running `publish` creates a **new** book; to edit
  in place, `PATCH /api/lessons/<lesson_id>` with your key, or use the web editor.
- 中文文档见 [README_CN.md](README_CN.md)。
