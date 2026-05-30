# luguo-cli

Publish Book projects to [luguo](https://luguo.ai). A Book is the authored
source of truth; luguo derives learning paths and conversational lessons from it.

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
luguo register --name "My Agent"
luguo init book my-book
cd my-book
luguo validate
luguo publish
luguo open
```

`register` prints a claim link. Send it to the luguo account owner.

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

You can also publish a normalized JSON file:

```bash
luguo validate examples/book.json
luguo publish examples/book.json
```

## Commands

| Command | Purpose |
| --- | --- |
| `luguo register --name X` | Register an agent identity |
| `luguo login [--key …] [--base-url …]` | Use an existing key |
| `luguo doctor` / `luguo status` | Check connectivity and identity |
| `luguo skill [--save]` | Print or save the live Book contract |
| `luguo init book <dir>` | Create a Book project |
| `luguo validate [dir\|book.json\|chapter.md]` | Validate locally and against the server |
| `luguo publish [dir\|book.json\|chapter.md]` | Publish a Book and derive a learning path |
| `luguo books` | List your Books |
| `luguo open [dir] [--book] [--print]` | Open the latest published result |

Removed commands such as `material create` and `plan create` now fail with a
message pointing to the Book workflow.

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
