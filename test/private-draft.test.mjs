import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "luguo.mjs");
const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_BOOK_ID = "55555555-5555-4555-8555-555555555555";
const LESSON_ID = "22222222-2222-4222-8222-222222222222";
const CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const COOKIE_NAME = "sb-test-auth-token";
const COOKIE_VALUE = "base64-test-human-session-cookie";
const COOKIE_CHUNK_NAME = "sb-test-auth-token.1";
const COOKIE_CHUNK_VALUE = "base64-test-human-session-cookie-chunk-2";
const EMAIL = "human@example.com";

const LESSON_V1 = `---
title: Private draft lesson
summary: A safe local fixture.
tags: [test]
visibility: private
language: en
emoji: 🧪
---

# Private draft lesson

Version one.
`;

const LESSON_V2 = LESSON_V1.replace("Version one.", "Version two, saved through CAS.");
const LESSON_V3 = LESSON_V1.replace("Version one.", "Version three, which must conflict.");

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function runCli(args, { cwd, home, baseUrl, stdin = "", envOverrides = {} } = {}) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, HOME: home };
    for (const name of [
      "LUGUO_API_KEY",
      "LUGUO_CONTEXT",
      "LUGUO_DRAFT_CONTEXT",
      "LESSON_LLM_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
    ]) delete env[name];
    if (baseUrl === undefined) delete env.LUGUO_BASE_URL;
    else env.LUGUO_BASE_URL = baseUrl;
    Object.assign(env, envOverrides);
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd || REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({
      code: code ?? 1,
      stdout: stripAnsi(stdout),
      stderr: stripAnsi(stderr),
    }));
    child.stdin.end(stdin);
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function withMock(handler, run) {
  let handlerError = null;
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      handlerError ||= error;
      sendJson(res, 500, { error: "mock handler failed" }, { "retry-after": "0" });
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const value = await run(baseUrl);
    if (handlerError) throw handlerError;
    return value;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "luguo-cli-private-draft-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

async function writeHumanSession(home, baseUrl, cookieValue = COOKIE_VALUE) {
  const path = join(home, ".config", "luguo", "human-sessions.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    current: "local",
    contexts: {
      local: {
        base_url: baseUrl,
        cookies: { [COOKIE_NAME]: cookieValue },
      },
    },
  }, null, 2), { mode: 0o600 });
  return path;
}

async function readOnlyDraftState(home) {
  const dir = join(home, ".config", "luguo", "drafts");
  const names = await readdir(dir);
  assert.equal(names.length, 1);
  const path = join(dir, names[0]);
  return { path, value: JSON.parse(await readFile(path, "utf8")) };
}

function assertCookieOnlyAuth(req) {
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, `${COOKIE_NAME}=${COOKIE_VALUE}`);
}

function assertSafeRequestLog(requests) {
  for (const request of requests) {
    assert.doesNotMatch(request.url, /\/api\/agent\/|validate|publish|admission/i);
    assert.notEqual(`${request.method} ${request.url}`, `PATCH /api/lessons/${LESSON_ID}`);
  }
}

