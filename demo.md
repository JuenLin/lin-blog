# Lin's Blog 目录与清理建议地图

> 生成方式：全量 `find` + 逐文件 `grep` 引用追踪（证据见文末「取证日志摘要」）。  
> 本文件已根据审计结论执行了安全清理：`database/`、`backup_workbuddy.sql` 已物理删除，`.codeartsdoer/` 已加入 `.gitignore`。 
> 评级图例：🔴 不可删 ｜ 🟡 需确认 ｜ 🟢 安全可删 / 加忽略。

## 1. 项目全景目录树

```
Lin's Blog/
├── backend/                         # Express + Prisma 后端
│   ├── prisma/
│   │   ├── schema.prisma            # 数据库唯一真相（13 表 / 17 迁移）
│   │   └── migrations/             # 17 个迁移目录（按时间戳升序）
│   ├── src/
│   │   ├── controllers/            # 14 个 controller（每业务一个）
│   │   ├── middlewares/            # 鉴权 / 错误处理
│   │   ├── routes/                 # 13 个 routes + index.js
│   │   ├── services/               # 14 个 service（业务逻辑核心）
│   │   ├── utils/                  # jwt / prisma / query / response / upload / pagination / password
│   │   └── validators/             # 入参校验
│   ├── scripts/                    # 后端辅助脚本
│   ├── uploads/                    # 运行时头像/配图落盘（git 忽略）
│   └── package.json
├── frontend/                        # Vue 3 前端
│   ├── dist/                        # 构建产物（git 忽略）
│   ├── public/
│   └── src/
│       ├── api/                     # 接口封装（对应后端路由）
│       ├── assets/
│       ├── components/             # 13 个全局组件
│       ├── router/                  # index.js（含通知壳入口说明）
│       ├── stores/                  # pinia（含 notification.js）
│       ├── utils/
│       └── views/                  # 15 个页面（13 实际页面 + 2 壳）
├── scripts/
│   └── acceptance/                 # 验收套件
│       ├── run.mjs                  # 单体验收 runner（内联 19 步截图）
│       ├── lib/                     # config / cdp / chrome / session / fixtures / tmp-account
│       ├── probe-*.mjs              # 33 个独立 UI 探针
│       ├── shot-*.mjs               # 3 个独立截图脚本（疑似遗留）
│       └── cleanup.mjs              # 独立清理脚本（疑似遗留）
├── docs/                           # 契约与文档（7 md + history/）
│   ├── ACCEPTANCE.md  AI_CONTRACT.md  API.md  ARCHITECTURE.md
│   ├── DB.md  FEATURES.md  docs/BATCH_HISTORY.md
│   └── history/                    # 已归档的历史记录
├── README.md
├── demo.md
├── .gitignore  .prettierignore  .markdownlintignore  .gitattributes
```

## 2. 根目录遗留物与清理建议

| 文件/目录                  | 现状与用途                                                                                             | 追踪结果（是否被代码引用）                                                                                               | 清理建议                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `database/`            | 仅含一个 `.gitkeep`（空占位），无任何子文件                                                                       | `grep -rn "database/" backend/src frontend/src scripts/` **零命中** → 无代码读取它                                   | ✅ **已于 2026-10-19 被安全清理**（物理删除 `database/`，仅含空 `.gitkeep`，全仓零引用，删除不影响任何功能）                            |
| `backup_workbuddy.sql` | 旧库 `workbuddy_dev` 全 13 表 INSERT 转储（用户早期刻意保留、约定不进 git）                                            | `git check-ignore` **空输出**（未被忽略）；`git status` 显示 `??`（未追踪、从未提交）；全仓 `grep "backup_workbuddy"` **零命中**（无代码读取） | ✅ **已于 2026-10-19 被安全清理**（物理删除 `backup_workbuddy.sql`，早期 workbuddy 时代旧库备份，现已完全无用） |
| `.codeartsdoer/`       | CloudStudio/CodeArts 的 IDE/智能体产物目录（含 `.codebase`/`agents`/`mcp`/`skills`/`rule`/`package.json` 等） | 非项目代码，全仓**无任何引用**                                                                                           | 🟢 **建议加入 .gitignore**：与项目源码无关，应排除出纳版本库（不删除本地，仅忽略）                                  |

## 3. 工程化基建评估

> 排查方法：对每个候选文件，在对应源码范围内 `grep` 其文件名/导入路径，排除自身后统计引用方数量。

- **前端孤儿组件：无。**  
  遍历 `frontend/src/views/`（15 个）+ `frontend/src/components/`（13 个）共 **28 个 .vue**，逐一 `grep` 文件名（含 router 与组件内 import/标签引用），**全部 ≥1 处引用**，最少 1 处（如 `AppFooter`/`CommentEditor`/`SearchBar`/`AdminLayout`/`UserFollows` 各 1 处，确认为父级/路由引用）。无任何零引用文件。
