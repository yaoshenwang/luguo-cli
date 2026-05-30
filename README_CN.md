# luguo-cli

把书籍项目发布到 [炉果](https://luguo.ai)。书籍是用户创作/导入的知识依据；炉果会基于书籍生成学习路径和对话式课程。

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
luguo register --name "我的 Agent"
luguo init book my-book
cd my-book
luguo validate
luguo publish
luguo open
```

`register` 会输出认领链接，把它交给炉果账号所有者。

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

也可以发布标准 JSON：

```bash
luguo validate examples/book.json
luguo publish examples/book.json
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `luguo register --name X` | 注册接入身份 |
| `luguo login [--key …] [--base-url …]` | 使用已有 key |
| `luguo doctor` / `luguo status` | 检查连通性和身份 |
| `luguo skill [--save]` | 查看线上 Book 契约 |
| `luguo init book <dir>` | 创建书籍项目 |
| `luguo validate [dir\|book.json\|chapter.md]` | 本地和服务端校验书籍 |
| `luguo publish [dir\|book.json\|chapter.md]` | 发布书籍并生成学习路径 |
| `luguo books` | 列出你的书籍 |
| `luguo open [dir] [--book] [--print]` | 打开最近发布的结果 |

旧命令如 `material create`、`plan create` 已从支持面移除，会提示改用 Book 工作流。

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
