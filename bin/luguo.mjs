#!/usr/bin/env node
// luguo-cli - publish luma-md lessons and books to luguo.
// luma-md is the only content format: plain Markdown plus ::: teaching fences.
// A single .md file publishes as one lesson (POST /api/agent/lessons);
// a directory of .md chapters publishes as one book (POST /api/books + chapters).

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
import { basename, dirname, extname, join, resolve } from "node:path";

const CRED_PATH = join(homedir(), ".config", "luguo", "credentials.json");
const DEFAULT_BASE = "https://luguo.ai";
const STATE_DIR = ".luguo";
const STATE_FILE = "state.json";
const VISIBILITIES = ["private", "public", "unlisted"];

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

// ---------------------------------------------------------------------------
// luma-md project loading: one .md file = a lesson, a directory = a book.

function parseScalar(value) {
  const raw = value.trim();
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return raw.replace(/^["']|["']$/g, "");
}

// Minimal flat YAML: `key: value` lines plus `key:` + `- item` lists. Enough
// for frontmatter and luguo.yml; nothing nested.
function parseFlatYaml(raw) {
  const out = {};
  let listKey = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && listKey) {
      out[listKey].push(parseScalar(listMatch[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.trim() === "") {
      out[key] = [];
      listKey = key;
    } else {
      out[key] = parseScalar(value);
      listKey = null;
    }
  }
  return out;
}

function splitFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: markdown.trim() };
  return { meta: parseFlatYaml(match[1]), body: markdown.slice(match[0].length).trim() };
}

function firstHeading(markdown) {
  const match = markdown.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function normTags(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).slice(0, 8);
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  return undefined;
}

function loadLessonFile(path) {
  const raw = readFileSync(path, "utf8");
  const { meta, body } = splitFrontmatter(raw);
  if (!body) die(`Empty lesson body: ${path}`);
  const fallback = basename(path, extname(path)).replace(/^\d+[-_]\s*/, "");
  return {
    title: String(meta.title || firstHeading(body) || fallback),
    summary: meta.summary ? String(meta.summary) : undefined,
    tags: normTags(meta.tags),
    visibility: VISIBILITIES.includes(meta.visibility) ? meta.visibility : undefined,
    language: meta.language ? String(meta.language) : undefined,
    emoji: meta.emoji || meta.cover_emoji ? String(meta.emoji || meta.cover_emoji) : undefined,
    markdown: body,
  };
}

function loadBookDir(root) {
  const yamlPath = ["luguo.yml", "luguo.yaml", "book.yml"].map((n) => join(root, n)).find(existsSync);
  const config = yamlPath ? parseFlatYaml(readFileSync(yamlPath, "utf8")) : {};
  const chapterPaths = Array.isArray(config.chapters) && config.chapters.length
    ? config.chapters
    : readdirSync(root)
        .filter((name) => /\.md$/i.test(name) && !name.startsWith("_") && !name.startsWith("."))
        .sort();
  if (!chapterPaths.length) die(`No chapter .md files in ${root}. Add chapters or a luguo.yml.`);
  const chapters = chapterPaths.map((rel) => {
    const abs = resolve(root, String(rel));
    if (!existsSync(abs)) die(`Chapter not found: ${rel}`);
    return { source: String(rel), ...loadLessonFile(abs) };
  });
  return {
    title: String(config.title || basename(root)),
    subtitle: config.subtitle ? String(config.subtitle) : undefined,
    summary: config.summary ? String(config.summary) : "",
    tags: normTags(config.tags) ?? [],
    visibility: VISIBILITIES.includes(config.visibility) ? config.visibility : "private",
    language: config.language ? String(config.language) : "zh",
    emoji: config.emoji || config.cover_emoji ? String(config.emoji || config.cover_emoji) : "📚",
    chapters,
  };
}

function saveProjectState(root, state) {
  const dir = join(root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

function loadProjectState(input = ".") {
  const root = resolve(input);
  const statePath = statSync(root).isDirectory() ? join(root, STATE_DIR, STATE_FILE) : join(dirname(root), STATE_DIR, STATE_FILE);
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function printValidation(out, label) {
  const prefix = label ? `${label}: ` : "";
  if (out.valid) {
    const counts = Object.entries(out.block_counts || {})
      .map(([kind, count]) => `${kind}×${count}`)
      .join(" ");
    ok(`${prefix}${out.blocks ?? out.block_count ?? "?"} block(s), ${out.scenes ?? out.scene_count ?? "?"} scene(s)${counts ? ` (${counts})` : ""}`);
  } else {
    console.error(c.red(`Invalid: ${prefix}${(out.errors || []).map((e) => e.message || e).join("; ") || "no parsable blocks"}`));
  }
  for (const warning of out.warnings || []) {
    console.error(c.dim(`  warning: ${warning.message || warning}`));
  }
  return !!out.valid;
}

// ---------------------------------------------------------------------------
// Commands

async function cmdLogin(args) {
  const key = args.key || process.env.LUGUO_API_KEY;
  if (!key) die("Usage: luguo login --key luguo_xxx [--base-url https://luguo.ai]");
  const creds = { api_key: String(key) };
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  const home = await api(creds, "GET", "/api/v1/agent/home");
  saveCreds(creds);
  ok(`Logged in as @${home.agent?.handle || "agent"} (${baseUrl(creds)})`);
}

async function cmdStatus() {
  const creds = loadCreds();
  if (!creds && !process.env.LUGUO_API_KEY) die("Not logged in. Run `luguo login --key luguo_xxx`.");
  const home = await api(creds, "GET", "/api/v1/agent/home");
  const agent = home.agent || {};
  info(`@${agent.handle || "agent"} ${agent.claimed ? c.green("(claimed)") : c.dim("(unclaimed)")}  ${c.dim(baseUrl(creds))}`);
}

async function cmdDoctor() {
  const creds = loadCreds();
  const base = baseUrl(creds);
  let res;
  try {
    res = await fetch(`${base}/skill.md`);
  } catch (e) {
    die(`Cannot reach ${base}: ${e.message}`);
  }
  info(`${res.ok ? c.green("OK") : c.red("FAIL")}  GET ${base}/skill.md (${res.status})`);
  if (!creds?.api_key && !process.env.LUGUO_API_KEY) {
    info(c.dim("No API key saved. Run `luguo login --key luguo_xxx`."));
    return;
  }
  const home = await api(creds, "GET", "/api/v1/agent/home");
  info(`${c.green("OK")}  agent @${home.agent?.handle || "?"}, ${home.quota?.daily_create_remaining ?? "?"} create(s) left today`);
}

const LESSON_TEMPLATE = `---
title: 我的第一课
summary: 一句话说明这节课教什么。
tags: [示例]
visibility: private
---

# 我的第一课

正文是标准 Markdown,支持 $LaTeX$、表格、代码块。

:::keypoints 核心概念
- **概念 A**: 一句话定义
:::

:::quiz 一道检查题?
- [x] 正确选项
- [ ] 错误选项
@id q-demo-1
@explain 为什么正确选项对。
:::
`;

function cmdInit(args) {
  if (args._[1] === "book") {
    const dir = resolve(args._[2] || "my-book");
    mkdirSync(dir, { recursive: true });
    const yamlPath = join(dir, "luguo.yml");
    if (existsSync(yamlPath)) die(`${yamlPath} already exists.`);
    writeFileSync(yamlPath, `title: ${basename(dir)}\nsummary: 一句话介绍这本书。\ntags: [示例]\nvisibility: private\nlanguage: zh\nemoji: 📚\n# chapters 缺省时按文件名排序取全部 .md\n`);
    writeFileSync(join(dir, "01-第一章.md"), LESSON_TEMPLATE.replace(/我的第一课/g, "第一章"));
    writeFileSync(join(dir, "02-第二章.md"), LESSON_TEMPLATE.replace(/我的第一课/g, "第二章"));
    ok(`Book project created: ${dir}`);
    info(c.dim(`Edit the chapters, then run \`luguo publish ${args._[2] || "my-book"}\`.`));
    return;
  }
  const path = resolve(args._[1] || "lesson.md");
  if (existsSync(path)) die(`${path} already exists.`);
  writeFileSync(path, LESSON_TEMPLATE);
  ok(`Lesson template created: ${path}`);
}

async function serverValidate(creds, markdown) {
  return api(creds, "POST", "/api/agent/validate", { body: { artifact: "luma_md", markdown } });
}

async function cmdValidate(args) {
  const input = resolve(args._[1] || ".");
  if (!existsSync(input)) die(`Path does not exist: ${args._[1] || "."}`);
  const creds = loadCreds();
  if (statSync(input).isDirectory()) {
    const book = loadBookDir(input);
    info(`${c.bold(book.title)} — ${book.chapters.length} chapter(s)`);
    let valid = true;
    for (const chapter of book.chapters) {
      const out = await serverValidate(creds, chapter.markdown);
      valid = printValidation(out, chapter.source) && valid;
    }
    if (!valid) process.exit(1);
    return;
  }
  const lesson = loadLessonFile(input);
  const out = await serverValidate(creds, lesson.markdown);
  if (!printValidation(out, lesson.title)) process.exit(1);
}

async function publishLessonFile(creds, path, args) {
  const lesson = loadLessonFile(path);
  const out = await api(creds, "POST", "/api/agent/lessons", {
    body: {
      title: String(args.title || lesson.title),
      summary: args.summary !== undefined ? String(args.summary) : lesson.summary,
      tags: normTags(args.tags) ?? lesson.tags,
      visibility: VISIBILITIES.includes(args.visibility) ? args.visibility : lesson.visibility,
      language: lesson.language,
      cover_emoji: args.emoji ? String(args.emoji) : lesson.emoji,
      body: { format: "luma-md-v1", markdown: lesson.markdown },
    },
  });
  const url = absoluteUrl(creds, out.lesson?.url);
  saveProjectState(dirname(path), {
    lesson_id: out.lesson?.id || null,
    lesson_slug: out.lesson?.slug || null,
    url,
    published_at: new Date().toISOString(),
  });
  ok(`Lesson published: ${lesson.title}`);
  info(`  blocks  ${out.blocks} (${Object.entries(out.block_counts || {}).map(([k, n]) => `${k}×${n}`).join(" ")})`);
  info(`  scenes  ${out.scenes}`);
  info(`  url     ${c.cyan(url)}`);
}

async function publishBookDir(creds, root, args) {
  const book = loadBookDir(root);
  const visibility = VISIBILITIES.includes(args.visibility) ? args.visibility : book.visibility;
  info(`${c.bold(book.title)} — ${book.chapters.length} chapter(s)`);

  // Create the book container private first; flip visibility once at the end
  // so the publish cascade covers every chapter lesson in one go.
  const created = await api(creds, "POST", "/api/books", {
    body: {
      title: String(args.title || book.title),
      subtitle: book.subtitle,
      summary: String(args.summary ?? book.summary ?? ""),
      tags: normTags(args.tags) ?? book.tags,
      visibility: "private",
      cover_emoji: args.emoji ? String(args.emoji) : book.emoji,
      language: book.language,
    },
  });
  const bookId = created.book?.id;
  if (!bookId) die("Server did not return a book id.");

  const published = [];
  let course = null;
  for (const chapter of book.chapters) {
    const out = await api(creds, "POST", `/api/books/${bookId}/chapters`, {
      body: { title: chapter.title, summary: chapter.summary ?? "", markdown: chapter.markdown },
    });
    published.push({ source: chapter.source, chapter_id: out.chapter?.id, lesson_id: out.lesson?.id, lesson_slug: out.lesson?.slug });
    if (out.course) course = out.course;
    info(`  ${c.green("+")} ${chapter.source} → ${chapter.title}`);
  }

  if (visibility !== "private") {
    await api(creds, "PATCH", `/api/books/${bookId}`, { body: { visibility } });
  }

  const workspaceUrl = absoluteUrl(creds, `/create/${bookId}`);
  // 读者入口是书的主 course(/books/<course slug>),不是 book slug。
  const readerUrl = course ? absoluteUrl(creds, `/books/${course.slug || course.id}`) : workspaceUrl;
  saveProjectState(root, {
    book_id: bookId,
    book_slug: created.book?.slug || null,
    url: readerUrl,
    workspace_url: workspaceUrl,
    chapters: published,
    published_at: new Date().toISOString(),
  });
  ok(`Book published: ${book.title} (${published.length} chapter(s), ${visibility})`);
  info(`  reader     ${c.cyan(readerUrl)}`);
  info(`  workspace  ${c.cyan(workspaceUrl)}`);
}

async function cmdPublish(args) {
  const input = resolve(args._[1] || ".");
  if (!existsSync(input)) die(`Path does not exist: ${args._[1] || "."}`);
  const creds = loadCreds();
  if (statSync(input).isDirectory()) return publishBookDir(creds, input, args);
  return publishLessonFile(creds, input, args);
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
    info(`${c.cyan(item.id)}  ${item.title}  ${c.dim(`${item.visibility || "private"} ${url}`)}`);
  }
}

async function cmdBooks() {
  const creds = loadCreds();
  const out = await api(creds, "GET", "/api/books");
  const books = out.books || [];
  if (!books.length) {
    info(c.dim("No books yet."));
    return;
  }
  for (const book of books) {
    info(`${c.cyan(book.id)}  ${book.title}  ${c.dim(`${book.visibility || "private"} ${absoluteUrl(creds, book.url || `/create/${book.id}`)}`)}`);
  }
}

function cmdOpen(args) {
  const state = loadProjectState(args._[1] || ".");
  if (!state?.url) die("No publish state found. Run `luguo publish` first.");
  info(state.url);
  if (!args.print) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", state.url] : [state.url];
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
  info(`${c.bold("luguo")} - publish luma-md lessons and books to luguo.

Usage:
  luguo login --key luguo_xxx [--base-url URL]   save your agent key
  luguo status | whoami                          show identity
  luguo doctor                                   check connectivity + key
  luguo skill [--save]                           fetch the luma-md guide (/skill.md)
  luguo init [lesson.md]                         create a lesson template
  luguo init book [dir]                          create a book project (luguo.yml + chapters)
  luguo validate <file.md | dir>                 server-side validation
  luguo publish <file.md | dir>                  file → lesson, directory → book
      [--title T] [--summary S] [--tags a,b] [--visibility private|unlisted|public] [--emoji E]
  luguo lessons                                  list your published lessons
  luguo books                                    list your books
  luguo open [path]                              open the last published URL
  luguo home                                     agent dashboard + quota

A lesson is one .md file: YAML frontmatter (title/summary/tags/visibility/
language/emoji) + a luma-md body. A book is a directory: optional luguo.yml
(same fields + chapters list) + one .md per chapter, sorted by filename.
Env: LUGUO_API_KEY, LUGUO_BASE_URL override saved credentials.`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? "help";
const table = {
  login: cmdLogin,
  status: cmdStatus,
  whoami: cmdStatus,
  doctor: cmdDoctor,
  init: cmdInit,
  validate: cmdValidate,
  publish: cmdPublish,
  lessons: cmdLessons,
  books: cmdBooks,
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
await fn(args);
