# 前端验收清单（可执行版）

> 目的：**改完前端直接重跑**，不用每次手写脚本、不用自己点浏览器。
> 覆盖范围：4 个页面 × 5 个区，共 **50 条断言**，全程真实浏览器交互 + 真实后端接口。
> 依赖：只用 Node 内置能力，零新增依赖（契约 §13-3）。

---

## 1. 怎么用

### 前置（你来起，脚本不碰这两个服务）

```bash
cd backend   && npm run dev      # 3000
cd frontend  && npm run dev      # 必须是 5173，见 §6 注意点
```

端口必须是 **5173**：`backend/.env` 的 `CORS_ORIGIN` 只配了这个源，换端口请求会被 CORS 拦掉。

### 一键跑

```bash
node scripts/acceptance/run.mjs
```

### 常用参数

| 参数 | 作用 |
| --- | --- |
| `--no-cleanup` | 保留临时数据不清理（方便复现问题） |
| `--no-chrome` | 不自动拉 Chrome，用你已有的 9222 端口实例 |
| `--no-seed` | 不造临时数据（数据不足的用例会标 SKIP） |
| `--shots <dir>` | 指定截图目录，默认 `%TEMP%/workbuddy-acceptance-shots` |
| `--report <path.md>` | 额外把结果表写成 markdown 文件 |

**退出码**：`0` = 全通过；`1` = 有 FAIL；`2` = 前置检查没过（服务没起 / Node 版本不够）。

### 输出长什么样

```
PASS | A2-2 | 「最近更新」首条是被改过的那篇 | 验收占位 01（已更新）
FAIL | D1-3 | 空正文提示「正文不能为空」 | 未出现
SKIP | A3-1 | 分页翻页 | 总条数 1 ≤ 每页 10，无第 2 页

合计 50 条：PASS 49 / FAIL 1 / SKIP 0
截图目录：C:\Users\123\AppData\Local\Temp\workbuddy-acceptance-shots
```

每条的结果依据是**从浏览器里读出来的真东西**：DOM 文本、CDP 抓到的请求 URL 和状态码、跳转后的 location，不是靠"看起来没报错"推断。

---

## 2. 脚本结构

```
scripts/acceptance/
├── run.mjs              # 主脚本：前置检查 → 造数据 → 起浏览器 → 跑 50 条 → 清理 → 出报告
├── cleanup.mjs          # 单独清理临时数据（脚本被中断时用它兜底）
└── lib/
    ├── config.mjs       # 路径与配置，全部相对脚本位置推算，和 cwd 无关
    ├── cdp.mjs          # 极简 CDP 客户端（Node 内置 fetch + WebSocket）
    ├── chrome.mjs       # 找 chrome.exe + 拉起 headless + 关闭
    ├── session.mjs      # 用 JWT_SECRET 签会话 token（不用密码）
    └── fixtures.mjs     # 临时数据夹具 + 精确清理 + 自愈回收
```

---

## 3. 它替你做了哪些脏活

### 3.1 浏览器

`agent-browser` 的 CLI (`open` / `connect`) 在本机会无限挂起，不可用。脚本改为自己拉起 headless Chrome 并用 CDP 协议驱动，**不需要 puppeteer / playwright**：

```
chrome.exe --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
           --remote-debugging-port=9222 --user-data-dir=<临时 profile>
```

`--no-sandbox` 必须带：本机 Chrome 沙箱会以「拒绝访问 (0x5)」拒绝执行可执行文件。
**跑完脚本自己把 Chrome 关掉**（契约 §13-17），你可以在日志里看到「已关闭脚本自己拉起的 headless Chrome」。

### 3.2 登录态：不要密码

不去要你的密码，也不改数据库。脚本加载 `backend/.env` 里的 `JWT_SECRET`（**只进进程内存，脚本从不打印它的值**，符合契约 §13-16），按后端 `utils/jwt.js` 的 payload `{userId, username}` 签一个会话 token，塞进 `localStorage.token`（键名来自 `stores/user.js`）：

- `userId=2` → admin：验「作者才看得到编辑/删除」
- `userId=1` → demo：验「非作者打开编辑页显示无权限」

可用 `ACCEPTANCE_ADMIN_ID` / `ACCEPTANCE_DEMO_ID` 换人。

### 3.3 数据：会临时造，也会自己收干净

Tab 排序差异要 ≥2 篇文章且其中一篇改过、分页要总数 > 每页条数，库里只有 1 篇时这两项根本验不出。所以脚本会临时造数据：

- 造够「能翻到第 2 页 + 两 Tab 结果不同」的量（标题统一带 `验收占位` 前缀）
- 额外造两篇专用：一篇给「编辑后保存」，一篇给**删除流程**（**删的是脚本自己的，绝不碰你的文章**）
- 详情/编辑回填的靶子优先挑**你原有的文章**，只在没有 admin 文章时才退回临时文章
- 跑完按记录下来的 id 精确删除（外键顺序：评论 → 文章），把库还原成跑之前一样

**中断也留不下脏数据**：所有新建 id 都落盘，哪怕跑到一半被 Ctrl+C 或管道掐掉，下次开跑会先自动回收上一轮的残留；也可以手动 `node scripts/acceptance/cleanup.mjs`。

