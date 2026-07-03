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

function rejectRemovedOptions(args, optionNames) {
  for (const name of optionNames) {
    if (args[name] !== undefined) {
      die(`--${name} was removed. luguo-cli now publishes only the current editor ContentDocument format.`);
    }
  }
}

const VISIBILITIES = ["private", "public", "unlisted"];
const BOOK_KINDS = ["cli", "manual", "upload", "official", "generated"];
const BOOK_STATUSES = ["draft", "ready", "archived"];
const CONTENT_BLOCK_TYPES = [
  "text",
  "heading",
  "figure",
  "equation",
  "code",
  "exercise",
  "interactive",
  "container",
  "keypoints",
  "worked_example",
];

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

  return result(errors, warnings, {
    chapter_count: Array.isArray(book.chapters) ? book.chapters.length : 0,
    section_count: sectionCount,
    concept_count: Array.isArray(book.concepts) ? book.concepts.length : 0,
  });
}

function contentResult(errors, warnings, stats = {}) {
  return { artifact: "content", valid: errors.length === 0, errors, warnings, ...stats };
}

function isContentDocument(value) {
  return isPlainObject(value) && value.version === "1" && Array.isArray(value.blocks) && isPlainObject(value.meta);
}

function validateBlock(block, path, ids, errors) {
  if (!isPlainObject(block)) {
    errors.push({ path, message: "block must be an object" });
    return 0;
  }
  checkUnknown(errors, block, new Set(["id", "type", "source", "meta", "children"]), path);
  checkString(errors, `${path}.id`, block.id, "missing string id");
  if (typeof block.id === "string") {
    if (ids.has(block.id)) errors.push({ path: `${path}.id`, message: `duplicate id "${block.id}"` });
    ids.add(block.id);
  }
  if (!CONTENT_BLOCK_TYPES.includes(block.type)) {
    errors.push({ path: `${path}.type`, message: `must be one of ${CONTENT_BLOCK_TYPES.join("/")}` });
    return 1;
  }
  if (!isPlainObject(block.source)) {
    errors.push({ path: `${path}.source`, message: "source must be an object" });
    return 1;
  }
  switch (block.type) {
    case "text":
      checkUnknown(errors, block.source, new Set(["md"]), `${path}.source`);
      checkString(errors, `${path}.source.md`, block.source.md, "must be a string", { min: 0 });
      break;
    case "heading":
      checkUnknown(errors, block.source, new Set(["level", "md"]), `${path}.source`);
      if (!Number.isInteger(block.source.level) || block.source.level < 1 || block.source.level > 6) {
        errors.push({ path: `${path}.source.level`, message: "must be an integer from 1 to 6" });
      }
      checkString(errors, `${path}.source.md`, block.source.md, "must be a string", { min: 0 });
      break;
    case "figure":
      checkUnknown(errors, block.source, new Set(["url", "prompt", "alt", "caption"]), `${path}.source`);
      checkString(errors, `${path}.source.url`, block.source.url, "must be a URL string", { optional: true });
      checkString(errors, `${path}.source.prompt`, block.source.prompt, "must be a string", { optional: true });
      checkString(errors, `${path}.source.alt`, block.source.alt, "must be a string", { optional: true });
      checkString(errors, `${path}.source.caption`, block.source.caption, "must be a string", { optional: true });
      break;
    case "equation":
      checkUnknown(errors, block.source, new Set(["latex", "display"]), `${path}.source`);
      checkString(errors, `${path}.source.latex`, block.source.latex, "must be a string", { min: 0 });
      if (block.source.display !== undefined && typeof block.source.display !== "boolean") {
        errors.push({ path: `${path}.source.display`, message: "must be a boolean" });
      }
      break;
    case "code":
      checkUnknown(errors, block.source, new Set(["lang", "src", "runnable"]), `${path}.source`);
      checkString(errors, `${path}.source.lang`, block.source.lang, "must be a string", { min: 0 });
      checkString(errors, `${path}.source.src`, block.source.src, "must be a string", { min: 0 });
      if (block.source.runnable !== undefined && typeof block.source.runnable !== "boolean") {
        errors.push({ path: `${path}.source.runnable`, message: "must be a boolean" });
      }
      break;
    case "exercise":
      checkUnknown(errors, block.source, new Set(["q", "choices", "answer", "explain", "skills", "steps"]), `${path}.source`);
      checkString(errors, `${path}.source.q`, block.source.q, "must be a string", { min: 0 });
      checkString(errors, `${path}.source.answer`, block.source.answer, "must be a string", { min: 0 });
      checkString(errors, `${path}.source.explain`, block.source.explain, "must be a string", { optional: true, min: 0 });
      checkStringArray(errors, `${path}.source.choices`, block.source.choices);
      checkStringArray(errors, `${path}.source.skills`, block.source.skills);
      checkStringArray(errors, `${path}.source.steps`, block.source.steps);
      break;
    case "interactive":
      checkUnknown(errors, block.source, new Set(["kind", "spec"]), `${path}.source`);
      checkString(errors, `${path}.source.kind`, block.source.kind, "must be a non-empty string");
      if (!isPlainObject(block.source.spec)) errors.push({ path: `${path}.source.spec`, message: "must be an object" });
      break;
    case "container":
      checkUnknown(errors, block.source, new Set(["kind", "title", "tone"]), `${path}.source`);
      if (block.source.kind !== undefined && !["callout", "quote", "section", "group"].includes(block.source.kind)) {
        errors.push({ path: `${path}.source.kind`, message: "must be callout/quote/section/group" });
      }
      checkString(errors, `${path}.source.title`, block.source.title, "must be a string", { optional: true });
      break;
    case "keypoints":
      checkUnknown(errors, block.source, new Set(["title", "points"]), `${path}.source`);
      checkString(errors, `${path}.source.title`, block.source.title, "must be a string", { optional: true });
      if (!Array.isArray(block.source.points) || block.source.points.length === 0) {
        errors.push({ path: `${path}.source.points`, message: "must be a non-empty array" });
      } else {
        block.source.points.forEach((point, index) => {
          const p = `${path}.source.points[${index}]`;
          if (!isPlainObject(point)) {
            errors.push({ path: p, message: "point must be an object" });
            return;
          }
          checkUnknown(errors, point, new Set(["term", "md", "latex"]), p);
          checkString(errors, `${p}.term`, point.term, "must be a string", { min: 0 });
          checkString(errors, `${p}.md`, point.md, "must be a string", { optional: true, min: 0 });
          checkString(errors, `${p}.latex`, point.latex, "must be a string", { optional: true, min: 0 });
        });
      }
      break;
    case "worked_example":
      checkUnknown(errors, block.source, new Set(["title", "tag", "problem", "approach", "steps", "answer"]), `${path}.source`);
      checkString(errors, `${path}.source.title`, block.source.title, "must be a string", { optional: true });
      checkString(errors, `${path}.source.tag`, block.source.tag, "must be a string", { optional: true });
      checkString(errors, `${path}.source.problem`, block.source.problem, "must be a string", { min: 0 });
      checkString(errors, `${path}.source.approach`, block.source.approach, "must be a string", { optional: true, min: 0 });
      checkString(errors, `${path}.source.answer`, block.source.answer, "must be a string", { optional: true, min: 0 });
      if (block.source.steps !== undefined && !Array.isArray(block.source.steps)) {
        errors.push({ path: `${path}.source.steps`, message: "must be an array" });
      }
      break;
  }
  let count = 1;
  if (block.type === "container" && block.children !== undefined) {
    if (!Array.isArray(block.children)) {
      errors.push({ path: `${path}.children`, message: "must be an array" });
    } else {
      block.children.forEach((child, index) => {
        count += validateBlock(child, `${path}.children[${index}]`, ids, errors);
      });
    }
  }
  return count;
}

