# 本项目 AI 协作规则

开始任何代码任务前，必须先读：

- docs/AI_CONTRACT.md   协作总约束（技术栈、禁止事项、验收硬性门槛）
- docs/API.md           接口契约（路径、参数、响应、业务码）
- docs/DB.md            数据库文档（表结构、字段、迁移）
- docs/CODING_STYLE.md  代码风格
- docs/ACCEPTANCE.md    验收说明书（跑什么、怎么跑、已知边界）

禁止事项：

- 禁止更换 Vue / Express / Prisma / MySQL
- 禁止修改接口路径、请求/响应字段
- 禁止修改 Prisma schema（**已批准的 schema 例外只有三项，见 `docs/AI_CONTRACT.md` 第 2 节「已批准的例外」**：① 第九批给 `users` 加 `avatar` / `bio` 两列；② 第十批新建 `likes` 一张表；③ 分类功能给 `articles` 加 `category` 一列。除此之外任何表结构变更都需重新向用户报批）
- 禁止新增 npm 依赖（**已批准的依赖例外只有一项，见同一小节第 3 项**：`multer ^2.4.0`，仅用于头像上传）
- 禁止升级大版本依赖
- 禁止明文存密码、生成真实密钥/token
- 禁止手拼 SQL、SELECT *

代码风格：

- 2 空格缩进、单引号、语句加分号
- 前端 <script setup>，后端 ESM
- 统一响应 { code, message, data }
- 所有接口入参用 zod 校验

如果任务会碰到以上“禁止项”，先列问题，不要直接改。

## 指向根目录的说明

本文件在仓库根目录，**根目录没有 `AI_CONTRACT.md`**，协作总约束在 `docs/AI_CONTRACT.md`。
（早期版本曾把两者混指，导致按 `AI_CONTRACT.md` 去找会找不到文件。）

## 提交与推送

- 本地 `commit` 可以，但 **`git push` 必须先拿到用户明确指令**。
- `README.md`、`.workbuddy/memory/` 下的文件按项目规矩**不提交**。
- **禁止 `git add -A` / `git add .`**：这两条会把不提交的文件一并带上，必须显式列文件路径。