test("draft help and forbidden subcommands are local and fail closed", async () => {
  const { root, home } = await tempProject();
  let requests = 0;
  try {
    await withMock((_req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "must stay local" });
    }, async (baseUrl) => {
      const help = await runCli(["draft", "help"], { cwd: root, home, baseUrl });
      assert.equal(help.code, 0, help.stderr);
      assert.match(help.stdout, /private human-account drafts/i);
      assert.match(help.stdout, /byte-empty markdown/i);
      assert.match(help.stdout, /never calls agent, validate, admission, publish/i);

      for (const command of ["publish", "validate", "admission"]) {
        const out = await runCli(["draft", command], { cwd: root, home, baseUrl });
        assert.equal(out.code, 1);
        assert.match(out.stderr, /is forbidden/i);
      }
    });
    assert.equal(requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft login verifies a human cookie session without persisting or printing the password", async () => {
  const { root, home } = await tempProject();
  const password = "fixture-password-NotARealSecret";
  const requests = [];
  try {
    await withMock(async (req, res) => {
      requests.push({ method: req.method, url: req.url });
      assert.equal(req.headers.authorization, undefined);
      if (req.method === "POST" && req.url === "/api/auth/signin") {
        assert.equal(req.headers.cookie, undefined);
        assert.deepEqual(await readJsonBody(req), { email: EMAIL, password });
        sendJson(res, 200, { success: true, user: { id: USER_ID, email: EMAIL } }, {
          "set-cookie": [
            `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
            `${COOKIE_CHUNK_NAME}=${COOKIE_CHUNK_VALUE}; Path=/; Expires=Tue, 14 Jul 2026 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
          ],
        });
        return;
      }
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/api/auth/me");
      assert.match(req.headers.cookie, new RegExp(`${COOKIE_NAME}=${COOKIE_VALUE}`));
      assert.match(req.headers.cookie, new RegExp(`${COOKIE_CHUNK_NAME}=${COOKIE_CHUNK_VALUE}`));
      sendJson(res, 200, { authenticated: true, user: { id: USER_ID, email: EMAIL } });
    }, async (baseUrl) => {
      const out = await runCli(
        ["draft", "login", "--email", EMAIL, "--password-stdin", "--base-url", baseUrl],
        {
          cwd: root,
          home,
          baseUrl,
          stdin: `${password}\n`,
          envOverrides: { LUGUO_CLI_FORCE_SET_COOKIE_FALLBACK: "1" },
        },
      );
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Human draft session saved/);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(password));
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(COOKIE_VALUE));

      const sessionPath = join(home, ".config", "luguo", "human-sessions.json");
      const raw = await readFile(sessionPath, "utf8");
      assert.match(raw, new RegExp(COOKIE_VALUE));
      assert.match(raw, new RegExp(COOKIE_CHUNK_VALUE));
      assert.doesNotMatch(raw, new RegExp(password));
      assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      "POST /api/auth/signin",
      "GET /api/auth/me",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authentication failures never echo server-provided text, even for short secrets", async () => {
  const { root, home } = await tempProject();
  const password = "zz";
  const leakedCookie = "sb-leaked-auth-token=base64-should-never-print";
  try {
    await withMock(async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 401, { error: `server raw authentication error; password=${body.password}; cookie=${leakedCookie}` });
    }, async (baseUrl) => {
      const out = await runCli(
        ["draft", "login", "--email", EMAIL, "--password-stdin", "--base-url", baseUrl],
        { cwd: root, home, baseUrl, stdin: `${password}\n` },
      );
      assert.equal(out.code, 1);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(password));
      assert.doesNotMatch(out.stdout + out.stderr, /base64-should-never-print/);
      assert.doesNotMatch(out.stdout + out.stderr, /server raw authentication error/i);
      assert.match(out.stderr, /Human authentication failed \(HTTP 401\)/i);
      await assert.rejects(readFile(join(home, ".config", "luguo", "human-sessions.json"), "utf8"), /ENOENT/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new draft creation uses private book -> byte-empty chapter -> draft PATCH only", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      assertCookieOnlyAuth(req);
      const body = await readJsonBody(req);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "POST" && req.url === "/api/books") {
        assert.deepEqual(Object.keys(body).sort(), ["cover_emoji", "language", "summary", "tags", "title", "visibility"]);
        assert.equal(body.visibility, "private");
        assert.equal(body.body, undefined);
        assert.equal(body.markdown, undefined);
        assert.match(req.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
        sendJson(res, 201, { book: { id: BOOK_ID, title: body.title } });
        return;
      }
      if (req.method === "POST" && req.url === `/api/books/${BOOK_ID}/chapters`) {
        assert.deepEqual(body, { title: "Private draft lesson", summary: "A safe local fixture.", markdown: "" });
        assert.equal(req.headers["idempotency-key"], requests[0].headers["idempotency-key"]);
        sendJson(res, 201, {
          chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
          lesson: { id: LESSON_ID, status: "draft", url: "/lessons/private-draft/edit" },
        });
        return;
      }
      if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}`) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
        return;
      }
      if (req.method === "GET" && req.url === `/api/books/${BOOK_ID}`) {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
        return;
      }
      assert.equal(req.method, "PATCH");
      assert.equal(req.url, `/api/lessons/${LESSON_ID}/draft`);
      assert.deepEqual(Object.keys(body).sort(), ["client_mutation_id", "expected_revision", "markdown", "title"]);
      assert.equal(body.expected_revision, 0);
      assert.equal(body.client_mutation_id, requests[0].headers["idempotency-key"]);
      assert.equal(body.title, "Private draft lesson");
      assert.match(body.markdown, /Version one\./);
      sendJson(res, 200, {
        draft: { ...body, revision: 1, published_revision: 0 },
      });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "save", lessonPath, "--json"], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(out.code, 0, out.stderr);
      const receipt = JSON.parse(out.stdout);
      assert.equal(receipt.book_id, BOOK_ID);
      assert.equal(receipt.lesson_id, LESSON_ID);
      assert.equal(receipt.revision, 1);
      assert.equal(receipt.mutation_uuid, requests[0].headers["idempotency-key"]);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(COOKIE_VALUE));

      const state = await readOnlyDraftState(home);
      assert.deepEqual(Object.keys(state.value).sort(), [
        "book_id", "content_sha256", "lesson_id", "mutation_uuid", "revision", "version",
      ]);
      assert.equal(state.value.book_id, BOOK_ID);
      assert.equal(state.value.lesson_id, LESSON_ID);
      assert.equal(state.value.revision, 1);
      assert.match(state.value.content_sha256, /^[0-9a-f]{64}$/);
      const serialized = JSON.stringify(state.value);
      for (const forbidden of [COOKIE_VALUE, EMAIL, "Private draft lesson", "Version one", "password"]) {
        assert.doesNotMatch(serialized, new RegExp(forbidden, "i"));
      }
      assert.equal((await stat(state.path)).mode & 0o777, 0o600);
      await assert.rejects(stat(join(root, ".luguo")), /ENOENT/);
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      "POST /api/books",
      `POST /api/books/${BOOK_ID}/chapters`,
      `GET /api/lessons/${LESSON_ID}`,
      `GET /api/books/${BOOK_ID}`,
      `PATCH /api/lessons/${LESSON_ID}/draft`,
    ]);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private book and empty-chapter transient retries keep one exact mutation UUID", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  let bookAttempts = 0;
  let chapterAttempts = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      assertCookieOnlyAuth(req);
      const body = ["POST", "PATCH"].includes(req.method) ? await readJsonBody(req) : undefined;
      requests.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"], body });
      if (req.method === "POST" && req.url === "/api/books") {
        bookAttempts += 1;
        if (bookAttempts === 1) {
          sendJson(res, 500, { error: "retry book" }, { "retry-after": "0" });
        } else {
          sendJson(res, 201, { book: { id: BOOK_ID } });
        }
        return;
      }
      if (req.method === "POST" && req.url === `/api/books/${BOOK_ID}/chapters`) {
        chapterAttempts += 1;
        if (chapterAttempts === 1) {
          sendJson(res, 500, { error: "retry chapter" }, { "retry-after": "0" });
        } else {
          sendJson(res, 201, {
            chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
            lesson: { id: LESSON_ID, status: "draft" },
          });
        }
        return;
      }
      if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}`) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
        return;
      }
      if (req.method === "GET" && req.url === `/api/books/${BOOK_ID}`) {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
        return;
      }
      assert.equal(req.method, "PATCH");
      sendJson(res, 200, { draft: { ...body, revision: 1, published_revision: 0 } });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
    });
    const mutations = requests
      .filter(({ method }) => method === "POST" || method === "PATCH")
      .map(({ key, body }) => key || body.client_mutation_id);
    assert.equal(new Set(mutations).size, 1);
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.deepEqual(requests[2].body, requests[3].body);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty-chapter HTTP 409 fails closed before metadata reads or draft PATCH", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      const body = await readJsonBody(req);
      requests.push({ method: req.method, url: req.url, body });
      if (req.url === "/api/books") {
        sendJson(res, 201, { book: { id: BOOK_ID } });
      } else {
        sendJson(res, 409, { error: "chapter mutation collision" });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /empty-chapter creation conflict/i);
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      "POST /api/books",
      `POST /api/books/${BOOK_ID}/chapters`,
    ]);
    const state = (await readOnlyDraftState(home)).value;
    assert.equal(state.book_id, BOOK_ID);
    assert.equal(state.lesson_id, undefined);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private-book HTTP 409 fails closed before chapter creation", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  let requests = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock((req, res) => {
      requests += 1;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/books");
      sendJson(res, 409, { error: "book mutation collision" });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /book creation idempotency conflict/i);
    });
    assert.equal(requests, 1);
    const state = (await readOnlyDraftState(home)).value;
    assert.equal(state.book_id, undefined);
    assert.equal(state.lesson_id, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replayed chapter attached to another book is rejected before any draft PATCH", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === "GET" && req.url === `/api/books/${BOOK_ID}`) {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      } else if (req.method === "POST" && req.url === `/api/books/${BOOK_ID}/chapters`) {
        assert.equal((await readJsonBody(req)).markdown, "");
        sendJson(res, 201, {
          idempotent_replay: true,
          chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
          lesson: { id: LESSON_ID, status: "draft" },
        });
      } else if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}`) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: OTHER_BOOK_ID, visibility: "private" } });
      } else {
        sendJson(res, 500, { error: "unsafe extra request" }, { "retry-after": "0" });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "save", lessonPath, "--book", BOOK_ID], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /not attached to the expected private book/i);
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      `GET /api/books/${BOOK_ID}`,
      `POST /api/books/${BOOK_ID}/chapters`,
      `GET /api/lessons/${LESSON_ID}`,
    ]);
    assert.equal(requests.some(({ method }) => method === "PATCH"), false);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second CLI process resumes an acknowledged-but-unreceived chapter with the same mutation", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  let chapterAttempts = 0;
  let mutationUuid = null;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      requests.push({ method: req.method, url: req.url, key: req.headers["idempotency-key"] });
      if (req.method === "POST" && req.url === "/api/books") {
        mutationUuid = req.headers["idempotency-key"];
        sendJson(res, 201, { book: { id: BOOK_ID } });
        return;
      }
      if (req.method === "POST" && req.url === `/api/books/${BOOK_ID}/chapters`) {
        chapterAttempts += 1;
        assert.equal(req.headers["idempotency-key"], mutationUuid);
        assert.equal((await readJsonBody(req)).markdown, "");
        if (chapterAttempts <= 3) {
          sendJson(res, 500, { error: "transient before commit" }, { "retry-after": "0" });
        } else if (chapterAttempts === 4) {
          // The mock records the server-side success but drops the response,
          // exactly the ambiguity the persisted mutation UUID must survive.
          res.destroy();
        } else {
          sendJson(res, 201, {
            idempotent_replay: true,
            chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
            lesson: { id: LESSON_ID, status: "draft" },
          });
        }
        return;
      }
      if (req.method === "GET" && req.url === `/api/books/${BOOK_ID}`) {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
        return;
      }
      if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}`) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
        return;
      }
      if (req.method === "PATCH" && req.url === `/api/lessons/${LESSON_ID}/draft`) {
        const body = await readJsonBody(req);
        assert.equal(body.client_mutation_id, mutationUuid);
        sendJson(res, 200, { draft: { ...body, revision: 1, published_revision: 0 } });
        return;
      }
      sendJson(res, 500, { error: "unexpected request" }, { "retry-after": "0" });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const first = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(first.code, 1);
      const uncertain = (await readOnlyDraftState(home)).value;
      assert.equal(uncertain.book_id, BOOK_ID);
      assert.equal(uncertain.lesson_id, undefined);
      assert.equal(uncertain.mutation_uuid, mutationUuid);

      const resumed = await runCli(["draft", "save", lessonPath, "--json"], { cwd: root, home, baseUrl });
      assert.equal(resumed.code, 0, resumed.stderr);
      const receipt = JSON.parse(resumed.stdout);
      assert.equal(receipt.lesson_id, LESSON_ID);
      assert.equal(receipt.mutation_uuid, mutationUuid);
    });
    assert.equal(chapterAttempts, 5);
    assert.equal(new Set(
      requests
        .filter(({ method }) => method === "POST")
        .map(({ key }) => key),
    ).size, 1);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second CLI process adopts a successful CAS whose response was lost", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  let patchAttempts = 0;
  let remoteDraft = {
    title: "Private draft lesson",
    markdown: "",
    revision: 0,
    published_revision: 0,
  };
  let mutationUuid = null;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/books") {
        mutationUuid = req.headers["idempotency-key"];
        sendJson(res, 201, { book: { id: BOOK_ID } });
      } else if (req.method === "POST") {
        assert.equal(req.headers["idempotency-key"], mutationUuid);
        sendJson(res, 201, {
          chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
          lesson: { id: LESSON_ID, status: "draft" },
        });
      } else if (req.method === "GET" && req.url.endsWith("/draft")) {
        sendJson(res, 200, { draft: remoteDraft });
      } else if (req.method === "GET" && req.url.startsWith("/api/lessons/")) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
      } else if (req.method === "GET") {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      } else {
        const body = await readJsonBody(req);
        patchAttempts += 1;
        assert.equal(body.client_mutation_id, mutationUuid);
        if (patchAttempts <= 3) {
          sendJson(res, 500, { error: "transient before commit" }, { "retry-after": "0" });
        } else {
          remoteDraft = { ...body, revision: 1, published_revision: 0 };
          res.destroy();
        }
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const first = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(first.code, 1);
      const uncertain = (await readOnlyDraftState(home)).value;
      assert.equal(uncertain.lesson_id, LESSON_ID);
      assert.equal(uncertain.revision, 0);
      assert.equal(uncertain.mutation_uuid, mutationUuid);

      const resumed = await runCli(["draft", "save", lessonPath, "--json"], { cwd: root, home, baseUrl });
      assert.equal(resumed.code, 0, resumed.stderr);
      const receipt = JSON.parse(resumed.stdout);
      assert.equal(receipt.revision, 1);
      assert.equal(receipt.unchanged, true);
      assert.equal(receipt.mutation_uuid, mutationUuid);
      assert.equal(patchAttempts, 4);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unconfirmed container mutation rejects changed content or book until explicit local reset", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  let requestCount = 0;
  let chapterAttempts = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      requestCount += 1;
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 201, { book: { id: BOOK_ID } });
        return;
      }
      assert.equal(req.method, "POST");
      assert.equal(req.url, `/api/books/${BOOK_ID}/chapters`);
      chapterAttempts += 1;
      if (chapterAttempts <= 3) {
        sendJson(res, 500, { error: "transient before lost response" }, { "retry-after": "0" });
      } else {
        res.destroy();
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const first = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(first.code, 1);
      const baselineRequests = requestCount;

      await writeFile(lessonPath, LESSON_V2);
      const changed = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(changed.code, 1);
      assert.match(changed.stderr, /mutation.*unconfirmed.*content changed/is);
      assert.equal(requestCount, baselineRequests);

      await writeFile(lessonPath, LESSON_V1);
      const retargeted = await runCli(
        ["draft", "save", lessonPath, "--book", OTHER_BOOK_ID],
        { cwd: root, home, baseUrl },
      );
      assert.equal(retargeted.code, 1);
      assert.match(retargeted.stderr, /unconfirmed.*target book/is);
      assert.equal(requestCount, baselineRequests);

      const reset = await runCli(["draft", "reset", lessonPath, "--yes"], { cwd: root, home, baseUrl });
      assert.equal(reset.code, 0, reset.stderr);
      assert.match(reset.stdout, /Removed only the local human draft receipt/i);
      assert.equal(requestCount, baselineRequests);
      assert.deepEqual(await readdir(join(home, ".config", "luguo", "drafts")), []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing draft reads first, verifies private scope, retries one CAS with the same mutation, then saves", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const requests = [];
  let patchAttempts = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      assertCookieOnlyAuth(req);
      const body = ["POST", "PATCH"].includes(req.method) ? await readJsonBody(req) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 201, { book: { id: BOOK_ID } });
      } else if (req.method === "POST") {
        sendJson(res, 201, {
          chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
          lesson: { id: LESSON_ID, status: "draft", url: "/lessons/private/edit" },
        });
      } else if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}/draft`) {
        sendJson(res, 200, { draft: {
          title: "Private draft lesson",
          markdown: LESSON_V1.split(/---\n\n/)[1].trim(),
          revision: 1,
          published_revision: 0,
        } });
      } else if (req.method === "GET" && req.url === `/api/lessons/${LESSON_ID}`) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
      } else if (req.method === "GET" && req.url === `/api/books/${BOOK_ID}`) {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      } else if (req.method === "PATCH" && req.url === `/api/lessons/${LESSON_ID}/draft`) {
        if (body.expected_revision === 0) {
          sendJson(res, 200, { draft: { ...body, revision: 1, published_revision: 0 } });
          return;
        }
        patchAttempts += 1;
        if (patchAttempts === 1) {
          sendJson(res, 500, { error: "transient fixture" }, { "retry-after": "0" });
          return;
        }
        sendJson(res, 200, { draft: { ...body, revision: 2, published_revision: 0 } });
      } else {
        sendJson(res, 500, { error: "unexpected mock request" }, { "retry-after": "0" });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const created = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(created.code, 0, created.stderr);
      await writeFile(lessonPath, LESSON_V2);
      requests.length = 0;
      const updated = await runCli(["draft", "save", lessonPath, "--json"], { cwd: root, home, baseUrl });
      assert.equal(updated.code, 0, updated.stderr);
      const receipt = JSON.parse(updated.stdout);
      assert.equal(receipt.revision, 2);
      assert.equal(receipt.unchanged, false);
    });

    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      `GET /api/lessons/${LESSON_ID}/draft`,
      `GET /api/lessons/${LESSON_ID}`,
      `GET /api/books/${BOOK_ID}`,
      `PATCH /api/lessons/${LESSON_ID}/draft`,
      `PATCH /api/lessons/${LESSON_ID}/draft`,
    ]);
    const patches = requests.filter(({ method }) => method === "PATCH");
    assert.equal(patches[0].body.expected_revision, 1);
    assert.equal(patches[1].body.expected_revision, 1);
    assert.equal(patches[0].body.client_mutation_id, patches[1].body.client_mutation_id);
    assert.equal(patches[0].body.markdown, patches[1].body.markdown);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP 409 from draft CAS fails closed without a second PATCH", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  let patchCount = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock(async (req, res) => {
      const body = ["POST", "PATCH"].includes(req.method) ? await readJsonBody(req) : undefined;
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 201, { book: { id: BOOK_ID } });
      } else if (req.method === "POST") {
        sendJson(res, 201, {
          chapter: { id: CHAPTER_ID, lesson_id: LESSON_ID },
          lesson: { id: LESSON_ID, status: "draft", url: "/lessons/private/edit" },
        });
      } else if (req.method === "GET" && req.url.endsWith("/draft")) {
        sendJson(res, 200, { draft: {
          title: "Private draft lesson",
          markdown: LESSON_V1.split(/---\n\n/)[1].trim(),
          revision: 1,
          published_revision: 0,
        } });
      } else if (req.method === "GET" && req.url.startsWith("/api/lessons/")) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
      } else if (req.method === "GET") {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      } else {
        if (body.expected_revision === 0) {
          sendJson(res, 200, { draft: { ...body, revision: 1, published_revision: 0 } });
          return;
        }
        patchCount += 1;
        sendJson(res, 409, { error: "revision conflict", draft: { revision: 2 } });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      assert.equal((await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl })).code, 0);
      await writeFile(lessonPath, LESSON_V3);
      const out = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /Draft conflict/);
      assert.doesNotMatch(out.stdout, /Private draft saved/);
    });
    assert.equal(patchCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft pull reads only draft/private metadata and writes clean local state", async () => {
  const { root, home } = await tempProject();
  const target = join(root, "chapters", "unit-1", "pulled.md");
  const requests = [];
  const remoteMarkdown = "# Pulled private draft\n\nRemote body.";
  let remoteRevision = 7;
  try {
    await mkdir(dirname(target), { recursive: true });
    await withMock((req, res) => {
      assertCookieOnlyAuth(req);
      requests.push({ method: req.method, url: req.url });
      if (req.url.endsWith("/draft")) {
        sendJson(res, 200, { draft: {
          title: "Pulled private draft",
          markdown: remoteMarkdown,
          revision: remoteRevision,
          published_revision: 0,
        } });
      } else if (req.url.startsWith("/api/lessons/")) {
        sendJson(res, 200, { lesson: { id: LESSON_ID, book_id: BOOK_ID, visibility: "private" } });
      } else {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const out = await runCli(["draft", "pull", target, "--lesson", LESSON_ID], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(out.code, 0, out.stderr);
      assert.match(await readFile(target, "utf8"), /Remote body\./);
      const state = (await readOnlyDraftState(home)).value;
      assert.deepEqual(Object.keys(state).sort(), [
        "book_id", "content_sha256", "lesson_id", "revision", "version",
      ]);
      assert.equal(state.revision, 7);

      remoteRevision = 8;
      const printed = await runCli(["draft", "pull", target, "--lesson", LESSON_ID, "--print"], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(printed.code, 0, printed.stderr);
      assert.match(printed.stdout, /Remote body\./);
      assert.equal((await readOnlyDraftState(home)).value.revision, 7);
      await assert.rejects(stat(join(root, ".luguo")), /ENOENT/);
    });
    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      `GET /api/lessons/${LESSON_ID}/draft`,
      `GET /api/lessons/${LESSON_ID}`,
      `GET /api/books/${BOOK_ID}`,
      `GET /api/lessons/${LESSON_ID}/draft`,
      `GET /api/lessons/${LESSON_ID}`,
      `GET /api/books/${BOOK_ID}`,
    ]);
    assertSafeRequestLog(requests);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draft pull round-trips escaped frontmatter and treats a title-only edit as a conflict", async () => {
  const { root, home } = await tempProject();
  const target = join(root, "escaped-title.md");
  const remoteTitle = String.raw`Quoted "title" \ path`;
  const remoteSummary = String.raw`Summary with "quotes", commas, and \slashes`;
  const remoteTags = ["math, logic", 'quote "tag"', String.raw`slash\tag`];
  const remoteMarkdown = "# Body\n\nThe remote body is unchanged.";
  try {
    await withMock((req, res) => {
      if (req.url.endsWith("/draft")) {
        sendJson(res, 200, { draft: {
          title: remoteTitle,
          markdown: remoteMarkdown,
          revision: 9,
          published_revision: 0,
        } });
      } else if (req.url.startsWith("/api/lessons/")) {
        sendJson(res, 200, { lesson: {
          id: LESSON_ID,
          book_id: BOOK_ID,
          visibility: "private",
          summary: remoteSummary,
          tags: remoteTags,
          language: "en-US",
          cover_emoji: "🧭",
        } });
      } else {
        sendJson(res, 200, { book: { id: BOOK_ID, visibility: "private" } });
      }
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const pulled = await runCli(["draft", "pull", target, "--lesson", LESSON_ID], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(pulled.code, 0, pulled.stderr);
      const canonical = await readFile(target, "utf8");
      assert.ok(canonical.includes(`title: ${JSON.stringify(remoteTitle)}`));
      assert.ok(canonical.includes(`summary: ${JSON.stringify(remoteSummary)}`));
      assert.ok(canonical.includes(`tags: ${JSON.stringify(remoteTags)}`));

      const outlined = await runCli(["outline", target, "--json"], {
        cwd: root,
        home,
        baseUrl: undefined,
      });
      assert.equal(outlined.code, 0, outlined.stderr);
      assert.equal(JSON.parse(outlined.stdout).title, remoteTitle);

      const localTitle = String.raw`Local "title" \ edit`;
      const locallyEdited = canonical.replace(
        `title: ${JSON.stringify(remoteTitle)}`,
        `title: ${JSON.stringify(localTitle)}`,
      );
      await writeFile(target, locallyEdited);
      const conflict = await runCli(["draft", "pull", target], { cwd: root, home, baseUrl });
      assert.equal(conflict.code, 1);
      assert.match(conflict.stderr, /differs from the remote draft/i);
      assert.equal(await readFile(target, "utf8"), locallyEdited);

      const forced = await runCli(["draft", "pull", target, "--force"], { cwd: root, home, baseUrl });
      assert.equal(forced.code, 0, forced.stderr);
      const reoutlined = await runCli(["outline", target, "--json"], {
        cwd: root,
        home,
        baseUrl: undefined,
      });
      assert.equal(JSON.parse(reoutlined.stdout).title, remoteTitle);
      assert.equal(await readFile(target, "utf8"), canonical);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-private supplied books and cross-site cookie reuse are rejected before mutation", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  let requests = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock((req, res) => {
      requests += 1;
      assert.equal(req.method, "GET");
      assert.equal(req.url, `/api/books/${BOOK_ID}`);
      sendJson(res, 200, { book: { id: BOOK_ID, visibility: "unlisted" } });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const scope = await runCli(["draft", "save", lessonPath, "--book", BOOK_ID], {
        cwd: root,
        home,
        baseUrl,
      });
      assert.equal(scope.code, 1);
      assert.match(scope.stderr, /require(?:s)? a private book/);
      assert.equal(requests, 1);

      const crossSite = await runCli(
        ["draft", "save", lessonPath, "--base-url", "http://127.0.0.1:9"],
        { cwd: root, home, baseUrl: undefined },
      );
      assert.equal(crossSite.code, 1);
      assert.match(crossSite.stderr, /refusing to send its cookie/i);
      assert.equal(requests, 1);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("markdown over 1,500,000 characters is rejected before session lookup, state, or requests", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "oversized.md");
  let requests = 0;
  try {
    await writeFile(lessonPath, `---\ntitle: Oversized\n---\n\n${"x".repeat(1_500_001)}`);
    await withMock((_req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "must not be called" });
    }, async (baseUrl) => {
      const out = await runCli(["draft", "save", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /exceeds 1500000 characters/i);
    });
    assert.equal(requests, 0);
    await assert.rejects(stat(join(home, ".config", "luguo", "drafts")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malicious route-shaped ids and site paths cannot escape the human draft allowlist", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  const pullPath = join(root, "pull.md");
  let requests = 0;
  try {
    await writeFile(lessonPath, LESSON_V1);
    await withMock((_req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "allowlist escape" });
    }, async (baseUrl) => {
      await writeHumanSession(home, baseUrl);
      const vectors = [
        ["draft", "save", lessonPath, "--lesson", `${LESSON_ID}/publish`],
        ["draft", "save", lessonPath, "--lesson", `${LESSON_ID}/draft`],
        ["draft", "save", lessonPath, "--lesson", `${LESSON_ID}?format=luma-md`],
        ["draft", "save", lessonPath, "--book", `${BOOK_ID}/chapters`],
        ["draft", "pull", pullPath, "--lesson", `${LESSON_ID}#admission`],
        ["draft", "/api/agent/lessons"],
        ["draft", "save", lessonPath, "--base-url", `${baseUrl}/api/validate`],
      ];
      for (const args of vectors) {
        const out = await runCli(args, { cwd: root, home, baseUrl: undefined });
        assert.equal(out.code, 1, `${args.join(" ")} unexpectedly succeeded`);
      }
    });
    assert.equal(requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary agent logout still accepts its legacy context names without human-context validation", async () => {
  const { root, home } = await tempProject();
  const credentialsPath = join(home, ".config", "luguo", "credentials.json");
  try {
    await mkdir(dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify({
      version: 2,
      current: "owner@prod",
      contexts: {
        "owner@prod": { api_key: "luguo_local-fixture", base_url: "https://luguo.ai" },
      },
    }, null, 2));
    const out = await runCli(["logout", "--context", "owner@prod"], {
      cwd: root,
      home,
      baseUrl: undefined,
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Logged out of context "owner@prod"/);
    const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert.deepEqual(saved.contexts, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