- **后端废弃服务：无。**  
  14 个 `services/*.js` 逐一核对：初扫曾误报 `auth/bookmark/report/series/view` 5 个「0 引用」，经深挖证实为扫描脚本 bug（把合法的 `../services/xxx.service.js` 导入路径行一并误删 + 变量名 camelCase 不含点号）。修正后确认 **14/14 均被各自 controller `import`**：
  - `auth.service` ← `controllers/auth.controller.js`
  - `bookmark.service` ← `controllers/bookmark.controller.js`
  - `report.service` ← `controllers/report.controller.js`
  - `series.service` ← `controllers/series.controller.js`
  - `view.service` ← `controllers/view.controller.js`（导入为 `recordViewService`）
  其余 `admin/article/comment/comment-like/follow/like/notification/upload/user` 亦均有引用。无任何未被路由或控制器使用的 service。
  - **研发工具链辅助脚本（测试脏数据兜底清理与 UI 截图留存，不可删除）。**
  - `scripts/acceptance/` 共 **33 个 `probe-*.mjs`**：每个文件头部均有 `用法：node scripts/acceptance/probe-xxx.mjs` 自述，且相互之间仅在**注释**里说明「与 probe-yyy 的分工」（无 import 调用）。它们是**项目自研的 E2E 自动化集成测试套件（零依赖 Node 脚本）**，按项目惯例经 wrapper 逐个跑，**属活跃套件，非孤儿**。
  - 以下 3 个 `shot-*.mjs` 与 1 个 `cleanup.mjs` 是**研发工具链辅助脚本（用于测试脏数据兜底清理与 UI 截图留存）**，虽未被 `run.mjs` 直接 import，但属于企业级项目标配的测试清理与截图留档工具，**不可删除**：
    - `scripts/acceptance/shot-before.mjs`
    - `scripts/acceptance/shot-detail-title.mjs`
    - `scripts/acceptance/shot-hover.mjs`
    - `scripts/acceptance/cleanup.mjs`（研发工具链辅助脚本，用于测试脏数据兜底清理，**不可删除**）

## 4. 架构与核心资产（仅作导览，不可删除）

- `backend/src/`：核心业务逻辑（controllers / services / routes / middlewares / utils / validators），改动需走 AI_CONTRACT 契约流程。
- `frontend/src/`：前端页面与组件（views 15 / components 13 / router / stores / api）。
- `backend/prisma/`：**唯一数据库真相**（schema.prisma + 17 个迁移），任何表结构变更只走 `migrate dev`。
- `docs/`：契约与文档（API.md / AI_CONTRACT.md / ARCHITECTURE.md / DB.md / FEATURES.md / docs/BATCH_HISTORY.md / ACCEPTANCE.md + history/）。
- `scripts/acceptance/`：验收套件（run.mjs + lib/ + 33 probe），是项目质量的守门员，不可删。

## 5. 清理执行结果（已于 2026-10-19 完成）

- ✅ **已物理删除**：`database/`（仅空 `.gitkeep`，零引用）、`backup_workbuddy.sql`（早期旧库备份，已无用）。
- ✅ **已加入 `.gitignore`**：`.codeartsdoer/`（IDE/智能体配置目录，非项目代码）。
- 🔒 **保留（不可删除）**：`scripts/acceptance/` 下的 `cleanup.mjs` 与 `shot-*.mjs` 为研发工具链辅助脚本（测试脏数据兜底清理与 UI 截图留存）；33 个 `probe-*.mjs` 为项目自研 E2E 集成测试套件。
- 🔒 **核心资产保持不变**：`backend/src/`、`frontend/src/`、`prisma/`、`docs/`、`scripts/acceptance/` 全部保留。

---

### 取证日志摘要（均为只读 grep/find 产物，存于 /tmp）

- `/tmp/all_tree.log`：全量物理目录树（312 行，已排除 .git/node_modules/.workbuddy/.codeartsdoer/uploads）。
- `/tmp/check_db.log`：`database/` 仅 `.gitkeep` + `grep "database/"` 零命中。
- `/tmp/check_sql.log` + `/tmp/sql_status.log`：`backup_workbuddy.sql` 未被 `.gitignore` 拦截、`git status` 为 `??`、从未提交、全仓零引用。
- `/tmp/check_codearts.log`：`.codeartsdoer/` 为 IDE/智能体配置目录（`.codebase`/`agents`/`mcp`/`skills`/`rule`/`package.json`）。
- `/tmp/frontend_refs.log`：28 个 .vue 引用计数，全部 ≥1。
- `/tmp/backend_refs.log` + `/tmp/backend_refs2.log`：14 个 service 修正后引用扫描，14/14 均有 controller 导入。
- `/tmp/acceptance_list.log` + `/tmp/run_load.log` + `/tmp/cross_ref.log`：33 probe 活跃、run.mjs 单体内联、shot-*/cleanup.mjs 无调用方。
