#!/usr/bin/env node
// luguo-cli - publish luma-md lessons and books to luguo.
// luma-md is the only content format: plain Markdown plus ::: teaching fences.
// A single .md file publishes as one lesson (POST /api/agent/lessons);
// a directory of .md chapters publishes as one book (POST /api/books + chapters).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const CRED_PATH = join(homedir(), ".config", "luguo", "credentials.json");
const LAST_PUBLISH_PATH = join(homedir(), ".config", "luguo", "last-publish.json");
const DEFAULT_BASE = "https://luguo.ai";
const STATE_DIR = ".luguo";
const STATE_FILE = "state.json";
const STATE_VERSION = 2;
const VISIBILITIES = ["private", "public", "unlisted"];
const AUTHOR_MODES = { agent: "agent", owner: "owner" };
const BOOLEAN_FLAGS = new Set(["as-owner", "workspace", "edit", "print", "save"]);
const TRANSIENT_MAX_RETRIES = 3;
const TRANSIENT_RETRY_BASE_MS = 500;
const TRANSIENT_RETRY_MAX_MS = 30_000;
// Named sites the CLI can bind to. `login` persists the chosen base into the
// credentials file, so every later command targets that same site.
const ENVS = {
  dev: "https://dev.luguo.ai",
  prod: "https://luguo.ai",
  production: "https://luguo.ai",
  local: "http://localhost:3000",
};

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
      const raw = arg.slice(2);
      const equals = raw.indexOf("=");
      const key = equals === -1 ? raw : raw.slice(0, equals);
      if (BOOLEAN_FLAGS.has(key)) {
        // Boolean flags never consume the following positional argument, so
        // both `publish lesson.md --as-owner` and
        // `publish --as-owner lesson.md` work. An explicit `=value` is retained
        // for strictBooleanFlag to reject instead of being silently coerced.
        args[key] = equals === -1 ? true : raw.slice(equals + 1);
        continue;
      }
      if (equals !== -1) {
        args[key] = raw.slice(equals + 1);
        continue;
      }
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

