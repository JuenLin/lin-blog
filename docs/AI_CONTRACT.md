# AI 协作约束模板：Vue + Node.js + MySQL

## 0. 使用方式

每次让 AI 写代码前，先发送本约束模板，再发送当前任务。

如果 AI 想修改以下内容，必须先说明原因并等待确认：

- 技术栈
- 接口路径
- 请求/响应字段
- 数据库表结构
- 依赖包
- 目录结构
- 统一返回格式
- 鉴权方式

---

## 1. 项目信息

- 项目名：workbuddy
- 项目类型：课程设计
- 当前模块：文章 / 评论（博客 MVP）
- 仓库根目录：work-project2
- 目标：能本地运行，前后端能联调，不要求生产级高可用。

---

## 2. 技术栈锁定

### 前端

- Vue 3
- Vite
- JavaScript，不使用 TypeScript，除非明确要求
- Vue Router 4
- Pinia
- Axios
- UI 库：Element Plus，如未安装必须先询问，不要擅自引入
- 包管理器：npm

### 后端

- Node.js 24.20.0
- Express
- JavaScript，ESM 模块
- Prisma ORM
- MySQL
- JWT：jsonwebtoken
- 密码加密：bcryptjs
- 参数校验：zod
- 跨域：cors
- 环境变量：dotenv
- 包管理器：npm

### 数据库

- MySQL 8.0.46
- 字符集：utf8mb4
- 排序规则：utf8mb4_unicode_ci

### 禁止事项

- 禁止擅自更换框架、ORM、数据库。
- 禁止擅自升级依赖大版本。
- 禁止擅自引入新依赖。**例外见「已批准的例外」第 3、7 项**。
- 禁止修改接口契约。
- 禁止修改数据库 schema。**例外见「已批准的例外」第 1、2、4、5、6、8、9 项**。

### 已批准的例外

以下九项（schema 七项：第 1、2、4、5、6、8、9 项；依赖两项：第 3、7 项）均为用户**明确批准**的例外，逐项登记「批准内容 / 范围 / 依据 / 是否援引前例」。  
**未列入本节的改动一律禁止**（禁止引入新依赖见上方列表第 3 条，禁止改 schema 见第 5 条）。

**注意**：第 1、2、4、5、6、8、9 项是「禁止改 schema」的七条例外（第九批 / 第十批 / 分类功能 / 第 4 批关注 / 第 5 批 role·status / 第 6 批 articles.status / 第 6 批 article_revisions），  
第 3、7 项是「禁止引入新依赖」的两条例外（第十一批 multer / 第 5 批 marked·highlight.js·dompurify）。**两项禁令的例外不在同一个维度上，不要按批次数混读。**

1. **第九批 · schema 变更（2026-10-03 批准）**
   - **批准内容**：`users` 表新增 `avatar VARCHAR(255) NULL` 与 `bio VARCHAR(200) NULL` 两列。
   - **范围**：仅限这两列。改列名、改类型、删列、其他表的任何变更均不在此列。
   - **依据**：见 `docs/DB.md`「第九批新增字段」与 `docs/API.md` 的 `PUT /api/users/me` 章节。
   - **是否援引前例**：无，这是第一次批准。
2. **第十批 · schema 变更（2026-10-03 批准）**
   - **批准内容**：新建 `likes` 表一张（`id` / `user_id` / `article_id` / `created_at`），含两条外键与两个索引（`likes_user_id_article_id_key` 唯一约束、`likes_article_id_idx` 普通索引），迁移 `20261003140221_add_user_likes`。
   - **范围**：**仅限新建 `likes` 一张表**。不含修改 `users` / `articles` / `comments` 任何一列，也不含给已建表补 `deleted_at`（`likes` 刻意不做软删除，见 `docs/DB.md`「为什么没有软删除列」）。
   - **依据**：见 `docs/DB.md`「likes」小节的「schema 变更已获批准（豁免登记）」，决策过程见 `docs/API.md` 的 `POST /api/articles/:id/like` 章节。
   - **是否援引前例**：无。第九批的豁免写明「仅限那两列，除此之外的任何 schema 变更仍需重新批准」，因此本项是**独立的一次批准**。
