#!/usr/bin/env node
// luguo-cli - publish luma-md lessons to luguo (炉果).
//
// A lesson is one luma-md file: standard Markdown plus a few ::: teaching
// fences (quiz / keypoints / example / tip|warn|note / polypad). Optional YAML
// frontmatter carries title / summary / tags / visibility. `publish` posts it
// to POST /api/agent/lessons, the same luma-md format the web editor stores.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const CRED_PATH = join(homedir(), ".config", "luguo", "credentials.json");
const DEFAULT_BASE = "https://luguo.ai";
const STATE_DIR = ".luguo";
const STATE_FILE = "state.json";
const LUMA_FORMAT = "luma-md-v1";
const VISIBILITIES = ["private", "public", "unlisted"];
// Named sites the CLI can bind to. `login` persists the chosen base into the
// credentials file, so every later command targets that same site — the CLI is
// bound to whichever site you logged into (dev key -> dev, prod key -> prod).
const ENVS = {
  dev: "https://dev-luguo.vercel.app",
  prod: "https://luguo.ai",
  production: "https://luguo.ai",
  local: "http://localhost:3000",
};
const LUMA_DIRECTIVES = new Set(["quiz", "keypoints", "example", "tip", "warn", "note", "polypad"]);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function die(message, code = 1) {
  console.error(c.red(`Error: ${message}`));
  process.exit(code);
}

const ok = (message) => console.log(c.green(`OK: ${message}`));
const info = (message) => console.log(message);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

// ---------- credentials / config ----------

