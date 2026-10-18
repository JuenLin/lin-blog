<!-- 文档：ACCEPTANCE.md | 定位：验收规范 | 核心：自动化验收探针编写规范与执行回归细则。 -->

# 前端验收清单（可执行版）

> 目的：**改完前端直接重跑**，不用每次手写脚本、不用自己点浏览器。
> 覆盖 4 类交互区、7 个页面中的主路径，共 **50 条断言**，全程真实浏览器交互 + 真实后端接口。
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
PASS | A2-1 | 切「热门」发出 sortBy=likeCount | 已捕获请求
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
├── probe-*.mjs          # 各批次的量化探针（25 个：search / search-ui / password / profile /
│                        #   profile-edit / like / liked / upload / dark / styles / batch2 /
│                        #   batch3 / card-visual / card-liked / prevnext / author-others / entries /
│                        #   category / user-detail / profile-tabs / comment-delete / follow / admin /
│                        #   draft / bookmark / view）
├── shot-*.mjs           # 截图辅助脚本（3 个：hover / before / detail-title，不改源码，仅 CDP 注入）
└── lib/
    ├── config.mjs       # 路径与配置，全部相对脚本位置推算，和 cwd 无关
    ├── cdp.mjs          # 极简 CDP 客户端（Node 内置 fetch + WebSocket）
    ├── chrome.mjs       # 找 chrome.exe + 拉起 headless + 关闭
    ├── session.mjs      # 用 JWT_SECRET 签会话 token（不用密码）
    ├── fixtures.mjs     # 临时数据夹具 + 精确清理 + 自愈回收
    └── tmp-account.mjs  # 一次性账号清理（只删 pwprobe 前缀用户名，传错参数直接 throw）
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
- 跑完按记录下来的 id 精确删除：夹具三表走主流程末尾的 `cleanupFixtures`，按 RESTRICT 依赖逐级（likes → comments → articles）；探针临时账号走各自 `finally` 里的 `cleanupProbeAccounts`（只删`pwprobe` 前缀）。两条路径跑完把库还原成跑之前一样。

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
| A2-1 | 切「热门」 | 发出 `sortBy=likeCount` 请求 | Network 新出现一条 `sortBy=likeCount` |
| A2-2 | 「热门」首条 | 是点赞最多的那篇（夹具专门点了赞） | 看第一张卡片标题 |
| A2-3 | 「热门」排序有效 | 卡片上的点赞数**非递增**（真实读取每张卡） | 逐张看卡片点赞数 |
| A2-4 | 切回「最新」 | 发出 `sortBy=createdAt`，首条回到最新创建那篇 | Network + 看第一张卡片标题 |
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

## 5. 四个「看着像 bug，其实不是」

1. **Tab 切换看不到排序差异**：「热门」按点赞数排序，需要**有点赞数据**才能验（夹具会给某篇夹具文章点上赞）。库里完全没有点赞时，「热门」和「最新」的首条可能碰巧相同，看起来像没生效 —— 这时看 Network 里有没有 `sortBy=likeCount` 才算数（A2-1 就是这么判的）。另外「最新」按 `createdAt`、「热门」按 `likeCount`，**两者排序结果的差异要靠点赞数区分**，不是靠更新时间。
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

- **「前端探不到」**：确认 dev server 是 5173；**它只监听 IPv6 `[::1]:5173`**，用 `127.0.0.1:5173` 探会失败；手工用 curl 探本机要加 `--noproxy '*'`（本机 curl 默认走代理，端口号每次会话可能变，否则看到的是代理返回的 502）。
- **「找不到 chrome.exe」**：设 `CHROME_PATH`，或先跑一次 `agent-browser install` 下载。
- **「需要 Node ≥ 22」**：CDP 客户端用了 Node 内置的全局 `WebSocket`。

---

## 7. 最近一次结果

`node scripts/acceptance/run.mjs` → **合计 50 条：PASS 50 / FAIL 0 / SKIP 0**（2026-10-08 复跑：第 2 批用户主页前端重构之后仍是 50/50 全绿；更早的基线是 2026-10-04，第三批 F1/F2/F7/D1 + B2 进度条之后、第四步 ⑤ 暗色模式叠加之后结论均未变）。

分类功能（2026-10-04 新增）另加 `node scripts/acceptance/probe-category.mjs` → **13/13 全绿**；含它的完整批共 **301 项断言全绿、exit 全 0**（原 288 + 分类 13）。

用户主页重构（2026-10-08 新增）另加 `node scripts/acceptance/probe-profile-tabs.mjs` → **29/29 全绿、exit 0**。跑前跑后库一致：**users 4** / 文章 13（可见 11）/ 评论 1 / likes 3 —— 注意 users 基线自 2026-10-07 起是 **4 不是 3**，多出来的 `#64 pwprobe1791293218495285` 由 `probe-password` 于 2026-10-06 遗留（0 文章 0 赞 0 评论），已决定保留不清；写「users 3」会误报多一个账号。

