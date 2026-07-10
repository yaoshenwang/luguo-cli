import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "bin", "luguo.mjs");
const TEST_KEY = "luguo_test_placeholder_not_a_secret";

const READY_ADMISSION = {
  id: "adm_test_1",
  status: "ready",
  content_version_id: "cv_test_1",
  content_hash: "sha256:test-content-hash",
  gate_version: "luma-admission-v2",
  repairs: 0,
  index: {
    teaches: 2,
    prereqs: 1,
    atoms: 4,
    bindings: 3,
    prereqEdges: 1,
  },
};

const LESSON = `---
title: Mock admission lesson
tags: [test]
visibility: private
---

# Mock admission lesson

:::quiz Which answer passes?
- [x] The grounded answer
- [ ] The distractor
@id q-mock-1
@explain The grounded answer is correct.
@skills mock-skill
:::
`;

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function runCli(args, { cwd, home, baseUrl, key = TEST_KEY } = {}) {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [CLI, ...args], {
      cwd: cwd || REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        LUGUO_BASE_URL: baseUrl,
        LUGUO_API_KEY: key,
      },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolveRun({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
      });
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function withMock(handler, run) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      sendJson(res, 500, { error: error.message });
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), "luguo-cli-admission-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

test("help documents automatic admission", async () => {
  const { root, home } = await tempProject();
  try {
    const out = await runCli(["help"], { cwd: root, home, baseUrl: "http://127.0.0.1:1", key: "" });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /automatic admission gate/i);
    assert.match(out.stdout, /idempotency/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor can check a mock server without reading real credentials", async () => {
  const { root, home } = await tempProject();
  try {
    await withMock((req, res) => {
      assert.equal(req.url, "/skill.md");
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("# Mock skill\n");
    }, async (baseUrl) => {
      const out = await runCli(["doctor"], { cwd: root, home, baseUrl, key: "" });
      assert.equal(out.code, 0);
      assert.match(out.stdout, /OK\s+GET .*\/skill\.md \(200\)/);
      assert.match(out.stdout, /No API key saved/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate sends luma-md to the server", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  try {
    await withMock(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/agent/validate");
      assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
      const body = await readJsonBody(req);
      assert.equal(body.artifact, "luma_md");
      assert.match(body.markdown, /q-mock-1/);
      sendJson(res, 200, {
        valid: true,
        blocks: 2,
        scenes: 1,
        block_counts: { heading: 1, quiz: 1 },
        warnings: [],
      });
    }, async (baseUrl) => {
      const out = await runCli(["validate", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0);
      assert.match(out.stdout, /OK: Mock admission lesson: 2 block\(s\), 1 scene\(s\)/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson publish requires 201 ready, persists admission, and reuses a stable idempotency key", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const keys = [];
  try {
    await withMock(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/agent/lessons");
      keys.push(req.headers["idempotency-key"]);
      const body = await readJsonBody(req);
      assert.equal(body.body.format, "luma-md-v1");
      assert.match(body.body.markdown, /q-mock-1/);
      sendJson(res, 201, {
        lesson: { id: "lesson_test_1", slug: "mock-admission", url: "/lessons/mock-admission" },
        admission: READY_ADMISSION,
        blocks: 2,
        scenes: 1,
        block_counts: { heading: 1, quiz: 1 },
      });
    }, async (baseUrl) => {
      const first = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const second = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const changed = await runCli(["publish", lessonPath, "--title", "Changed title"], { cwd: root, home, baseUrl });
      const otherAgent = await runCli(["publish", lessonPath], {
        cwd: root,
        home,
        baseUrl,
        key: "luguo_other_test_placeholder_not_a_secret",
      });
      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.equal(changed.code, 0);
      assert.equal(otherAgent.code, 0);
      assert.match(first.stdout, /gate\s+luma-admission-v2 \(ready, 0 repair\(s\)\)/);
      assert.match(first.stdout, /teaches×2.*bindings×3/);
    });
    assert.equal(keys.length, 4);
    assert.match(keys[0], /^luguo-cli-v1-[a-f0-9]{64}$/);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.notEqual(keys[0], keys[3]);
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.deepEqual(state.admission, READY_ADMISSION);
    assert.equal(state.lesson_id, "lesson_test_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("422 admission issues are printed with paths and codes", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  try {
    await withMock((req, res) => {
      sendJson(res, 422, {
        error: "Content admission failed",
        issues: [{
          code: "quiz_missing_skill",
          path: ["body", "quiz", "q-mock-1", "skills"],
          message: "Add at least one canonical skill.",
        }],
        admission: { status: "rejected" },
      });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /HTTP 422: Content admission failed/);
      assert.match(out.stderr, /body\.quiz\.q-mock-1\.skills \[quiz_missing_skill\]: Add at least one canonical skill\./);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish rejects non-201 and non-ready admission responses", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  let requestNumber = 0;
  try {
    await withMock((req, res) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        sendJson(res, 200, { lesson: { id: "lesson_test_1" }, admission: READY_ADMISSION });
        return;
      }
      if (requestNumber === 2) {
        sendJson(res, 201, {
          lesson: { id: "lesson_test_1" },
          admission: { ...READY_ADMISSION, status: "indexing" },
        });
        return;
      }
      if (requestNumber === 3) {
        sendJson(res, 201, {
          lesson: { id: "lesson_test_1" },
          admission: {
            ...READY_ADMISSION,
            index: { ...READY_ADMISSION.index, bindings: 0 },
          },
        });
        return;
      }
      sendJson(res, 201, {
        lesson: { id: "lesson_test_1" },
        admission: {
          ...READY_ADMISSION,
          index: { ...READY_ADMISSION.index, teaches: 0 },
        },
      });
    }, async (baseUrl) => {
      const wrongStatus = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(wrongStatus.code, 1);
      assert.match(wrongStatus.stderr, /Expected HTTP 201/);

      const indexing = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(indexing.code, 1);
      assert.match(indexing.stderr, /admission is indexing, not ready/);

      const orphan = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(orphan.code, 1);
      assert.match(orphan.stderr, /not algorithm-ready \(teaches=2, bindings=0\)/);

      const noTeaching = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(noTeaching.code, 1);
      assert.match(noTeaching.stderr, /not algorithm-ready \(teaches=0, bindings=3\)/);
    });
    await assert.rejects(readFile(join(root, ".luguo", "state.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("book chapters pass the same gate and retain per-chapter admission receipts", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "book");
  await mkdir(bookRoot);
  await writeFile(join(bookRoot, "luguo.yml"), "title: Mock book\nvisibility: unlisted\nlanguage: en\n");
  await writeFile(join(bookRoot, "01-chapter.md"), LESSON);
  const keysByPath = new Map();
  try {
    await withMock(async (req, res) => {
      const keys = keysByPath.get(req.url) || [];
      keys.push(req.headers["idempotency-key"]);
      keysByPath.set(req.url, keys);
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 200, { book: { id: "book_test_1", slug: "mock-book" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/books/book_test_1/chapters") {
        const body = await readJsonBody(req);
        assert.match(body.markdown, /q-mock-1/);
        sendJson(res, 201, {
          chapter: { id: "chapter_test_1", lesson_id: "lesson_test_1" },
          lesson: { id: "lesson_test_1", slug: "mock-chapter" },
          course: { id: "course_test_1", slug: "mock-course" },
          admission: READY_ADMISSION,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/books/book_test_1") {
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const first = await runCli(["publish", bookRoot], { cwd: root, home, baseUrl });
      const second = await runCli(["publish", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.match(first.stdout, /01-chapter\.md → Mock admission lesson \(luma-admission-v2, ready\)/);
    });
    for (const keys of keysByPath.values()) {
      assert.equal(keys.length, 2);
      assert.equal(keys[0], keys[1]);
      assert.match(keys[0], /^luguo-cli-v1-[a-f0-9]{64}$/);
    }
    const state = JSON.parse(await readFile(join(bookRoot, ".luguo", "state.json"), "utf8"));
    assert.deepEqual(state.chapters[0].admission, READY_ADMISSION);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