3. **第十一批 · 新增依赖（2026-10-03 批准）**
   - **批准内容**：后端引入 `multer ^2.4.0`，仅用于头像上传（`POST /api/users/me/avatar`）。
   - **依据**：选 2.x 而非 1.4.5-lts 线，是因为 CVE-2025-47935 与 CVE-2025-47944两个高危 DoS 仅修复于 2.0.0+。
   - **范围**：仅限这一个包；除此之外仍禁止引入新依赖。
   - **是否援引前例**：无，与第九批是两次独立批准。
4. **分类功能 · schema 变更（2026-10-04 批准）**
   - **批准内容**：`articles` 表新增 `category VARCHAR(20) NOT NULL DEFAULT '未分类'` 一列，枚举值 `技术` / `生活` / `随笔` / `未分类`，由后端枚举白名单校验（不接受自由字符串，非法值返回 `400 / 40000`）；迁移用 `NOT NULL DEFAULT '未分类'` 自动回填既有行，零 NULL。
   - **范围**：**仅限此列**。不含其他表结构变更、不含新增 `categories` 表 / 外键 / 索引，也不含改 `category` 的类型 / 长度。
   - **依据**：见 `docs/DB.md`「category 分类列」与 `docs/API.md` 文章相关接口章节。
   - **是否援引前例**：无，与第九批 / 第十批 / 第十一批各自独立。
5. **第 4 批 · schema 变更（关注功能，2026-10-11 批准）**
   - **批准内容**：新建 `follows` 表一张（`id` / `follower_id` / `following_id` / `created_at`），含两条外键（均 → `users.id`，`ON DELETE RESTRICT ON UPDATE CASCADE`）与两个索引（`follows_follower_id_following_id_key` 唯一约束、`follows_following_id_idx` 普通索引），无 `deleted_at` / `updated_at` 列（物理 DELETE，与 `likes` 同构）。
   - **范围**：**仅限新建 `follows` 一张表**。不含修改 `users` / `articles` / `comments` / `likes` 任何一列，也不含给已建表补 `deleted_at`（`follows` 刻意不做软删除，理由见 `docs/DB.md`「follows（关注表）→ 为什么没有软删除列」）。
   - **依据**：见 `docs/DB.md`「follows（关注表）」小节的「schema 变更已获批准（豁免登记 · 第 5 项）」，决策过程见 `docs/API.md` 的 4 个关注接口章节。
   - **是否援引前例**：无，与第九批 / 第十批 / 第十一批 / 分类功能各自独立。
6. **第 5 批 · schema 变更（role / status，2026-10-17 批准）**
   - **批准内容**：`users` 表新增 `role` 与 `status` 两列（Prisma enum `UserRole { USER, ADMIN }` / `UserStatus { ACTIVE, BANNED }`，均 `NOT NULL DEFAULT`），迁移名 `add_user_role_status`。
   - **范围**：仅限这两列。不含索引、不含其他表任何变更、不含改列名 / 类型 / 删列。
   - **依据**：见 `docs/DB.md`「第 5 批：role / status」小节与 `docs/API.md`「管理端接口（第 5 批）」章节。
   - **是否援引前例**：无，与第九批 / 第十批 / 分类功能 / 第 4 批各自独立。
7. **第 5 批 · 新增依赖（2026-10-17 批准）**
   - **批准内容**：前端引入 `marked ^18.1.1` / `highlight.js ^11.12.0` / `dompurify ^3.4.17` 三包（作为一组），仅用于文章详情页的 Markdown 渲染、代码高亮与 XSS 净化。
   - **依据**：版本为 2026-10-17 `npm view` 实测当前稳定版；`dompurify` 是 `v-html` 渲染面的必需净化组件，与渲染不可拆开；目录用 element-plus 2.14.6 自带 `el-anchor`，零新增。
   - **范围**：仅限这三个包（不含 `marked-highlight` 等衍生包）；后端零新增。
   - **是否援引前例**：援引第十一批 multer 特批的流程先例（内容上是两次独立批准）。

8. **第 6 批 · schema 变更（articles.status，2026-10-17 批准）**
   - **批准内容**：`articles` 表新增 `status` 列（Prisma enum `ArticleStatus { DRAFT, PUBLISHED }`，`NOT NULL DEFAULT PUBLISHED`），并新增索引 `(status, created_at)`。迁移名 `add_article_status`。
   - **范围**：仅限此一列一索引。不含其他表结构变更、不含改列名 / 类型 / 删列、不含给 `article_revisions` 等加列。
   - **依据**：见 `docs/DB.md`「articles（文章表）」的 `status` 字段与「第 6 批」小节，决策过程见 `docs/API.md` 文章相关接口章节（草稿 / 发布状态）。
   - **是否援引前例**：无，与第九批 / 第十批 / 分类功能 / 第 4 批 / 第 5 批各自独立。