第 5 批 管理员后台新增 `node scripts/acceptance/probe-admin.mjs` → **59/59 全绿、exit 0**（A 组 非管理员访问 `/api/admin/*` 全部 403/40300；B 组 管理员操作含「管理员不能封禁或解封管理员」→ 40000 防呆，admin 与 lin 已置 ADMIN；C 组 role 透出；D 组 后台页渲染 + `UserDropdown` 管理后台入口只对 ADMIN 显示；E 组 代码块高亮 + TOC + DOMPurify XSS）。跑前跑后库一致：探针自建 ADMIN 临时账号并 `finally` 物理删，**不碰 admin / lin**。

第 6 批 草稿/自动保存/版本历史新增 `node scripts/acceptance/probe-draft.mjs` → **25/25 全绿、exit 0**（门槛 IDLE / 建+更新含清空 0 字 / 草稿箱带 content 全文 / DRAFT 详情 404 / draftId 与 sourceArticleId 越权 404 / 快照产生+倒序 / restore 先快照后覆盖 / 跨文章 revisionId 404 / 非作者 403 / 计数只数 PUBLISHED / 未登录 401，详见探针表）。同轮回归（2026-10-17）：`run.mjs` **50/50**、`probe-like` **24/24**（B1 并发本轮通过，历史偶发 500 挂账仍在）、`probe-follow` **22/22**（基线相对写法复核 users 6→6、follows 1→1 一致）、`probe-admin` **59/59**，全部 exit 0。前端 build 绿；`probe-draft` 自建 A/B 双账号，finally 按 revisions → articles → users 清理，跑后零残留。

第 9 批 收藏夹 + 阅读量新增 `node scripts/acceptance/probe-bookmark.mjs` → **26/26 全绿、exit 0**（A 组幂等语义 11 项：重复收藏/取消未收藏都 200，与 like 的 409/404 刻意相反已钉死；B 组列表 6 项：默认 bookmarkedAt desc、bookmarkedAt≠createdAt、分页、白名单；C 组串号 3 项；D 组 UI 6 项：刷新后金星不丢、收藏 Tab、.prevent.stop）与 `node scripts/acceptance/probe-view.mjs` → **15/15 全绿、exit 0**（V 组 13 项：免登录 +1、同 IP 同文章判重不 +1、换文章正常 +1（证明是判重不是链路坏）、viewCount 三处透出、sortBy=viewCount 双向排序（Prisma 造数 5 vs 1）、软删/草稿/不存在 404、非法 id 400；U 组 2 项：详情页 POST /view 恰好 1 次、「阅读 N」chip 与接口一致）。同轮回归（2026-10-18）：`run.mjs` **50/50**、前端 build 绿。跑前跑后库一致：users 6 / 文章 17（可见 14）/ 评论 2 / likes 3 / follows 1 / **bookmarks 0** / notifications 0。两探针均走 `tmp-account` 统一清理（本轮已给该库函数补上 bookmarks 清理——第 9 批新表双 RESTRICT 外键，不补会在硬删账号时撞 P2003）。

同轮附加回归还抓到并修复了**第 8 批漏网的一个探针清理问题**：`probe-liked` 断言 26/26 全绿但清理阶段崩（`article.deleteMany` 撞 notifications 外键）——第 8 批给 like 服务加了通知钩子后，「次账号给主账号靶子文章点赞」会产生 LIKE 通知，而 probe-liked 自有清理顺序还是旧的 likes→articles→users（不走 tmp-account，所以第 8 批当天修公共库时漏了它）。已按同款顺序补 notifications（+bookmarks 防护）并复跑全绿；`probe-card-liked` 的自定义 cleanup 同款前置（防将来型）。**教训：新增关系表 + RESTRICT 外键时，所有自带清理逻辑的探针都要过一遍，不能只修两个公共清理库。** 连带确认：`probe-like` 24/24、`probe-liked` 26/26、`probe-card-liked` 全绿，exit 全 0。