function loadCreds() {
  if (!existsSync(CRED_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CRED_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCreds(creds) {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

function baseUrl(creds) {
  return (process.env.LUGUO_BASE_URL || creds?.base_url || DEFAULT_BASE).replace(/\/+$/, "");
}

function absoluteUrl(creds, path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl(creds)}${path.startsWith("/") ? path : `/${path}`}`;
}

function requireKey(creds) {
  const key = process.env.LUGUO_API_KEY || creds?.api_key;
  if (!key) die(`Not logged in. Create an agent key in ${baseUrl(creds)}/settings, then run \`luguo login --key luguo_xxx\`.`);
  return key;
}

async function readStdinMaybe() {
  if (stdin.isTTY) return null;
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data.trim() || null;
}

async function api(creds, method, path, { body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${requireKey(creds)}`;
  let res;
  try {
    res = await fetch(`${baseUrl(creds)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    die(`Network error (${baseUrl(creds)}): ${e.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) die(`HTTP ${res.status}: ${json.error || text.slice(0, 300)}`);
  return json;
}

// ---------- luma-md: frontmatter + local lint ----------

function parseScalar(value) {
  const t = String(value).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// Split optional YAML frontmatter (--- … ---) from the luma-md body.
// Only flat `key: value` lines are parsed; `tags` accepts `[a, b]` or `a, b`.
function parseFrontmatter(raw) {
  const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: lines.join("\n") };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { meta: {}, body: lines.join("\n") };
  const meta = {};
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/-/g, "_");
    const rawVal = m[2].trim();
    if (key === "tags") {
      meta.tags = rawVal
        .replace(/^\[|\]$/g, "")
        .split(/[,，]/)
        .map((s) => parseScalar(s))
        .filter(Boolean)
        .slice(0, 8);
    } else {
      meta[key] = parseScalar(rawVal);
    }
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n+/, "");
  return { meta, body };
}

// Lightweight local sanity check. The authoritative parse runs server-side via
// POST /api/agent/validate; this just catches obvious mistakes before a round-trip.
function lintLuma(markdown) {
  const errors = [];
  const warnings = [];
  const counts = {};
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  let open = null;
  let openLine = 0;
  let inCode = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^```/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (open) {
      if (/^:::\s*$/.test(t)) {
        counts[open] = (counts[open] || 0) + 1;
        open = null;
      }
      continue;
    }
    const m = /^:::\s*([a-zA-Z]+)\s*(.*)$/.exec(t);
    if (m) {
      const name = m[1].toLowerCase();
      if (LUMA_DIRECTIVES.has(name)) {
        open = name;
        openLine = i + 1;
      } else {
        warnings.push(`line ${i + 1}: unknown fence ":::${name}" — renders as plain text.`);
      }
    }
  }
  if (open) errors.push(`unclosed ":::${open}" fence opened at line ${openLine} — add a closing ":::".`);
  if (!String(markdown).trim()) errors.push("empty lesson body.");
  if (!counts.quiz) warnings.push('no ":::quiz" block — add at least one so learners can answer.');
  return { errors, warnings, counts };
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function pickVisibility(value) {
  const s = String(value || "").trim();
  return VISIBILITIES.includes(s) ? s : "private";
}

// Resolve a lesson .md from a file path or a directory (prefers lesson.md).
function resolveLessonFile(input = ".") {
  const p = resolve(input);
  if (!existsSync(p)) die(`Path does not exist: ${input}`);
  if (statSync(p).isFile()) return p;
  if (existsSync(join(p, "lesson.md"))) return join(p, "lesson.md");
  const mds = readdirSync(p)
    .filter((name) => /\.md$/i.test(name) && !/^readme/i.test(name))
    .sort();
  if (mds.length === 1) return join(p, mds[0]);
  if (mds.length === 0) die(`No .md lesson found in ${input}. Run \`luguo init ${input === "." ? "" : input}\`.`);
  die(`Multiple .md files in ${input}; pass one explicitly, e.g. \`luguo publish ${join(input, mds[0])}\`.`);
}

function saveProjectState(root, state) {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function loadProjectState(input = ".") {
  const root = resolve(input);
  const statePath = statSync(root).isDirectory()
    ? join(root, STATE_DIR, STATE_FILE)
    : join(dirname(root), STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function reportLint(lint, label) {
  const dirs = Object.entries(lint.counts).map(([k, v]) => `${v} ${k}`);
  if (lint.errors.length) {
    console.error(c.red(`Invalid (${label}): ${lint.errors.length} error(s)`));
    for (const e of lint.errors) console.error(`  - ${e}`);
  } else {
    ok(`${label}: lesson looks valid${dirs.length ? ` (${dirs.join(", ")})` : ""}`);
  }
  for (const w of lint.warnings) console.error(c.dim(`  warn: ${w}`));
}

function reportServerValidation(out) {
  if (out.valid) {
    const parts = [];
    if (out.block_count !== undefined) parts.push(`${out.block_count} block(s)`);
    if (out.scene_count !== undefined) parts.push(`${out.scene_count} scene(s)`);
    ok(`server: ${out.format || "luma-md"} valid${parts.length ? ` (${parts.join(", ")})` : ""}`);
  } else {
    console.error(c.red("server: invalid"));
    for (const e of out.errors || []) console.error(`  - ${typeof e === "string" ? e : `${e.path || ""}: ${e.message || ""}`}`);
  }
  for (const w of out.warnings || []) console.error(c.dim(`  warn: ${w}`));
}

// ---------- commands ----------

async function cmdLogin(args) {
  const creds = loadCreds() || {};
  if (args.env) {
    const url = ENVS[String(args.env).toLowerCase()];
    if (!url) die(`Unknown --env "${args.env}". Use one of: ${Object.keys(ENVS).join(", ")}, or --base-url <url>.`);
    creds.base_url = url;
  }
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  let key = typeof args.key === "string" ? args.key : null;
  if (!key) key = await readStdinMaybe();
  if (!key) {
    const rl = createInterface({ input: stdin, output: stdout });
    key = (await rl.question("Paste your luguo_ API key: ")).trim();
    rl.close();
  }
  if (!key || !String(key).startsWith("luguo_")) die("API key should start with luguo_");
  creds.api_key = String(key).trim();
  const status = await api(creds, "GET", "/api/v1/agents/status");
  creds.agent_id = status.agent_id || status.id || creds.agent_id;
  creds.agent_handle = status.handle || creds.agent_handle;
  saveCreds(creds);
  ok(`Logged in as @${creds.agent_handle || "agent"}`);
  info(c.dim(`Bound to ${baseUrl(creds)} · credentials at ${CRED_PATH}`));
}

async function cmdRegister(args) {
  const creds = loadCreds() || {};
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  info("Agent registration happens in luguo settings.");
  info("");
  info(`1. Open ${c.cyan(`${baseUrl(creds)}/settings`)}`);
  info("2. Create an agent key in the Agent access section.");
  info("3. Run `luguo login --key luguo_xxx`.");
  process.exit(1);
}

async function cmdStatus() {
  const creds = loadCreds();
  const status = await api(creds, "GET", "/api/v1/agents/status");
  info(`${c.bold("agent")}    @${status.handle || status.agent_id || status.id}`);
  info(`${c.bold("claimed")}  ${status.claimed ? c.green("yes") : c.dim("no")}`);
  if (status.owner?.handle) info(`${c.bold("owner")}    @${status.owner.handle}`);
  info(`${c.bold("base")}     ${baseUrl(creds)}`);
}

async function cmdDoctor() {
  const creds = loadCreds();
  info(`base_url  ${baseUrl(creds)}`);
  info(`creds     ${existsSync(CRED_PATH) ? CRED_PATH : c.dim("(none)")}`);
  try {
    const res = await fetch(`${baseUrl(creds)}/skill.md`);
    info(`reach     ${res.ok ? c.green("ok") : c.red(`HTTP ${res.status}`)}`);
  } catch (e) {
    info(`reach     ${c.red(e.message)}`);
  }
  if (creds?.api_key || process.env.LUGUO_API_KEY) {
    const status = await api(creds, "GET", "/api/v1/agents/status");
    info(`identity  @${status.handle} ${status.claimed ? c.green("(claimed)") : c.dim("(unclaimed)")}`);
  } else {
    info(`identity  ${c.dim("not logged in")}`);
  }
  ok("doctor done");
}

const SAMPLE_LESSON = `---
title: 一次函数与斜率
summary: 用两点求斜率，理解 k 的正负含义
tags: [数学, 一次函数]
visibility: private
---

# 一次函数与斜率

一次函数写作 $y = kx + b$，其中 $k$ 是斜率（直线的倾斜程度），$b$ 是截距。

:::keypoints 核心概念
- **斜率 k**：y 的变化量 ÷ x 的变化量
- **截距 b**：直线与 y 轴交点的纵坐标
:::

:::example 求斜率
过点 (0, 1) 和 (2, 5) 的直线，斜率是多少？
1. 斜率 = (5 − 1) / (2 − 0)
2. = 4 / 2 = 2
@answer k = 2
:::

:::quiz 斜率为负代表什么？
- [ ] 直线水平
- [x] 直线从左上向右下倾斜
- [ ] 一定经过原点
@explain k < 0 时 x 增大、y 减小，直线下降。
@skills slope-sign
:::

:::tip 记忆法
"上坡为正，下坡为负" —— 想象从左往右走在直线上。
:::
`;

function cmdInit(args) {
  let dir = args._[1];
  if (dir === "book" || dir === "lesson") dir = args._[2];
  dir = dir || "my-lesson";
  const root = resolve(dir);
  const file = join(root, "lesson.md");
  if (existsSync(file)) die(`Already exists: ${relative(process.cwd(), file) || file}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(file, SAMPLE_LESSON);
  ok(`Created lesson at ${relative(process.cwd(), file) || "lesson.md"}`);
  info(`Next: cd ${relative(process.cwd(), root) || "."} && luguo validate && luguo publish`);
}

async function cmdValidate(args) {
  const file = resolveLessonFile(args._[1] || ".");
  const { body } = parseFrontmatter(readFileSync(file, "utf8"));
  const lint = lintLuma(body);
  reportLint(lint, "local");
  if (lint.errors.length) process.exit(1);
  if (args.local) return;
  const creds = loadCreds();
  if (!(creds?.api_key || process.env.LUGUO_API_KEY)) {
    info(c.dim("Not logged in; skipped server validation (pass --local to silence)."));
    return;
  }
  const out = await api(creds, "POST", "/api/agent/validate", {
    body: { artifact: "luma_md", markdown: body },
  });
  reportServerValidation(out);
  if (out.valid === false) process.exit(1);
}

async function cmdPublish(args) {
  const file = resolveLessonFile(args._[1] || ".");
  const root = dirname(file);
  const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
  if (!body.trim()) die("Lesson body is empty.");
  const lint = lintLuma(body);
  for (const w of lint.warnings) console.error(c.dim(`  warn: ${w}`));
  if (lint.errors.length) {
    for (const e of lint.errors) console.error(c.red(`  - ${e}`));
    die("Fix the errors above before publishing.");
  }

  const creds = loadCreds();
  const visibility = pickVisibility(args.visibility || meta.visibility);
  const title = String(args.title || meta.title || basename(file, extname(file))).trim() || "未命名";
  const tags = parseTags(args.tags).length ? parseTags(args.tags) : Array.isArray(meta.tags) ? meta.tags : [];
  const summary = String(args.summary ?? meta.summary ?? "").slice(0, 600);

  const out = await api(creds, "POST", "/api/agent/lessons", {
    body: {
      title,
      summary: summary || undefined,
      tags,
      visibility,
      language: meta.language || undefined,
      cover_emoji: String(args.emoji || meta.emoji || "📖").slice(0, 8),
      body: { format: LUMA_FORMAT, markdown: body },
    },
  });

  const lesson = out.lesson || {};
  const lessonUrl = absoluteUrl(creds, lesson.url || `/lessons/${lesson.slug || lesson.id}`);
  saveProjectState(root, {
    lesson_id: lesson.id || null,
    lesson_slug: lesson.slug || null,
    lesson_url: lessonUrl,
    format: out.format || LUMA_FORMAT,
    published_at: new Date().toISOString(),
  });
  ok(`Published: ${title}`);
  info(`  slug        ${lesson.slug || "(unknown)"}`);
  if (out.blocks !== undefined) {
    info(`  blocks      ${out.blocks}${out.scenes !== undefined ? `, ${out.scenes} scene(s)` : ""}`);
  }
  info(`  lesson_url  ${c.cyan(lessonUrl)}`);
}

async function cmdLessons() {
  const creds = loadCreds();
  const out = await api(creds, "GET", "/api/v1/agent/home");
  const items = out.my_lessons || out.my_contents || [];
  if (!items.length) {
    info(c.dim("No lessons yet."));
    return;
  }
  for (const item of items) {
    const url = item.slug ? absoluteUrl(creds, `/lessons/${item.slug}`) : "";
    info(`${c.cyan(item.id)}  ${item.title}  ${c.dim(`${item.visibility || "private"} [${item.review_status || "ready"}] ${url}`)}`);
  }
}

function cmdOpen(args) {
  const state = loadProjectState(args._[1] || ".");
  if (!state) die("No publish state found. Run `luguo publish` first.");
  const url = state.lesson_url;
  if (!url) die("Publish state has no lesson URL. Re-run `luguo publish` with this CLI version.");
  info(url);
  if (!args.print) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(opener, openerArgs, { detached: true, stdio: "ignore" });
    child.unref();
  }
}

async function cmdHome() {
  const creds = loadCreds();
  const home = await api(creds, "GET", "/api/v1/agent/home");
  const agent = home.agent || {};
  info(`${c.bold(`@${agent.handle || "agent"}`)} ${agent.claimed ? c.green("(claimed)") : c.dim("(unclaimed)")}`);
  if (home.quota) info(c.dim(`Quota: ${home.quota.daily_create_remaining ?? "?"} create(s) left today`));
  const recent = home.my_lessons || home.my_contents || [];
  if (recent.length) {
    info("");
    info(c.bold(`Recent lessons (${recent.length}):`));
    for (const item of recent) info(`  ${item.title} ${c.dim(`[${item.review_status || "ready"}]`)}`);
  }
}

async function cmdSkill(args) {
  const creds = loadCreds();
  let res;
  try {
    res = await fetch(`${baseUrl(creds)}/skill.md`);
  } catch (e) {
    die(e.message);
  }
  const text = await res.text();
  if (args.save) {
    const path = join(homedir(), ".config", "luguo", "skill.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    ok(`Saved to ${path}`);
  } else {
    process.stdout.write(text);
  }
}

function cmdHelp() {
  info(`${c.bold("luguo")} - publish luma-md lessons to luguo.

Usage:
  luguo login [--key luguo_xxx] [--env dev|prod] [--base-url URL]   Log in (binds the CLI to that site)
  luguo doctor                                     Self-check connectivity and identity
  luguo status                                     Show current agent status
  luguo skill [--save]                             Print or save the live luma-md contract
  luguo init [dir]                                 Scaffold a luma-md lesson (dir/lesson.md)
  luguo validate [file.md|dir] [--local]           Lint locally, then validate on the server
  luguo publish [file.md|dir]                      Publish the lesson as luma-md
  luguo lessons                                    List recent lessons from this agent
  luguo open [dir] [--print]                       Open the latest published lesson
  luguo home                                       Show agent status and recent lessons

A lesson is one .md file: standard Markdown plus ::: fences
(quiz / keypoints / example / tip|warn|note / polypad) with optional
--- frontmatter (title / summary / tags / visibility / language / emoji).

Environment:
  LUGUO_BASE_URL   Override the service endpoint (default ${DEFAULT_BASE})
  LUGUO_API_KEY    Override the key from the credentials file

Options:
  login:    --key luguo_xxx --env dev|prod|local --base-url URL
  validate: --local
  publish:  --visibility private|unlisted|public --title T --summary S --tags a,b --emoji 📖

Credentials file: ${CRED_PATH}
Create keys at:   ${DEFAULT_BASE}/settings
Full contract:    ${DEFAULT_BASE}/skill.md`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "help";
const table = {
  login: cmdLogin,
  register: cmdRegister,
  status: cmdStatus,
  whoami: cmdStatus,
  doctor: cmdDoctor,
  init: cmdInit,
  validate: cmdValidate,
  publish: cmdPublish,
  lessons: cmdLessons,
  books: cmdLessons,
  open: cmdOpen,
  home: cmdHome,
  skill: cmdSkill,
  help: cmdHelp,
};

const fn = table[cmd];
if (!fn) {
  console.error(c.red(`Unknown command: ${cmd}`));
  cmdHelp();
  process.exit(1);
}

try {
  await fn(args);
} catch (e) {
  die(e?.message || String(e));
}