9. **第 6 批 · schema 变更（article_revisions，2026-10-17 批准）**
   - **批准内容**：新建 `article_revisions` 表一张（`id` / `article_id` / `title` / `content` / `category` / `author_id` / `created_at`），存文章每次「更新前」的版本快照；含一条外键（`article_id` → `articles.id`，`ON DELETE CASCADE`）与一个索引 `(article_id, created_at)`。迁移名 `add_article_revisions`。
   - **范围**：**仅限新建 `article_revisions` 一张表**。不含修改 `users` / `articles` / `comments` / `likes` / `follows` 任何一列，也不含给已建表补列。
   - **依据**：见 `docs/DB.md`「article_revisions（文章版本历史表）」小节与 `docs/API.md` 的 `GET /api/articles/:id/revisions` / `POST /api/articles/:id/restore` 章节。
   - **是否援引前例**：无，与前述各批各自独立。

- 禁止把密码明文存入数据库。
- 禁止生成真实密钥、真实密码、真实 token。
- 禁止把 API Key、数据库密码等敏感信息写进代码。

---

## 3. 目录结构

project/                              # 项目根目录，所有代码和文档都放这里

├─ frontend/                          # 前端项目，Vue 3 + Vite

│  ├─ src/                            # 前端源码

│  │  ├─ api/                         # 所有后端接口请求集中放这里

│  │  │  ├─ request.js                # axios 实例：baseURL、token拦截、统一错误处理

│  │  │  ├─ auth.js       	# 认证接口：登录、注册、登出、当前用户

│  │  │  ├─ user.js       	# 用户接口：改资料、传头像（列表 / 详情 / 增删未实现）

│  │  │  ├─ article.js              # 文章接口：发布、列表、详情、编辑、删除

│  │  │  ├─ comment.js              # 评论接口：发表、文章评论列表  
│  │  │  └─ like.js                 # 点赞接口：点赞、取消点赞（第十批）

│  │  ├─ router/                      # Vue Router 路由配置

│  │  ├─ stores/                      # Pinia 状态仓库，如用户登录状态

│  │  ├─ views/                       # 页面级组件，如登录页、文章详情页

│  │  ├─ components/                  # 可复用小组件，如表格、弹窗、表单

│  │  ├─ utils/                       # 前端工具函数，如时间格式化、校验

│  │  ├─ App.vue                      # Vue 根组件，通常放 router-view

│  │  └─ main.js                      # 前端入口：创建 Vue、挂载 Pinia/Router

│  ├─ .env.development                # 前端开发环境变量，如 VITE_API_BASE_URL

│  └─ package.json                    # 前端依赖和 npm 脚本

├─ backend/                           # 后端项目，Node.js + Express

│  ├─ src/                            # 后端源码

│  │  ├─ routes/                      # 路由定义：URL 对应哪个 controller

│  │  ├─ controllers/                 # 控制器：接收请求、取参数、调 service、返回响应

│  │  ├─ services/                    # 业务逻辑：真正处理业务，调用 Prisma

│  │  ├─ middlewares/                 # 中间件：鉴权、错误处理、日志等

│  │  ├─ utils/                       # 后端工具：统一响应、JWT、密码等

│  │  ├─ validators/                  # 入参校验：zod schema，按模块拆分

│  │  ├─ app.js                       # 创建 Express app，注册中间件和路由

│  │  ├─ uploads/                     # 头像落盘目录（第十一批）：avatars/ 存用户头像，不进 git

│  │  └─ server.js                    # 启动后端服务，监听端口

│  ├─ prisma/                         # Prisma：schema 与迁移

│  │  ├─ schema.prisma                # 数据库模型：表、字段、关系

│  │  └─ migrations/                  # 迁移文件，由 prisma migrate 生成

│  ├─ .env                            # 后端环境变量：数据库密码、JWT_SECRET、端口

│  └─ package.json                    # 后端依赖和 npm 脚本