同轮按上述教训做了**全量排查**（grep 全部 `probe-*.mjs` 的 deleteMany/cleanup，逐个核对通知/收藏覆盖），又修复 7 个探针并复跑全绿：`probe-comment-delete`（14/14，清理实证删通知 3 条）、`probe-nested-comment`（19/19，删通知 7 条）、`probe-user-detail`（88/88，删通知 3 条）——这三个不清通知则删文章/账号必撞 P2003；`probe-like`（24/24，删通知 1 条：E4 点的列表第一张卡是真实用户文章，跨账号点赞产 LIKE 通知、actor_id 指向探针账号，不清则账号删不掉）、`probe-draft`（25/25）、`probe-tag`（19/19）、`probe-profile-tabs`（29/29）为同顺序加固。公共路径 `lib/fixtures.mjs` 补 bookmarks（自愈路径 cleanupKnownArtifacts 同享）、`run.mjs` 清理日志加通知/收藏计数。复跑后库与基线一致（notifications 0 / bookmarks 0）。`probe-admin` 的 hardDeleteUser 同款加固因文件读取被敏感门控拦截，顺延第 10 批（与 probe-notification preflight 自愈一起）。

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
| `node scripts/acceptance/probe-card-visual.mjs [截图目录]` | ④ 卡片视觉丰富：元数据 chip 化（**作者/时间两枚**）、**时间 chip 显示相对时间**、**卡片上无阅读时长 chip**（反向断言无accent chip；方案 D 起卡片改用相对时间，阅读时长只在详情页展示）、summary 为空/纯空白不影响 chip 构成、详情页按 content 算精确值、chip 令牌生效（胶囊圆角/非透明底/无白底白字）、暗色下 chip 底与字成对翻转（4 场景共 14 项） |
| `node scripts/acceptance/probe-entries.mjs [截图目录]` | 第六批 入口：`UserDropdown` 我的主页（在退出登录上方 / 跳转 id 正确 / 保留退出登录）、卡片作者可点且**不误触发**进详情、点标题仍进详情、AuthorCard 整卡可点、评论者可点、UserProfile 标题为「XXX 的主页」且无编辑资料/关注按钮（16 项） |
| `node scripts/acceptance/probe-search.mjs [报告目录]` | 第二步 搜索 `GET /api/articles?keyword=`：命中标题 / 命中正文 / 搜不到 / 不匹配作者昵称、空串与纯空白不 400、超 50 字符 400（边界 50 通过）、搜索下分页两页不重叠 / asc-desc 反序 / sortBy 白名单仍生效 / 不传 keyword 行为不变、软删除搜不到、重复传值 400、首尾空格 trim（**纯 API，不启 Chrome**，共 16 项） |
| `node scripts/acceptance/probe-password.mjs [报告目录]` | 第二步 修改密码 `PUT /api/auth/password`：成功返回 200/code 0/message「密码已修改」/data 为 null、改完后新密码能登录、旧密码登录 401、**旧 token 仍可用且仍具备写权限**（「旧 token 语义」）、未登录 401、oldPassword 错 401（message 与登录接口一致）、newPassword 与旧密码相同 400、5 字符 400、101 字符 400、25 个汉字（75 字节）400、**24 个汉字（72 字节）边界通过**、禁传 userId/id/username 各 400 且**未误改密码**、还原前前提检查、改回初始值、还原后重新登录（**纯 API，不启Chrome，共 19 项**） |
| `node scripts/acceptance/probe-profile-edit.mjs [报告目录]` | 第九批 用户头像/简介 `PUT /api/users/me`：**三态语义**（字段不出现=不改 / `avatar:null`=清空且**不是空操作** / 设 `/uploads/` 路径 / `bio:""`=转null 清空）、同时传两项、未登录+非法体→**401 而非 400**（证明 `auth` 在 `validate` 之前）、token 有效但用户已软删→40400、禁传 username/id/userId/password 各 40000、**avatar 只接受 `/uploads/` 站内路径**（外链 `https://`/`http://` 与 `javascript:` / `data:` / `ftp:` / 相对路径 / 无协议 `example.com/a.png` 共 7 种非法值全拦）、长度边界 255 与 200 放行而 256 与 201 拒绝、成功响应含完整 public user、`GET /auth/me` 同步含两键、**回归：内嵌 author 含 `avatar` 键且不含 `bio` 键**（**纯 API，不启 Chrome，共 30 项**） |
| `node scripts/acceptance/probe-like.mjs [--shots <dir>]` | 第十批 点赞 `POST` / `DELETE /api/articles/:id/like`：创建文章 201 带 `likeCount:0`、首次点赞 200 且 `liked=true`+`likeCount=1`、**重复点赞 409/40900**、点赞后 `GET /articles/:id` 的 `likeCount` 同步、取消 200 且回落 0、**取消没赞过的 404/40400**、**真并发双 POST 恰好 1 个 200 + 1 个 409**（证明靠 DB 唯一约束兜底，不是「先查后写」）、并发后 `likeCount` 恰为 1、未登录点赞 / 未登录取消 / 非法 token 各 401、**软删文章点赞 / 取消 / 详情全 404**、列表页只发 1 次 `GET /api/articles`（**无 N+1**）、每张卡片 `likeCount` 与接口逐一对齐、卡片点赞按钮 **`.prevent.stop` 生效（计数 +1 且不跳详情页）**、点后进入 `is-liked` 态、再点回到原值（**启 Chrome 验列表交互，共 23 项**） |
| `node scripts/acceptance/probe-card-liked.mjs` | 列表卡片「已点赞态」同步（likedStore 缓存方案，对应后端 `GET /api/users/me/likes`）：登录拉一次「我赞过的文章 id」缓存在 `frontend/src/stores/liked.js`，卡片命中即红；A 组 未登录不打该请求、登录恰好 1 次（无 N+1）、刷新后仍红（核心回归）；B 组 广场/文章Tab/点赞Tab 三处列表点位都认得红心；C 组 取消点赞即时变灰、UI 登出后全灰且不再打该请求；D 组 换账号不串号（A 赞过的在 B 首页是灰的）；与 `probe-liked.mjs` 分工：本探针管【列表卡片】红心，probe-liked 管【详情页】按钮态（`:id/liked` 接口）（**启 Chrome，共 10 项**） |
| `node scripts/acceptance/probe-liked.mjs` | 第十四批 `GET /api/articles/:id/liked` + `/settings` 设置页：liked 的 `data` 只含 `liked` 一个键（不带 `likeCount`）、点赞后变 true / 取消后变 false、**另一个未点赞账号查同一篇仍为 false（按 userId 隔离）**、双账号互不影响、未登录/非法 token/未登录+非法 id 各 401（证明 `auth` 先于 `validate`）、已登录+非法 id 400、不存在文章 404、**软删文章 404**；详情页**刷新后按钮态还原为 `is-liked`**（核心诉求）且 `aria-pressed` 同步、进入时恰好发 1 次 liked 请求、已赞态点按钮计数 -1、换文章按新 id 重拉、**未登录访问详情页不发该请求且不被 401 拦截器踢走**；`/settings` 未登录跳登录带 redirect、`/settings` 重定向到 `/settings/profile`、侧栏两项且当前项高亮、点侧栏切换子页且壳不丢、下拉菜单入口已合并为「设置」（**启 Chrome，共 26 项**） |
| `node scripts/acceptance/probe-upload.mjs [报告目录]` | 第十一批 头像上传 `POST /api/users/me/avatar`：真传 PNG → 201 且 avatar 形状为 `/uploads/avatars/{userId}/{ts}-{16hex}.{ext}`、**originalname 不参与命名**（故意传 `../../evil.html`）、落盘字节数一致、静态可访问且 `content-type: image/*`、目录列表已关 / 点文件被拒、非 multipart / 无文件 / 字段名错 / `image/gif` / 超 2MB / 未登录 各自 40000 或 40100、**二次上传旧文件被删（磁盘核对）**、`PUT /me` 传站内路径放行 + 传非 `/uploads/` 值（伪协议/外链/相对路径）全 40000、`avatar:null` 清空且旧文件删、回收后 users 条数复原（**纯 API + 直读磁盘，不启 Chrome，共 19 项**） |
| `node scripts/acceptance/probe-search-ui.mjs [截图目录]` | 第七批 前端搜索框：未登录时搜索框渲染在 AppHeader 内、回车触发且 URL 带 keyword、真实请求带 keyword（抓 Network）、页面结果与后端命中 id 集合逐一对齐、刷新后搜索态保留、切 Tab 仍带 keyword、第 2 页状态下搜索 page 重置为 1、搜不到时独立文案 + 清空搜索按钮且不误显示「还没有文章」、点清空恢复全量、详情页/个人主页搜索框可见且回车跳回首页带 keyword、**卡片时间 chip 悬停出绝对时间且 chip 本身显示相对时间**（两者互补）、详情页阅读时长 chip 悬停出「预计阅读时长」（含暗色，共 21 项） |
| `node scripts/acceptance/probe-category.mjs [报告目录]` | 分类功能 `POST` / `GET` / `PUT` + 卡片 chip：POST 带/不带 category（默认未分类）、`GET ?category=技术` 只返回技术子集、`GET ?category=xx` → 400/40000、`GET ?category=技术&keyword=xx` 两条件 AND、PUT 不传保留原值、PUT 非法 → 400、列表/详情响应含 category、卡片渲染分类 chip 且复用 `.article-chip` 基类（含暗色成对翻转，**启 Chrome，共 13 项**） |
| `node scripts/acceptance/probe-user-detail.mjs` | 第 2 批 用户主页三个接口的**后端**探针：`GET /users/:id` public user 恰 6 个字段且**不含** `password` / `updatedAt` / `email`、字段名是 `receivedCommentCount` 而**非** `commentCount`（防回归）、三个计数实时 COUNT 且口径为「别人给我的」（`receivedLikeCount` **含自赞**；别人在我文章上评论才算我收到的）、跨用户隔离（A 给 B 点赞是「给出去的赞」，不计入 A 的 `receivedLikeCount`）；`GET /users/:id/articles` 存在但 0 篇返 200 空列表、**软删文章不计入**、`pageSize=2` 翻两页 2+1 无重复；`GET /users/me/likes` 每条带 `likedAt` 且**与文章 `createdAt` 不同**（证明取的是 `likes.createdAt`）、软删文章上的赞不计入、未登录 401；D 组验路由注册顺序与**既有接口不回归**，并把 `GET /api/users/me`（不带 `/likes`）回 400 登记为预期行为以防将来当 bug 修（**纯 API，不启 Chrome，共 88 项**） |
| `node scripts/acceptance/probe-profile-tabs.mjs [截图目录]` | 第 2 批 用户主页重构 `GET /users/:id` + `/users/:id/articles` + `/users/me/likes`：头部三计数与详情接口**逐字一致**、**0 篇用户头部不退化成「用户 #id」**（旧实现靠列表反推 author，0 篇就丢昵称/头像）、文章 Tab 第一页 10 张且**两页无重复**（证明是真后端分页不是前端切片）、total 走后端 COUNT、不再出现「仅显示最近 100 篇」、点赞 Tab **仅本人主页可见**、软删文章不计入、每条都带 `likedAt` 且**与文章 `createdAt` 不同**（证明取的是 `likes.createdAt` 而非文章时间，符合契约「不得改 `toArticleListItem()`、须在 map 之后另行附加」）；切 Tab 页码重置为 1 且**每次都重新发请求**、**反复切 3 轮每次列表都有数据**（修的真 bug：曾被 `initialized` 短路，切回历史 Tab 只清空不加载 → 全变空）、首屏骨架只给当前激活 Tab、翻页 `is-refreshing` 期间旧卡片仍在（含浅色/暗色截图，**启 Chrome + Network 域，共 29 项**） |
| `node scripts/acceptance/probe-comment-delete.mjs` | 第 3 批 评论删除 `DELETE /api/comments/:id`：评论作者删自己 / 文章作者删他人（文章未软删）/ 第三人删他人→403（且评论未被删）/ 重复删→404 / 未登录→401 / 非法 id→400；A 组纯 API（10 项）+ B 组 Chrome 交互（4 项）：B 视角下删除按钮、二次确认框、删除后列表消失、空态出现；A10 文章作者软删收口（**共 14 项**） |
| `node scripts/acceptance/probe-follow.mjs` | 第 4 批 关注功能 `POST` / `DELETE /api/users/:id/follow` 与 `GET /api/users/:id/followers` / `following`：A 组纯 API（7 项）：首关 200 且 **`followerCount` 属于路径 `:id` 这个人、`followingCount` 属于操作者本人**（计数归属断言，两者不是同一个对象）、**重复关注 200 幂等（非 409）**、关注自己 400、关注不存在的人 404、取消关注 200、**取消未关注的 200 no-op（非 404）**、跑完 A/B 之间 follows 行数归零（给 B 组干净起点）；B 组 Chrome（B1-B9 + B5b + B10 拆 5 条，共 15 项）：自己主页按钮是「编辑资料」而非关注且文案「N 关注 + 我的粉丝」、别人主页按钮三态（关注 / 已关注）与文案「他关注 / 他的粉丝」（纯文字链接，零额外请求）、点关注切「已关注」且自己主页计数 +1、取关回「关注」且计数 -1 且**无二次确认框**、粉丝 / 关注列表页（标题带昵称 / 40px 头像 / **不含 bio** / `followedAt` 相对时间且悬停出绝对时间 / 点整行进主页）、双空态文案分开、非法 type 重定向回 `/user/:id`、**换账号 followingStore 已 reset 不串号**（全程客户端路由，不用整页刷新）（**启 Chrome + Network 域，共 22 项**） |
| `node scripts/acceptance/probe-admin.mjs [报告目录]` | 第 5 批 管理员后台 + 权限系统 + 代码块/TOC 渲染 + XSS 防护：A 组 非管理员访问 `/api/admin/*` 全部 403/40300；B 组 管理员操作（stats / users 列表 / 改 status 封禁 / 删文章 / 删评论，含「管理员不能封禁或解封管理员」→ 40000 防呆、admin 与 lin 已置 ADMIN）；C 组 role 透出（toPublicUser 与两份 AUTHOR_SELECT 含 role）；D 组 Chrome 管理后台页渲染（含 `/admin` 路由守卫非 admin 回首页、统计卡渲染、金色徽章、UserDropdown 管理后台入口只对 ADMIN 显示，共 6 项）；E 组 代码块高亮 + TOC 锚点 + DOMPurify XSS 防护（**启 Chrome + 报告目录，共 59 项**，实测 59/59 全绿、exit 0） |
| `node scripts/acceptance/probe-draft.mjs` | 第 6 批 草稿 / 自动保存 / 版本历史 / 回滚（**纯 API，双账号 A 作者 + B 越权者，不启 Chrome，共 25 项**，实测 25/25 全绿、exit 0）：G1 建草稿门槛（title 空且 content<10 字 → `{id:null,status:'IDLE',saved:false}` 且草稿箱仍为 0，**补丁 3 第一道闸**）；G2 auto-save 建草稿（`{status:'DRAFT',saved:true}`）→ 草稿箱列表 **带 `content` 全文**（继续编辑回填的唯一来源，坑 3 决定了草稿没有公开详情可拿）→ **持有 draftId 后清空到 0 字仍保存成功且确实落库**（补丁 3 第二道闸）；G3 草稿隔离（DRAFT 公开详情 404/40400；B 用 A 的 draftId auto-save → **404 非 403**、B 删 A 草稿 → 404、不存在的 draftId → 404）；G4 PUT 已发布文章产生快照（total=1 且快照=更新前内容）→ 再 PUT total=2 且**倒序**（最新在前）、草稿查版本历史 → 404（草稿无版本）、非作者查 → **403/40300**（此处与草稿口径刻意不同）；G5 restore 回滚后正文/标题回到所选版本、**回滚本身也产生快照**（先快照后覆盖，total 2→3 且最新=回滚前）、revisionId 属于别的文章 → 404（防跨文章回滚）、非作者 restore → 403；G6 补丁 1（sourceArticleId 指向他人文章 → 404；本人建独立草稿成功 → PUT 原文覆盖 + DELETE 临时草稿 → 已删 draftId 再 auto-save → 404 物理删生效）；G7 坑 4（articleCount 与个人主页列表**只数 PUBLISHED**，草稿不计入）；G8 未登录 401/40100。清理按 **revisions → articles → users** 顺序（两条 author 外键 RESTRICT） |
| `node scripts/acceptance/probe-bookmark.mjs` | 第 9 批 收藏 `POST` / `DELETE /api/articles/:id/bookmark` + `GET /:id/bookmarked` + `GET /users/me/bookmarks`：A 组 **幂等语义与 like 刻意相反**（重复收藏 / 取消没收藏过的都 **200 / code 0**，断言「不是 409 / 404」钉死差异，防将来被「统一」）、查询接口只回 `{ bookmarked }` **不带 bookmarkCount 键**、未登录 / 非法 token 四接口各 40100、软删文章三接口全 404；B 组 收藏列表（total、默认 `bookmarkedAt` desc、`bookmarkedAt` 与文章 `createdAt` 是两个时间、pageSize=1 翻两页、sortBy 白名单内 200 / 越界 40000、列表项与文章列表同形带 viewCount/likeCount）；C 组 换账号不串号（B 的列表为空、B 收藏 A 已收藏的靶子 → `bookmarkCount=2` 证明是**全站该文章**口径而非「我的」）；D 组 Chrome（未登录不打 `/users/me/bookmarks`、登录恰好 1 次无 N+1、**刷新后收藏过的卡片仍是金色 ★**、收藏 Tab 全星标且顺序=默认排序、点星标 `.prevent.stop` 生效不跳详情页且完整往返）（**启 Chrome + Network 域，双账号，共 26 项**） |
| `node scripts/acceptance/probe-view.mjs` | 第 9 批 阅读量 `POST /api/articles/:id/view` + `viewCount` 透出 + `sortBy=viewCount`：新建文章响应带 `viewCount:0`、**未登录**首次 +1（阅读免登录，与点赞/收藏刻意不同）、同 IP 同文章立即重发**不 +1**（判重窗口）、**同 IP 换一篇文章正常 +1**（证明上一条是判重而非计数链路坏）、详情与列表 viewCount 透出且口径一致、`sortBy=viewCount` desc/asc 双向排序（Prisma 造数 5 vs 1）+ `viewcount` 小写 40000（大小写敏感）、软删 / 草稿 / 不存在 id 各 40400、非法 id 40000；U 组 Chrome：详情页 mounted 后 **POST /view 恰好 1 次**（未登录也计）、meta 行「阅读 N」chip 与接口 viewCount 一致（轮询等 fire-and-forget 响应，不睡死）（**启 Chrome + Network 域，共 15 项**） |
| `node scripts/acceptance/shot-hover.mjs` | 真移鼠标后截 hover 态 |
| `node scripts/acceptance/shot-before.mjs` | 注入覆盖样式还原「改前观感」并拍对照图 |
| `node scripts/acceptance/shot-detail-title.mjs` | 详情页标题随文章变 + 复原 |

