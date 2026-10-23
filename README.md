# Lin's Blog

[![Vue](https://img.shields.io/badge/Vue-3.5-4fc08d?logo=vue.js)](https://vuejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-6.19-2D3748?logo=prisma)](https://www.prisma.io/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql)](https://www.mysql.com/)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js)](https://nodejs.org/)

一个基于 Vue 3 + Express + Prisma + MySQL 的全栈个人博客系统。

## ✨ 核心特性

- **丰富的内容互动**：文章点赞、收藏、评论楼中楼、标签、专栏系列。
- **完善的社区治理**：管理员后台、用户封禁、举报与审核机制。
- **沉浸的创作体验**：Markdown 渲染、代码高亮、XSS 防护、草稿自动保存、版本历史与回滚。
- **完备的通知中心**：评论、回复、点赞、@提及、举报处理等 10 类动作触发站内信。
- **极高的代码质量**：59 个 RESTful 接口 + 13 张关系表 + 738 条自动化 E2E 验收断言。

## 环境要求

- Node.js ≥ 22（本项目在 v22.22.2 上开发与验收；验收脚本依赖 Node 内置 WebSocket，低于 22 会失败）
- npm 10+
- MySQL 8.0.46（端口 3306，数据库 `lin_blog_dev`，字符集 utf8mb4 / utf8mb4_unicode_ci）

## 目录结构

```text
frontend/   Vue 3 + Vite，开发端口 5173
backend/    Node.js + Express + Prisma，开发端口 3000
  ├─ prisma/migrations/   17 个迁移文件，schema 与库的唯一真相
  └─ uploads/             头像落盘目录，运行时数据，不进 git
docs/       共享契约与架构：AI_CONTRACT.md / API.md / DB.md / ACCEPTANCE.md / ARCHITECTURE.md / BATCH_HISTORY.md / FEATURES.md / demo.md
  └─ history/            历史交接单归档（如 TASK_HANDOFF_batch10.md）
scripts/acceptance/       自动化验收脚本（零新增依赖）
```

数据库迁移的唯一真相是 `backend/prisma/migrations/`：新建库只需 `npm run prisma:migrate`，无需手工执行任何 SQL 初始化脚本。

## 启动步骤

### 1. 准备数据库

使用项目专用账号，**不使用 root**。主库名 `lin_blog_dev`，Prisma Migrate 还需要一个 shadow 库 `lin_blog_dev_shadow`。

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
CREATE USER 'lin_blog_user'@'localhost' IDENTIFIED BY '你的密码';

-- 3. 授权，范围只有这两个库
GRANT ALL PRIVILEGES ON `lin_blog_dev`.* TO 'lin_blog_user'@'localhost';
GRANT ALL PRIVILEGES ON `lin_blog_dev_shadow`.* TO 'lin_blog_user'@'localhost';
FLUSH PRIVILEGES;
```

授权是否生效可用下面这条确认，应看到两个库都是 `ALL PRIVILEGES`：

```sql
SHOW GRANTS FOR 'lin_blog_user'@'localhost';
```

### 2. 启动后端

```bash
cd backend
npm install
cp .env.example .env        # Windows 用 copy .env.example .env
```

编辑 `backend/.env`，填入专用账号密码和 JWT_SECRET（不要提交该文件）：

```env
DATABASE_URL="mysql://lin_blog_user:你的密码@localhost:3306/lin_blog_dev"
SHADOW_DATABASE_URL="mysql://lin_blog_user:你的密码@localhost:3306/lin_blog_dev_shadow"
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

- 接口前缀 `/api`，统一响应 `{ code, message, data }`，业务码见 [API.md](./docs/API.md)。
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

## 📚 详细文档

- [接口契约 (API.md)](./docs/API.md)
- [数据库表结构 (DB.md)](./docs/DB.md)
- [架构全景图 (ARCHITECTURE.md)](./docs/ARCHITECTURE.md)
- [迭代演进史 (BATCH_HISTORY.md)](./docs/BATCH_HISTORY.md)
- [验收指南 (ACCEPTANCE.md)](./docs/ACCEPTANCE.md)
- [项目资产地图 (demo.md)](./docs/demo.md)
