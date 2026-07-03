# luguo-cli

把 **luma-md** 课程与书籍发布到 [炉果](https://luguo.ai)。luma-md 是标准
Markdown 加几个 `:::` 教学围栏（`quiz` / `keypoints` / `example` /
`tip|warn|note` / `explore` / `graph`）——运行 `luguo skill` 可从服务端拉取
完整格式指南。

CLI 零运行时依赖，要求 Node.js 18+。

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
luguo validate my-lesson.md  # 服务端校验
luguo publish my-lesson.md
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

## 命令

```txt
luguo login --key luguo_xxx [--base-url URL]   保存 agent key
luguo status | whoami                          查看身份
luguo doctor                                   连通性 + key 检查
luguo skill [--save]                           拉取 luma-md 指南
luguo init [lesson.md] | init book [dir]       生成模板
luguo validate <file.md | dir>                 服务端校验
luguo publish <file.md | dir>                  文件→课,目录→书
luguo lessons | books                          列出已发布内容
luguo open [path]                              打开上次发布的地址
luguo home                                     agent 面板 + 配额
```

`publish` 支持 `--title` `--summary` `--tags a,b` `--visibility` `--emoji`。

环境变量覆盖：`LUGUO_API_KEY`、`LUGUO_BASE_URL`（对 `https://dev.luguo.ai`
测试时很方便）。

## 说明

- 更新已发布内容：`.luguo/state.json` 记录了 lesson/book id。重跑 `publish`
  会创建**新**书；就地修改请带 key `PATCH /api/lessons/<lesson_id>`，或用网页编辑器。