探针会**按住列表请求**（`Fetch.enable` + 暂不 `continueRequest`）来定格骨架屏/刷新态，再用 `fulfillRequest` 造假响应 —— 全程不动真实数据。

> **涉及密码 /登录态的探针必须自建一次性账号，绝不能用 admin 或 demo。** `lib/session.mjs` 的 `mintToken` 是直接用 `JWT_SECRET` 签名，**不经过密码校验**，所以它验不了「密码改了还能不能登录」这类语义 —— 那类探针必须走真实 `POST /auth/login`，就必然需要一个已知密码的账号。正确做法：注册一个 `pwprobe<时间戳>` 账号，只动它自己，跑完用 `lib/tmp-account.mjs` 的 `cleanupProbeAccounts` 按用户名精确硬删。
>
> `cleanupProbeAccounts` **只删 `pwprobe` 前缀的用户名**，传错参数直接 throw 而非误删；用户不存在 `DELETE /api/users`（API.md 登记为未实现），所以走 Prisma 直连，**不手写SQL**（契约 §11）。
>
> 这类探针还要注意**「当前生效密码」会随用例漂移**：改了密码后，后续用例的 `oldPassword` 必须跟着变，否则整片用例会连环崩在「登录拿不到 token」上（`probe-password` 首轮就踩了这个：72 字节边界用例把密码改成 24 个汉字后，`currentPassword`被错设回初始值，导致还原步骤中断）。已改为先断言登录成功再取值，不做裸链式取值。