├─ docs/                              # 项目文档，也是给 AI 看的共享契约

│  ├─ AI_CONTRACT.md                  # AI 协作约束：技术栈、规范、禁止事项

│  ├─ API.md                          # 接口文档：路径、参数、返回格式

│  ├─ DB.md                           # 数据库文档：表结构、字段说明

│  ├─ CODING_STYLE.md                 # 代码风格约定文档

│  ├─ ARCHITECTURE.md                # 架构视图文档：六张关系图（系统/链路/ER/功能/接口全景/前端路由），第 3 批引入
│  └─ ACCEPTANCE.md                   # 验收说明书：跑什么、怎么跑、已知边界与不变式

├─ scripts/                           # 项目级辅助脚本，不进前后端依赖

│  └─ acceptance/                     # 验收脚本，零新增依赖（只用 Node 内置能力）

│     ├─ run.mjs                      # 一键跑完全部断言（主验收）

│     ├─ cleanup.mjs                  # 中断后兜底清理

│     ├─ probe-*.mjs                  # 各批次的量化探针（暗色 / 上下篇 / 作者其他文章 …）

│     ├─ shot-*.mjs                   # 截图辅助脚本（不改源码，仅 CDP 注入）

│     └─ lib/                         # 公共库：CDP 封装、JWT 会话、断言、夹具等

└─ README.md                          # 项目总说明：怎么安装、启动、使用

> 说明：`probe-*.mjs` 与 `shot-*.mjs` 按批次持续新增，命名遵循上述模式即可，不在本文件中逐个列举。

---

## 4. 端口与环境变量

### 前端

- 开发端口：5173
- 环境变量文件：`frontend/.env.development`

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

### 后端

- 开发端口：3000
- 环境变量文件：`backend/.env`

```env
PORT=3000
DATABASE_URL="mysql://{{DB_USER}}:{{DB_PASSWORD}}@localhost:3306/{{DB_NAME}}"
SHADOW_DATABASE_URL="mysql://{{DB_USER}}:{{DB_PASSWORD}}@localhost:3306/{{DB_NAME}}_shadow"
JWT_SECRET="{{JWT_SECRET}}"
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:5173
```

### MySQL

- 端口：3306
- 主库名：{{DB_NAME}}
- Shadow 库名：{{DB_NAME}}\_shadow
- 项目账号：{{DB_USER}}（项目专用账号，不使用 root）
- 权限范围：仅 {{DB_NAME}}.* 和 {{DB_NAME}}\_shadow.*

---

## 5. 接口总约定

- 接口前缀：`/api`
- 风格：RESTful
- 数据格式：JSON
- 请求编码：UTF-8
- 鉴权方式：`Authorization: Bearer <token>`
- 前端所有请求必须通过 `src/api/request.js` 的 axios 实例。
- 组件内禁止直接写完整 URL。
- 后端所有接口必须返回统一格式。
- 后端必须校验入参，不能信任前端传参。

### 常见路径规范

```text
GET    /api/health             健康检查
POST   /api/auth/register      注册
POST   /api/auth/login         登录
GET    /api/auth/me            当前用户
PUT    /api/auth/password      修改密码
PUT    /api/users/me           修改当前用户资料
POST   /api/users/me/avatar    上传头像
GET    /api/users/:id          用户详情（含文章数 / 获赞数 / 收到评论数）
GET    /api/users/:id/articles 该用户的文章列表（分页）
GET    /api/users/me/likes     我点赞过的文章（需登录，分页）
POST   /api/users/:id/follow       关注用户（需登录，幂等；不能关注自己）
DELETE /api/users/:id/follow       取消关注（需登录，幂等；未关注也返回 200）
GET    /api/users/:id/followers    粉丝列表（关注 :id 的人，公开）
GET    /api/users/:id/following    关注列表（:id 关注的人，公开）
GET    /api/users              用户列表（未实现）
POST   /api/users              新增用户（未实现）
PUT    /api/users/:id          更新用户（未实现）
DELETE /api/users/:id          删除用户（未实现）
POST   /api/articles           发布文章
GET    /api/articles           博客广场列表
GET    /api/articles/:id       文章详情
PUT    /api/articles/:id       编辑文章（仅作者）
DELETE /api/articles/:id       删除文章（仅作者，软删除）
POST   /api/comments           发表评论
GET    /api/articles/:id/comments   文章评论列表
DELETE /api/comments/:id       删除评论（评论作者或文章作者，软删除）
POST   /api/articles/:id/like       点赞
DELETE /api/articles/:id/like       取消点赞
GET    /api/articles/:id/liked      查询当前用户是否已点赞（需登录）
GET    /api/admin/stats             管理端数据概览（需 ADMIN）
GET    /api/admin/users             管理端用户列表（需 ADMIN）
PATCH  /api/admin/users/:id/status  封禁/解禁用户（需 ADMIN）
GET    /api/admin/articles          管理端文章列表（需 ADMIN，含软删）
DELETE /api/admin/articles/:id      管理端删除文章（需 ADMIN，软删）
GET    /api/admin/comments          管理端评论列表（需 ADMIN，含软删）
DELETE /api/admin/comments/:id      管理端删除评论（需 ADMIN，软删）
POST   /api/articles/auto-save       自动保存草稿（需登录，第 6 批）
GET    /api/users/me/drafts          我的草稿箱（需登录，第 6 批）
DELETE /api/users/me/drafts/:id      删除草稿（需登录，第 6 批）
GET    /api/articles/:id/revisions   文章版本历史（需登录，仅作者，第 6 批）
POST   /api/articles/:id/restore     回滚版本（需登录，仅作者，第 6 批）
```

