# 代码风格约定

本文件是 `docs/AI_CONTRACT.md` 第 12 节的展开版，补充实际可执行的细则。两者冲突时以 AI_CONTRACT.md 为准。

## 1. 通用

- 缩进：2 空格，不用 Tab。
- 字符串：单引号 `'`。需要拼接或含变量时用模板字符串 `` `${x}` ``。
- 语句结尾：分号 `;`。
- 行尾不留分号后空格，文件末尾保留一个换行。
- 禁止在输出代码里写省略号注释（`// ...`、`/* 略 */`）；要么写完整实现，要么不写。
- 常量：`UPPER_SNAKE_CASE`。变量与函数：`camelCase`。类名与组件名：`PascalCase`。

## 2. 前端（Vue 3 + Vite）

### 组件

- 一律使用 `<script setup>`，不用 Options API。
- 样式一律 `<style scoped>`，避免污染全局。
- 页面放 `src/views`，命名 `XxxView.vue`（例如 `HomeView.vue`）。
- 可复用组件放 `src/components`，命名 `PascalCase.vue`。
- 不要直接操作 DOM，除非确实没有 Vue 方案。
- 模板里不要写复杂表达式，抽成 `computed` 或函数。

### 目录职责

| 目录 | 放什么 | 不放什么 |
|---|---|---|
| `src/api` | 所有后端请求，`request.js` 导出 axios 实例 | 组件、业务逻辑 |
| `src/router` | 路由表与导航守卫 | 请求代码 |
| `src/stores` | Pinia store | DOM 操作 |
| `src/views` | 页面级组件 | 通用小组件 |
| `src/components` | 通用小组件 | 页面 |
| `src/utils` | 纯函数工具 | 有副作用的网络请求 |

### 请求

- 所有请求必须走 `src/api/request.js` 导出的 axios 实例。
- 组件内禁止出现完整 URL，最多出现路径片段。
- baseURL 来自环境变量 `VITE_API_BASE_URL`，不写死域名端口。
- 响应拦截器约定：`code === 0` 返回 `data`，其余抛错并携带 `message`；401 清除本地 token。

### 状态

- 全局共享状态才进 Pinia，组件内部状态用 `ref` / `reactive`。
- token 同时存 Pinia 和 localStorage，登出时两边一起清。

## 3. 后端（Node.js + Express + Prisma）

### 分层

```text
routes      只做 URL 到 controller 的映射，不写业务逻辑
controllers 取参数、调 service、返回统一响应，不直接操作数据库
services    业务逻辑，唯一允许调用 Prisma 的一层
middlewares 鉴权、校验、错误处理
utils       通用工具（统一响应、Prisma 单例等）
```

### 路由与控制器

- 文件命名：`xxx.routes.js` / `xxx.controller.js` / `xxx.service.js`。
- 路由模块导出 `Router` 实例，在 `src/routes/index.js` 统一挂载到 `/api` 下。
- 所有路由处理函数必须能被错误中间件捕获：用 try/catch 包住并 `next(error)`，或统一由异步包装处理。

### 数据库

- 只允许 Prisma 操作数据库，禁止手拼 SQL。
- 禁止 `SELECT *`：用 Prisma 的 `select` 明确字段。
- Prisma schema 位于 `backend/prisma/schema.prisma`，改表结构必须先更新 `docs/DB.md` 并确认。
- 软删除表查询默认带 `deletedAt: null` 条件。

### 校验与响应

- 所有入参用 zod schema 校验，通过 `validate` 中间件注入 `req.validated`。
- 所有响应走 `src/utils/response.js`：`sendOk` / `sendFail`，格式固定 `{ code, message, data }`。
- 业务码只用 `CODE` 常量，禁止在业务代码里写魔法数字。
- 错误中间件的入参是 `(err, req, res, next)` 四个参数，缺一个 Express 会当作普通中间件处理。

### 环境变量

- 只从 `process.env` 读取，入口文件顶部 `import 'dotenv/config'`。
- 禁止把密码、密钥、`DATABASE_URL` 写进代码或提交 `.env`。

## 4. 命名对照

| 场景 | 规则 | 示例 |
|---|---|---|
| 组件文件 | PascalCase.vue | `UserList.vue` |
| 前端 JS | camelCase.js | `request.js` |
| 路由文件 | xxx.routes.js | `user.routes.js` |
| 控制器 | xxx.controller.js | `user.controller.js` |
| 服务 | xxx.service.js | `user.service.js` |
| 数据库表 | 复数 snake_case | `users` |
| 数据库字段 | snake_case | `created_at` |
| Prisma 模型 | PascalCase | `User` |
| Prisma 字段 | camelCase（映射到 snake_case） | `createdAt` → `created_at` |
| API JSON 字段 | camelCase | `createdAt` |

## 5. 当前工具链状态

本次未启用 ESLint / Prettier（按约定不引入契约外依赖），以下由人工与审查保证：

- 2 空格缩进、单引号、分号 —— 全项目统一。
- Node.js 24.20.0，后端 ESM（`"type": "module"`）。
- 前端 Vite 8 + Vue 3.5，组件用 `.vue` 单文件形式。
- 后端 Express 5，注意其路由与 Express 4 的差异。
- Prisma 6.19.3，schema 中保留 `url = env("DATABASE_URL")` 的经典写法。