> **用 `Fetch` 造假响应时必须单独处理 OPTIONS 预检。** `src/api/request.js` 给所有请求（含 GET）都设了 `Content-Type: application/json`，这不是 CORS 安全值，所以跨源列表请求**一定**会先发一次 OPTIONS 预检。若把 OPTIONS 也 `fulfillRequest` 成列表体、且不返回 `Access-Control-Allow-Methods` / `Access-Control-Allow-Headers`，浏览器会直接拦掉随后的真实 GET —— 页面表现为「Network Error + 卡片 0 张」，看起来像前端坏了，实际是探针自己的问题。
> 正确写法：先按 `request.method === 'OPTIONS'` 分支回 `204` + 三个 CORS 头并 `return`，其余请求再走原来的 fulfill/continue 逻辑。`probe-card-visual` / `probe-author-others` / `probe-prevnext` / `probe-profile` 都踩过这个坑（2026-10-03 修）。

## 8. 探针审计记录

> 2026-10-04 第 3 批复审计 + 修复。原始编号清单（#21-40）未落盘、会话检索不可得，故本轮按相同类别（label/文案对齐、清理死等待、B2-3 opacity 时序脆弱）对当时全部 15 个探针的断言重新通读（`probe-category.mjs` 于本批之后新增，见 8.4）。结论：**只发现 2 类真问题，label/文案对齐全部无误报。** 两处已于当日修复并跑完整批对比基线验证（见 8.3）。

