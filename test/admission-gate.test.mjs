import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

const OWNER_HOME = {
  agent: {
    id: "agent_user_test_1",
    handle: "mock-agent",
    claimed: true,
    owner: { id: "owner_user_test_1", handle: "mock-owner", full_name: "Mock Owner" },
  },
  capabilities: { publish_as_owner: true },
  quota: { daily_create_remaining: 199, daily_create_limit: 200, trial: false },
  my_lessons: [],
};

const OWNER_AUTHORSHIP = {
  mode: "owner",
  agent: { id: "agent_user_test_1", handle: "mock-agent" },
  owner: { id: "owner_user_test_1", handle: "mock-owner" },
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
@steps identify the condition,apply the rule,check the result
:::

:::quiz Which second answer is grounded?
- [ ] The unsupported answer
- [x] The second grounded answer
@id q-mock-2
@explain The second grounded answer follows the lesson.
@skills mock-skill
@steps read the evidence,compare the choices,verify the conclusion
:::

:::quiz Which answer transfers the idea?
- [x] The valid transfer
- [ ] The superficial match
@id q-mock-3
@explain The valid transfer preserves the taught rule.
@skills mock-skill
@steps recognize the new context,transfer the rule,test a counterexample
:::

:::keypoints
- **mock-skill**: A grounded conclusion must follow the lesson evidence.
:::
`;

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
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

function legacyIdempotencyKey(baseUrl, method, path, body, key = TEST_KEY) {
  const identityScope = createHash("sha256").update(`${baseUrl}\n${key}`).digest("hex");
  const digest = createHash("sha256")
    .update(`${identityScope}\n${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
    .digest("hex");
  return `luguo-cli-v1-${digest}`;
}

function runCli(args, { cwd, home, baseUrl, key = TEST_KEY } = {}) {
  return new Promise((resolveRun) => {
    const env = {
      ...process.env,
      HOME: home,
      LUGUO_API_KEY: key,
    };
    if (baseUrl === undefined) delete env.LUGUO_BASE_URL;
    else env.LUGUO_BASE_URL = baseUrl;
    execFile(process.execPath, [CLI, ...args], {
      cwd: cwd || REPO_ROOT,
      env,
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

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
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

function assertFoldSafeKeypoints(markdown, label) {
  const keypointCount = (markdown.match(/^:::keypoints\b/gm) || []).length;
  const foldingPairs = [...markdown.matchAll(
    /^:::keypoints\b[^\n]*\n[\s\S]*?^@skills\s+([^\n]+)\n^:::\n\n^:::quiz\b[^\n]*\n[\s\S]*?^@skills\s+([^\n]+)\n/gm,
  )];
  assert.ok(keypointCount > 0, `${label}: expected at least one keypoints block`);
  assert.equal(foldingPairs.length, keypointCount, `${label}: every keypoints block needs an adjacent verification quiz`);
  for (const pair of foldingPairs) {
    assert.equal(pair[1], pair[2], `${label}: keypoints and verification quiz skills must match exactly`);
  }

  const quizSkills = [...markdown.matchAll(/^:::quiz\b[^\n]*\n([\s\S]*?)^:::$/gm)]
    .flatMap((match) => match[1].match(/^@skills\s+(.+)$/m)?.[1].split(",") ?? [])
    .map((skill) => skill.trim())
    .filter(Boolean);
  const distinctSkills = new Set(quizSkills);
  assert.ok(distinctSkills.size >= 3 && distinctSkills.size <= 8, `${label}: expected 3–8 distinct quiz skills`);
}

test("help documents automatic admission", async () => {
  const { root, home } = await tempProject();
  try {
    const out = await runCli(["help"], { cwd: root, home, baseUrl: "http://127.0.0.1:1", key: "" });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /automatic admission gate/i);
    assert.match(out.stdout, /idempotency/i);
    assert.match(out.stdout, /publish <file\.md \| dir>[\s\S]*--as-owner/);
    assert.match(out.stdout, /claimed agent[\s\S]*authorship[\s\S]*receipt/i);
    assert.match(out.stdout, /Allow publishing as me[\s\S]*same key[\s\S]*cannot edit/i);
    assert.match(out.stdout, /open \[path\] \[--workspace\|--edit\] \[--print\]/);
    assert.match(out.stdout, /retry transient network\/429\/5xx failures[\s\S]*three times/i);
    assert.match(out.stdout, /Every :::keypoints fence[\s\S]*complete scene skill set[\s\S]*exactly the same @skills set[\s\S]*fold\s+safely/i);
    assert.match(out.stdout, /3–8 distinct skills[\s\S]*action \+ object/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--help short-circuits every subcommand without network or side effects", async () => {
  const { root, home } = await tempProject();
  const commands = [
    "login", "logout", "register", "context", "contexts", "status", "whoami",
    "doctor", "draft", "init", "validate", "outline", "publish", "pull", "delete",
    "archive", "lessons", "books", "open", "home", "skill", "help",
  ];
  let requests = 0;
  try {
    await withMock((req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "help must not reach the network" });
    }, async (baseUrl) => {
      for (const command of commands) {
        const out = await runCli([command, "--help"], { cwd: root, home, baseUrl, key: "" });
        assert.equal(out.code, 0, `${command}: ${out.stderr}`);
        assert.match(out.stdout, /publish luma-md lessons and books/i, command);
        assert.equal(out.stderr, "", command);
      }
    });
    assert.equal(requests, 0);
    await assert.rejects(readFile(join(root, "lesson.md"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init creates an admission-ready structural template", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "ready-template.md");
  try {
    const out = await runCli(["init", lessonPath], {
      cwd: root,
      home,
      baseUrl: "http://127.0.0.1:1",
      key: "",
    });
    assert.equal(out.code, 0);
    const markdown = await readFile(lessonPath, "utf8");
    assert.equal((markdown.match(/^:::quiz\b/gm) || []).length, 3);
    // 3 quiz ids + 1 explore id (the :::explore sample ships with the template)
    assert.equal((markdown.match(/^@id\s+/gm) || []).length, 4);
    const skillLines = [...markdown.matchAll(/^@skills\s+(.+)$/gm)].map((match) => match[1]);
    assert.equal(skillLines.length, 4);
    assert.equal(new Set(skillLines).size, 3);
    assert.equal((markdown.match(/^@steps\s+/gm) || []).length, 3);
    assert.match(markdown, /^:::keypoints\b/m);
    assertFoldSafeKeypoints(markdown, "generated lesson template");
    assert.match(markdown, /^:::example\b/m);
    assert.match(markdown, /"domain": \[-8, 8\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bilingual docs and bundled examples keep fold-safe keypoints", async () => {
  const files = [
    "README.md",
    "README_CN.md",
    "examples/lesson.md",
    "examples/luma-book/01-第一章.md",
    "examples/luma-book/02-第二章.md",
  ];
  for (const file of files) {
    assertFoldSafeKeypoints(await readFile(join(REPO_ROOT, file), "utf8"), file);
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
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /OK\s+GET .*\/skill\.md \(200\)/);
      assert.match(out.stdout, /No API key saved/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status and home show the claimed owner and owner-publish capability", async () => {
  const { root, home } = await tempProject();
  try {
    await withMock((req, res) => {
      assert.equal(req.method, "GET");
      if (req.url === "/skill.md") {
        res.writeHead(200, { "content-type": "text/markdown" });
        res.end("# Mock skill\n");
        return;
      }
      assert.equal(req.url, "/api/v1/agent/home");
      assert.equal(req.headers["x-luguo-act-as"], undefined);
      sendJson(res, 200, OWNER_HOME);
    }, async (baseUrl) => {
      const status = await runCli(["status"], { cwd: root, home, baseUrl });
      const dashboard = await runCli(["home"], { cwd: root, home, baseUrl });
      const doctor = await runCli(["doctor"], { cwd: root, home, baseUrl });
      assert.equal(status.code, 0, status.stderr);
      assert.equal(dashboard.code, 0, dashboard.stderr);
      assert.equal(doctor.code, 0, doctor.stderr);
      assert.match(status.stdout, /@mock-agent \(claimed\)/);
      assert.match(status.stdout, /Owner: @mock-owner/);
      assert.match(status.stdout, /available with --as-owner/);
      assert.match(dashboard.stdout, /Owner: @mock-owner/);
      assert.match(dashboard.stdout, /199 create\(s\) left/);
      assert.match(doctor.stdout, /Owner: @mock-owner/);
      assert.match(doctor.stdout, /available with --as-owner/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status tells a claimed owner to enable per-key publishing when capability is false", async () => {
  const { root, home } = await tempProject();
  try {
    await withMock((req, res) => {
      sendJson(res, 200, { ...OWNER_HOME, capabilities: { publish_as_owner: false } });
    }, async (baseUrl) => {
      const out = await runCli(["status"], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /disabled for this key/);
      assert.match(out.stdout, /Allow publishing as me.*Settings/);
      assert.doesNotMatch(out.stdout, /server version/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--as-owner preflight distinguishes unclaimed, disabled keys, and unsupported servers", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  try {
    for (const scenario of [
      {
        home: { agent: { id: "agent_user_test_1", handle: "mock-agent", claimed: false, owner: null } },
        error: /requires a claimed agent/,
      },
      {
        home: { ...OWNER_HOME, capabilities: { publish_as_owner: false } },
        error: /disabled for this key.*Allow publishing as me.*No content was written/,
      },
      {
        home: { ...OWNER_HOME, capabilities: undefined },
        error: /not supported by this server version.*No content was written/,
      },
    ]) {
      let writes = 0;
      await withMock((req, res) => {
        if (req.method !== "GET") writes += 1;
        sendJson(res, 200, scenario.home);
      }, async (baseUrl) => {
        const out = await runCli(["publish", lessonPath, "--as-owner"], { cwd: root, home, baseUrl });
        assert.equal(out.code, 1);
        assert.match(out.stderr, scenario.error);
      });
      assert.equal(writes, 0);
    }
    await assert.rejects(readFile(join(root, ".luguo", "state.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(home, ".config", "luguo", "last-publish.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lessons and books --as-owner preflight then query the owner scope", async () => {
  const { root, home } = await tempProject();
  try {
    let ownerHomeReads = 0;
    let ownerBookReads = 0;
    await withMock((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/agent/home") {
        if (req.headers["x-luguo-act-as"] === "owner") {
          ownerHomeReads += 1;
          sendJson(res, 200, {
            ...OWNER_HOME,
            my_lessons: [{ id: "lesson_owner_1", title: "Owner lesson", slug: "owner-lesson", visibility: "private" }],
            authorship: OWNER_AUTHORSHIP,
          });
        } else {
          sendJson(res, 200, OWNER_HOME);
        }
        return;
      }
      if (req.method === "GET" && req.url === "/api/books") {
        assert.equal(req.headers["x-luguo-act-as"], "owner");
        ownerBookReads += 1;
        sendJson(res, 200, {
          books: [{ id: "book_owner_1", title: "Owner book", visibility: "private" }],
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const lessons = await runCli(["lessons", "--as-owner"], { cwd: root, home, baseUrl });
      const books = await runCli(["books", "--as-owner"], { cwd: root, home, baseUrl });
      assert.equal(lessons.code, 0, lessons.stderr);
      assert.equal(books.code, 0, books.stderr);
      assert.match(lessons.stdout, /Owner scope: @mock-owner/);
      assert.match(lessons.stdout, /Owner lesson/);
      assert.match(books.stdout, /Owner scope: @mock-owner/);
      assert.match(books.stdout, /Owner book/);
    });
    assert.equal(ownerHomeReads, 1);
    assert.equal(ownerBookReads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner-scoped lesson and book lists fail closed without matching authorship", async () => {
  const { root, home } = await tempProject();
  try {
    for (const command of ["lessons", "books"]) {
      await withMock((req, res) => {
        if (req.method === "GET" && req.url === "/api/v1/agent/home" && req.headers["x-luguo-act-as"] !== "owner") {
          sendJson(res, 200, OWNER_HOME);
          return;
        }
        assert.equal(req.headers["x-luguo-act-as"], "owner");
        if (command === "lessons") {
          sendJson(res, 200, { ...OWNER_HOME, my_lessons: [] });
        } else {
          sendJson(res, 200, {
            books: [],
            authorship: { ...OWNER_AUTHORSHIP, owner: { id: "wrong_owner", handle: "wrong-owner" } },
          });
        }
      }, async (baseUrl) => {
        const out = await runCli([command, "--as-owner"], { cwd: root, home, baseUrl });
        assert.equal(out.code, 1);
        assert.match(
          out.stderr,
          command === "lessons" ? /did not return an authorship receipt/ : /does not match the claimed owner/,
        );
      });
    }
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

test("ordinary validation does not use publish-only transient retries", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  let requests = 0;
  try {
    await withMock((req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "validation unavailable" }, { "retry-after": "0" });
    }, async (baseUrl) => {
      const out = await runCli(["validate", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /HTTP 500: validation unavailable/);
      assert.doesNotMatch(out.stdout, /retry 1\/3/);
    });
    assert.equal(requests, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson publish requires 201 ready, persists admission, and republish updates in place", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const creates = [];
  const updates = [];
  try {
    await withMock(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/agent/lessons") {
        creates.push(req.headers["idempotency-key"]);
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
        return;
      }
      // A source file with a v2 receipt republishes as an in-place update: the
      // lesson URL and @id answer history survive instead of duplicating.
      if (req.method === "PATCH" && req.url === "/api/lessons/lesson_test_1") {
        updates.push(req.headers["idempotency-key"]);
        const body = await readJsonBody(req);
        assert.equal(body.body.format, "luma-md-v1");
        sendJson(res, 200, {
          lesson: { id: "lesson_test_1", slug: "mock-admission", url: "/lessons/mock-admission" },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const first = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const second = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const changed = await runCli(["publish", lessonPath, "--title", "Changed title"], { cwd: root, home, baseUrl });
      const forcedNew = await runCli(["publish", lessonPath, "--new"], { cwd: root, home, baseUrl });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(changed.code, 0, changed.stderr);
      assert.equal(forcedNew.code, 0, forcedNew.stderr);
      assert.match(first.stdout, /gate\s+luma-admission-v2 \(ready, 0 repair\(s\)\)/);
      assert.match(first.stdout, /teaches×2.*bindings×3/);
      assert.match(second.stdout, /Lesson updated/);
    });
    assert.equal(creates.length, 2); // first publish + --new
    assert.equal(updates.length, 2); // unchanged republish + --title change
    assert.match(creates[0], /^luguo-cli-v1-[a-f0-9]{64}$/);
    assert.equal(creates[0], creates[1]); // same payload → same create intent key
    assert.match(updates[0], /^luguo-cli-v1-[a-f0-9]{64}$/);
    assert.notEqual(updates[0], updates[1]); // changed title → new update intent
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.equal(state.version, 2);
    assert.deepEqual(state.lessons["lesson.md"].admission, READY_ADMISSION);
    assert.equal(state.lessons["lesson.md"].lesson_id, "lesson_test_1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson update skips unchanged visibility and requests a separate scope change only when needed", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const patches = [];
  let currentVisibility = "private";
  try {
    await withMock(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/agent/lessons") {
        sendJson(res, 201, {
          lesson: {
            id: "lesson_visibility_1",
            slug: "visibility-lesson",
            url: "/lessons/visibility-lesson",
            visibility: currentVisibility,
          },
          admission: READY_ADMISSION,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/lessons/lesson_visibility_1") {
        const body = await readJsonBody(req);
        patches.push(body);
        if (body.visibility) currentVisibility = body.visibility;
        sendJson(res, 200, {
          lesson: {
            id: "lesson_visibility_1",
            slug: "visibility-lesson",
            url: "/lessons/visibility-lesson",
            visibility: currentVisibility,
          },
          ...(body.body ? { admission: READY_ADMISSION } : {}),
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const created = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const unchanged = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      const changed = await runCli(
        ["publish", lessonPath, "--visibility", "public"],
        { cwd: root, home, baseUrl },
      );
      assert.equal(created.code, 0, created.stderr);
      assert.equal(unchanged.code, 0, unchanged.stderr);
      assert.equal(changed.code, 0, changed.stderr);
    });

    assert.equal(patches.length, 3);
    assert.ok(patches[0].body);
    assert.equal(patches[0].visibility, undefined);
    assert.ok(patches[1].body);
    assert.equal(patches[1].visibility, undefined);
    assert.deepEqual(patches[2], { visibility: "public" });
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.equal(state.lessons["lesson.md"].visibility, "public");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson publish retries an initial HTTP 500 with the same idempotency key", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const keys = [];
  try {
    await withMock((req, res) => {
      assert.equal(req.method, "POST");
      keys.push(req.headers["idempotency-key"]);
      if (keys.length === 1) {
        sendJson(res, 500, { error: "temporary server fault" }, { "retry-after": "0" });
        return;
      }
      sendJson(res, 201, {
        lesson: { id: "lesson_after_500", slug: "after-500", url: "/lessons/after-500" },
        admission: READY_ADMISSION,
      });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Transient HTTP 500 .*retry 1\/3 in 0ms/);
      assert.doesNotMatch(out.stdout, new RegExp(TEST_KEY));
    });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson publish retries an initial network failure with the same idempotency key", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const keys = [];
  try {
    await withMock((req, res) => {
      assert.equal(req.method, "POST");
      keys.push(req.headers["idempotency-key"]);
      if (keys.length === 1) {
        req.socket.destroy();
        return;
      }
      sendJson(res, 201, {
        lesson: { id: "lesson_after_network", slug: "after-network", url: "/lessons/after-network" },
        admission: READY_ADMISSION,
      });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Transient network error .*retry 1\/3 in 500ms/);
      assert.doesNotMatch(out.stdout, new RegExp(TEST_KEY));
    });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient publish retries are bounded to three and keep one idempotency key", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const keys = [];
  try {
    await withMock((req, res) => {
      keys.push(req.headers["idempotency-key"]);
      sendJson(res, 503, { error: "still unavailable" }, { "retry-after": "0" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stdout, /retry 3\/3 in 0ms/);
      assert.match(out.stderr, /HTTP 503: still unavailable/);
    });
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 1);
    await assert.rejects(readFile(join(root, ".luguo", "state.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed owner publish is scoped, idempotent, verified, and opens the human workspace", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const requests = [];
  try {
    await withMock(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/agent/home") {
        assert.equal(req.headers["x-luguo-act-as"], undefined);
        sendJson(res, 200, OWNER_HOME);
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/lessons") {
        const mode = req.headers["x-luguo-act-as"] === "owner" ? "owner" : "agent";
        const body = await readJsonBody(req);
        requests.push({ method: "POST", mode, body, key: req.headers["idempotency-key"] });
        const id = mode === "owner" ? "lesson_owner_1" : "lesson_agent_1";
        sendJson(res, 201, {
          lesson: { id, slug: `${mode}-lesson`, url: `/lessons/${mode}-lesson` },
          admission: READY_ADMISSION,
          ...(mode === "owner" ? { authorship: OWNER_AUTHORSHIP } : {}),
        });
        return;
      }
      // Owner-published lessons stay manageable through the same key: the
      // republish arrives as a delegated PATCH instead of a duplicate create.
      if (req.method === "PATCH" && req.url === "/api/lessons/lesson_owner_1") {
        const mode = req.headers["x-luguo-act-as"] === "owner" ? "owner" : "agent";
        const body = await readJsonBody(req);
        requests.push({ method: "PATCH", mode, body, key: req.headers["idempotency-key"] });
        sendJson(res, 200, {
          lesson: { id: "lesson_owner_1", slug: "owner-lesson", url: "/lessons/owner-lesson" },
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const first = await runCli(["publish", lessonPath, "--as-owner"], { cwd: root, home, baseUrl });
      const second = await runCli(["publish", "--as-owner", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Lesson updated/);
      assert.match(first.stdout, /author\s+@mock-owner \(via @mock-agent\)/);
      assert.match(first.stdout, new RegExp(`${baseUrl}/lessons/lesson_owner_1/edit`));

      const stateAfterOwner = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
      const ownerReceipt = stateAfterOwner.lessons["lesson.md"];
      assert.equal(ownerReceipt.publish_as, "owner");
      assert.deepEqual(ownerReceipt.authorship, OWNER_AUTHORSHIP);
      assert.equal(ownerReceipt.workspace_url, `${baseUrl}/lessons/lesson_owner_1/edit`);
      const global = JSON.parse(await readFile(join(home, ".config", "luguo", "last-publish.json"), "utf8"));
      assert.equal(global.receipt.workspace_url, ownerReceipt.workspace_url);

      const opened = await runCli(["open", "--workspace", lessonPath, "--print"], { cwd: root, home, baseUrl, key: "" });
      assert.equal(opened.code, 0, opened.stderr);
      assert.equal(opened.stdout.trim(), ownerReceipt.workspace_url);

      const rebased = await runCli(["open", "--workspace", lessonPath, "--print"], {
        cwd: root,
        home,
        baseUrl: "https://dev.example",
        key: "",
      });
      assert.equal(rebased.code, 0, rebased.stderr);
      assert.equal(rebased.stdout.trim(), "https://dev.example/lessons/lesson_owner_1/edit");

      // A plain republish keeps the lesson's recorded owner authorship and
      // updates in place; --new is the explicit way to mint a fresh agent-mode
      // lesson from the same source file.
      const ownerUpdateNoFlag = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(ownerUpdateNoFlag.code, 0, ownerUpdateNoFlag.stderr);
      const agent = await runCli(["publish", lessonPath, "--new"], { cwd: root, home, baseUrl });
      assert.equal(agent.code, 0, agent.stderr);

      assert.equal(requests.length, 4);
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].mode, "owner");
      assert.equal(requests[1].method, "PATCH");
      assert.equal(requests[1].mode, "owner");
      assert.equal(requests[2].method, "PATCH");
      assert.equal(requests[2].mode, "owner");
      assert.equal(requests[3].method, "POST");
      assert.equal(requests[3].mode, "agent");
      assert.equal(requests[1].key, requests[2].key); // unchanged update intent is idempotent
      assert.notEqual(requests[0].key, requests[3].key);
      assert.equal(
        requests[3].key,
        legacyIdempotencyKey(baseUrl, "POST", "/api/agent/lessons", requests[3].body),
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner update reads legacy visibility, patches content only, and verifies authorship", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  await mkdir(join(root, ".luguo"), { recursive: true });
  await writeFile(join(root, ".luguo", "state.json"), JSON.stringify({
    version: 2,
    last: { kind: "lesson", key: "lesson.md" },
    book: null,
    lessons: {
      "lesson.md": {
        source: "lesson.md",
        lesson_id: "lesson_owner_legacy_1",
        lesson_slug: "owner-legacy",
        reader_url: "https://example.invalid/lessons/owner-legacy",
        workspace_url: "https://example.invalid/lessons/lesson_owner_legacy_1/edit",
        publish_as: "owner",
        authorship: OWNER_AUTHORSHIP,
      },
    },
  }, null, 2));
  const requests = [];
  let patchNumber = 0;
  try {
    await withMock(async (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/agent/home") {
        requests.push({ method: "GET", path: req.url, mode: req.headers["x-luguo-act-as"] });
        sendJson(res, 200, OWNER_HOME);
        return;
      }
      if (req.method === "GET" && req.url === "/api/lessons/lesson_owner_legacy_1?format=luma-md") {
        requests.push({ method: "GET", path: req.url, mode: req.headers["x-luguo-act-as"] });
        sendJson(res, 200, {
          lesson: { id: "lesson_owner_legacy_1", visibility: "private" },
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/lessons/lesson_owner_legacy_1") {
        patchNumber += 1;
        const body = await readJsonBody(req);
        requests.push({ method: "PATCH", path: req.url, mode: req.headers["x-luguo-act-as"], body });
        sendJson(res, 200, {
          lesson: { id: "lesson_owner_legacy_1", slug: "owner-legacy", visibility: "private" },
          admission: READY_ADMISSION,
          ...(patchNumber === 1 ? { authorship: OWNER_AUTHORSHIP } : {}),
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const updated = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(updated.code, 0, updated.stderr);
      assert.match(updated.stdout, /Lesson updated/);
      assert.match(updated.stdout, /author\s+@mock-owner \(via @mock-agent\)/);

      // The refreshed receipt now carries visibility, so the second update
      // needs no metadata read. Its missing authorship must still fail closed.
      const missingAuthorship = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(missingAuthorship.code, 1);
      assert.match(missingAuthorship.stderr, /did not return an authorship receipt/);

      // A real delegated scope change is rejected locally before the content
      // PATCH, matching the server's owner-only visibility boundary.
      const changedVisibility = await runCli(
        ["publish", lessonPath, "--visibility", "public"],
        { cwd: root, home, baseUrl },
      );
      assert.equal(changedVisibility.code, 1);
      assert.match(changedVisibility.stderr, /Owner delegation cannot change lesson visibility/);
      assert.match(changedVisibility.stderr, /no lesson content was updated/);
    });

    const metadataReads = requests.filter((request) => request.path.includes("?format=luma-md"));
    const contentPatches = requests.filter((request) => request.method === "PATCH");
    assert.equal(metadataReads.length, 1);
    assert.equal(metadataReads[0].mode, "owner");
    assert.equal(contentPatches.length, 2);
    for (const request of contentPatches) {
      assert.equal(request.mode, "owner");
      assert.ok(request.body.body);
      assert.equal(request.body.visibility, undefined);
    }
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.equal(state.lessons["lesson.md"].visibility, "private");
    assert.deepEqual(state.lessons["lesson.md"].authorship, OWNER_AUTHORSHIP);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner publish fails closed on missing or mismatched authorship and writes no state", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  let publishNumber = 0;
  try {
    await withMock((req, res) => {
      if (req.method === "GET") {
        sendJson(res, 200, OWNER_HOME);
        return;
      }
      publishNumber += 1;
      sendJson(res, 201, {
        lesson: { id: `lesson_wrong_${publishNumber}`, slug: `wrong-${publishNumber}`, url: `/lessons/wrong-${publishNumber}` },
        admission: READY_ADMISSION,
        ...(publishNumber === 2
          ? { authorship: { ...OWNER_AUTHORSHIP, owner: { id: "someone_else", handle: "wrong-owner" } } }
          : {}),
      });
    }, async (baseUrl) => {
      const missing = await runCli(["publish", lessonPath, "--as-owner"], { cwd: root, home, baseUrl });
      const mismatch = await runCli(["publish", lessonPath, "--as-owner"], { cwd: root, home, baseUrl });
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /did not return an authorship receipt/);
      assert.equal(mismatch.code, 1);
      assert.match(mismatch.stderr, /does not match the claimed owner/);
    });
    await assert.rejects(readFile(join(root, ".luguo", "state.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(join(home, ".config", "luguo", "last-publish.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lesson publish follows a durable 202 admission until it is ready", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  let posts = 0;
  let polls = 0;
  try {
    await withMock((req, res) => {
      if (req.method === "POST" && req.url === "/api/agent/lessons") {
        posts += 1;
        assert.match(String(req.headers["idempotency-key"]), /^luguo-cli-v1-[a-f0-9]{64}$/);
        res.writeHead(202, {
          "content-type": "application/json",
          "retry-after": "0",
          location: "/api/agent/admissions/11111111-1111-4111-8111-111111111111",
        });
        res.end(JSON.stringify({
          queued: true,
          admission: { id: "11111111-1111-4111-8111-111111111111", status: "validating" },
          status_url: "/api/agent/admissions/11111111-1111-4111-8111-111111111111",
        }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/agent/admissions/11111111-1111-4111-8111-111111111111") {
        polls += 1;
        assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
        if (polls === 1) {
          res.writeHead(202, { "content-type": "application/json", "retry-after": "0" });
          res.end(JSON.stringify({
            queued: true,
            admission: { id: "11111111-1111-4111-8111-111111111111", status: "indexing" },
          }));
          return;
        }
        sendJson(res, 200, {
          lesson: { id: "lesson_queued_1", slug: "queued-ready", url: "/lessons/queued-ready" },
          admission: { ...READY_ADMISSION, id: "11111111-1111-4111-8111-111111111111" },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Admission 11111111-1111-4111-8111-111111111111 queued; waiting for the automatic gate/);
      assert.match(out.stdout, /Lesson published: Mock admission lesson/);
    });
    assert.equal(posts, 1);
    assert.equal(polls, 2);
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.equal(state.lessons["lesson.md"].admission.id, "11111111-1111-4111-8111-111111111111");
    assert.equal(state.lessons["lesson.md"].admission.status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner-mode 202 admission polling preserves act-as-owner and verifies final authorship", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  const admissionId = "33333333-3333-4333-8333-333333333333";
  let polls = 0;
  try {
    await withMock((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/agent/home") {
        assert.equal(req.headers["x-luguo-act-as"], undefined);
        sendJson(res, 200, OWNER_HOME);
        return;
      }
      if (req.method === "POST" && req.url === "/api/agent/lessons") {
        assert.equal(req.headers["x-luguo-act-as"], "owner");
        const statusUrl = `/api/agent/admissions/${admissionId}`;
        sendJson(res, 202, {
          queued: true,
          admission: { id: admissionId, status: "validating" },
          status_url: statusUrl,
        }, { location: statusUrl, "retry-after": "0" });
        return;
      }
      if (req.method === "GET" && req.url === `/api/agent/admissions/${admissionId}`) {
        assert.equal(req.headers["x-luguo-act-as"], "owner");
        polls += 1;
        if (polls === 1) {
          sendJson(res, 500, { error: "temporary poll failure" }, { "retry-after": "0" });
          return;
        }
        sendJson(res, 200, {
          lesson: { id: "lesson_owner_queued", slug: "owner-queued", url: "/lessons/owner-queued" },
          admission: { ...READY_ADMISSION, id: admissionId },
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", lessonPath, "--as-owner"], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Transient HTTP 500 from GET .*retry 1\/3 in 0ms/);
    });
    assert.equal(polls, 2);
    const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
    assert.deepEqual(state.lessons["lesson.md"].authorship, OWNER_AUTHORSHIP);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("422 admission issues are printed with paths and codes", async () => {
  const { root, home } = await tempProject();
  const lessonPath = join(root, "lesson.md");
  await writeFile(lessonPath, LESSON);
  let requests = 0;
  try {
    await withMock((req, res) => {
      requests += 1;
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
    assert.equal(requests, 1);
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

test("state v2 preserves sibling lessons, global last works, and legacy state remains readable", async () => {
  const { root, home } = await tempProject();
  const firstPath = join(root, "first.md");
  const secondPath = join(root, "second.md");
  await writeFile(firstPath, LESSON);
  await writeFile(secondPath, LESSON.replaceAll("Mock admission lesson", "Second lesson"));
  try {
    await withMock(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/agent/lessons");
      const body = await readJsonBody(req);
      const second = body.title === "Second lesson";
      sendJson(res, 201, {
        lesson: {
          id: second ? "lesson_second" : "lesson_first",
          slug: second ? "second" : "first",
          url: second ? "/lessons/second" : "/lessons/first",
        },
        admission: READY_ADMISSION,
      });
    }, async (baseUrl) => {
      const first = await runCli(["publish", firstPath], { cwd: root, home, baseUrl });
      const second = await runCli(["publish", secondPath], { cwd: root, home, baseUrl });
      assert.equal(first.code, 0, first.stderr);
      assert.equal(second.code, 0, second.stderr);

      const state = JSON.parse(await readFile(join(root, ".luguo", "state.json"), "utf8"));
      assert.equal(state.version, 2);
      assert.equal(state.lessons["first.md"].lesson_id, "lesson_first");
      assert.equal(state.lessons["second.md"].lesson_id, "lesson_second");
      assert.deepEqual(state.last, { kind: "lesson", key: "second.md" });

      const explicit = await runCli(["open", firstPath, "--print"], { cwd: root, home, baseUrl, key: "" });
      const printBeforePath = await runCli(["open", "--print", firstPath], { cwd: root, home, baseUrl, key: "" });
      const latest = await runCli(["open", "--print"], { cwd: root, home, baseUrl, key: "" });
      const noWorkspace = await runCli(["open", firstPath, "--workspace", "--print"], { cwd: root, home, baseUrl, key: "" });
      assert.equal(explicit.stdout.trim(), `${baseUrl}/lessons/first`);
      assert.equal(printBeforePath.stdout.trim(), `${baseUrl}/lessons/first`);
      assert.equal(latest.stdout.trim(), `${baseUrl}/lessons/second`);
      assert.equal(noWorkspace.code, 1);
      assert.match(noWorkspace.stderr, /has no human workspace URL/);

      const rebasedLatest = await runCli(["open", "--print"], {
        cwd: root,
        home,
        baseUrl: "https://dev.example",
        key: "",
      });
      assert.equal(rebasedLatest.code, 0, rebasedLatest.stderr);
      assert.equal(rebasedLatest.stdout.trim(), "https://dev.example/lessons/second");

      const badFlag = await runCli(["publish", firstPath, "--as-owner=true"], { cwd: root, home, baseUrl });
      assert.equal(badFlag.code, 1);
      assert.match(badFlag.stderr, /--as-owner does not take a value/);
    });

    const stateFiles = await readdir(join(root, ".luguo"));
    const configFiles = await readdir(join(home, ".config", "luguo"));
    assert.equal(stateFiles.some((name) => name.endsWith(".tmp")), false);
    assert.equal(configFiles.some((name) => name.endsWith(".tmp")), false);

    const credentialsPath = join(home, ".config", "luguo", "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({
      api_key: TEST_KEY,
      base_url: "https://configured.example",
    }));
    const configuredSite = await runCli(["open", "--print"], {
      cwd: root,
      home,
      key: "",
    });
    assert.equal(configuredSite.code, 0, configuredSite.stderr);
    assert.equal(configuredSite.stdout.trim(), "https://configured.example/lessons/second");
    await rm(credentialsPath, { force: true });

    const legacyRoot = join(root, "legacy");
    const legacyLesson = join(legacyRoot, "legacy.md");
    await mkdir(join(legacyRoot, ".luguo"), { recursive: true });
    await writeFile(legacyLesson, LESSON);
    await writeFile(join(legacyRoot, ".luguo", "state.json"), JSON.stringify({
      lesson_id: "legacy_lesson",
      url: "https://legacy.example/lessons/legacy",
    }));
    const legacy = await runCli(["open", legacyLesson, "--print"], {
      cwd: legacyRoot,
      home,
      key: "",
    });
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.equal(legacy.stdout.trim(), "https://legacy.example/lessons/legacy");

    await withMock((req, res) => {
      assert.equal(req.method, "POST");
      sendJson(res, 201, {
        lesson: { id: "legacy_republished", slug: "legacy-republished", url: "/lessons/legacy-republished" },
        admission: READY_ADMISSION,
      });
    }, async (baseUrl) => {
      const republished = await runCli(["publish", legacyLesson], { cwd: legacyRoot, home, baseUrl });
      assert.equal(republished.code, 0, republished.stderr);
    });
    const migrated = JSON.parse(await readFile(join(legacyRoot, ".luguo", "state.json"), "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.lessons.__legacy__.lesson_id, "legacy_lesson");
    assert.equal(migrated.lessons["legacy.md"].lesson_id, "legacy_republished");
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
        sendJson(res, 200, {
          publication: { id: "pub_committed_1", status: "committed" },
          book: { id: "book_test_1", slug: "mock-book", visibility: "unlisted" },
        });
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
    assert.deepEqual(state.book.chapters[0].admission, READY_ADMISSION);
    assert.equal(state.book.publication.status, "committed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outline v1 publishes Unit -> Module -> Topic payloads and finalizes a private book", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "textbook");
  await mkdir(bookRoot);
  await writeFile(
    join(bookRoot, "luguo.yml"),
    "title: Structured book\nvisibility: private\nlanguage: en\noutline: outline.json\n",
  );
  await writeFile(join(bookRoot, "01-slope.md"), LESSON);
  await writeFile(
    join(bookRoot, "02-intercept.md"),
    LESSON
      .replaceAll("Mock admission lesson", "Intercept lesson")
      .replace("tags: [test]", "tags: [geometry, intercept]\nlanguage: fr\nemoji: 🧭"),
  );
  const outline = {
    version: 1,
    units: [{
      key: "unit-1",
      title: "Algebra foundations",
      position: 1,
      modules: [{
        key: "unit-1-module-1",
        title: "Linear relationships",
        position: 1,
        // Deliberately reversed: normalized position is authoritative.
        chapters: [
          { file: "02-intercept.md", position: 2 },
          { file: "01-slope.md", position: 1 },
        ],
      }],
    }],
  };
  await writeFile(join(bookRoot, "outline.json"), JSON.stringify(outline));
  const normalizedOutline = {
    ...outline,
    units: [{
      ...outline.units[0],
      modules: [{
        ...outline.units[0].modules[0],
        chapters: [
          { file: "01-slope.md", position: 1 },
          { file: "02-intercept.md", position: 2 },
        ],
      }],
    }],
  };
  const outlineHash = createHash("sha256")
    .update(canonicalJson(normalizedOutline))
    .digest("hex");
  const chapterBodies = [];
  const keys = [];
  try {
    await withMock(async (req, res) => {
      keys.push({ path: `${req.method} ${req.url}`, key: req.headers["idempotency-key"] });
      if (req.method === "POST" && req.url === "/api/books") {
        const body = await readJsonBody(req);
        assert.equal(body.visibility, "private");
        assert.equal(body.outline_hash, outlineHash);
        sendJson(res, 201, { book: { id: "book_outline_1", slug: "structured-book" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/books/book_outline_1/chapters") {
        const body = await readJsonBody(req);
        chapterBodies.push(body);
        const number = chapterBodies.length;
        sendJson(res, 201, {
          chapter: { id: `chapter_outline_${number}`, lesson_id: `lesson_outline_${number}` },
          lesson: { id: `lesson_outline_${number}`, slug: `outline-topic-${number}` },
          course: { id: "course_outline_1", slug: "structured-course" },
          admission: READY_ADMISSION,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/books/book_outline_1") {
        assert.deepEqual(await readJsonBody(req), { finalize: true });
        sendJson(res, 200, {
          publication: { id: "publication_outline_1", status: "committed" },
          book: { id: "book_outline_1", visibility: "private", status: "ready" },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Book published: Structured book \(2 chapter\(s\), private\)/);
    });

    assert.equal(chapterBodies.length, 2);
    assert.deepEqual(chapterBodies.map((body) => body.hierarchy.topic_position), [1, 2]);
    assert.deepEqual(chapterBodies.map((body) => body.tags), [
      ["test"],
      ["geometry", "intercept"],
    ]);
    assert.deepEqual(chapterBodies.map((body) => body.language), ["en", "fr"]);
    assert.deepEqual(chapterBodies.map((body) => body.cover_emoji), ["📚", "🧭"]);
    assert.ok(chapterBodies.every((body) => !("visibility" in body)));
    for (const body of chapterBodies) {
      assert.equal(body.outline_hash, outlineHash);
      assert.deepEqual(body.hierarchy.unit, {
        key: "unit-1", title: "Algebra foundations", position: 1,
      });
      assert.deepEqual(body.hierarchy.module, {
        key: "unit-1-module-1", title: "Linear relationships", position: 1,
      });
    }
    assert.ok(keys.every(({ key }) => /^luguo-cli-v1-[a-f0-9]{64}$/.test(String(key))));
    const state = JSON.parse(await readFile(join(bookRoot, ".luguo", "state.json"), "utf8"));
    assert.equal(state.book.outline_hash, outlineHash);
    assert.equal(state.book.outline_source, "outline.json");
    assert.deepEqual(state.book.chapters.map((chapter) => chapter.source), [
      "01-slope.md",
      "02-intercept.md",
    ]);
    assert.deepEqual(
      state.book.chapters.map((chapter) => chapter.hierarchy.topic_position),
      [1, 2],
    );
    assert.deepEqual(state.book.chapters.map((chapter) => chapter.tags), [
      ["test"],
      ["geometry", "intercept"],
    ]);
    assert.deepEqual(state.book.chapters.map((chapter) => chapter.language), ["en", "fr"]);
    assert.deepEqual(state.book.chapters.map((chapter) => chapter.cover_emoji), ["📚", "🧭"]);
    assert.equal(state.book.publication.status, "committed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outline validation fails closed before network when a publishable markdown file is unlisted", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "invalid-textbook");
  await mkdir(bookRoot);
  await writeFile(join(bookRoot, "luguo.yml"), "title: Invalid\noutline: outline.json\n");
  await writeFile(join(bookRoot, "01-listed.md"), LESSON);
  await writeFile(join(bookRoot, "02-unlisted.md"), LESSON);
  await writeFile(join(bookRoot, "outline.json"), JSON.stringify({
    version: 1,
    units: [{
      key: "u1", title: "Unit", position: 1,
      modules: [{
        key: "u1-m1", title: "Module", position: 1,
        chapters: [{ file: "01-listed.md", position: 1 }],
      }],
    }],
  }));
  let requests = 0;
  try {
    await withMock((_req, res) => {
      requests += 1;
      sendJson(res, 500, { error: "must not reach network" });
    }, async (baseUrl) => {
      const out = await runCli(["validate", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /Every publishable \.md must appear exactly once.*02-unlisted\.md/);
    });
    assert.equal(requests, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("book publish follows a 202 publication saga through atomic commit", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "book");
  await mkdir(bookRoot);
  await writeFile(join(bookRoot, "luguo.yml"), "title: Saga book\nvisibility: public\nlanguage: en\n");
  await writeFile(join(bookRoot, "01-chapter.md"), LESSON);
  let polls = 0;
  try {
    await withMock(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 200, { book: { id: "book_saga_1", slug: "saga-book" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/books/book_saga_1/chapters") {
        sendJson(res, 201, {
          chapter: { id: "chapter_saga_1", lesson_id: "lesson_saga_1" },
          lesson: { id: "lesson_saga_1", slug: "saga-chapter" },
          course: { id: "course_saga_1", slug: "saga-course" },
          admission: READY_ADMISSION,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/books/book_saga_1") {
        sendJson(res, 202, {
          queued: true,
          publication: { id: "11111111-1111-4111-8111-111111111111", status: "validating" },
          status_url: "/api/books/book_saga_1/publications/11111111-1111-4111-8111-111111111111",
        }, { location: "/api/books/book_saga_1/publications/11111111-1111-4111-8111-111111111111", "retry-after": "0" });
        return;
      }
      if (req.method === "GET" && req.url === "/api/books/book_saga_1/publications/11111111-1111-4111-8111-111111111111") {
        polls += 1;
        if (polls === 1) {
          sendJson(res, 202, {
            queued: true,
            publication: { id: "11111111-1111-4111-8111-111111111111", status: "committing" },
          }, { "retry-after": "0" });
          return;
        }
        sendJson(res, 200, {
          publication: { id: "11111111-1111-4111-8111-111111111111", status: "committed" },
          book: { id: "book_saga_1", slug: "saga-book", visibility: "public" },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Publication 11111111-1111-4111-8111-111111111111 queued/);
      assert.match(out.stdout, /Book published: Saga book/);
    });
    assert.equal(polls, 2);
    const state = JSON.parse(await readFile(join(bookRoot, ".luguo", "state.json"), "utf8"));
    assert.deepEqual(state.book.publication, {
      id: "11111111-1111-4111-8111-111111111111",
      status: "committed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner book publish carries owner scope through every mutation and publication poll", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "owner-book");
  await mkdir(bookRoot);
  await writeFile(join(bookRoot, "luguo.yml"), "title: Owner book\nvisibility: unlisted\nlanguage: en\n");
  await writeFile(join(bookRoot, "01-chapter.md"), LESSON);
  const runId = "44444444-4444-4444-8444-444444444444";
  const ownerRequests = [];
  let publicationPolls = 0;
  try {
    await withMock((req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/agent/home") {
        assert.equal(req.headers["x-luguo-act-as"], undefined);
        sendJson(res, 200, OWNER_HOME);
        return;
      }
      assert.equal(req.headers["x-luguo-act-as"], "owner");
      ownerRequests.push(`${req.method} ${req.url}`);
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 200, {
          book: { id: "book_owner_1", slug: "owner-book" },
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/books/book_owner_1/chapters") {
        sendJson(res, 201, {
          chapter: { id: "chapter_owner_1", lesson_id: "lesson_owner_chapter_1" },
          lesson: { id: "lesson_owner_chapter_1", slug: "owner-chapter" },
          course: { id: "course_owner_1", slug: "owner-course" },
          admission: READY_ADMISSION,
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/books/book_owner_1") {
        const statusUrl = `/api/books/book_owner_1/publications/${runId}`;
        sendJson(res, 202, {
          queued: true,
          publication: { id: runId, status: "validating" },
          status_url: statusUrl,
        }, { location: statusUrl, "retry-after": "0" });
        return;
      }
      if (req.method === "GET" && req.url === `/api/books/book_owner_1/publications/${runId}`) {
        publicationPolls += 1;
        if (publicationPolls === 1) {
          sendJson(res, 429, { error: "temporarily rate limited" }, { "retry-after": "0" });
          return;
        }
        sendJson(res, 200, {
          publication: { id: runId, status: "committed" },
          book: { id: "book_owner_1", slug: "owner-book", visibility: "unlisted" },
          authorship: OWNER_AUTHORSHIP,
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", "--as-owner", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /author\s+@mock-owner \(via @mock-agent\)/);
      assert.match(out.stdout, /Transient HTTP 429 from GET .*retry 1\/3 in 0ms/);
      assert.match(out.stdout, new RegExp(`${baseUrl}/create/book_owner_1`));

      const state = JSON.parse(await readFile(join(bookRoot, ".luguo", "state.json"), "utf8"));
      assert.equal(state.book.publish_as, "owner");
      assert.deepEqual(state.book.authorship, OWNER_AUTHORSHIP);
      assert.deepEqual(state.book.chapters[0].authorship, OWNER_AUTHORSHIP);
      assert.equal(state.book.workspace_url, `${baseUrl}/create/book_owner_1`);

      const opened = await runCli(["open", "--workspace", "--print"], { cwd: root, home, baseUrl, key: "" });
      assert.equal(opened.code, 0, opened.stderr);
      assert.equal(opened.stdout.trim(), `${baseUrl}/create/book_owner_1`);
    });
    assert.deepEqual(ownerRequests, [
      "POST /api/books",
      "POST /api/books/book_owner_1/chapters",
      "PATCH /api/books/book_owner_1",
      `GET /api/books/book_owner_1/publications/${runId}`,
      `GET /api/books/book_owner_1/publications/${runId}`,
    ]);
    assert.equal(publicationPolls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner book publish fails closed at create, chapter, and final publication authorship", async () => {
  const { root, home } = await tempProject();
  try {
    for (const stage of ["book", "chapter", "publication"]) {
      const bookRoot = join(root, `book-${stage}`);
      await mkdir(bookRoot);
      await writeFile(join(bookRoot, "luguo.yml"), `title: ${stage} receipt\nvisibility: unlisted\nlanguage: en\n`);
      await writeFile(join(bookRoot, "01-chapter.md"), LESSON);
      await withMock((req, res) => {
        if (req.method === "GET" && req.url === "/api/v1/agent/home") {
          sendJson(res, 200, OWNER_HOME);
          return;
        }
        assert.equal(req.headers["x-luguo-act-as"], "owner");
        if (req.method === "POST" && req.url === "/api/books") {
          sendJson(res, 200, {
            book: { id: `book_${stage}`, slug: `book-${stage}` },
            ...(stage === "book" ? {} : { authorship: OWNER_AUTHORSHIP }),
          });
          return;
        }
        if (req.method === "POST" && req.url === `/api/books/book_${stage}/chapters`) {
          sendJson(res, 201, {
            chapter: { id: `chapter_${stage}`, lesson_id: `lesson_${stage}` },
            lesson: { id: `lesson_${stage}`, slug: `lesson-${stage}` },
            course: { id: `course_${stage}`, slug: `course-${stage}` },
            admission: READY_ADMISSION,
            ...(stage === "chapter" ? {} : { authorship: OWNER_AUTHORSHIP }),
          });
          return;
        }
        if (req.method === "PATCH" && req.url === `/api/books/book_${stage}`) {
          sendJson(res, 200, {
            publication: { id: `publication_${stage}`, status: "committed" },
            book: { id: `book_${stage}`, visibility: "unlisted" },
            ...(stage === "publication" ? {} : { authorship: OWNER_AUTHORSHIP }),
          });
          return;
        }
        sendJson(res, 404, { error: "Not found" });
      }, async (baseUrl) => {
        const out = await runCli(["publish", bookRoot, "--as-owner"], { cwd: root, home, baseUrl });
        assert.equal(out.code, 1);
        assert.match(out.stderr, /did not return an authorship receipt/);
      });
      await assert.rejects(readFile(join(bookRoot, ".luguo", "state.json"), "utf8"), /ENOENT/);
    }
    await assert.rejects(readFile(join(home, ".config", "luguo", "last-publish.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("book publication saga fails closed when its status endpoint returns 422", async () => {
  const { root, home } = await tempProject();
  const bookRoot = join(root, "book");
  await mkdir(bookRoot);
  await writeFile(join(bookRoot, "luguo.yml"), "title: Rejected book\nvisibility: public\nlanguage: en\n");
  await writeFile(join(bookRoot, "01-chapter.md"), LESSON);
  const runId = "22222222-2222-4222-8222-222222222222";
  try {
    await withMock(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/books") {
        sendJson(res, 200, { book: { id: "book_rejected_1", slug: "rejected-book" } });
        return;
      }
      if (req.method === "POST" && req.url === "/api/books/book_rejected_1/chapters") {
        sendJson(res, 201, {
          chapter: { id: "chapter_rejected_1", lesson_id: "lesson_rejected_1" },
          lesson: { id: "lesson_rejected_1", slug: "rejected-chapter" },
          course: { id: "course_rejected_1", slug: "rejected-course" },
          admission: READY_ADMISSION,
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/books/book_rejected_1") {
        const statusUrl = `/api/books/book_rejected_1/publications/${runId}`;
        sendJson(res, 202, {
          queued: true,
          publication: { id: runId, status: "validating" },
          status_url: statusUrl,
        }, { location: statusUrl, "retry-after": "0" });
        return;
      }
      if (req.method === "GET" && req.url === `/api/books/book_rejected_1/publications/${runId}`) {
        sendJson(res, 422, {
          error: "chapter admission failed",
          publication: { id: runId, status: "failed" },
        });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    }, async (baseUrl) => {
      const out = await runCli(["publish", bookRoot], { cwd: root, home, baseUrl });
      assert.equal(out.code, 1);
      assert.match(out.stderr, /HTTP 422: chapter admission failed/);
    });
    await assert.rejects(readFile(join(bookRoot, ".luguo", "state.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