> ⚠️ 别用 `| head -N` 截断脚本输出 —— 管道关闭会把 node 提前掐死，清理就来不及跑（发生过一次）。要看前面部分就重定向到日志文件再翻。

空态是用 CDP `Fetch.fulfillRequest` 拦截返回空列表来验证的，**没有真的把数据删空**。

---

## 4. 50 条用例清单

### A 区：首页广场 `/`

| 编号 | 用例 | 预期 | F12 人工怎么看 |
| --- | --- | --- | --- |
| A1-1 | 第 1 页卡片数 | 渲染 min(每页条数, 总数) 张卡片 | Elements 里数 `.article-card` |
| A1-2 | 首屏请求参数 | 带 `sortBy=createdAt` | Network 找 `/api/articles?` 那条 |
| A1-3 | 分页条总数 | 显示「共 N 条」 | Elements 看 `.el-pagination__total` |
| A1-4 | 卡片内容 | 只有摘要，不含整篇正文 | 对比列表卡片和详情页文本 |
| A2-1 | 切「最近更新」 | 发出 `sortBy=updatedAt` 请求 | Network 新出现一条 `sortBy=updatedAt` |
| A2-2 | 「最近更新」首条 | 是刚被改过的那篇 | 看第一张卡片标题 |
| A2-3 | 切回「最新」 | 发出 `sortBy=createdAt` 请求 | Network 同上 |
| A2-4 | 「最新」首条 | 回到最新创建那篇 | 看第一张卡片标题 |
| A3-1 | 点第 2 页 | 发出 `page=2` | Network |
| A3-2 | 第 2 页条数 | 渲染「总数 - 每页条数」条 | 数卡片 |
| A3-3 | 切每页 20 条 | 发出 `pageSize=20` | Network |
| A3-4 | 切每页条数 | **强制回第 1 页**（契约要求） | 看请求里的 `page=1` |
| A3-5 | 每页 20 时 | 全部数据落在一页 | 数卡片 |
| A4-1 | 列表为空 | 出现 `.el-empty` 空状态 | Elements |
| A4-2 | 空态 | 不残留卡片 | Elements |

### B 区：文章详情 `/article/:id`

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| B0-1 | 有 token 时头部 | 渲染用户名 + 下拉，不显示「登录」 |
| B0-2 | 带 token 加载 | 请求 `/auth/me` |
| B1-1 | 标题渲染 | 与接口 `data.title` 一致 |
| B1-2 | 正文渲染 | 分段、换行保留（`white-space: pre-wrap`） |
| B1-3 | 作者卡片 | 头像 + 昵称 + `@用户名` |
| B2-0 | 未登录 | **看不到**编辑/删除按钮 |
| B2-1 | 作者本人 | 编辑/删除按钮都在 |
| B3-1 | 点编辑 | 跳 `/editor/:id` |
| B3-2 | 编辑页 | 表单回填原标题（不触发保存） |
| B4-1 | 点删除 | 弹二次确认框 |
| B4-2 | 确认删除 | 回首页 |
| B4-3 | 删除后 | 总数 -1（软删除，接口不再返回） |

### C 区：评论

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| C1-1 | 未登录 | 显示「登录后才能发表评论」 |
| C1-2 | 未登录 | 不渲染输入框（没有 `textarea`） |
| C1-3 | 点「去登录」 | 跳 `/login?redirect=/article/:id` |
| C2-1 | 登录后发表 | 发出 `POST /comments`，返回 201 |
| C2-2 | 请求路径 | 顶层资源 `/api/comments`（符合 `docs/API.md`） |
| C2-3 | 发表后 | 列表立刻出现新评论 |
| C2-4 | 发表后 | 总数 +1 |
| C2-5 | 发表后 | 输入框被清空 |
| C3 | 刷新页 | 评论仍在（已落库） |

### D 区：编辑器 `/editor`、`/editor/:id`

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| D1-1 | 空标题提交 | toast「标题不能为空」 |
| D1-2 | 校验不通过 | **不发** POST /api/articles |
| D1-3 | 空正文提交 | toast「正文不能为空」 |
| D1-4 | 标题 > 100 字 | toast「标题最多 100 个字」 |
| D2-1 | 新建成功 | 跳 `/article/:新id` |
| D2-2 | 详情页 | 展示新标题与正文 |
| D3-1 / D3-2 | 编辑回填 | 标题、正文都回填 |
| D3-3 | 点保存 | 跳回 `/article/:id` |
| D3-4 | 详情页 | 标题已更新 |
| D4-1 | 新建页「取消」 | 回首页 |
| D4-2 | 编辑页「取消」 | 回详情页 |
| D5 | 非作者打开编辑页 | 显示「只有作者本人可以编辑这篇文章」 |

### E 区：路由守卫

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| E1 | 未登录访问 `/editor` | 跳 `/login?redirect=/editor` |
| E2 | 未登录访问 `/editor/:id` | 跳 `/login?redirect=/editor/:id` |

---

## 5. 三个「看着像 bug，其实不是」

