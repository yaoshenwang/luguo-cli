# luguo-cli

Publish Book projects to [luguo](https://luguo.ai). By default, `publish`
creates the same editor-compatible `ContentDocument` used by `/books/new`, so
CLI output can be opened and edited in the current luguo editor.

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
luguo init book my-book
cd my-book
luguo validate
luguo publish
luguo open
```

Use `--base-url` with `login` when you are testing against another luguo
deployment.

## Book Project

```txt
my-book/
├─ luguo.yml
└─ chapters/
   ├─ 01-intro.md
   └─ 02-bayes.md
```

`luguo.yml`:

```yaml
title: Fourier Transform by Sound
summary: A short textbook that explains frequency-domain decomposition through music.
audience: First-year college learners
language: en
visibility: private
chapters:
  - chapters/01-frequency-domain.md
```

Chapter Markdown:

```md
# Frequency domain

The frequency domain describes which frequency components make up a signal.

# Exercise

If a spectrum has peaks at 440 Hz and 880 Hz, identify the fundamental and first overtone.
```

## JSON Book

You can also publish a normalized JSON Book project:

```bash
luguo validate examples/book.json
luguo publish examples/book.json
```

If you already have a `/books/new` editor JSON (`{ "version": "1", "blocks": ... }`),
publish it directly:

```bash
luguo validate document.json
luguo publish document.json --title "My Book"
```

## Commands

| Command | Purpose |
| --- | --- |
| `luguo login [--key …] [--base-url …]` | Use an existing key |
| `luguo doctor` / `luguo status` | Check connectivity and identity |
| `luguo skill [--save]` | Print or save the live Book contract |
| `luguo init book <dir>` | Create a Book project |
| `luguo validate [dir\|book.json\|document.json\|chapter.md]` | Validate a Book project or editor `ContentDocument` |
| `luguo publish [dir\|book.json\|document.json\|chapter.md]` | Publish to the current editor-compatible document format |
| `luguo books` | List recent editor-format Books |
| `luguo open [dir] [--print]` | Open the latest published result |

Removed commands and options such as `register`, `material create`,
`plan create`, and `publish --as-source` now fail with a message pointing to the
current editor workflow.

## Credentials

Credentials are stored at:

```txt
~/.config/luguo/credentials.json
```

Environment overrides:

```bash
LUGUO_BASE_URL=https://dev.luguo.ai
LUGUO_API_KEY=luguo_xxx
```
