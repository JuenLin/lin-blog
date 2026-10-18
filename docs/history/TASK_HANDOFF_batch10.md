<!-- 文档：TASK_HANDOFF_batch10.md | 定位：历史归档 | 核心：第 10 批功能交接单、现场封存与后续步骤。 -->

# 第 10 批交接单（TASK_HANDOFF）

> 生成时间：2026-10-18 16:45（用户紧急指令：更换 AI 模型，防御性封存现场）
> 状态：**开发中断，未 commit、未回归**。新模型接手后从「后续步骤」第 1 项接着做。

## 一、当前批次

**第 10 批：文章图片上传 + 专栏系列**（接口 47 → 53，schema 例外 14 → 15 项）

## 二、进度描述（截至封存）

| 环节 | 状态 | 说明 |
|---|---|---|
| 文档四步（API/DB/AI_CONTRACT/ROADMAP） | ✅ **已完成**（未 commit） | API.md +219/-3（新章节「文章图片上传与专栏系列（第 10 批）」+ 文章 POST/PUT 三态 + 失败码表补 409）；DB.md +104/-8（series 表小节 + 第 10 批顶层节 + 硬删序加 series + 外键 11→13 + 迁移记录）；AI_CONTRACT.md +15/-3（路径清单 +6、接口总数 47→53、例外第 15 项）；ROADMAP.md +10/-1（插队候选加「图片孤儿清理」+ 本轮拍板记录 5 条）。四步纪律已做：改前后 `grep "^## "` 全列比对无丢节 |
| migrate | ✅ **已执行**：`20261018082357_add_series` | 新建 `series` 表（title/description/authorId/时间戳，author_id → users.id **RESTRICT**）；`articles` 加 `series_id INT NULL`（→ series.id **SET NULL**，全库第一条 SET NULL 外键）与 `series_order INT NULL`。`SHOW CREATE TABLE` + `information_schema.REFERENTIAL_CONSTRAINTS` 已核实两条规则；17 行既有文章两列全 NULL 零回填。Prisma client 已 generate |
| schema.prisma | ✅ 已改 | Series 模型 + Article.seriesId/seriesOrder（onDelete: SetNull）+ User.series 关系 |
| 后端代码 | ✅ **已完成并冒烟通过**（未 commit） | 新：`validators/series.validator.js`、`services/series.service.js`、`controllers/series.controller.js`、`routes/series.routes.js`（含 userSeriesRouter 挂 /users/:id/series）；改：`utils/upload.js`（ARTICLE_SUBDIR/ARTICLE_FIELD 常量）、`services/upload.service.js`（buildUploader 工厂泛化，avatarUpload 行为不变 + articleImageUpload + toUploadUrl/toAvatarUrl 别名）、`validators/article.validator.js`（两字段三态 + superRefine 跨字段规则）、`services/article.service.js`（详情透出 seriesId/seriesOrder + create/update 绑定助手 requireOwnSeries/isSeriesOrderFree/nextSeriesOrder/resolveSeriesBindingFor*）、`controllers/article.controller.js`（uploadImage）、`routes/article.routes.js`（POST /upload-image 注册在 /:id 前）、`routes/index.js`（挂载）。**冒烟实测**：上传 5 态全对（200+url / 非图 40000 / 超2MB 40000 / 无token 401 / 缺文件 40000）、系列 CRUD、自动 max+1（order=1）、409 冲突、解绑双清（seriesId/seriesOrder 同时 null）、删系列 unboundCount。冒烟残留已清（基线 users=6 / articles=17 / series=0） |
| 前端代码 | 🟡 **约 60%** | ✅ 已完成：`api/article.js`（uploadArticleImage）、`api/series.js`（新，5 个函数）、`views/ArticleEditor.vue`（插入图片按钮 + 粘贴拦截非图片 + 光标插入 + 系列下拉 + 序号框 + 三态载荷：editPublished 未动系列则不发两键）。❌ 未开始：`views/ArticleDetail.vue`（系列横幅 + 系列内上/下篇）、`views/UserProfile.vue`（系列 Tab） |
| 探针 | ❌ 未开始 | probe-image-upload.mjs（~6 项）、probe-series.mjs（~15 项）都没写 |
| 基建清理序 | ❌ **未做（重要！）** | `lib/tmp-account.mjs` 与 `lib/fixtures.mjs` 的硬删序还没加 series。series.author_id 是 RESTRICT，不补则探针清理撞 P2003（第 8/9 批同款教训） |
| 回归三连 | ❌ 未跑 | 前端 build / run.mjs / 两个新探针都未跑 |
| commit | ❌ 未 commit | 第 10 批所有改动都在工作区。HEAD 仍是 `ee0b114`（第 9 批挂账修复的 fix(probe)） |