function strictBooleanFlag(args, name) {
  if (args[name] === undefined) return false;
  if (args[name] !== true) die(`--${name} does not take a value.`);
  return true;
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stableIdempotencyKey(creds, method, path, body, authorMode = AUTHOR_MODES.agent) {
  // Namespace deterministic payload fingerprints by site and credential. This
  // prevents two agent identities publishing identical content from sharing an
  // idempotency key, while never sending or persisting the credential itself.
  const identityScope = createHash("sha256")
    .update(`${baseUrl(creds)}\n${requireKey(creds)}`)
    .digest("hex");
  const digest = createHash("sha256")
    // Keep the v0.1.6 byte sequence exactly unchanged for default agent-mode
    // retries. Owner-mode adds a domain separator so the two author intents can
    // never replay one another's result.
    .update(
      `${identityScope}\n${method.toUpperCase()}\n${path}\n${canonicalJson(body)}` +
      (authorMode === AUTHOR_MODES.owner ? "\nact-as-owner:v1" : ""),
    )
    .digest("hex");
  return `luguo-cli-v1-${digest}`;
}

function normalizeIssuePath(path) {
  if (Array.isArray(path)) return path.join(".");
  return path ? String(path) : "content";
}

function formatApiIssues(json) {
  const issues = Array.isArray(json?.issues)
    ? json.issues
    : Array.isArray(json?.admission?.issues)
      ? json.admission.issues
      : [];
  if (!issues.length) return "";
  return `\n${issues
    .map((issue) => {
      if (typeof issue === "string") return `  - ${issue}`;
      const code = issue?.code ? ` [${issue.code}]` : "";
      const path = normalizeIssuePath(issue?.path);
      return `  - ${path}${code}: ${issue?.message || "Admission gate rejected this content."}`;
    })
    .join("\n")}`;
}

function apiErrorMessage(status, json, raw) {
  const error = typeof json?.error === "string"
    ? json.error
    : json?.error?.message || json?.message || raw.slice(0, 300) || "Request failed";
  return `HTTP ${status}: ${error}${formatApiIssues(json)}`;
}

async function api(creds, method, path, {
  body,
  auth = true,
  authorMode = AUTHOR_MODES.agent,
  expectedStatus,
  idempotencyKey,
  retryTransient = false,
  returnMeta = false,
} = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${requireKey(creds)}`;
  if (authorMode === AUTHOR_MODES.owner) headers["X-Luguo-Act-As"] = "owner";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const requestBody = body === undefined ? undefined : JSON.stringify(body);
  let transientRetries = 0;
  while (true) {
    let res;
    try {
      res = await fetch(`${baseUrl(creds)}${path}`, { method, headers, body: requestBody });
    } catch (e) {
      if (retryTransient && transientRetries < TRANSIENT_MAX_RETRIES) {
        transientRetries += 1;
        const waitMs = transientRetryMs(null, transientRetries);
        info(
          `Transient network error from ${method} ${path}; retry ${transientRetries}/${TRANSIENT_MAX_RETRIES} ` +
          `in ${formatWait(waitMs)}.`,
        );
        await delay(waitMs);
        continue;
      }
      die(`Network error (${baseUrl(creds)}): ${e.message}`);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    const transientStatus = res.status === 429 || res.status >= 500;
    if (!res.ok && retryTransient && transientStatus && transientRetries < TRANSIENT_MAX_RETRIES) {
      transientRetries += 1;
      const waitMs = transientRetryMs(res.headers, transientRetries);
      info(
        `Transient HTTP ${res.status} from ${method} ${path}; retry ${transientRetries}/${TRANSIENT_MAX_RETRIES} ` +
        `in ${formatWait(waitMs)}.`,
      );
      await delay(waitMs);
      continue;
    }
    if (!res.ok) die(apiErrorMessage(res.status, json, text));
    if (expectedStatus !== undefined && res.status !== expectedStatus) {
      die(`Expected HTTP ${expectedStatus} from ${method} ${path}, received HTTP ${res.status}. The content was not accepted as ready.`);
    }
    return returnMeta ? { json, status: res.status, headers: res.headers } : json;
  }
}

function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (raw === undefined || raw === null || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function transientRetryMs(headers, retryNumber) {
  const requested = retryAfterMs(headers);
  if (requested !== null) return Math.min(TRANSIENT_RETRY_MAX_MS, requested);
  return Math.min(
    TRANSIENT_RETRY_MAX_MS,
    TRANSIENT_RETRY_BASE_MS * (2 ** Math.max(0, retryNumber - 1)),
  );
}

function formatWait(ms) {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${Number((ms / 1_000).toFixed(1))}s`;
}

function admissionRetryMs(headers) {
  const seconds = Number(headers?.get?.("retry-after"));
  return Number.isFinite(seconds) ? Math.max(0, Math.min(10_000, seconds * 1_000)) : 2_000;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForAdmission(creds, initial, authorMode = AUTHOR_MODES.agent) {
  const admissionId = initial.json?.admission?.id;
  const statusPath = initial.json?.status_url || initial.headers.get("location");
  if (
    typeof admissionId !== "string" || !admissionId ||
    typeof statusPath !== "string" ||
    !/^\/api\/agent\/admissions\/[A-Za-z0-9-]+$/.test(statusPath)
  ) {
    die("HTTP 202 did not include a valid admission id and same-site status URL.");
  }
  const configured = Number(process.env.LUGUO_ADMISSION_TIMEOUT_MS || 300_000);
  const timeoutMs = Number.isFinite(configured)
    ? Math.max(1_000, Math.min(900_000, configured))
    : 300_000;
  const deadline = Date.now() + timeoutMs;
  let nextDelay = admissionRetryMs(initial.headers);
  info(`Admission ${admissionId} queued; waiting for the automatic gate…`);
  for (let attempt = 0; attempt < 300 && Date.now() < deadline; attempt += 1) {
    await delay(nextDelay);
    const polled = await api(creds, "GET", statusPath, {
      authorMode,
      retryTransient: true,
      returnMeta: true,
    });
    if (polled.status === 200) return polled.json;
    if (polled.status !== 202) {
      die(`Expected HTTP 200 or 202 from GET ${statusPath}, received HTTP ${polled.status}.`);
    }
    nextDelay = admissionRetryMs(polled.headers);
  }
  die(
    `Admission ${admissionId} is still running after ${Math.round(timeoutMs / 1_000)}s. ` +
    "The server will continue automatically; rerun the same publish command to resume safely.",
  );
}

async function waitForBookPublication(creds, initial, bookId, authorMode = AUTHOR_MODES.agent) {
  const runId = initial.json?.publication?.id;
  const statusPath = initial.json?.status_url || initial.headers.get("location");
  const expectedPath = new RegExp(
    `^/api/books/${String(bookId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/publications/[A-Za-z0-9-]+$`,
  );
  if (
    typeof runId !== "string" || !runId ||
    typeof statusPath !== "string" || !expectedPath.test(statusPath)
  ) {
    die("HTTP 202 did not include a valid publication run and same-book status URL.");
  }
  const configured = Number(
    process.env.LUGUO_PUBLICATION_TIMEOUT_MS || process.env.LUGUO_ADMISSION_TIMEOUT_MS || 300_000,
  );
  const timeoutMs = Number.isFinite(configured)
    ? Math.max(1_000, Math.min(900_000, configured))
    : 300_000;
  const deadline = Date.now() + timeoutMs;
  let nextDelay = admissionRetryMs(initial.headers);
  info(`Publication ${runId} queued; waiting for the atomic book commit…`);
  for (let attempt = 0; attempt < 300 && Date.now() < deadline; attempt += 1) {
    await delay(nextDelay);
    const polled = await api(creds, "GET", statusPath, {
      authorMode,
      retryTransient: true,
      returnMeta: true,
    });
    if (polled.status === 200) {
      if (polled.json?.publication?.status !== "committed" || !polled.json?.book?.id) {
        die(`Book publication ${runId} returned HTTP 200 without a committed receipt.`);
      }
      return polled.json;
    }
    if (polled.status !== 202) {
      die(`Expected HTTP 200 or 202 from GET ${statusPath}, received HTTP ${polled.status}.`);
    }
    nextDelay = admissionRetryMs(polled.headers);
  }
  die(
    `Book publication ${runId} is still running after ${Math.round(timeoutMs / 1_000)}s. ` +
    "The server will continue automatically; rerun the same publish command to resume safely.",
  );
}

async function publishApi(creds, method, path, body, {
  expectedStatus,
  awaitAdmission = false,
  awaitBookPublication = null,
  authorMode = AUTHOR_MODES.agent,
} = {}) {
  const request = {
    body,
    authorMode,
    idempotencyKey: stableIdempotencyKey(creds, method, path, body, authorMode),
    retryTransient: true,
  };
  if (!awaitAdmission && !awaitBookPublication) {
    return api(creds, method, path, { ...request, expectedStatus });
  }
  const response = await api(creds, method, path, { ...request, returnMeta: true });
  if (awaitAdmission) {
    if (response.status === 201) return response.json;
    if (response.status === 202) return waitForAdmission(creds, response, authorMode);
  } else {
    if (response.status === 200) {
      if (response.json?.publication?.status !== "committed" || !response.json?.book?.id) {
        die("Book publication returned HTTP 200 without a committed receipt.");
      }
      return response.json;
    }
    if (response.status === 202) {
      return waitForBookPublication(creds, response, awaitBookPublication, authorMode);
    }
  }
  const expected = awaitAdmission ? "HTTP 201 or 202" : "HTTP 200 or 202";
  die(
    `Expected ${expected} from ${method} ${path}, received HTTP ${response.status}. ` +
    "The content was not accepted into the admission pipeline.",
  );
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

function readJsonFile(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    die(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function normalizeProjectState(existing) {
  if (existing?.version === STATE_VERSION) {
    return {
      ...existing,
      version: STATE_VERSION,
      lessons: existing.lessons && typeof existing.lessons === "object" && !Array.isArray(existing.lessons)
        ? existing.lessons
        : {},
    };
  }

  const migrated = { version: STATE_VERSION, last: null, lessons: {}, book: null };
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return migrated;
  if (existing.book_id) {
    migrated.book = existing;
    migrated.last = { kind: "book" };
  } else if (existing.lesson_id) {
    // v1 did not retain the source filename, so preserve it under a stable
    // legacy slot instead of guessing or discarding a successful receipt.
    migrated.lessons.__legacy__ = existing;
    migrated.last = { kind: "lesson", key: "__legacy__" };
  } else {
    migrated.legacy = existing;
  }
  return migrated;
}

function saveLastPublish(kind, receipt) {
  writeJsonAtomic(LAST_PUBLISH_PATH, { version: 1, kind, receipt });
}

function saveProjectReceipt(input, kind, receipt) {
  const target = resolve(input);
  const root = kind === "book" ? target : dirname(target);
  const statePath = join(root, STATE_DIR, STATE_FILE);
  const state = normalizeProjectState(readJsonFile(statePath, "project publish state"));
  if (kind === "book") {
    state.book = receipt;
    state.last = { kind: "book" };
  } else {
    const key = basename(target);
    state.lessons[key] = receipt;
    state.last = { kind: "lesson", key };
  }
  writeJsonAtomic(statePath, state);
  saveLastPublish(kind, receipt);
}

function selectProjectReceipt(state, target, isDirectory) {
  if (!state) return null;
  if (state.version !== STATE_VERSION) return state;
  if (!isDirectory) return state.lessons?.[basename(target)] ?? null;
  if (state.book) return state.book;
  if (state.last?.kind === "lesson" && state.last.key) return state.lessons?.[state.last.key] ?? null;
  return null;
}

function loadProjectState(input = ".") {
  const target = resolve(input);
  if (!existsSync(target)) return null;
  const isDirectory = statSync(target).isDirectory();
  const root = isDirectory ? target : dirname(target);
  const state = readJsonFile(join(root, STATE_DIR, STATE_FILE), "project publish state");
  return selectProjectReceipt(state, target, isDirectory);
}

function loadLastPublish() {
  const state = readJsonFile(LAST_PUBLISH_PATH, "last publish state");
  return state?.receipt && typeof state.receipt === "object" ? state.receipt : null;
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

const ADMISSION_INDEX_COUNTS = ["teaches", "prereqs", "atoms", "bindings", "prereqEdges"];

function requireReadyAdmission(out, label) {
  const admission = out?.admission;
  if (!admission || typeof admission !== "object" || Array.isArray(admission)) {
    die(`${label} returned HTTP 201 without an admission receipt.`);
  }
  const required = ["id", "content_version_id", "content_hash", "gate_version"];
  const missing = required.filter((key) => typeof admission[key] !== "string" || !admission[key]);
  if (missing.length) {
    die(`${label} returned an incomplete admission receipt (missing: ${missing.join(", ")}).`);
  }
  if (admission.status !== "ready") {
    die(`${label} admission is ${String(admission.status || "unknown")}, not ready.`);
  }
  if (!Number.isInteger(admission.repairs) || admission.repairs < 0) {
    die(`${label} admission receipt has an invalid repairs count.`);
  }
  const index = admission.index;
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    die(`${label} admission receipt is missing index counts.`);
  }
  const invalidCounts = ADMISSION_INDEX_COUNTS.filter(
    (key) => !Number.isInteger(index[key]) || index[key] < 0,
  );
  if (invalidCounts.length) {
    die(`${label} admission has invalid index count(s): ${invalidCounts.join(", ")}.`);
  }
  if (index.teaches < 1 || index.bindings < 1) {
    die(`${label} admission is not algorithm-ready (teaches=${index.teaches}, bindings=${index.bindings}).`);
  }
  return admission;
}

function printAdmission(admission) {
  const index = admission.index;
  info(`  gate    ${admission.gate_version} (${admission.status}, ${admission.repairs} repair(s))`);
  info(`  index   ${ADMISSION_INDEX_COUNTS.map((key) => `${key}×${index[key]}`).join(" ")}`);
  info(`  version ${c.cyan(admission.content_version_id)}`);
  info(`  hash    ${c.dim(admission.content_hash)}`);
}

function profileLabel(profile, fallback = "account") {
  if (profile?.handle) return `@${profile.handle}`;
  if (profile?.full_name) return String(profile.full_name);
  return fallback;
}

function printOwnerStatus(home, creds) {
  const agent = home.agent || {};
  if (!agent.claimed) {
    info(c.dim(`Owner publishing unavailable: claim this agent in ${baseUrl(creds)}/settings.`));
    return;
  }
  info(`Owner: ${profileLabel(agent.owner, "claimed account")}`);
  const ownerCapability = home.capabilities?.publish_as_owner;
  if (ownerCapability === true && agent.owner?.id) {
    info(c.dim("Owner publishing is available with --as-owner."));
  } else if (ownerCapability === false) {
    info(c.dim('Owner publishing is disabled for this key. Enable "Allow publishing as me" in Settings.'));
  } else {
    info(c.dim("Owner publishing is not supported by this server version yet."));
  }
}

async function resolveAuthorContext(creds, args) {
  if (!strictBooleanFlag(args, "as-owner")) return { mode: AUTHOR_MODES.agent };
  const home = await api(creds, "GET", "/api/v1/agent/home");
  const agent = home.agent || {};
  if (!agent.claimed) {
    die(`--as-owner requires a claimed agent. Claim @${agent.handle || "agent"} in ${baseUrl(creds)}/settings, then retry.`);
  }
  const ownerCapability = home.capabilities?.publish_as_owner;
  if (ownerCapability === false) {
    die(
      `Owner publishing is disabled for this key. In ${baseUrl(creds)}/settings, enable ` +
      '"Allow publishing as me", then retry. No content was written.',
    );
  }
  if (ownerCapability !== true) {
    die(`--as-owner is not supported by this server version (${baseUrl(creds)}). No content was written.`);
  }
  if (!agent.id || !agent.owner?.id) {
    die("The server did not return complete agent and owner identities for --as-owner. No content was written.");
  }
  return {
    mode: AUTHOR_MODES.owner,
    agent: { id: String(agent.id), handle: agent.handle ? String(agent.handle) : null },
    owner: {
      id: String(agent.owner.id),
      handle: agent.owner.handle ? String(agent.owner.handle) : null,
      full_name: agent.owner.full_name ? String(agent.owner.full_name) : null,
    },
  };
}

function requireAuthorship(out, context, label) {
  const receipt = out?.authorship;
  if (context.mode !== AUTHOR_MODES.owner) return receipt ?? null;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    die(`${label} did not return an authorship receipt. Refusing to report owner publishing as successful.`);
  }
  if (receipt.mode !== AUTHOR_MODES.owner) {
    die(`${label} reported authorship mode ${String(receipt.mode || "unknown")}, not owner.`);
  }
  if (receipt.agent?.id !== context.agent.id) {
    die(`${label} authorship receipt does not match the authenticated agent.`);
  }
  if (receipt.owner?.id !== context.owner.id) {
    die(`${label} authorship receipt does not match the claimed owner.`);
  }
  return receipt;
}

function printAuthorship(authorship, context) {
  if (context.mode !== AUTHOR_MODES.owner) return;
  info(`  author  ${profileLabel(authorship.owner, "owner")} ${c.dim(`(via ${profileLabel(authorship.agent, "agent")})`)}`);
}

// ---------------------------------------------------------------------------
// Commands

async function cmdLogin(args) {
  const key = args.key || process.env.LUGUO_API_KEY;
  if (!key) die("Usage: luguo login --key luguo_xxx [--env dev|prod|local] [--base-url URL]");
  const creds = { api_key: String(key) };
  if (args.env) {
    const url = ENVS[String(args.env).toLowerCase()];
    if (!url) die(`Unknown --env "${args.env}". Use one of: ${Object.keys(ENVS).join(", ")}, or --base-url <url>.`);
    creds.base_url = url;
  }
  if (args["base-url"]) creds.base_url = String(args["base-url"]).replace(/\/+$/, "");
  const home = await api(creds, "GET", "/api/v1/agent/home");
  saveCreds(creds);
  ok(`Logged in as @${home.agent?.handle || "agent"} (${baseUrl(creds)})`);
  printOwnerStatus(home, creds);
}

async function cmdStatus() {
  const creds = loadCreds();
  if (!creds && !process.env.LUGUO_API_KEY) die("Not logged in. Run `luguo login --key luguo_xxx`.");
  const home = await api(creds, "GET", "/api/v1/agent/home");
  const agent = home.agent || {};
  info(`@${agent.handle || "agent"} ${agent.claimed ? c.green("(claimed)") : c.dim("(unclaimed)")}  ${c.dim(baseUrl(creds))}`);
  printOwnerStatus(home, creds);
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
  printOwnerStatus(home, creds);
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

:::quiz 检查题一?
- [x] 正确选项
- [ ] 错误选项
@id q-demo-1
@explain 为什么正确选项对。
@skills 概念 A
@steps 识别条件,应用概念 A,检查结论
:::

:::quiz 检查题二?
- [ ] 常见误解
- [x] 正确结论
@id q-demo-2
@explain 用另一个场景确认概念 A。
@skills 概念 A
@steps 提取信息,比较选项,验证答案
:::

:::quiz 检查题三?
- [x] 可以迁移到新场景的结论
- [ ] 只复述题面但不成立的结论
@id q-demo-3
@explain 把概念 A 迁移到新场景仍得到同一规则。
@skills 概念 A
@steps 识别新场景,迁移规则,反例检查
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

async function publishLessonFile(creds, path, args, context) {
  const lesson = loadLessonFile(path);
  const payload = {
    title: String(args.title || lesson.title),
    summary: args.summary !== undefined ? String(args.summary) : lesson.summary,
    tags: normTags(args.tags) ?? lesson.tags,
    visibility: VISIBILITIES.includes(args.visibility) ? args.visibility : lesson.visibility,
    language: lesson.language,
    cover_emoji: args.emoji ? String(args.emoji) : lesson.emoji,
    body: { format: "luma-md-v1", markdown: lesson.markdown },
  };
  const out = await publishApi(creds, "POST", "/api/agent/lessons", payload, {
    expectedStatus: 201,
    awaitAdmission: true,
    authorMode: context.mode,
  });
  const admission = requireReadyAdmission(out, `Lesson "${lesson.title}"`);
  const authorship = requireAuthorship(out, context, `Lesson "${lesson.title}"`);
  const lessonId = out.lesson?.id;
  if (typeof lessonId !== "string" || !lessonId) die(`Lesson "${lesson.title}" returned no lesson id.`);
  const readerUrl = absoluteUrl(
    creds,
    out.lesson?.url || (out.lesson?.slug ? `/lessons/${out.lesson.slug}` : `/lessons/${lessonId}`),
  );
  const workspaceUrl = context.mode === AUTHOR_MODES.owner
    ? absoluteUrl(creds, `/lessons/${lessonId}/edit`)
    : null;
  const receipt = {
    source: basename(path),
    lesson_id: lessonId,
    lesson_slug: out.lesson?.slug || null,
    url: readerUrl,
    reader_url: readerUrl,
    workspace_url: workspaceUrl,
    publish_as: context.mode,
    authorship,
    admission,
    published_at: new Date().toISOString(),
  };
  saveProjectReceipt(path, "lesson", receipt);
  ok(`Lesson published: ${lesson.title}`);
  printAuthorship(authorship, context);
  printAdmission(admission);
  if (Number.isInteger(out.blocks)) {
    info(`  blocks  ${out.blocks} (${Object.entries(out.block_counts || {}).map(([k, n]) => `${k}×${n}`).join(" ")})`);
  }
  if (Number.isInteger(out.scenes)) info(`  scenes  ${out.scenes}`);
  info(`  reader  ${c.cyan(readerUrl)}`);
  if (workspaceUrl) info(`  workspace ${c.cyan(workspaceUrl)}`);
}

async function publishBookDir(creds, root, args, context) {
  const book = loadBookDir(root);
  const visibility = VISIBILITIES.includes(args.visibility) ? args.visibility : book.visibility;
  info(`${c.bold(book.title)} — ${book.chapters.length} chapter(s)`);

  // Create the book container private first; flip visibility once at the end
  // so the publish cascade covers every chapter lesson in one go.
  const createPayload = {
    title: String(args.title || book.title),
    subtitle: book.subtitle,
    summary: String(args.summary ?? book.summary ?? ""),
    tags: normTags(args.tags) ?? book.tags,
    visibility: "private",
    cover_emoji: args.emoji ? String(args.emoji) : book.emoji,
    language: book.language,
  };
  const created = await publishApi(creds, "POST", "/api/books", createPayload, {
    authorMode: context.mode,
  });
  const bookId = created.book?.id;
  if (!bookId) die("Server did not return a book id.");
  const bookAuthorship = requireAuthorship(created, context, `Book "${book.title}"`);

  const published = [];
  let course = null;
  for (const chapter of book.chapters) {
    const chapterPath = `/api/books/${bookId}/chapters`;
    const chapterPayload = {
      title: chapter.title,
      summary: chapter.summary ?? "",
      markdown: chapter.markdown,
    };
    const out = await publishApi(creds, "POST", chapterPath, chapterPayload, {
      expectedStatus: 201,
      awaitAdmission: true,
      authorMode: context.mode,
    });
    const admission = requireReadyAdmission(out, `Chapter "${chapter.title}"`);
    const authorship = requireAuthorship(out, context, `Chapter "${chapter.title}"`);
    published.push({
      source: chapter.source,
      chapter_id: out.chapter?.id,
      lesson_id: out.lesson?.id,
      lesson_slug: out.lesson?.slug,
      authorship,
      admission,
    });
    if (out.course) course = out.course;
    info(`  ${c.green("+")} ${chapter.source} → ${chapter.title} ${c.dim(`(${admission.gate_version}, ready)`)}`);
  }

  let publication = null;
  let publicationAuthorship = null;
  if (visibility !== "private") {
    const publicationResult = await publishApi(
      creds,
      "PATCH",
      `/api/books/${bookId}`,
      { visibility },
      { awaitBookPublication: bookId, authorMode: context.mode },
    );
    publication = publicationResult.publication;
    publicationAuthorship = requireAuthorship(
      publicationResult,
      context,
      `Book publication "${book.title}"`,
    );
  }

  const workspaceUrl = context.mode === AUTHOR_MODES.owner
    ? absoluteUrl(creds, `/create/${bookId}`)
    : null;
  // 读者入口是书的主 course(/books/<course slug>),不是 book slug。
  const readerUrl = course
    ? absoluteUrl(creds, `/books/${course.slug || course.id}`)
    : absoluteUrl(creds, created.book?.url) || workspaceUrl;
  const receipt = {
    source: basename(resolve(root)),
    book_id: bookId,
    book_slug: created.book?.slug || null,
    url: readerUrl,
    reader_url: readerUrl,
    workspace_url: workspaceUrl,
    publish_as: context.mode,
    authorship: publicationAuthorship || bookAuthorship,
    chapters: published,
    publication,
    published_at: new Date().toISOString(),
  };
  saveProjectReceipt(root, "book", receipt);
  ok(`Book published: ${book.title} (${published.length} chapter(s), ${visibility})`);
  printAuthorship(receipt.authorship, context);
  info(`  reader     ${c.cyan(readerUrl)}`);
  if (workspaceUrl) info(`  workspace  ${c.cyan(workspaceUrl)}`);
}

async function cmdPublish(args) {
  const input = resolve(args._[1] || ".");
  if (!existsSync(input)) die(`Path does not exist: ${args._[1] || "."}`);
  const creds = loadCreds();
  const context = await resolveAuthorContext(creds, args);
  if (statSync(input).isDirectory()) return publishBookDir(creds, input, args, context);
  return publishLessonFile(creds, input, args, context);
}

async function cmdLessons(args) {
  const creds = loadCreds();
  const context = await resolveAuthorContext(creds, args);
  const out = await api(creds, "GET", "/api/v1/agent/home", { authorMode: context.mode });
  requireAuthorship(out, context, "Lesson list");
  const items = out.my_lessons || out.my_contents || [];
  if (context.mode === AUTHOR_MODES.owner) {
    info(c.dim(`Owner scope: ${profileLabel(context.owner, "claimed account")}`));
  }
  if (!items.length) {
    info(c.dim("No lessons yet."));
    return;
  }
  for (const item of items) {
    const url = item.slug ? absoluteUrl(creds, `/lessons/${item.slug}`) : "";
    info(`${c.cyan(item.id)}  ${item.title}  ${c.dim(`${item.visibility || "private"} ${url}`)}`);
  }
}

async function cmdBooks(args) {
  const creds = loadCreds();
  const context = await resolveAuthorContext(creds, args);
  const out = await api(creds, "GET", "/api/books", { authorMode: context.mode });
  requireAuthorship(out, context, "Book list");
  const books = out.books || [];
  if (context.mode === AUTHOR_MODES.owner) {
    info(c.dim(`Owner scope: ${profileLabel(context.owner, "claimed account")}`));
  }
  if (!books.length) {
    info(c.dim("No books yet."));
    return;
  }
  for (const book of books) {
    info(`${c.cyan(book.id)}  ${book.title}  ${c.dim(`${book.visibility || "private"} ${absoluteUrl(creds, book.url || `/create/${book.id}`)}`)}`);
  }
}

function cmdOpen(args) {
  const explicit = args._[1];
  if (explicit && !existsSync(resolve(explicit))) die(`Path does not exist: ${explicit}`);
  const state = explicit ? loadProjectState(explicit) : loadLastPublish() || loadProjectState(".");
  if (!state) die("No publish state found. Run `luguo publish` first.");
  const workspace = strictBooleanFlag(args, "workspace");
  const edit = strictBooleanFlag(args, "edit");
  const print = strictBooleanFlag(args, "print");
  const wantWorkspace = workspace || edit;
  const target = wantWorkspace ? state.workspace_url : state.reader_url || state.url;
  if (!target && wantWorkspace) {
    die("This publish has no human workspace URL. Use --as-owner when publishing, then retry `luguo open --workspace`.");
  }
  if (!target) die("Publish state has no reader URL. Republish the content to refresh its state.");
  info(target);
  if (!print) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openerArgs = process.platform === "win32" ? ["/c", "start", "", target] : [target];
    const child = spawn(opener, openerArgs, { detached: true, stdio: "ignore" });
    child.unref();
  }
}

async function cmdHome() {
  const creds = loadCreds();
  const home = await api(creds, "GET", "/api/v1/agent/home");
  const agent = home.agent || {};
  info(`${c.bold(`@${agent.handle || "agent"}`)} ${agent.claimed ? c.green("(claimed)") : c.dim("(unclaimed)")}`);
  printOwnerStatus(home, creds);
  if (home.quota) info(c.dim(`Quota: ${home.quota.daily_create_remaining ?? "?"} create(s) left today`));
}

async function cmdSkill(args) {
  const creds = loadCreds();
  const save = strictBooleanFlag(args, "save");
  let res;
  try {
    res = await fetch(`${baseUrl(creds)}/skill.md`);
  } catch (e) {
    die(e.message);
  }
  const text = await res.text();
  if (save) {
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
  luguo login --key luguo_xxx [--env dev|prod|local] [--base-url URL]
                                                 save key + bind the CLI to a site
  luguo status | whoami                          show identity
  luguo doctor                                   check connectivity + key
  luguo skill [--save]                           fetch the luma-md guide (/skill.md)
  luguo init [lesson.md]                         create a lesson template
  luguo init book [dir]                          create a book project (luguo.yml + chapters)
  luguo validate <file.md | dir>                 preview server-side validation
  luguo publish <file.md | dir>                  automatic admission gate, then publish
      [--as-owner] [--title T] [--summary S] [--tags a,b]
      [--visibility private|unlisted|public] [--emoji E]
  luguo lessons [--as-owner]                     list agent / this-key owner lessons
  luguo books [--as-owner]                       list agent / this-key owner books
  luguo open [path] [--workspace|--edit] [--print]
                                                 open the last reader/editor URL
  luguo home                                     agent dashboard + quota

A lesson is one .md file: YAML frontmatter (title/summary/tags/visibility/
language/emoji) + a luma-md body. A book is a directory: optional luguo.yml
(same fields + chapters list) + one .md per chapter, sorted by filename.
Every publish is cleaned, structurally checked, semantically aligned, and
indexed by the server. HTTP 202 is followed until the durable admission is ready;
success still requires a complete ready receipt. Stable Idempotency-Key headers
make unchanged retries safe from duplicates.
By default, content belongs to the agent profile. A claimed agent can add
--as-owner to publish into its owner's Studio; the server confirms an authorship
receipt before the CLI records success. The same flag selects owner scope for
lessons and books.
Claiming alone is not permission: the owner must enable "Allow publishing as me"
for this key in Settings. Owner lists and book continuation are limited to work
created through this same key; the key cannot edit, archive, or delete the
owner's other content.
Publish writes and durable status polls retry transient network/429/5xx failures
up to three times with the same idempotency key; other 4xx responses fail once.
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