1. **Tab 切换像是没反应**：需要 ≥2 篇文章、且其中至少 1 篇被改过（改过才会让 `updatedAt` 和 `createdAt` 排序不同）。只有 1 篇文章时两个 Tab 返回完全相同的结果，正常。
2. **长度校验触发不了**：输入框写了 `maxlength="100"`，手工输入到不了 101 字。脚本是用 JS 绕过 `maxlength` 强行赋值的。
3. **过期/失效 token 不会立刻被拦**：前端只在收到 401 时才清 token 并跳登录。拿旧 token 能进页面，是直到请求返回 401 才被踢出。
4. **切 Tab / 翻页后不能再用「卡片数 > 0」判断刷新完成**（第二批 B2 之后）：翻页时旧列表是**留在原地**的，卡片数一直 > 0。脚本统一改成等 `.home-list.is-refreshing` 这个刷新标记消失。以后谁再写列表相关的等待，都用这个标记，别退回数卡片。

---

## 6. 环境变量 / 排错

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ACCEPTANCE_FRONTEND` | `http://localhost:5173` | 前端地址 |
| `ACCEPTANCE_API` | `http://127.0.0.1:3000/api` | 后端 API |
| `CDP_PORT` | `9222` | CDP 调试端口 |
| `CHROME_PATH` | 自动搜索 | 指定 chrome.exe |
| `ACCEPTANCE_ADMIN_ID` / `ACCEPTANCE_DEMO_ID` | `2` / `1` | 两个会话用户 |
| `ACCEPTANCE_SHOTS` | `%TEMP%/workbuddy-acceptance-shots` | 截图目录 |

排错：

- **「前端探不到」**：确认 dev server 是 5173；**它只监听 IPv6 `[::1]:5173`**，用 `127.0.0.1:5173` 探会失败；手工用 curl 探本机要加 `--noproxy '*'`（本机 curl 默认走代理 `127.0.0.1:51332`，否则看到的是代理返回的 502）。
- **「找不到 chrome.exe」**：设 `CHROME_PATH`，或先跑一次 `agent-browser install` 下载。
- **「需要 Node ≥ 22」**：CDP 客户端用了 Node 内置的全局 `WebSocket`。

---

## 7. 最近一次结果

`node scripts/acceptance/run.mjs` → **合计 50 条：PASS 50 / FAIL 0 / SKIP 0**（2026-10-03，第三批 F1/F2/F7/D1 + B2 进度条之后，结论不变；第四步 ⑤ 暗色模式叠加后仍是 50/50 全绿）。

历史上一共出现过 2 条 FAIL，**都是脚本自己的断言写错，不是产品问题**，已修复：

1. 把评论接口断言成 `/api/articles/:id/comments`，实际是顶层资源 `/api/comments`（`docs/API.md` 就是这么定的）。
2. 把「评论总数 +1」写死成「共 2 条」，应先读发表前的总数再比 +1。

### 配套的量化探针（不靠肉眼看截图）

| 脚本 | 量什么 |
| --- | --- |
| `node scripts/acceptance/probe-styles.mjs` | 读计算样式：页面底色、卡片盒模型、主色变量、hover 位移 |
| `node scripts/acceptance/probe-batch2.mjs [截图目录]` | B1 骨架屏与真实卡片的盒模型逐项比对；B2 刷新期间旧列表是否还在；H1 各路由是否按需加载 |
| `node scripts/acceptance/probe-batch3.mjs [截图目录]` | F1 返回顶部按钮显隐/回顶；F2 卡片是 `<a>` 且键盘可聚焦；F7 标题随文章变+复原；D1 空态「写第一篇」按登录态显隐；B2 刷新进度条激活/变淡/隐藏 |
| `node scripts/acceptance/probe-dark.mjs [截图目录]` | ⑤ 暗色模式：切换按钮可用、变量成对翻转、EP 组件（输入框/主按钮）暗色下无白底白字、刷新保持选择（22/22 通过） |
| `node scripts/acceptance/probe-profile.mjs [截图目录]` | ① 个人主页：作者名渲染、按 author.id 前端过滤、分页 total 取过滤后真实条数、空态复用 EmptyState |
| `node scripts/acceptance/probe-prevnext.mjs [截图目录]` | ③ 上一篇/下一篇：拉 100 篇窗口定位当前篇、上=更旧(下一条)/下=更新(上一条)、边界禁用、超出窗口两条都禁用（4 场景共 12 项） |
| `node scripts/acceptance/probe-author-others.mjs [截图目录]` | ② 作者其他文章：复用 ③ 100 篇窗口、过滤同作者排除当前篇取前 min(5, 窗口内篇数-1)、复用 ArticleCard、窗口内该作者仅当前篇时整块不渲染（2 场景共 5 项） |
| `node scripts/acceptance/shot-hover.mjs` | 真移鼠标后截 hover 态 |
| `node scripts/acceptance/shot-before.mjs` | 注入覆盖样式还原「改前观感」并拍对照图 |

探针会**按住列表请求**（`Fetch.enable` + 暂不 `continueRequest`）来定格骨架屏/刷新态，再用 `fulfillRequest` 造假响应 —— 全程不动真实数据。
