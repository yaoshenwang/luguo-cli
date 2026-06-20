# luguo-cli

用任意 AI 开发 agent 把 **luma-md 课程**发布到 [炉果](https://luguo.ai)。一节课就是
一个 Markdown 文件——标准 Markdown 加上几个 `:::` 教学围栏——用 `luguo publish` 发布。
它和网页编辑器存的是同一种 luma-md 格式，所以你发布什么，学习者就学什么。

CLI 零运行时依赖，要求 Node.js 18+。

## 安装

```bash
npm i -g luguo-cli
```

也可以直接运行：

```bash
npx luguo-cli@latest help
```

## 快速开始

```bash
# 先在 https://luguo.ai/settings 创建 Agent key。
luguo login --key luguo_xxx
luguo init my-lesson
cd my-lesson
luguo validate
luguo publish
luguo open
```

`login` 会把 CLI 绑定到一个站点并记住它：用 `--env dev`（或 `--base-url <url>`）
指向 dev 预览，`--env prod` 指向生产（默认）。要在新版成为正式发布前先测，从
`beta` 通道安装（`@latest` 仍是稳定版）：

```bash
npm i -g luguo-cli@beta
luguo login --key luguo_xxx --env dev
```

## 一节课就是一个文件

`luguo init` 会生成 `my-lesson/lesson.md`：

```md
---
title: 一次函数与斜率
summary: 用两点求斜率，理解 k 的正负含义
tags: [数学, 一次函数]
visibility: private
---

# 一次函数与斜率

一次函数写作 $y = kx + b$，其中 $k$ 是斜率。

:::keypoints 核心概念
- **斜率 k**：y 的变化量 ÷ x 的变化量
- **截距 b**：直线与 y 轴交点的纵坐标
:::

:::quiz 斜率为负代表什么？
- [ ] 直线水平
- [x] 直线从左上向右下倾斜
@explain k < 0 时 x 增大、y 减小。
:::
```

正文是标准 Markdown；`---` frontmatter（全部可选）携带
`title` / `summary` / `tags` / `visibility` / `language` / `emoji`。

## luma-md 围栏

| 围栏 | 作用 |
| --- | --- |
| `:::quiz <题干>` | 选择题；选项 `- [x] 正确` / `- [ ] 错误`；`@explain`、`@skills`、`@steps` |
| `:::keypoints <标题>` | `- **术语**：定义` 的要点列表 |
| `:::example <标题>` | 题目正文，再写 `1.`/`2.` 步骤；`@approach`、`@answer` |
| `:::tip` / `:::warn` / `:::note <标题>` | 提示框（内部可写 Markdown） |
| `:::polypad <标题>` | 互动数学画布；`@prompt`，再跟一段 `json` 围栏 spec |
| `---` | 分隔线（强制断幕） |

覆盖所有知识点，至少放一道 `:::quiz`。炉果解析不了的围栏会降级成普通 Markdown，
绝不会炸掉整页。

## 命令

| 命令 | 作用 |
| --- | --- |
| `luguo login [--key …] [--base-url …]` | 用已有 Agent key 登录 |
| `luguo doctor` / `luguo status` | 检查连通性和身份 |
| `luguo skill [--save]` | 查看/保存线上 luma-md 契约 |
| `luguo init [dir]` | 生成 luma-md 课程脚手架（`dir/lesson.md`） |
| `luguo validate [file.md\|dir] [--local]` | 本地 lint，再到服务端校验 |
| `luguo publish [file.md\|dir]` | 把课程发布为 luma-md |
| `luguo lessons` | 列出本 agent 最近的课程 |
| `luguo open [dir] [--print]` | 打开最近发布的课程 |

`publish` 支持 `--visibility`、`--title`、`--summary`、`--tags`、`--emoji`
覆盖 frontmatter。

## 凭证

凭证存放在：

```txt
~/.config/luguo/credentials.json
```

环境变量覆盖：

```bash
LUGUO_BASE_URL=https://dev-luguo.vercel.app
LUGUO_API_KEY=luguo_xxx
```

线上格式契约始终在 `https://luguo.ai/skill.md`（或运行 `luguo skill`）。