> `/api/users` 系列**已实现 9 个**：`PUT /api/users/me`（改资料）、`POST /api/users/me/avatar`（上传头像）、`GET /api/users/:id`（用户详情）、`GET /api/users/:id/articles`（他的文章）、`GET /api/users/me/likes`（我的点赞）、`POST /api/users/:id/follow`（关注）、`DELETE /api/users/:id/follow`（取消关注）、`GET /api/users/:id/followers`（粉丝列表）、`GET /api/users/:id/following`（关注列表）。
>
> 清单里标「未实现」的 4 个（列表 / 新增 / 改他人 / 删）保持未实现，作者信息通过文章 / 评论内嵌的 `author` 对象返回。
>
> 三个已实现接口的字段与失败码以 `docs/API.md` 为准。`GET /api/users/me`（不带 `/likes`）会命中 `/:id` 并由 zod 回 400（`id='me'` 不是数字），这是第 2 批登记过的预期行为，**不是 bug**，不要为此新增 `GET /api/users/me` 别名。
>
> 路径之外的字段、校验与错误码以 `docs/API.md` 为准（第 13 节第 15 条）。
>
> **第 5 批起管理端接口共 7 个；第 6 批新增 5 个草稿 / 版本接口（非管理端），接口总数 25 → 37**。`/api/admin/*` 与 `/api/users/*` 是两套：管理端用户管理走 `/api/admin/users`（需 ADMIN），`/api/users` 系列的「列表 / 新增 / 改他人 / 删」**仍未实现**（作者信息通过文章 / 评论内嵌 `author` 对象返回）。
>
> **管理端一刀切防呆规则**：`PATCH /api/admin/users/:id/status` 的目标用户 `role = 'ADMIN'` 时直接 400 / 40000「不能封禁或解禁管理员账号」（含自己封自己，**不计算「是不是最后一个管理员」**）。管理员的任命 / 罢免 / 封禁只由开发者直接改数据库，不走管理端界面。规则全文见 `docs/API.md`「管理员不能被管理端操作」。

---

## 6. 统一响应格式

### 成功

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

### 失败

```json
{
  "code": 40000,
  "message": "参数错误",
  "data": null
}
```

### HTTP 状态码

- 200：成功
- 201：创建成功
- 400：请求参数错误
- 401：未登录 / token 无效 / **账号已封禁（40101，旧 token 即刻失效）**
- 403：无权限
- 404：资源不存在
- 409：资源冲突
- 500：服务器错误

### 业务码

```text
0       成功
40000   参数错误
40100   未登录或 token 无效
40101   账号已封禁
40300   无权限
40400   资源不存在
40900   资源冲突
50000   服务器错误
```

---

## 7. 分页、排序、搜索

### 请求参数

```text
page=1
pageSize=10
keyword=
sortBy=createdAt
order=desc
```

### 响应 data

```json
{
  "list": [],
  "page": 1,
  "pageSize": 10,
  "total": 100,
  "totalPages": 10
}
```

### 约束

