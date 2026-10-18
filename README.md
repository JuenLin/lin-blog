# Lin's Blog

Vue 3 + Express + Prisma + MySQL 的博客项目。后端通用骨架（`/api/health` 健康检查、`/api/auth/*` 认证接口）与博客业务部分均已实现：`users` / `articles` / `comments` / `likes` / `follows` / `notifications` / `tags` / `bookmarks` / `article_revisions` 九张表由 14 个迁移创建，47 个接口已实现并通过自动化验收；前端 12 个页面（登录、首页广场、文章详情、发布/编辑、个人主页、编辑资料、修改密码、关注列表、设置壳、管理后台四页）已可运行。已完成到哪一步见下方「当前状态」。

协作约束见 [`docs/AI_CONTRACT.md`](./docs/AI_CONTRACT.md)，接口以 [`docs/API.md`](./docs/API.md) 为准，表结构以 [`docs/DB.md`](./docs/DB.md) 为准。

全站功能清单见 [`docs/FEATURES.md`](./docs/FEATURES.md)。

## 环境要求

- Node.js ≥ 22（本项目在 v22.22.2 上开发与验收；验收脚本依赖 Node 内置 WebSocket，低于 22 会失败）
- npm 10+
- MySQL 8.0.46（端口 3306，数据库 `lin_blog_dev`，字符集 utf8mb4 / utf8mb4_unicode_ci）

## 目录结构

```text
frontend/   Vue 3 + Vite，开发端口 5173
backend/    Node.js + Express + Prisma，开发端口 3000
  ├─ prisma/migrations/   14 个迁移文件，schema 与库的唯一真相
  └─ uploads/             头像落盘目录，运行时数据，不进 git
docs/       共享契约与架构：AI_CONTRACT.md / API.md / DB.md / ACCEPTANCE.md / ARCHITECTURE.md / ROADMAP.md / FEATURES.md
  └─ history/            历史交接单归档（如 TASK_HANDOFF_batch10.md）
scripts/acceptance/       自动化验收脚本（零新增依赖）
```

数据库迁移不在 `database/` 里维护：`backend/prisma/migrations/` 是唯一真相，新建库只需 `npm run prisma:migrate`，无需手工执行任何 SQL 初始化脚本。

## 启动步骤

### 1. 准备数据库

按契约第 4 节，使用项目专用账号，**不使用 root**。主库名 `lin_blog_dev`，Prisma Migrate 还需要一个 shadow 库 `lin_blog_dev_shadow`。

以 root 登录后执行（root 密码自行输入，不要写进任何文件）：

```sql
-- 1. 建两个库
CREATE DATABASE lin_blog_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE DATABASE lin_blog_dev_shadow
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2. 建项目专用账号（密码替换成你自己的）
CREATE USER 'workbuddy_dev'@'localhost' IDENTIFIED BY '你的密码';

-- 3. 授权，范围只有这两个库
GRANT ALL PRIVILEGES ON `lin_blog_dev`.* TO 'workbuddy_dev'@'localhost';
GRANT ALL PRIVILEGES ON `lin_blog_dev_shadow`.* TO 'workbuddy_dev'@'localhost';
FLUSH PRIVILEGES;
```

授权是否生效可用下面这条确认，应看到两个库都是 `ALL PRIVILEGES`：

```sql
SHOW GRANTS FOR 'workbuddy_dev'@'localhost';
```

### 2. 启动后端

```bash
cd backend
npm install
cp .env.example .env        # Windows 用 copy .env.example .env
```

编辑 `backend/.env`，填入专用账号密码和 JWT_SECRET（不要提交该文件）：

```env
DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/lin_blog_dev"
SHADOW_DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/lin_blog_dev_shadow"
JWT_SECRET="你自己生成的随机字符串"
```

然后启动：

```bash
npm run dev                 # node --watch，改文件自动重启
```

看到 `[backend] 已启动：http://localhost:3000` 即成功。

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

打开 <http://localhost:5173> ，未登录会自动跳到 `/login`。注册或登录后进入首页。

默认账密不存在，需用上面的注册接口或登录页注册第一个账号。

### 4. Prisma 常用命令

Prisma 固定在 6.19.3（7.x 开始 schema 里不再支持 `url`，需要额外的 adapter 依赖，与本项目契约冲突）。CLI 与 Client 版本必须一致，升级时两个一起升。

```bash
cd backend
npm run prisma:generate     # 生成 Prisma Client
npm run prisma:migrate      # 建迁移并同步到数据库
npm run prisma:studio       # 可视化查看数据
```

## 约定速查

- 接口前缀 `/api`，统一响应 `{ code, message, data }`，业务码见契约第 6 节。
- 鉴权：`Authorization: Bearer <token>`。
- 前端所有请求走 `frontend/src/api/request.js`，不要在组件里写完整 URL。
- 后端入参一律用 zod 校验，数据库操作一律走 Prisma，禁止手拼 SQL。

## 依赖安装说明

默认 npm 源在国内可能超时（Prisma 引擎尤其明显）。装不上时改用 npmmirror：

```bash
npm install --registry=https://registry.npmmirror.com
# Prisma 引擎走镜像
export PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma   # Windows: set PRISMA_ENGINES_MIRROR=...
```

## 已知问题

### `npx prisma generate` 报 EPERM（根因：后端进程占用引擎 DLL）

现象：迁移或生成 Client 时报错

```text
EPERM: operation not permitted, rename '...\node_modules\.prisma\client\query_engine-windows.dll.node.tmpNNN'
       -> '...\query_engine-windows.dll.node'
```