### 8.1 确实是问题的（2 处）

| 文件 | 位置 | 问题 | 改法 |
| --- | --- | --- | --- |
| `probe-search-ui.mjs` | `SU-3` 区的 `await waitFor('true', 100)`（约 178 行）与 `SU-9` 区同样写法（约 213 行） | 死等待：等待条件恒为常量 `true`（永远立即满足），返回值 `okReq` 从未被使用，真正同步靠后面的 `sleep(600/700)`。语义上「等了等于没等」，还误导读者以为在等某个真实条件。 | **已修复（2026-10-04）：** 改为 Node 侧轮询真实条件——等到 `listReqs()` 真的捕获到带 `keyword=` 的请求（SU-3）/ 带 `sortBy=likeCount&keyword=` 的请求（SU-9）再继续，超时（~5s）则自然落到后续「实际请求为空」的证据里；删掉无用的 `okReq`。 |
| `probe-batch2.mjs` | `B2-3`（约 213-227 行） | opacity 时序脆弱：切 Tab 后只 `for(...) sleep(100)` 等到请求被按住就读 `refreshState().opacity`，但 CSS 过渡（1→0.5）还没跑完，采到的是中间态（历史证据 0.61 / 0.68）。断言 `opacity < 1` 侥幸过，但理论上有采到 1.0 的可能 → 偶发 FAIL。 | **已修复（2026-10-04）：** 采样前轮询直到 opacity 落到稳定态（连续两次读 ≤0.52 或达到目标 0.5）再读 `during`。`pointer-events==='none'` 是瞬变属性无需等，保留即时判。 |