function validateContentDocument(doc) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(doc)) {
    errors.push({ path: "(root)", message: "document must be a JSON object" });
    return contentResult(errors, warnings, { block_count: 0 });
  }
  checkUnknown(errors, doc, new Set(["version", "blocks", "meta"]), "");
  if (doc.version !== "1") errors.push({ path: "version", message: 'must be "1"' });
  if (!isPlainObject(doc.meta)) {
    errors.push({ path: "meta", message: "must be an object" });
  } else {
    checkString(errors, "meta.title", doc.meta.title, "must be a non-empty string");
    checkString(errors, "meta.language", doc.meta.language, "must be a language string", { optional: true, min: 2, max: 16 });
  }
  const ids = new Set();
  let blockCount = 0;
  if (!Array.isArray(doc.blocks)) {
    errors.push({ path: "blocks", message: "must be an array" });
  } else {
    doc.blocks.forEach((block, index) => {
      blockCount += validateBlock(block, `blocks[${index}]`, ids, errors);
    });
  }
  return contentResult(errors, warnings, { block_count: blockCount });
}

function nextBlockIdFactory() {
  let n = 0;
  return () => `b${String(++n).padStart(4, "0")}`;
}

function stripLeadingHeading(markdown) {
  return String(markdown || "").replace(/^#{1,6}\s+.+(?:\r?\n|$)/, "").trim();
}

function blockToPlainText(block) {
  switch (block.type) {
    case "heading":
    case "text":
      return block.source.md || "";
    case "equation":
      return block.source.latex || "";
    case "code":
      return block.source.src || "";
    case "exercise":
      return [block.source.q, ...(block.source.choices || []), block.source.answer, block.source.explain].filter(Boolean).join(" ");
    case "keypoints":
      return [block.source.title, ...(block.source.points || []).map((p) => [p.term, p.md, p.latex].filter(Boolean).join(" "))].filter(Boolean).join(" ");
    case "worked_example":
      return [block.source.title, block.source.problem, block.source.approach, ...(block.source.steps || []).map((s) => [s.md, s.latex].filter(Boolean).join(" ")), block.source.answer].filter(Boolean).join(" ");
    case "container":
      return [block.source.title, ...(block.children || []).map(blockToPlainText)].filter(Boolean).join(" ");
    default:
      return "";
  }
}

function makeSceneTitle(blocks, fallback) {
  const heading = blocks.find((block) => block.type === "heading" && block.source.md?.trim());
  if (heading) return heading.source.md.trim().slice(0, 48);
  const text = blocks.map(blockToPlainText).find((part) => part.trim());
  return text?.trim().slice(0, 48) || fallback;
}

function buildLessonOverlay(blocks) {
  const scenes = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    scenes.push({
      id: `scene-${scenes.length + 1}`,
      title: makeSceneTitle(current, `第 ${scenes.length + 1} 节`),
      block_ids: current.map((block) => block.id),
    });
    current = [];
  };
  for (const block of blocks) {
    if (block.type === "heading" && block.source.level <= 2) flush();
    current.push(block);
    if (block.type === "exercise") flush();
  }
  flush();
  return scenes.length ? { scenes } : undefined;
}

