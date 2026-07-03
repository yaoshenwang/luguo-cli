# luguo-cli

把书籍项目发布到 [炉果](https://luguo.ai)。默认 `publish` 会创建与 `/books/new`
编辑器一致的 `ContentDocument`，所以 CLI 产物可以直接在当前炉果编辑器里继续打开和编辑。

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
luguo init book my-book
cd my-book
luguo validate
luguo publish
luguo open
```

测试其他炉果部署时，在 `login` 后加 `--base-url`。

## 书籍项目

```txt
my-book/
├─ luguo.yml
└─ chapters/
   ├─ 01-intro.md
   └─ 02-bayes.md
```

`luguo.yml`：

```yaml
title: 用生活例子学概率
summary: 用奶茶、抽卡和天气例子理解概率基础。
audience: 高中到大学低年级
language: zh
visibility: private
chapters:
  - chapters/01-conditional-probability.md
```

章节 Markdown：

```md
# 条件概率是什么

条件概率是在某个条件已经发生时，另一件事发生的可能性。

# 小练习

已知 P(H)=0.3，P(E|H)=0.7，P(E)=0.5。请计算 P(H|E)。
```

## JSON 书籍

也可以发布标准 JSON 书籍项目：

```bash
luguo validate examples/book.json
luguo publish examples/book.json
```

如果你已经有 `/books/new` 编辑器 JSON（`{ "version": "1", "blocks": ... }`），也可以直接发布：

```bash
luguo validate document.json
luguo publish document.json --title "我的书"
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `luguo login [--key …] [--base-url …]` | 使用已有 key |
| `luguo doctor` / `luguo status` | 检查连通性和身份 |
| `luguo skill [--save]` | 查看线上 Book 契约 |
| `luguo init book <dir>` | 创建书籍项目 |
| `luguo validate [dir\|book.json\|document.json\|chapter.md]` | 校验书籍项目或编辑器 `ContentDocument` |
| `luguo publish [dir\|book.json\|document.json\|chapter.md]` | 发布为当前编辑器兼容的文档 |
| `luguo books` | 列出最近由本 agent 创建的编辑器书籍 |
| `luguo open [dir] [--print]` | 打开最近发布的结果 |

旧命令和选项如 `register`、`material create`、`plan create`、`publish --as-source`
已从支持面移除，会提示改用当前编辑器工作流。

## 凭证

凭证存放在：

```txt
~/.config/luguo/credentials.json
```

环境变量覆盖：

```bash
LUGUO_BASE_URL=https://dev.luguo.ai
LUGUO_API_KEY=luguo_xxx
```