### 8.2 复核后无误报（label/文案对齐）

通读全部 15 个探针的断言，逐条比对「标签文字」与「判定条件」，**未发现**以下任何一类问题：

- 标签声称 X、条件验的是 Y（名实不符）；
- 标签声称「无/不出现」但条件对空集合 `every` 恒真（与第 2 批已修的 S5-1/SU-4/D4 同类，本轮未再出现）；
- 硬编码 `true`（除 `probe-batch3` 的 `F7 取不到可见文章，跳过` 是刻意的 SKIP 标记，非问题）。

### 8.3 修复验证（2026-10-04）

完整批 15 探针 + `run.mjs` 主验收 **288 项全绿、exit 全 0**，项数与修前基线逐项一致（本轮 2 处全是改写，未增删条目）。关键实证（新逻辑抓到的真实值，不再是死等待 / 中间态）：

- `SU-3` → `请求=http://localhost:3000/api/articles?...&keyword=验收占位` `status=200`（轮询真实捕获，非 sleep 后猜）
- `SU-9` → `请求=...&sortBy=likeCount&order=desc&keyword=验收占位`（排序与搜索正交，两者真一起带上）
- `B2-3` → `opacity=0.5 pointer-events=none`（已落稳到目标值，不再是 0.61/0.68 中间态）

