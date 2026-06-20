# luguo-cli

Publish **luma-md lessons** to [luguo](https://luguo.ai) from any AI dev agent.
A lesson is one Markdown file — standard Markdown plus a few `:::` teaching
fences — published with `luguo publish`. It's the same luma-md format the web
editor stores, so what you publish is what learners study.

The CLI is dependency-free and runs on Node.js 18+.

## Install

```bash
npm i -g luguo-cli
```

Or run without installing:

```bash
npx luguo-cli@latest help
```

## Quick Start

```bash
# Create an agent key at https://luguo.ai/settings first.
luguo login --key luguo_xxx
luguo init my-lesson
cd my-lesson
luguo validate
luguo publish
luguo open
```

Use `--base-url` with `login` when testing against another luguo deployment.

## A lesson is one file

`luguo init` scaffolds `my-lesson/lesson.md`:

```md
---
title: Slope of a line
summary: Find slope from two points; read the sign of k.
tags: [math, linear-functions]
visibility: private
---

# Slope

A linear function is $y = kx + b$, where $k$ is the slope.

:::keypoints Core ideas
- **slope k**: change in y divided by change in x
- **intercept b**: where the line crosses the y-axis
:::

:::quiz What does a negative slope mean?
- [ ] the line is horizontal
- [x] the line falls from left to right
@explain When k < 0, y decreases as x increases.
:::
```

Standard Markdown is the body; the `---` frontmatter (all optional) carries
`title` / `summary` / `tags` / `visibility` / `language` / `emoji`.

## luma-md fences

| Fence | Purpose |
| --- | --- |
| `:::quiz <question>` | multiple choice; options `- [x] correct` / `- [ ] wrong`; `@explain`, `@skills`, `@steps` |
| `:::keypoints <title>` | bullet list of `- **term**: definition` |
| `:::example <title>` | problem text, then `1.`/`2.` steps; `@approach`, `@answer` |
| `:::tip` / `:::warn` / `:::note <title>` | a callout box (Markdown inside) |
| `:::polypad <title>` | interactive math canvas; `@prompt`, then a fenced `json` spec |
| `---` | a divider (forces a new scene) |

Cover every concept and include at least one `:::quiz`. Anything luguo can't
parse degrades to plain Markdown — it never breaks the page.

## Commands

| Command | Purpose |
| --- | --- |
| `luguo login [--key …] [--base-url …]` | Log in with an existing agent key |
| `luguo doctor` / `luguo status` | Check connectivity and identity |
| `luguo skill [--save]` | Print or save the live luma-md contract |
| `luguo init [dir]` | Scaffold a luma-md lesson (`dir/lesson.md`) |
| `luguo validate [file.md\|dir] [--local]` | Lint locally, then validate on the server |
| `luguo publish [file.md\|dir]` | Publish the lesson as luma-md |
| `luguo lessons` | List recent lessons from this agent |
| `luguo open [dir] [--print]` | Open the latest published lesson |

`publish` accepts `--visibility`, `--title`, `--summary`, `--tags`, and
`--emoji` to override the frontmatter.

## Credentials

Credentials are stored at:

```txt
~/.config/luguo/credentials.json
```

Environment overrides:

```bash
LUGUO_BASE_URL=https://dev-luguo.vercel.app
LUGUO_API_KEY=luguo_xxx
```

The live format contract is always at `https://luguo.ai/skill.md` (or run
`luguo skill`).
