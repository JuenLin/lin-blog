# workbuddy

Vue 3 + Express + Prisma + MySQL 的全栈项目骨架。当前已完成通用骨架（前端 `/login` 登录注册页与鉴权后的首页，后端 `/api/health` 健康检查与 `/api/auth/*` 认证接口）与博客 MVP 的后端部分：`users` / `articles` / `comments` 三张表已由迁移创建，文章与评论共 7 个业务接口已实现并冒烟通过。博客 MVP 的前端页面尚未开始。

协作约束见 [`docs/AI_CONTRACT.md`](./docs/AI_CONTRACT.md)，接口以 [`docs/API.md`](./docs/API.md) 为准，表结构以 [`docs/DB.md`](./docs/DB.md) 为准。

## 环境要求

- Node.js 24.20.0
- npm 11+
- MySQL 8.0.46（端口 3306，数据库 `workbuddy_dev`，字符集 utf8mb4 / utf8mb4_unicode_ci）

## 目录结构

```text
frontend/   Vue 3 + Vite，开发端口 5173
backend/    Node.js + Express + Prisma，开发端口 3000
docs/       共享契约：AI_CONTRACT.md / API.md / DB.md
database/   初始化 SQL 与迁移说明
```

## 启动步骤

### 1. 准备数据库

按契约第 4 节，使用项目专用账号，**不使用 root**。主库名 `workbuddy_dev`，Prisma Migrate 还需要一个 shadow 库 `workbuddy_dev_shadow`。

以 root 登录后执行（root 密码自行输入，不要写进任何文件）：

```sql
-- 1. 建两个库
CREATE DATABASE workbuddy_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE DATABASE workbuddy_dev_shadow
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2. 建项目专用账号（密码替换成你自己的）
CREATE USER 'workbuddy_dev'@'localhost' IDENTIFIED BY '你的密码';

-- 3. 授权，范围只有这两个库
GRANT ALL PRIVILEGES ON `workbuddy_dev`.* TO 'workbuddy_dev'@'localhost';
GRANT ALL PRIVILEGES ON `workbuddy_dev_shadow`.* TO 'workbuddy_dev'@'localhost';
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
DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/workbuddy_dev"
SHADOW_DATABASE_URL="mysql://workbuddy_dev:你的密码@localhost:3306/workbuddy_dev_shadow"
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

### `npx prisma generate` 偶发 EPERM（不影响当前开发）

现象：迁移或生成 Client 时报错

```text
EPERM: operation not permitted, rename '...\node_modules\.prisma\client\query_engine-windows.dll.node.tmpNNN'
       -> '...\query_engine-windows.dll.node'
```

排查结论（已实测，非持久句柄占用）：

- 源 tmp 文件可以 `mv`，目标 dll 也可以被覆盖 —— **两边都没有进程持有锁**。
- 无 node 进程在跑。
- 因此是「写完 21MB 引擎文件后立刻 rename」这一瞬间的占用，高度疑似杀软 / Windows Search 的实时扫描。

影响与处理：

- JS 与类型产物其实**已经更新成功**，引擎 dll 在同版本下不会被替换也不影响运行；失败后目录会残留 `query_engine-windows.dll.node.tmp*` 文件。
- **重跑一次 `npx prisma generate` 即可**（实测第二次成功），残留的 `.tmp*` 手工删除。
- 若频繁复现：把 `backend/node_modules` 加进杀软排除目录。
- **升级 Prisma 版本前必须解决**：那时引擎 dll 必须真正被替换，写不进去会导致 Client 与引擎版本不匹配。

## 当前状态

- [x] 前端能启动：`npm run dev`
- [x] 后端能启动：`npm run dev`
- [x] MySQL 能连接（`workbuddy_dev`，8.0.46，utf8mb4_unicode_ci）
- [x] Prisma 迁移已应用：`20260929123151_init`（users）、`20260929144738_blog_articles_comments`（articles / comments）、`20260929145244_comments_idx_article_created`（评论索引调整）
- [x] 注册 / 登录 / `/api/auth/me` 跑通，拿到 token 且鉴权生效
- [x] `docs/API.md`：auth + health 通用接口 + 文章 / 评论业务接口
- [x] `docs/DB.md`：users / articles / comments 三表说明、外键命名规则、新增业务表流程
- [x] 后端业务接口：文章 5 个 + 评论 2 个，含 400 / 401 / 403 / 404 异常路径冒烟
- [ ] 博客 MVP 前端页面（广场列表、文章详情、发布 / 编辑、评论）
