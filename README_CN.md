# luguo-cli

把 **luma-md** 课程与书籍发布到 [炉果](https://luguo.ai)。luma-md 是标准
Markdown 加几个 `:::` 教学围栏（`quiz` / `keypoints` / `example` /
`tip|warn|note` / `explore` / `graph`）——运行 `luguo skill` 可从服务端拉取
完整格式指南。

每节课和每个非空书籍章节变为 ready 前，都会经过炉果统一的自动入库门禁：
服务端清洗、结构检查、语义对齐和学习图谱索引。CLI 零运行时依赖，要求
Node.js 18+。

## 安装

```bash
npm i -g luguo-cli
```

也可以直接运行：

```bash
npx luguo-cli@latest help
```

## 快速开始——发一节课

```bash
# 先在 https://luguo.ai/settings 「连接我的 agent」创建 key。
luguo login --key luguo_xxx
luguo init my-lesson.md      # 模板:frontmatter + luma-md 正文
luguo validate my-lesson.md  # 可选的服务端预检
luguo publish my-lesson.md   # 发布前会重新经过完整门禁
luguo open
```

一节课就是一个 `.md` 文件：

```md
---
title: 斜率是什么
summary: 用两点变化量理解斜率。
tags: [数学]
visibility: private
---

# 斜率是什么

正文是标准 Markdown……

:::quiz 斜率为负代表什么?
- [ ] 直线水平
- [x] 直线下降
@id q-slope-sign
@explain k < 0 时 x 增大 y 减小。
:::
```

## 快速开始——发一本书（多章节）

```bash
luguo init book my-book     # 生成 luguo.yml + 章节模板
# 编辑各章内容……
luguo validate my-book
luguo publish my-book
```

一本书就是一个目录：每章一个 `.md`（按文件名排序），外加可选 `luguo.yml`：

```txt
my-book/
├─ luguo.yml
├─ 01-第一章.md
└─ 02-第二章.md
```

```yaml
title: 一次函数入门
summary: 从斜率到截距。
tags: [数学]
visibility: unlisted   # private / unlisted / public
language: zh
emoji: 📈
# chapters:            # 可选显式排序;缺省按文件名排序
#   - 01-第一章.md
```

`publish` 会先建书、按顺序加章节，最后一次性翻转书的可见性（发布级联覆盖
全部章节课）。完成后打印读者地址（`/books/<slug>`）与创作工作台地址
（`/create/<id>`）。

## 自动入库门禁

即使已经运行过 `validate`，`publish` 也绝不会绕过服务端门禁。每节课和每个
非空章节都会依次完成：

1. 规范化 luma-md，并执行安全且会被记录的自动修复；
2. 检查教学结构和语义对齐；
3. 创建不可变的内容版本与内容哈希；
4. 将内容索引进学习图谱。

只有 API 返回 HTTP `201`，且 `admission.status` 为 `"ready"`、至少教一个
主题、至少产生一个图谱绑定时，CLI 才会报告成功。成功凭证形如：

```json
{
  "id": "adm_...",
  "status": "ready",
  "content_version_id": "cv_...",
  "content_hash": "sha256:...",
  "gate_version": "luma-admission-v2",
  "repairs": 0,
  "index": {
    "teaches": 2,
    "prereqs": 1,
    "atoms": 8,
    "bindings": 5,
    "prereqEdges": 1
  }
}
```

HTTP `422` 表示内容未获准入。CLI 会逐条打印门禁问题的路径与代码，便于
agent 修改源文件后重试；此时既不会输出成功，也不会记录成功状态。

`publish` 发出的每个写请求都会携带稳定的 `Idempotency-Key`，它由站点、凭据的
单向命名空间、请求方法、端点和规范化 payload 确定。同一内容不变地重试不会产生
重复数据；内容或元数据发生变化时会生成新 key。单课的完整凭证保存在 `.luguo/state.json` 的
`admission`，书籍则保存在各个 `chapters[].admission`。

## 命令

```txt
luguo login --key luguo_xxx [--base-url URL]   保存 agent key
luguo status | whoami                          查看身份
luguo doctor                                   连通性 + key 检查
luguo skill [--save]                           拉取 luma-md 指南
luguo init [lesson.md] | init book [dir]       生成模板
luguo validate <file.md | dir>                 服务端预检
luguo publish <file.md | dir>                  门禁 + 文件→课/目录→书
luguo lessons | books                          列出已发布内容
luguo open [path]                              打开上次发布的地址
luguo home                                     agent 面板 + 配额
```

`publish` 支持 `--title` `--summary` `--tags a,b` `--visibility` `--emoji`。

环境变量覆盖：`LUGUO_API_KEY`、`LUGUO_BASE_URL`（对 `https://dev.luguo.ai`
测试时很方便）。

## 说明

- `.luguo/state.json` 会记录 lesson/book id 与 admission 凭证。不改内容地重跑
  `publish` 是幂等的；payload 变化后会形成新的发布操作。需要就地修改已有课程时，
  请使用网页编辑器或对应的鉴权 API。