跑前跑后库一致（users 3 / 文章 11 / 可见 11 / 评论 1 / likes 1），Chrome 临时 profile 残留 0。**只改了 2 个探针文件，未改功能代码。** 报告与日志：`D:/tools/probe-baseline/audit-b3/`。

覆盖到的探针与重点断言：`probe-search`(S1-S6) / `probe-password`(P1-P14) / `probe-profile-edit`(PE-0,A1-A5,B1-B5,C1-C2,D1-D2,E1-E3) / `probe-like`(B1-B2,C1-C3,D0-D4,E1-E3) / `probe-batch3`(F1-1~F1-4,F2-1~F2-2,F7-1~F7-2,D1-1~D1-2,B2-1~B2-3) / `probe-dark`(D0-1~D0-3,D1-1~D1-3,D2-1~D2-10,D3-1~D3-4,D4-1~D4-2) / `probe-profile`(P1-1~P1-4,P2-1~P2-2) / `probe-prevnext`(N1-1~N4-3) / `probe-author-others`(O1-1~O1-4,O2-1) / `probe-entries`(E1-1,E1-3,E1-4,E5-1~E5-4,E2-1~E2-5,E3-1~E3-2,E4-0~E4-1) / `probe-card-visual`(C1-1~C1-7,C2-1~C2-2,C3-1~C3-3,C4-2) / `probe-styles`(S1-S4) / `run.mjs`(A1-A3,B1-B3,C2-C5) / `probe-search-ui`(其余 SU-*) / `probe-batch2`(其余 B/H 段)。

### 8.4 分类功能探针（2026-10-04）

> 随分类功能一起新增 `probe-category.mjs`，覆盖 docs/API.md「category 语义」全部可度量点。前半段纯后端 API（不启 Chrome），后半段启 Chrome 验卡片分类 chip 走 `.article-chip` 基类。

| 编号 | 覆盖点 | 结论 |
| --- | --- | --- |
| CAT-1 | POST 不带 category → 默认 `未分类` | PASS |
| CAT-2 | POST 带 `category=技术` → 写入成功 | PASS |
| CAT-3 | `GET ?category=技术` 只返回技术子集（total=技术总数且全部为技术） | PASS |
| CAT-8a | 列表项响应含 `category` 字段（字符串） | PASS |
| CAT-4 | `GET ?category=非法值` → 400 / 40000 | PASS |
| CAT-5a/5b | `keyword` 单独命中两篇（含未分类）；叠加 `category=技术` 后只剩技术一篇 → 证明 AND | PASS |
| CAT-6 | PUT 不传 category → 保留原值 | PASS |
| CAT-7 | PUT 非法 category → 400 / 40000 | PASS |
| CAT-8b | `GET /:id` 详情响应含 `category` | PASS |
| CAT-D1/D1b | 卡片渲染分类 chip 且复用 `.article-chip` 基类、底色非透明（令牌生效） | PASS |
| CAT-D2 | 暗色下分类 chip 令牌成对翻转（底色变、仍非透明） | PASS |

执行：`node scripts/acceptance/probe-category.mjs` → **13/13 全绿、exit 0**。靶子文章创建后由 `cleanupFixtures` 精确回收，跑前跑后库一致（users 3 / 文章 11 / 可见 11 / 评论 1 / likes 1），Chrome 临时 profile 残留 0。报告与日志：`D:/tools/acceptance-shots/category-<时间戳>/report.md`。

### 8.5 状态

- 第 3 批**已修复并提交** `c6b5b33`（2026-10-04，当日跑完整批 288 项全绿验证，见 8.3）。
- 第 1 批（高）、第 2 批（中，13 条）已修并分别提交 `94c68d8` / `aa4c80d`。