function bookToContentDocument(book) {
  const id = nextBlockIdFactory();
  const blocks = [];
  for (const chapter of book.chapters || []) {
    blocks.push({ id: id(), type: "heading", source: { level: 2, md: chapter.title || "Chapter" } });
    if (chapter.summary?.trim()) blocks.push({ id: id(), type: "text", source: { md: chapter.summary.trim() } });
    for (const section of chapter.sections || []) {
      blocks.push({ id: id(), type: "heading", source: { level: 3, md: section.title || "Section" } });
      if (section.summary?.trim()) blocks.push({ id: id(), type: "text", source: { md: section.summary.trim() } });
      const body = stripLeadingHeading(section.markdown);
      if (body) blocks.push({ id: id(), type: "text", source: { md: body } });
    }
  }
  const overlay = buildLessonOverlay(blocks);
  return {
    version: "1",
    blocks,
    meta: {
      title: book.title,
      language: book.language || "zh",
      license: book.license,
      refs: Array.isArray(book.source_refs)
        ? book.source_refs
            .map((ref) => (isPlainObject(ref) && typeof ref.title === "string" ? { title: ref.title, url: typeof ref.url === "string" ? ref.url : undefined } : null))
            .filter(Boolean)
        : undefined,
      created_from: "luguo_cli",
      source_format: "book_project",
      ...(overlay ? { lesson_overlay: overlay } : {}),
    },
  };
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function contentTitle(document, fallback) {
  return document?.meta?.title?.trim?.() || fallback || "Untitled";
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
    if (extname(root).toLowerCase() === ".json") {
      const json = readJsonFile(root);
      if (isContentDocument(json)) {
        return {
          root: dirname(root),
          document: json,
          book: {
            title: contentTitle(json, basename(root, extname(root))),
            summary: json.meta.summary || "",
            book_kind: "cli",
            language: json.meta.language || "zh",
            visibility: "private",
            chapters: [{ id: "ch1", title: contentTitle(json, basename(root, extname(root))), sections: [{ id: "s1", title: contentTitle(json, basename(root, extname(root))), markdown: blockToPlainText({ type: "container", source: { title: "" }, children: json.blocks }), meta: {} }], meta: {} }],
            meta: { imported_content_document: true },
          },
        };
      }
      return { root: dirname(root), book: json };
    }
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

function printValidation(out, label = "") {
  const prefix = label ? `${label}: ` : "";
  const artifact = out.artifact || "book";
  if (out.valid) {
    const stats = [];
    if (out.block_count !== undefined) stats.push(`${out.block_count} block(s)`);
    if (out.chapter_count !== undefined) stats.push(`${out.chapter_count} chapter(s)`);
    if (out.section_count !== undefined) stats.push(`${out.section_count} section(s)`);
    if (out.concept_count !== undefined) stats.push(`${out.concept_count} concept(s)`);
    if (out.node_count !== undefined) stats.push(`${out.node_count} planned node(s)`);
    ok(`${prefix}${artifact} valid${stats.length ? ` (${stats.join(", ")})` : ""}`);
  } else {
    console.error(c.red(`Invalid: ${prefix}${artifact} (${out.errors.length} error(s))`));
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
  const creds = loadCreds() || {};
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  info("Agent registration now happens in luguo settings.");
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
  rejectRemovedOptions(args, ["as-source"]);
  const input = args._[1] || ".";
  const { book, document } = loadBookProject(input);
  if (document) {
    const local = validateContentDocument(document);
    printValidation(local, "local");
    if (!local.valid) process.exit(1);
    return;
  }
  if (args.visibility && VISIBILITIES.includes(String(args.visibility))) book.visibility = String(args.visibility);
  const local = validateBook(book);
  printValidation(local, "local");
  if (!local.valid) process.exit(1);
  const content = validateContentDocument(bookToContentDocument(book));
  printValidation(content, "content");
  if (!content.valid) process.exit(1);
}

async function cmdPublish(args) {
  rejectRemovedOptions(args, ["as-source", "no-plan", "skip-server-validate"]);
  const input = args._[1] || ".";
  const creds = loadCreds();
  const { root, book, document: loadedDocument } = loadBookProject(input);
  if (args.visibility) {
    if (!VISIBILITIES.includes(String(args.visibility))) die(`--visibility must be one of ${VISIBILITIES.join("/")}`);
    book.visibility = String(args.visibility);
  }
  const local = loadedDocument ? null : validateBook(book);
  if (local) {
    printValidation(local, "local");
    if (!local.valid) process.exit(1);
  }

  const document = loadedDocument || bookToContentDocument(book);
  if (args.title) document.meta.title = String(args.title);
  const content = validateContentDocument(document);
  printValidation(content, "content");
  if (!content.valid) process.exit(1);
  const title = String(args.title || contentTitle(document, book.title)).trim();
  const out = await api(creds, "POST", "/api/lessons/import", {
    body: {
      title,
      summary: String(args.summary ?? book.summary ?? "").slice(0, 600),
      tags: parseTags(args.tags),
      visibility: book.visibility || "private",
      cover_emoji: String(args.emoji || book.meta?.cover_emoji || "📖").slice(0, 8),
      document,
    },
  });
  const lesson = out.lesson || {};
  const lessonUrl = absoluteUrl(creds, lesson.url || `/lessons/${lesson.slug || lesson.id}`);
  saveProjectState(root, {
    lesson_id: lesson.id || null,
    lesson_slug: lesson.slug || null,
    lesson_url: lessonUrl,
    embed_url: lesson.embed_url ? absoluteUrl(creds, lesson.embed_url) : null,
    published_at: new Date().toISOString(),
    mode: "content",
  });
  ok(`Book published to the editor format: ${lesson.title || title}`);
  info(`  id          ${c.cyan(lesson.id || "(unknown)")}`);
  info(`  slug        ${lesson.slug || "(unknown)"}`);
  info(`  blocks      ${content.block_count}`);
  info(`  lesson_url  ${c.cyan(lessonUrl)}`);
}

async function cmdBooks() {
  const creds = loadCreds();
  const out = await api(creds, "GET", "/api/v1/agent/home");
  const books = out.my_contents || [];
  if (!books.length) {
    info(c.dim("No books yet."));
    return;
  }
  for (const book of books) {
    const url = book.slug ? absoluteUrl(creds, `/lessons/${book.slug}`) : "";
    info(`${c.cyan(book.id)}  ${book.title}  ${c.dim(`${book.visibility || "private"} [${book.review_status || "ready"}] ${url}`)}`);
  }
}

function cmdOpen(args) {
  rejectRemovedOptions(args, ["book", "path", "source"]);
  const state = loadProjectState(args._[1] || ".");
  if (!state) die("No publish state found. Run `luguo publish` first.");
  const url = state.lesson_url;
  if (!url) die("Publish state does not include a current editor URL. Run `luguo publish` with this CLI version.");
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
  info(`${c.bold("luguo")} - publish Books to luguo's current editor format.

Usage:
  luguo login [--key luguo_xxx] [--base-url URL]                Log in with an existing key
  luguo doctor                                                  Self-check connectivity and identity
  luguo status                                                  Show current agent status
  luguo skill [--save]                                          Print or save the live Book contract
  luguo init book <dir>                                         Create a Book project
  luguo validate [dir|book.json|document.json|chapter.md]       Validate the current editor document shape locally
  luguo publish [dir|book.json|document.json|chapter.md]        Publish as the /books/new editor ContentDocument
  luguo books                                                   List recent editor-format Books from this agent
  luguo open [dir] [--print]                                    Open the latest published editor result
  luguo home                                                    Show agent status and recent writes

Environment:
  LUGUO_BASE_URL   Override the service endpoint (default ${DEFAULT_BASE})
  LUGUO_API_KEY    Override the key from the credentials file

Options:
  login:    --key luguo_xxx --base-url URL
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