## 三、5 个决策点（用户 2026-10-18 拍板，原样留存）

1. **孤儿图片文件：MVP 不清，挂账** —— 解析正文 markdown 反查文件并删除，成本和风险都太高（正文可能被并发修改、图片可能被外部引用）。已在 ROADMAP.md「插队候选」加一条：「图片孤儿清理：文章删除后 /uploads/articles/* 的清理（推荐方案：定时任务扫描未被任何文章正文引用的文件）」。本批不实现。
2. **GET /api/users/me/series：不加 /me 变体，复用 GET /users/:id/series** —— 理由：series 没有"草稿/私密"概念，本来就是公开列表，就像 /users/:id/articles 一样。前端编辑器里直接用 userStore.user.id 传参即可。加 /me 变体是冗余，破坏「/me 系列 = 需要登录才能看的自己专属数据」的语义（likes/bookmarks/drafts 才需要 /me）。接口数是 47 + 6 = 53（不加 /me 变体）。
3. **seriesId/seriesOrder 三态：采纳** —— 与 PUT /users/me 的 avatar/bio 三态同范式（不传=不改 / null=解绑 / 有值=绑定）。新建时如果传了 seriesId，后端必须校验 series.authorId === 当前用户，否则 403/404。同理 PUT 时如果改 seriesId 也必须校验新系列的归属。
4. **系列导航位置：详情页顶部** —— 位置：在文章 meta 行（分类/标签下方、正文上方）显示一个系列横幅「本文属于《xxx》系列，第 N 篇 / 共 M 篇」，带上/下篇按钮。不动底部全局的 prev/next（那是时间线维度的），两者语义正交，不混装。前端复用现有 neighborWindow 模式。
5. **seriesOrder 同系列冲突：409 拒绝，但新建时未传则自动 max+1** —— 用户显式传了 seriesOrder 但和已有的冲突 → 409/40900（必须让用户明确选择）。新建时未传 seriesOrder → 后端自动取该系列当前最大 order + 1（用户大多数情况不需要手动填）。PUT 时未传 seriesOrder → 保留原值（三态语义）。不做服务端自动重排——用户可能有意识地想插入到中间，自动重排会打乱他的预期。

## 四、写代码时必须守住的防坑（用户特别叮嘱）

- 图片上传：multer 字段名用 **'image'**，落盘路径 `/uploads/articles/{userId}/`，前端粘贴时必须拦截 clipboardData.files 里的非图片类型（防止用户粘贴一个 word 文档进来）。【已实现】
- 系列归属：`POST /api/series/:id` 的 PUT/DELETE 必须校验当前用户 role=ADMIN 或 series.authorId=当前用户。【已实现：requireSeriesManagePermission】
- 三态实现：**seriesId=null 解绑文章时，seriesOrder 必须同时置 null**（不能留一个孤儿 order）。【已实现：resolveSeriesBindingForUpdate 解绑分支双清】
- 硬删序更新：`tmp-account.mjs` 和 `fixtures.mjs` 里 series 必须排在 articles 之后（因为有 articles.series_id → series.id 的 SET NULL FK），否则硬删系列前要先解绑。【**未做，接手先补这条**】

## 五、后续步骤清单（新模型接手后照此往下做）

1. **补基建清理序**：`scripts/acceptance/lib/tmp-account.mjs` 的 cleanupProbeAccounts 与 `lib/fixtures.mjs` 的 cleanupFixtures，在 articles 之后、users 之前加 series（顺序：notifications → bookmarks → likes → follows → comments → articles → **series** → users）。series 无软删，物理删。
2. **写前端剩余两文件**：
   - `views/ArticleDetail.vue`：load() 里 article.seriesId != null 时调 `getSeries(id)`（api/series.js 已导出）；在 meta 行/标签行下方、正文上方加系列横幅（「本文属于《xxx》系列，第 N 篇 / 共 M 篇」+ 上/下篇按钮，N = 列表下标+1，M = articles.length）；换文章（watch route.params.id → load）时复位 series 状态；全局 prev/next 不动。
   - `views/UserProfile.vue`：加「系列」Tab（**公开**，不对 isOwner 设限——系列列表是公开数据）；seriesState 走 makeTabState 模式；loadSeries 调 listUserSeries(targetId, {page, pageSize})；handleTabChange / handlePageChange / resetAll 各加一个分支；行渲染用自定义行（标题/描述/篇数/创建时间，无详情页可跳，参考 drafts 行的写法）。注意 UserProfile.vue 有历史 bug 教训：切 Tab 必须「清空 + 发请求」成对，别用 initialized 短路（见该文件 497-514 行注释）。
3. **写探针**：`scripts/acceptance/probe-image-upload.mjs`（~6 项：成功返回 URL + 落盘路径在 /uploads/articles/{userId}/、非图片 40000、超 2MB 40000、未登录 401、UI 编辑器插入；清理：删落盘文件 + 按 id 精确删）；`scripts/acceptance/probe-series.mjs`（~15 项：CRUD、文章绑定/解绑、自动 max+1、409 冲突、归属 403/404、ADMIN 可改、删系列 SET NULL 解绑不断言行数、GET /users/:id/series、UI 横幅；清理按创建 id 精确删，series 先于 article 删或靠 SET NULL）。
4. **回归三连**：前端 build、`node scripts/acceptance/run.mjs`、两个新探针全绿；跑后查库（基线 users=6 / articles=17 / series=0 / notifications=0 / bookmarks=0）。
5. **贴报告等 commit 指令**（按项目老流程：改完一批停下给用户看；README.md 与 .workbuddy/* 不进 commit；预计 4 笔：后端 / 前端 / 探针+基建 / 文档）。

## 六、环境与进程现状

- 后端 3000：`node --watch src/server.js` 在后台跑（AI 起的 task tYeAG1），已热加载全部第 10 批代码，冒烟全过。按封存指令**保留给用户**。
- 前端 5173：dev server 在跑（保留）。⚠️ 前端代码改了 3 个文件（含 ArticleEditor.vue 补全），5173 应已热更新；若用户看到编辑器报错请刷新。
- 冒烟残留已清；`zz-*.cjs/mjs` 临时脚本全部删净。
- ⚠️ 环境坑（实测，2026-10-18）：本环境 **Git Bash 里 curl `-F` multipart 上传必然 exit=26**（连第 11 批已知良好的头像上传也一样）——不是代码问题。上传类冒烟/探针一律用 **Node fetch + FormData**。
- ⚠️ `node --watch` 编辑窗口期会偶发把中间态文件加载崩一次（本次 user.service 的 toAvatarUrl 命名导入撞过），watch 会自行恢复，看到一次崩溃日志不必恐慌。
- npm 必须 `--registry=https://registry.npmmirror.com`；prisma generate 前停后端（EPERM 老坑）。

## 七、git 现状（封存时）

未 commit 的第 10 批改动（详见下方 git status 输出）：
- 文档 4 份 + schema.prisma + 后端 11 文件 + 前端 3 文件 + 迁移目录 1 个。
- 另有第 9 批遗留的 README.md / .workbuddy/* 漂移（按约定不进 commit）。
- HEAD = `ee0b114`（fix(probe): 第 9 批三个挂账修复）。