- `page` 默认 1。
- `pageSize` 默认 10，最大 100。
- `order` 只能是 `asc` 或 `desc`。
- `sortBy` 必须使用后端白名单，不能直接拼 SQL。

---

## 8. 鉴权与密码

- 登录成功后返回：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "token": "{{JWT_TOKEN}}",
    "user": {
      "id": 1,
      "username": "demo",
      "nickname": "Demo"
    }
  }
}
```

- JWT payload 至少包含：

```json
{
  "userId": 1,
  "username": "demo"
}
```

- JWT 过期时间：7d。
- 密码必须用 bcryptjs 加密，禁止明文。
- 前端登录后把 token 存入 Pinia 和 localStorage。
- 前端 axios 请求拦截器自动加：

```text
Authorization: Bearer <token>
```

- 后端鉴权中间件解析 token，失败返回 40100。

### 封禁拦截（第 5 批）

- **登录接口**：密码比对**通过后**查 `users.status`，`BANNED` → 401 / 40101「账号已封禁」（输错密码仍只得到「用户名或密码错误」，不额外泄露信息）。
- **`auth` 中间件**：验签通过后按 `userId` 主键查 `status`，`BANNED` → 401 / 40101，**该用户所有已签发的 token 即刻失效**；解禁后同一枚旧 token**自动恢复有效**——拦截判据是 `status` 本身，不是 token 黑名单。
- **JWT payload 不放 `role` / `status`**：放了能省一次查询，但封禁 / 改角色后旧 token 不失效——安全上不可接受，必须 DB 实时查。代价是每个已鉴权请求多一次主键查询，项目规模可接受。
- **管理员判定**在 `requireAdmin` 中间件（`auth` 之后查 `role`），非 ADMIN → 403 / 40300；`/api/admin/*` 全部走 `auth → requireAdmin` 链。
- **防呆规则**：`PATCH /api/admin/users/:id/status` 目标为 ADMIN 时直接 400 / 40000「不能封禁或解禁管理员账号」（含自己封自己，不计算「是不是最后一个管理员」）；管理员权限变更只由开发者直接改数据库。

---

## 9. 数据库约定

### 命名

- 表名：复数 snake_case，例如 `users`、`articles`。
- 字段名：snake_case，例如 `created_at`、`updated_at`。
- Prisma 模型：PascalCase，例如 `User`。
- Prisma 字段：camelCase，映射到数据库 snake_case。
- API JSON 字段：camelCase，例如 `createdAt`、`updatedAt`。

### 通用字段

每张业务表建议包含：

```prisma
id        Int      @id @default(autoincrement())
createdAt DateTime @default(now()) @map("created_at")
updatedAt DateTime @updatedAt @map("updated_at")
deletedAt DateTime? @map("deleted_at")
```

### 用户表示例

```prisma
model User {
  id        Int      @id @default(autoincrement())
  username  String   @unique @db.VarChar(50)
  password  String   @db.VarChar(255)
  nickname  String?  @db.VarChar(50)
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  @@map("users")
}
```

### 时间

- 数据库存 UTC。
- API 返回 ISO 8601 字符串，例如 `2026-09-27T10:00:00.000Z`。
- 前端负责转成本地时间显示。

### 删除

- 默认软删除：设置 `deletedAt`。
- 查询默认过滤 `deletedAt = null`。
- 如需硬删除，必须明确说明。

---

## 10. 前端约束

- Vue 组件使用 `<script setup>`。
- 页面放 `src/views`。
- 公共组件放 `src/components`。
- API 请求放 `src/api`。
- 状态放 `src/stores`。
- 路由放 `src/router`。
- 工具函数放 `src/utils`。
- 所有请求使用 `src/api/request.js`。
- axios 响应拦截器统一处理：
  - `code === 0`：返回 `data`
  - `code !== 0`：抛出错误并提示 `message`
  - 401：清除 token，跳转登录页
- 表单必须有基本校验。
- 不要直接操作 DOM，除非没有 Vue 方案。
- 样式使用 `<style scoped>`。
- 不要引入新依赖，除非用户明确同意。

### 主题机制（浅色 / 暗色）

- 浅色为默认主题，暗色由 `<html class="dark">` 驱动。
- 所有颜色必须走 `frontend/src/style.css` 中的 CSS 变量（如 `--bg-page`、`--text-strong`、`--border` 等），**禁止在组件内硬编码色值**。
- 暗色是 `html.dark` 对同名变量的镜像覆盖。新增颜色必须**浅色 / 暗色成对添加**，只加一边会导致暗色下对比度错误。
- Element Plus 组件同样通过覆盖 `--el-*` 变量适配暗色，不引入官方 dark css 包。
- 切换状态存 `localStorage.theme`；`frontend/index.html` 内联一小段脚本，在首帧前读 `localStorage` 给 `<html>` 加 class，防闪白。
- `html.dark` 必须挂在 `<html>` 上（不是 scoped class），否则 teleport 到 body 的 `ElMessage` / `ElMessageBox` / 下拉浮层吃不到变量。


### 前端验收

- 任何前端改动完成后，必须重跑 `node scripts/acceptance/run.mjs`，保持**全部通过**（当前为 50 条断言，随功能增加而变）。
- 新增功能另写 `scripts/acceptance/probe-*.mjs` 出**客观证据**（计算样式值、DOM 结构、请求参数），不靠截图判断正确性。
- 截图仅作辅助，产物放 `D:/tools/acceptance-shots/<批次>-<时间戳>/`（见第 13 节第 20 条）。

---

## 11. 后端约束

- 入口：`src/server.js`
- Express app：`src/app.js`
- 路由：`src/routes`
- 控制器：`src/controllers`
- 业务逻辑：`src/services`
- 中间件：`src/middlewares`
- 入参校验：`src/validators`，按模块建 `xxx.validator.js`
- Prisma：`backend/prisma/schema.prisma`
- 所有接口必须 try/catch 或统一错误中间件。
- 所有成功/失败必须走统一响应工具。
- 所有入参必须用 zod 校验。
- 所有数据库操作必须用 Prisma，禁止手拼 SQL。
- 所有需要登录的接口必须经过鉴权中间件。
- 分页查询必须限制 `pageSize <= 100`。
- 错误日志至少打印 `message` 和 `stack`。

## 12. 代码规范

- 缩进：2 空格。
- 字符串：单引号。
- 语句结尾：分号。
- 文件名：
  - 前端组件（含页面级）：PascalCase，例如 `Home.vue`、`ArticleDetail.vue`、`UserProfile.vue`
  - 前端 JS：camelCase，例如 `request.js`
  - 后端路由：`user.routes.js`
  - 后端控制器：`user.controller.js`
  - 后端服务：`user.service.js`
- 函数命名：camelCase。
- 常量命名：UPPER_SNAKE_CASE。
- 不要输出省略号，例如 `// ...`。
- 要求输出完整文件内容。
- 不要重写无关文件。
- 不要修改接口契约。
- 如果必须改契约，先说明原因并等待确认。
- 页面级组件命名以实际代码为准：`Home.vue` / `ArticleDetail.vue` / `ArticleEditor.vue` / `Login.vue` / `UserProfile.vue` / `ProfileEdit.vue` / `ChangePassword.vue`，**不加 `View` 后缀**（`views/` 目录本身已表明它是页面层）。`docs/CODING_STYLE.md` 的命名约定已与此对齐，两处不再冲突。

---

## 13. AI 行为约束

当 AI 生成代码时，必须遵守：

1. 只生成当前任务要求的文件。
2. 输出完整文件内容，不要只给片段。
3. 不要擅自新增依赖。
4. 不要擅自升级依赖。
5. 不要擅自改数据库表结构。
6. 不要擅自改 API 路径和字段。
7. 不要生成真实密钥、密码、token。
8. 不要忽略错误处理。
9. 不要忽略参数校验。
10. 不要使用 `SELECT *` 手拼 SQL。
11. 不要在前端组件里直接写接口完整 URL。
12. 如果信息不足，先列出需要确认的问题，不要胡乱假设。
13. 如果任务很大，先给文件清单，再按文件生成。
14. 如果修改了公共文件，必须说明影响范围。
15. 如果发现前后端契约冲突，以 `docs/API.md` 为准。
16. **读取 `.env` 时只输出 key，不输出 value**（`backend/.env` 与 `backend/.env.example` 同样适用）。
    - 确需确认连通性时，只允许输出脱敏后的 `host` / `port` / 库名 / 用户名。
    - **密码、完整连接串、JWT 密钥一律不输出**，需要引用时用「已设置」或长度代替。
    - 禁止用「只认识 DATABASE_URL 和 JWT_SECRET」这种白名单式脱敏：2026-10-02 就是这么把 `SHADOW_DATABASE_URL` 的密码漏进了对话记录。规则应是——**凡名字含 `PASSWORD` / `SECRET` / `TOKEN` / `KEY`，或值是连接串的，一律脱敏**。
    - 排查配置问题的正确做法是让用户自己在本地打开 `.env` 比对，而不是把内容贴出来。
17. 任务结束前必须停掉自己启动的后台服务（backend node server、vite dev server），释放端口。  
    2026-10-02 因遗漏此事，遗留进程占住 3000 与 5175，导致用户侧 `npm run dev` 起不来。
18. **本机 npm 官方源不可用，`npm install` / `npm ci` / `npm view` 等所有会联网的 npm 命令必须显式加 `--registry=https://registry.npmmirror.com`**。  
    本机 `https://registry.npmjs.org` 会被解析到一个百度 HTML 页面，npm 报 `FETCH_ERROR ... invalid json response body at https://m.baidu.com/`。不加这个参数，安装必然失败（2026-10-02 实测）。
19. **未经用户明确同意，不执行 `git push`**。本地 `commit` 可以，但推送必须等指令。用户明确说「不上传」时，只本地存档，不要推送。
20. **截图产物放带时间戳的子目录**：`D:/tools/acceptance-shots/<批次名>-<YYYYMMDD-HHMM>/`。  
    不带时间戳的目录容易被外部进程清理（2026-10-03 实测：`batch1-before/` 与 `batch1-after/` 被整目录删除，无法恢复）。探针用 UTC 时间戳时，注意本地分钟变化会生成新目录，找产物时用 `ls -d` 通配。

    **两处截图路径用途不同，不是冲突**：`run.mjs` 一次性的截图默认写 `%TEMP%/workbuddy-acceptance-shots`（临时性质，可随系统清理）；探针的批次产物归档到 `D:/tools/acceptance-shots/<批次>-<时间戳>/`（要留档给未来会话看）。临时看一次 vs 留档跨会话，所以路径不同。
21. **发现契约 / API / DB 三边冲突时，先停下来列出冲突点，不要自行选一边。**  
    第 15 条「以 `docs/API.md` 为准」是冲突已明确后的取舍规则；在冲突尚不清楚、或涉及数据库 schema / 接口契约变更时，必须先向用户报告冲突点与影响范围，等待确认后再动手。

---

## 14. 当前任务模板

每次开新 AI 会话，贴完本约束后，再贴下面这段：

```text
当前任务：{{一句话说明要做什么}}

所属模块：{{模块名}}

需要生成/修改的文件：
- {{文件路径 1}}
- {{文件路径 2}}

具体要求：
- {{要求 1}}
- {{要求 2}}
- {{要求 3}}

不要做：
- 不要改接口契约
- 不要改数据库 schema
- 不要引入新依赖
- 不要重写无关文件

输出要求：
- 输出完整文件内容
- 每个文件用代码块包裹
- 文件路径写在代码块上方
- 不要省略代码
```

---

## 15. 验收硬性门槛

任何模块完成前必须满足以下条件。**可执行的细则、断言清单与排错方式见 `docs/ACCEPTANCE.md`**；本节只列门槛，不重复细则；「项目已完成什么」见 `README.md` 的「当前状态」。

### 契约一致性

- 接口路径、请求/响应字段符合 `docs/API.md`。
- 错误返回统一 `{ code, message, data }`，业务码取自第 6 节，不用魔法数字。
- 所有入参经 zod 校验；数据库操作一律走 Prisma，无手拼 SQL、无 `SELECT *`。
- 需登录的接口经 `auth` 中间件；密码 bcryptjs 加密，不落明文。

### 可运行性

- 前后端能启动。
- `npx prisma migrate status` 无 pending 迁移。
- `README.md` 的启动步骤能实际跑通。

### 自动化验收

- 前端改动后 `node scripts/acceptance/run.mjs` 保持全绿。
- 新增功能有对应 `probe-*.mjs` 提供客观证据（计算样式值、DOM 结构、请求参数），不靠截图判断正确性。
- 探针跑完自清理，数据库回到跑前基线，不留脏数据、不删用户真实数据。
