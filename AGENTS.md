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
- 禁止修改 Prisma schema（**已批准的 schema 例外只有九项，见 `docs/AI_CONTRACT.md` §2「已批准的例外」**：① 第九批给 `users` 加 `avatar` / `bio` 两列；② 第十批新建 `likes` 一张表；③ 分类功能给 `articles` 加 `category` 一列；④ 第 4 批新建 `follows` 一张表（含两条外键与两个索引，无软删列）；⑤ 第 5 批给 `users` 加 `role` / `status` 两列（Prisma enum，均带默认值）；⑥ 第 6 批给 `articles` 加 `status` 一列（Prisma enum `ArticleStatus { DRAFT, PUBLISHED }`，默认 `PUBLISHED`）；⑦ 第 6 批新建 `article_revisions` 一张表（版本快照，外键 `article_id` → `articles.id` `ON DELETE CASCADE`）；⑧ 第 7 批新建 `tags` 与 `article_tags` 两张表（标签多对多，`tags.name` 唯一约束，`article_tags` 联合主键 + 双 Cascade 外键）；⑨ 第 7 批给 `comments` 加 `parent_id` 一列（父评论自引用，`ON DELETE CASCADE`，索引 `comments_parent_id_idx`）。除此之外任何表结构变更都需重新向用户报批）
- 禁止新增 npm 依赖（**已批准的依赖例外只有两项，见 `docs/AI_CONTRACT.md` §2「已批准的例外」第 3、7 项**：① `multer ^2.4.0`（后端，仅用于头像上传）；② 第 5 批前端三包一组 `marked ^18.1.1` / `highlight.js ^11.12.0` / `dompurify ^3.4.17`（仅用于文章详情页 Markdown 渲染、代码高亮与 XSS 净化）。除此之外任何新依赖都需重新向用户报批）
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

## 文档改动核对

改 `docs/*.md` 或根目录的 md 文件时，按这四步：

1. **改前记基线**：`grep "^## " <文件>`，把输出全列留下。
2. **用 Edit 工具按整行匹配改**，不要写脚本按行号切片——按行号切会吞掉相邻章节（`docs/AI_CONTRACT.md` 的 §12 曾因此丢过三次）。
3. **改后逐行比对**：`grep "^## " <文件>` 再输出一遍，与基线对照——数量一致、序号连续、标题文本一致。
4. **`git diff --numstat` 复核**：如出现「数字突变」（比如突然 -20 行以上），停下查清原因再继续。

- **`docs/ARCHITECTURE.md` 同样受本四步约束**：它是第 3 批引入的架构视图文档，含多张 Mermaid 图的 `##` 章节；改它时改前/改后都要 `grep "^## "` 留全列比对，防止整张图被吞。它与 `AI_CONTRACT.md` / `API.md` / `DB.md` / `ACCEPTANCE.md` / `CODING_STYLE.md` 一并视为「项目文档集」，改动任一都走这四步。

`grep -c "^## "` 只数数量，能发现整块丢失、发现不了「数量不变但标题被换」。核对一律用 `grep "^## "` 输出全列，不用 `-c`。

## 测试纪律（探针清理铁律）

**【探针清理铁律】** 所有自动化探针和 fixtures 的 finally 清理逻辑，绝对禁止使用 `deleteMany({})` 或基于跨表关联条件删除（如 `where: { article: { authorId: { in: [...] } } }` 这类经关系字段跨表命中的写法）。必须收集本次跑批明确创建的实体主键 ID，按 `id: { in: [...] }` 精确清理。

- 背景：2026-10-18 事故——probe-nested-comment 用 `article.authorId` 连表删除，把库内真实评论数据全表清零。跨表关联条件的命中范围不受探针掌控，一旦关联字段取值异常（如 null 过滤失误）就会扫到库内既有数据。
- 后端自分配主键、探针拿不到的行（如 `article_revisions`）：先按「本趟创建的文章 id」这类**直接外键列**查出 id，再按 `id: { in: [...] }` 删。
- 探针自造的独立命名空间数据（如带时间戳前缀的 tags）：同样先查 id 再按 id 删，不做前缀直接 deleteMany 以外的任何宽泛删除。
- 探针必须内置**跑前/跑后全表行数自检**：跑前记 `count()` 基线，finally 清完后复查，行数下降即 FAIL-SAFE 置 exit=1 并打日志。

## 提交与推送

- 本地 `commit` 可以，但 **`git push` 必须先拿到用户明确指令**。
- `README.md`、`.workbuddy/memory/` 下的文件按项目规矩**不提交**。
- **禁止 `git add -A` / `git add .`**：这两条会把不提交的文件一并带上，必须显式列文件路径。
