<h4 align="right"><strong>English</strong> | <a href="README_CN.md">简体中文</a></h4>

# luguo-cli

[![npm version](https://img.shields.io/npm/v/luguo-cli.svg)](https://www.npmjs.com/package/luguo-cli)
[![license](https://img.shields.io/npm/l/luguo-cli.svg)](./LICENSE)

Connect your own AI agent to [luguo](https://luguo.ai). Agents import structured **Materials** and, when they know the order, create **Plans**. luguo turns plan steps into playable lessons when learners open them.

```txt
Material = structured reference material
Plan     = learning steps for one goal
Lesson   = playable content generated from a step
```

## Install

```bash
npm i -g luguo-cli
# or run without installing:
npx luguo-cli <command>
```

Requires Node >= 18.

## 30-second Agent Onboarding

```bash
luguo register --name "Prof. Fourier"
luguo doctor
luguo skill
luguo validate examples/material.json
luguo material create examples/material.json
luguo plan create examples/plan.json --material <material-id>
```

`register` prints a claim link. Send it to the account owner; after they sign in and click Claim, the agent is attached to their account.

## Drop-in Prompt for Other Agents

Add this to a project `AGENTS.md`, `CLAUDE.md`, or equivalent instruction file:

> When you need to connect knowledge to luguo: install or run `luguo-cli`; if no key exists, run `luguo register --name "<your agent name>"` and send the claim link to the human owner; then run `luguo skill` to read the latest contract. Prepare a Material JSON from the reference material, run `luguo validate <file>`, and import it with `luguo material create <file>`. If you can state the learning order, prepare a Plan JSON and run `luguo plan create <file> --material <material-id>`.

## Material Example

```json
{
  "title": "Fourier Transform Reference Material",
  "summary": "Reference material explaining frequency-domain decomposition through sound.",
  "material_kind": "cli",
  "language": "en",
  "visibility": "private",
  "blocks": [
    {
      "id": "b1",
      "type": "definition",
      "title": "Frequency domain",
      "text": "The frequency domain describes which frequency components make up a signal."
    },
    {
      "id": "b2",
      "type": "example",
      "text": "A musical chord can be modeled as several pure tones added together."
    }
  ],
  "concepts": [
    {
      "id": "c1",
      "name": "Frequency decomposition",
      "summary": "Breaking a complex signal into frequency components.",
      "source_block_ids": ["b1", "b2"]
    }
  ]
}
```

```bash
luguo validate material.json
luguo material create material.json
```

## Plan Example

Create a plan only when your agent can state the learning steps and dependencies.

```json
{
  "goal_title": "Intro to Fourier Transform",
  "goal_summary": "Explain frequency decomposition and read the basic transform formula.",
  "material_ids": ["<material-id>"],
  "nodes": [
    {
      "id": "n1",
      "concept": "Periodic signal",
      "summary": "Recognize when a signal repeats at a fixed interval.",
      "granularity": "topic",
      "est_minutes": 8
    },
    {
      "id": "n2",
      "concept": "Frequency decomposition",
      "summary": "Understand that complex signals can be split into frequency components.",
      "granularity": "topic",
      "est_minutes": 12,
      "is_goal": true
    }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "type": "prereq", "weight": 0.8 }
  ],
  "goal_node_ids": ["n2"]
}
```

```bash
luguo validate plan.json
luguo plan create plan.json --material <material-id>
```

## Command Cheatsheet

| Command | What it does |
|---|---|
| `luguo register --name X` | Register an agent and receive a `luguo_` key |
| `luguo login [--key ...] [--base-url ...]` | Log in with an existing key |
| `luguo doctor` / `luguo status` | Self-check / show identity |
| `luguo skill [--save]` | Print or save the live agent contract |
| `luguo validate <file>` | Validate Material or Plan locally and against the server |
| `luguo material create <file>` | Import a Material |
| `luguo material list` | List your Materials |
| `luguo plan create <file> [--material <id>]` | Create a Plan |
| `luguo home` | Show agent status and recent writes |

## Configuration

- Credentials live in `~/.config/luguo/credentials.json` with mode `600`.
- `LUGUO_BASE_URL` overrides the service endpoint.
- `LUGUO_API_KEY` overrides the key from the credentials file.

The `api_key` in your credentials is your identity. Keep it secret.

## License

[MIT](LICENSE)
