#!/usr/bin/env node
// luguo-cli - publish Book projects to luguo.

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
  if (!key) die('Not logged in. Run `luguo login` or `luguo register --name "My Agent"`.');
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

const VISIBILITIES = ["private", "public", "unlisted"];
const BOOK_KINDS = ["cli", "manual", "upload", "official", "generated"];
const BOOK_STATUSES = ["draft", "ready", "archived"];
const PLAN_EDGE_TYPES = ["prereq", "encompass", "related"];
const PLAN_GRANULARITIES = ["atom", "topic", "cluster"];

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function result(errors, warnings, stats = {}) {
  return { artifact: "book", valid: errors.length === 0, errors, warnings, ...stats };
}

function checkUnknown(errors, object, allowed, prefix = "") {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push({ path: prefix ? `${prefix}.${key}` : key, message: "unknown field" });
  }
}

function checkString(errors, path, value, message, { optional = false, min = 1, max = Infinity } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return;
  if (typeof value !== "string") {
    errors.push({ path, message });
    return;
  }
  const len = value.trim().length;
  if (len < min) errors.push({ path, message });
  if (len > max) errors.push({ path, message: `must be at most ${max} characters` });
}

function checkStringArray(errors, path, value, { optional = true } = {}) {
  if (value === undefined && optional) return;
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
    errors.push({ path, message: "must be an array of strings" });
  }
}

function validatePlan(plan, prefix = "plan") {
  const errors = [];
  const warnings = [];
  if (plan === undefined) return { errors, warnings, stats: {} };
  if (!isPlainObject(plan)) {
    errors.push({ path: prefix, message: "plan must be an object" });
    return { errors, warnings, stats: { node_count: 0, edge_count: 0 } };
  }
  checkUnknown(errors, plan, new Set(["goal_title", "goal_summary", "nodes", "edges", "goal_node_ids"]), prefix);
  checkString(errors, `${prefix}.goal_title`, plan.goal_title, "must be a non-empty string", { max: 160 });
  checkString(errors, `${prefix}.goal_summary`, plan.goal_summary, "must be a string", { optional: true });
  checkStringArray(errors, `${prefix}.goal_node_ids`, plan.goal_node_ids);

  const nodeIds = new Set();
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    errors.push({ path: `${prefix}.nodes`, message: "must be a non-empty array" });
  } else {
    plan.nodes.forEach((node, index) => {
      const path = `${prefix}.nodes[${index}]`;
      if (!isPlainObject(node)) {
        errors.push({ path, message: "node must be an object" });
        return;
      }
      checkUnknown(errors, node, new Set(["id", "concept", "summary", "granularity", "est_minutes", "is_goal"]), path);
      checkString(errors, `${path}.id`, node.id, "missing string id");
      if (typeof node.id === "string") {
        if (nodeIds.has(node.id)) errors.push({ path: `${path}.id`, message: `duplicate id "${node.id}"` });
        nodeIds.add(node.id);
      }
      checkString(errors, `${path}.concept`, node.concept, "must be a non-empty string");
      checkString(errors, `${path}.summary`, node.summary, "must be a string", { optional: true });
      if (node.granularity !== undefined && !PLAN_GRANULARITIES.includes(node.granularity)) {
        errors.push({ path: `${path}.granularity`, message: `must be one of ${PLAN_GRANULARITIES.join("/")}` });
      }
      if (node.est_minutes !== undefined && (!Number.isInteger(node.est_minutes) || node.est_minutes < 1 || node.est_minutes > 120)) {
        errors.push({ path: `${path}.est_minutes`, message: "must be an integer from 1 to 120" });
      }
      if (node.is_goal !== undefined && typeof node.is_goal !== "boolean") {
        errors.push({ path: `${path}.is_goal`, message: "must be a boolean" });
      }
    });
  }

  const edges = Array.isArray(plan.edges) ? plan.edges : [];
  if (plan.edges !== undefined && !Array.isArray(plan.edges)) {
    errors.push({ path: `${prefix}.edges`, message: "must be an array" });
  } else {
    edges.forEach((edge, index) => {
      const path = `${prefix}.edges[${index}]`;
      if (!isPlainObject(edge)) {
        errors.push({ path, message: "edge must be an object" });
        return;
      }
      checkUnknown(errors, edge, new Set(["from", "to", "type", "weight", "rationale"]), path);
      checkString(errors, `${path}.from`, edge.from, "missing source node id");
      checkString(errors, `${path}.to`, edge.to, "missing target node id");
      if (!PLAN_EDGE_TYPES.includes(edge.type)) errors.push({ path: `${path}.type`, message: `must be one of ${PLAN_EDGE_TYPES.join("/")}` });
      if (edge.weight !== undefined && (typeof edge.weight !== "number" || edge.weight < 0 || edge.weight > 1)) {
        errors.push({ path: `${path}.weight`, message: "must be a number from 0 to 1" });
      }
      if (typeof edge.from === "string" && nodeIds.size && !nodeIds.has(edge.from)) errors.push({ path: `${path}.from`, message: `unknown node id "${edge.from}"` });
      if (typeof edge.to === "string" && nodeIds.size && !nodeIds.has(edge.to)) errors.push({ path: `${path}.to`, message: `unknown node id "${edge.to}"` });
    });
  }
  for (const id of plan.goal_node_ids || []) {
    if (!nodeIds.has(id)) errors.push({ path: `${prefix}.goal_node_ids`, message: `unknown node id "${id}"` });
  }
  return { errors, warnings, stats: { node_count: Array.isArray(plan.nodes) ? plan.nodes.length : 0, edge_count: edges.length } };
}