**根因：跑着 `npm run dev` 的后端进程（`node --watch`）占用了引擎 DLL。**  
停掉后端再跑 `npx prisma generate` 即成功（实测 v6.19.3，61ms）。

判定依据：

- 停后端 → generate 成功；起后端 → 复现。**开关后端是唯一变量**。
- `@prisma/client` 启动时把 `query_engine-windows.dll.node` 载入为进程映像  
  （见 `node_modules/.prisma/client/index.js` 里 `path.join(__dirname, "query_engine-windows.dll.node")`），  
  Windows 上进程映像在进程存活期间不能被替换，Prisma 的 rename 因此报 `EPERM`。

> 早期这里归因为「杀软 / Windows Search 实时扫描」，**该结论不成立**。  
> 当时只观察到「源 tmp 可 `mv`、目标 dll 可被覆盖」，就推断是扫描类占用 ——  
> 这是不充分的证据：Git Bash 的 `mv` 与 Node 的 `rename(..., REPLACE_EXISTING)`  
> 不是同一条 Windows API，**前者成功不能证明文件没被占用**。

处理：

- **遇到就停掉后端（`Ctrl+C`），跑完 generate 再起**。这是确定有效的做法。
- 失败留下的 `query_engine-windows.dll.node.tmp*` 不会被下次 generate 自动清理，  
  可在确认无进程占用后直接删（同目录下真正的 `query_engine-windows.dll.node` 不要动）。
- 失败时 JS 与类型产物其实**已经更新成功**，同版本下引擎 dll 不被替换也不影响运行，  
  所以「先停后端再 generate」不会打断工作流。
- **升级 Prisma 版本前必须先停后端**：那时引擎 dll 必须真正被替换，  
  写不进去会导致 Client 与引擎版本不匹配。

## 当前状态

- [x] 前端能启动：`npm run dev`
- [x] 后端能启动：`npm run dev`
- [x] MySQL 能连接（`lin_blog_dev`，8.0.46，utf8mb4_unicode_ci）
- [x] Prisma 迁移已应用，共 14 个：`20260929123151_init`（users）、`20260929144738_blog_articles_comments`（articles / comments）、`20260929145244_comments_idx_article_created`（评论索引调整）、`20261003080727_add_user_avatar_bio`（users.avatar / bio）、`20261003140221_add_user_likes`（likes 表）、`20261004145107_add_article_category`（articles.category）、`20261011083029_add_follows`（follows 表）、`20261017063642_add_user_role_status`（users.role / status，MySQL 8 INSTANT 回填）、`20261017125847_add_article_status`（articles.status 草稿）、`20261017130010_add_article_revisions`（版本快照表）、`20261017130223_add_article_status_idx`（status 索引）、`20261018014846_add_tags_and_article_tags`（标签多对多）、`20261018042009_add_notifications`（通知表）、`20261018053624_add_bookmarks_and_view_count`（bookmarks 表 + articles.view_count）
- [x] 注册 / 登录 / `/api/auth/me` 跑通，拿到 token 且鉴权生效
- [x] `docs/API.md`：auth + health 通用接口 + 文章 / 评论 / 点赞 / 用户业务接口，含未实现接口的显式登记
- [x] `docs/DB.md`：users / articles / comments / likes / follows / notifications / tags / bookmarks / article_revisions 九表说明、外键命名规则、新增业务表流程、头像文件存储（第十一批）、category 分类列
- [x] 后端接口共 47 个：文章 5（列表 / 详情 / 发布 / 编辑 / 删除）+ 评论 3（发表 / 列表 / 删除）+ 点赞 3（点赞 / 取消 / 查询是否已赞）+ 收藏 4（收藏 / 取消 / 查询是否已收藏 / 我的收藏列表）+ 阅读 1（`POST /view`，免登录判重）+ 用户 9（改资料 / 传头像 / 用户详情 / 他的文章列表 / 我的点赞列表 / 关注 / 取消关注 / 粉丝列表 / 关注列表）+ 草稿与版本 5（auto-save / 草稿箱 / 删草稿 / 版本历史 / 回滚）+ 标签 1（热门标签）+ 通知 4（列表 / 未读数 / 标已读 / 全部已读）+ 管理端 7（`/api/admin`：stats / users 列表 / 改用户状态封禁 / 文章列表 / 删文章 / 评论列表 / 删评论，仅 ADMIN）+ health 1 + auth 4（注册 / 登录 / me / 改密码）
- [x] 前端 12 个页面：`Login` / `Home`（广场列表 + 最新/热门 Tab + 分类筛选）/ `ArticleDetail` / `ArticleEditor`（发布与编辑共用）/ `UserProfile` / `ProfileEdit` / `ChangePassword`（自第十四批起并列挂在 `/settings` 父级壳下）/ `UserFollows`（关注 / 粉丝列表）/ `AdminStats` / `AdminUsers` / `AdminArticles` / `AdminComments`（自第 5 批起挂在 `/admin` 父级壳 `AdminLayout` 下，仅 ADMIN 可进）
- [x] 文章分类：列表按 `category` 筛选（枚举 `技术` / `生活` / `随笔` / `未分类`），发布与编辑可设分类
- [x] 自动化验收：`node scripts/acceptance/run.mjs` 全绿（25 个探针脚本 + 3 个截图脚本，执行细则见 `docs/ACCEPTANCE.md`）

## 明确不做

以下项已评估并决定不实现，不要在后续批次里补：

- 列表 / 详情返回 `liked`（需给 `auth` 加可选认证模式，待单独排批）