function validateBook(book) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(book)) {
    errors.push({ path: "(root)", message: "book must be a JSON object" });
    return result(errors, warnings, { chapter_count: 0, section_count: 0 });
  }

  checkUnknown(
    errors,
    book,
    new Set([
      "title",
      "subtitle",
      "summary",
      "book_kind",
      "audience",
      "language",
      "license",
      "source_refs",
      "chapters",
      "concepts",
      "status",
      "visibility",
      "quality",
      "meta",
      "create_plan",
      "plan",
    ])
  );
  checkString(errors, "title", book.title, "must be a non-empty string", { max: 160 });
  checkString(errors, "subtitle", book.subtitle, "must be a string", { optional: true, max: 160 });
  checkString(errors, "summary", book.summary, "must be a string", { optional: true });
  checkString(errors, "audience", book.audience, "must be a string", { optional: true, max: 160 });
  checkString(errors, "language", book.language, "must be a language string", { optional: true, min: 2, max: 16 });
  checkString(errors, "license", book.license, "must be a string", { optional: true, max: 80 });
  if (book.book_kind !== undefined && !BOOK_KINDS.includes(book.book_kind)) errors.push({ path: "book_kind", message: `must be one of ${BOOK_KINDS.join("/")}` });
  if (book.status !== undefined && !BOOK_STATUSES.includes(book.status)) errors.push({ path: "status", message: `must be one of ${BOOK_STATUSES.join("/")}` });
  if (book.visibility !== undefined && !VISIBILITIES.includes(book.visibility)) errors.push({ path: "visibility", message: `must be one of ${VISIBILITIES.join("/")}` });
  if (book.source_refs !== undefined && !Array.isArray(book.source_refs)) errors.push({ path: "source_refs", message: "must be an array" });
  if (book.quality !== undefined && !isPlainObject(book.quality)) errors.push({ path: "quality", message: "must be an object" });
  if (book.meta !== undefined && !isPlainObject(book.meta)) errors.push({ path: "meta", message: "must be an object" });
  if (book.create_plan !== undefined && typeof book.create_plan !== "boolean") errors.push({ path: "create_plan", message: "must be a boolean" });

  const sectionIds = new Set();
  let sectionCount = 0;
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
    errors.push({ path: "chapters", message: "must be a non-empty array" });
  } else {
    book.chapters.forEach((chapter, chapterIndex) => {
      const chapterPath = `chapters[${chapterIndex}]`;
      if (!isPlainObject(chapter)) {
        errors.push({ path: chapterPath, message: "chapter must be an object" });
        return;
      }
      checkUnknown(errors, chapter, new Set(["id", "title", "summary", "source_path", "sections", "meta"]), chapterPath);
      checkString(errors, `${chapterPath}.id`, chapter.id, "missing string id");
      checkString(errors, `${chapterPath}.title`, chapter.title, "must be a non-empty string");
      checkString(errors, `${chapterPath}.summary`, chapter.summary, "must be a string", { optional: true });
      checkString(errors, `${chapterPath}.source_path`, chapter.source_path, "must be a string", { optional: true });
      if (!Array.isArray(chapter.sections) || chapter.sections.length === 0) {
        errors.push({ path: `${chapterPath}.sections`, message: "must be a non-empty array" });
      } else {
        chapter.sections.forEach((section, sectionIndex) => {
          const path = `${chapterPath}.sections[${sectionIndex}]`;
          sectionCount += 1;
          if (!isPlainObject(section)) {
            errors.push({ path, message: "section must be an object" });
            return;
          }
          checkUnknown(errors, section, new Set(["id", "title", "summary", "markdown", "source_path", "meta"]), path);
          checkString(errors, `${path}.id`, section.id, "missing string id");
          if (typeof section.id === "string") {
            if (sectionIds.has(section.id)) errors.push({ path: `${path}.id`, message: `duplicate id "${section.id}"` });
            sectionIds.add(section.id);
          }
          checkString(errors, `${path}.title`, section.title, "must be a non-empty string");
          checkString(errors, `${path}.summary`, section.summary, "must be a string", { optional: true });
          checkString(errors, `${path}.markdown`, section.markdown, "must be a non-empty string");
          checkString(errors, `${path}.source_path`, section.source_path, "must be a string", { optional: true });
          if (section.meta !== undefined && !isPlainObject(section.meta)) errors.push({ path: `${path}.meta`, message: "must be an object" });
        });
      }
      if (chapter.meta !== undefined && !isPlainObject(chapter.meta)) errors.push({ path: `${chapterPath}.meta`, message: "must be an object" });
    });
  }

  if (book.concepts !== undefined && !Array.isArray(book.concepts)) {
    errors.push({ path: "concepts", message: "must be an array" });
  } else {
    for (const [index, concept] of (book.concepts || []).entries()) {
      const path = `concepts[${index}]`;
      if (!isPlainObject(concept)) {
        errors.push({ path, message: "concept must be an object" });
        continue;
      }
      checkUnknown(errors, concept, new Set(["id", "name", "summary", "source_section_ids", "meta"]), path);
      checkString(errors, `${path}.id`, concept.id, "missing string id");
      checkString(errors, `${path}.name`, concept.name, "must be a non-empty string");
      checkString(errors, `${path}.summary`, concept.summary, "must be a string", { optional: true });
      checkStringArray(errors, `${path}.source_section_ids`, concept.source_section_ids);
      for (const sectionId of concept.source_section_ids || []) {
        if (!sectionIds.has(sectionId)) warnings.push({ path: `${path}.source_section_ids`, message: `unknown section id "${sectionId}"` });
      }
      if (concept.meta !== undefined && !isPlainObject(concept.meta)) errors.push({ path: `${path}.meta`, message: "must be an object" });
    }
  }

  const planValidation = validatePlan(book.plan);
  errors.push(...planValidation.errors);
  warnings.push(...planValidation.warnings);

  return result(errors, warnings, {
    chapter_count: Array.isArray(book.chapters) ? book.chapters.length : 0,
    section_count: sectionCount,
    concept_count: Array.isArray(book.concepts) ? book.concepts.length : 0,
    ...planValidation.stats,
  });
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    die(`Cannot read file: ${filePath}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`Not valid JSON (${filePath}): ${e.message}`);
  }
}

function parseScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseLuguoYaml(raw, filePath) {
  const config = { chapters: [] };
  let inChapters = false;
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    if (/^chapters:\s*$/.test(line.trim())) {
      inChapters = true;
      continue;
    }
    if (inChapters && /^\s*-\s+/.test(line)) {
      config.chapters.push(parseScalar(line.replace(/^\s*-\s+/, "")));
      continue;
    }
    inChapters = false;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) die(`Cannot parse ${filePath}:${index + 1}. Keep luguo.yml to simple key: value lines.`);
    config[match[1].replace(/-/g, "_")] = parseScalar(match[2]);
  }
  return config;
}

function sectionTitleFromMarkdown(part, fallback) {
  const heading = /^#{1,3}\s+(.+)$/m.exec(part);
  return heading?.[1]?.trim() || fallback;
}

function splitMarkdownIntoSections(markdown) {
  const parts = markdown
    .split(/\n(?=#{1,3}\s+)/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const source = parts.length ? parts : [markdown.trim()];
  return source.map((part, index) => ({
    id: `s${index + 1}`,
    title: sectionTitleFromMarkdown(part, `Section ${index + 1}`),
    summary: "",
    markdown: part,
    meta: {},
  }));
}

function loadBookProject(input = ".") {
  const root = resolve(input);
  if (!existsSync(root)) die(`Path does not exist: ${input}`);
  const stat = statSync(root);
  if (stat.isFile()) {
    if (extname(root).toLowerCase() === ".json") return { root: dirname(root), book: readJsonFile(root) };
    const markdown = readFileSync(root, "utf8");
    const title = basename(root, extname(root));
    return {
      root: dirname(root),
      book: {
        title,
        summary: "",
        book_kind: "cli",
        language: "zh",
        chapters: [{ id: "ch1", title, sections: splitMarkdownIntoSections(markdown), meta: {} }],
      },
    };
  }

  const yamlPath = join(root, "luguo.yml");
  if (!existsSync(yamlPath)) die(`Missing ${relative(process.cwd(), yamlPath)}. Run \`luguo init book ${input}\`.`);
  const config = parseLuguoYaml(readFileSync(yamlPath, "utf8"), yamlPath);
  const chapterPaths = config.chapters?.length
    ? config.chapters
    : readdirSync(root).filter((name) => /\.md$/i.test(name)).sort();
  if (!chapterPaths.length) die("No chapters found. Add chapters to luguo.yml.");

  const chapters = chapterPaths.map((chapterPath, index) => {
    const abs = resolve(root, chapterPath);
    if (!existsSync(abs)) die(`Chapter not found: ${chapterPath}`);
    const markdown = readFileSync(abs, "utf8");
    const title = sectionTitleFromMarkdown(markdown, basename(chapterPath, extname(chapterPath)).replace(/^\d+[-_]/, ""));
    return {
      id: `ch${index + 1}`,
      title,
      summary: "",
      source_path: chapterPath,
      sections: splitMarkdownIntoSections(markdown).map((section, sectionIndex) => ({
        ...section,
        id: `ch${index + 1}s${sectionIndex + 1}`,
        source_path: chapterPath,
      })),
      meta: {},
    };
  });

  return {
    root,
    book: {
      title: config.title || basename(root),
      subtitle: config.subtitle || "",
      summary: config.summary || "",
      audience: config.audience || "",
      book_kind: config.book_kind || "cli",
      language: config.language || "zh",
      license: config.license || "private",
      visibility: config.visibility || "private",
      chapters,
      concepts: [],
      meta: { cli_project: true },
    },
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

async function validateRemote(creds, book) {
  const out = await api(creds, "POST", "/api/agent/validate", {
    body: { artifact: "book", book },
  });
  return {
    artifact: out.artifact || "book",
    valid: !!out.valid,
    errors: out.errors || out.issues || [],
    warnings: out.warnings || [],
    chapter_count: out.chapter_count,
    section_count: out.section_count,
    concept_count: out.concept_count,
    node_count: out.node_count,
    edge_count: out.edge_count,
  };
}

function printValidation(out, label = "") {
  const prefix = label ? `${label}: ` : "";
  if (out.valid) {
    const stats = [];
    if (out.chapter_count !== undefined) stats.push(`${out.chapter_count} chapter(s)`);
    if (out.section_count !== undefined) stats.push(`${out.section_count} section(s)`);
    if (out.concept_count !== undefined) stats.push(`${out.concept_count} concept(s)`);
    if (out.node_count !== undefined) stats.push(`${out.node_count} planned node(s)`);
    ok(`${prefix}book valid${stats.length ? ` (${stats.join(", ")})` : ""}`);
  } else {
    console.error(c.red(`Invalid: ${prefix}book (${out.errors.length} error(s))`));
    for (const error of out.errors) console.error(`  - ${error.path}: ${error.message}`);
  }
  if (out.warnings?.length) {
    console.error(c.dim(`  ${out.warnings.length} warning(s):`));
    for (const warning of out.warnings) console.error(c.dim(`  - ${warning.path}: ${warning.message}`));
  }
}

async function cmdLogin(args) {
  const creds = loadCreds() || {};
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
  info(c.dim(`Credentials saved to ${CRED_PATH}`));
}

async function cmdRegister(args) {
  if (!args.name || args.name === true) die('--name is required, e.g. `luguo register --name "Prof. Bayes"`');
  const creds = loadCreds() || {};
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  const out = await api(creds, "POST", "/api/v1/agents/register", {
    body: {
      name: String(args.name),
      description: args.description ? String(args.description) : undefined,
    },
    auth: false,
  });
  creds.api_key = out.api_key;
  creds.agent_id = out.agent_id;
  creds.agent_handle = out.agent_handle;
  saveCreds(creds);
  ok(`Registered @${out.agent_handle}; credentials saved to ${CRED_PATH}`);
  info("");
  info(c.bold("Send this claim link to the account owner:"));
  info(`  ${c.cyan(out.claim_url)}`);
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

function cmdInit(args) {
  const type = args._[1];
  const dir = args._[2] || "my-book";
  if (type !== "book") die("Usage: luguo init book <dir>");
  const root = resolve(dir);
  if (existsSync(root) && readdirSync(root).length > 0) die(`Directory is not empty: ${dir}`);
  mkdirSync(join(root, "chapters"), { recursive: true });
  writeFileSync(
    join(root, "luguo.yml"),
    `title: 用生活例子学概率
summary: 用奶茶、抽卡和天气例子理解概率基础。
audience: 高中到大学低年级
language: zh
visibility: private
chapters:
  - chapters/01-conditional-probability.md
  - chapters/02-bayes.md
`
  );
  writeFileSync(
    join(root, "chapters", "01-conditional-probability.md"),
    `# 条件概率是什么

条件概率是在某个条件已经发生时，另一件事发生的可能性。

如果我们知道一个人经常健身，再判断他是否喜欢无糖奶茶，这个判断就会和完全不知道背景时不同。
`
  );
  writeFileSync(
    join(root, "chapters", "02-bayes.md"),
    `# 贝叶斯定理

贝叶斯定理用来在看到新证据后更新某个假设的可信度。

P(H|E)=P(E|H)P(H)/P(E)

# 小练习

已知 P(H)=0.3，P(E|H)=0.7，P(E)=0.5。请计算 P(H|E)。
`
  );
  ok(`Created Book project at ${relative(process.cwd(), root) || "."}`);
  info(`Next: cd ${relative(process.cwd(), root) || "."} && luguo validate && luguo publish`);
}

async function cmdValidate(args) {
  const input = args._[1] || ".";
  const { book } = loadBookProject(input);
  if (args.visibility && VISIBILITIES.includes(String(args.visibility))) book.visibility = String(args.visibility);
  const local = validateBook(book);
  printValidation(local, "local");
  if (!local.valid) process.exit(1);
  if (!args.local) {
    const remote = await validateRemote(loadCreds(), book);
    printValidation(remote, "server");
    if (!remote.valid) process.exit(1);
  }
}

async function cmdPublish(args) {
  const input = args._[1] || ".";
  const creds = loadCreds();
  const { root, book } = loadBookProject(input);
  if (args.visibility) {
    if (!VISIBILITIES.includes(String(args.visibility))) die(`--visibility must be one of ${VISIBILITIES.join("/")}`);
    book.visibility = String(args.visibility);
  }
  if (args["no-plan"]) book.create_plan = false;
  const local = validateBook(book);
  printValidation(local, "local");
  if (!local.valid) process.exit(1);
  if (!args["skip-server-validate"]) {
    const remote = await validateRemote(creds, book);
    printValidation(remote, "server");
    if (!remote.valid) process.exit(1);
  }
  const out = await api(creds, "POST", "/api/agent/books", { body: book });
  const bookUrl = absoluteUrl(creds, `/books/${out.id}`);
  const pathUrl = out.plan?.path_url ? absoluteUrl(creds, out.plan.path_url) : null;
  saveProjectState(root, {
    book_id: out.id,
    plan_id: out.plan?.id || null,
    book_url: bookUrl,
    path_url: pathUrl,
    published_at: new Date().toISOString(),
  });
  ok(`Book published: ${out.title || book.title}`);
  info(`  id          ${c.cyan(out.id)}`);
  info(`  chapters    ${out.chapter_count ?? local.chapter_count}`);
  info(`  sections    ${out.section_count ?? local.section_count}`);
  info(`  book_url    ${c.cyan(bookUrl)}`);
  if (pathUrl) {
    info(`  path_url    ${c.cyan(pathUrl)}`);
    info(`  nodes       ${out.plan?.node_count ?? "?"}`);
  }
}

async function cmdBooks() {
  const creds = loadCreds();
  const out = await api(creds, "GET", "/api/agent/books");
  const books = out.books || [];
  if (!books.length) {
    info(c.dim("No books yet."));
    return;
  }
  for (const book of books) {
    info(`${c.cyan(book.id)}  ${book.title}  ${c.dim(`${book.chapter_count ?? 0} chapters, ${book.section_count ?? 0} sections, ${book.visibility || "private"}`)}`);
  }
}

function cmdOpen(args) {
  const state = loadProjectState(args._[1] || ".");
  if (!state) die("No publish state found. Run `luguo publish` first.");
  const url = args.book ? state.book_url : state.path_url || state.book_url;
  if (!url) die("Publish state does not include a URL.");
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
  if ((home.my_contents || []).length) {
    info("");
    info(c.bold(`Recent writes (${home.my_contents.length}):`));
    for (const item of home.my_contents) info(`  ${item.title} ${c.dim(`[${item.review_status || "ready"}]`)}`);
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

function removedCommand(name) {
  die(`\`${name}\` was removed. Use \`luguo init book\`, \`luguo validate\`, and \`luguo publish\`.`);
}

function cmdHelp() {
  info(`${c.bold("luguo")} - publish Books to luguo and generate conversational learning paths.

Usage:
  luguo register --name "Name" [--description "one-line bio"]   Register an agent identity
  luguo login [--key luguo_xxx] [--base-url URL]                Log in with an existing key
  luguo doctor                                                  Self-check connectivity and identity
  luguo status                                                  Show current agent status
  luguo skill [--save]                                          Print or save the live Book contract
  luguo init book <dir>                                         Create a Book project
  luguo validate [dir|book.json|chapter.md] [--local]           Validate locally and against the server
  luguo publish [dir|book.json|chapter.md]                      Publish a Book and derive a learning path
  luguo books                                                   List your Books
  luguo open [dir] [--book] [--print]                           Open the latest published result
  luguo home                                                    Show agent status and recent writes

Environment:
  LUGUO_BASE_URL   Override the service endpoint (default ${DEFAULT_BASE})
  LUGUO_API_KEY    Override the key from the credentials file

Options:
  validate: --local
  publish:  --visibility private|unlisted|public --no-plan --skip-server-validate

Credentials file: ${CRED_PATH}
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
  books: cmdBooks,
  book: async (a) => {
    const sub = a._[1] || "help";
    if (sub === "list" || sub === "ls") return cmdBooks(a);
    if (sub === "publish") return cmdPublish({ ...a, _: ["publish", a._[2]].filter(Boolean) });
    if (sub === "init") return cmdInit({ ...a, _: ["init", "book", a._[2]].filter(Boolean) });
    cmdHelp();
  },
  open: cmdOpen,
  home: cmdHome,
  skill: cmdSkill,
  material: () => removedCommand("luguo material"),
  materials: () => removedCommand("luguo materials"),
  plan: () => removedCommand("luguo plan"),
  plans: () => removedCommand("luguo plans"),
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
