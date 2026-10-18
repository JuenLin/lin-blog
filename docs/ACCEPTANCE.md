<!-- 文档：ACCEPTANCE.md | 定位：验收指南 | 核心：如何启动验收、一键跑 run.mjs、跑全量探针、排错与最新结论。 -->

# 验收指南（自动化探针）

> 目的：改完代码直接重跑，**不用每次手写脚本、不用自己点浏览器**。
> 全量验收 = `run.mjs` 自身的 50 条断言 + 33 个 `probe-*.mjs` 量化探针，共 **738 条断言全绿、exit 全 0**。
> 依赖：只用 Node 内置能力，零新增依赖（契约 §13-3）。

---

## 1. 怎么用

### 前置（你来起，脚本不碰这两个服务）

```bash
cd backend   && npm run dev      # 3000
cd frontend  && npm run dev      # 必须是 5173，见 §2 注意点
```

端口必须是 **5173**：`backend/.env` 的 `CORS_ORIGIN` 只配了这个源，换端口请求会被 CORS 拦掉。

### 一键跑（主验收）

```bash
node scripts/acceptance/run.mjs
```

**退出码**：`0` = 全通过；`1` = 有 FAIL；`2` = 前置检查没过（服务没起 / Node 版本不够）。

### 常用参数

| 参数 | 作用 |
| --- | --- |
| `--no-cleanup` | 保留临时数据不清理（方便复现问题） |
| `--no-chrome` | 不自动拉 Chrome，用你已有的 9222 端口实例 |
| `--no-seed` | 不造临时数据（数据不足的用例会标 SKIP） |
| `--shots <dir>` | 指定截图目录，默认 `%TEMP%/lin-blog-acceptance-shots` |
| `--report <path.md>` | 额外把结果表写成 markdown 文件 |

### 跑完全量探针（含 run.mjs 之外的 33 个 probe）

`run.mjs` 只覆盖它自身的 50 条断言；其余量化探针是每个独立的 `probe-*.mjs`，需逐个跑。建议用下面这个脚本一次性跑完并汇总每个探针的退出码与 FAIL 数（**输出务必重定向到文件，不要走 `| tail` 管道**——Node 在 SIGPIPE 下会崩）：

```bash
#!/usr/bin/env bash
set -u
NODE="C:/Users/123/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PASS=0; FAIL=0
for f in scripts/acceptance/probe-*.mjs; do
  out="/tmp/$(basename "$f" .mjs).log"
  "$NODE" "$f" > "$out" 2>&1
  code=$?
  n=$(grep -c "FAIL" "$out")
  if [ "$code" -eq 0 ] && [ "$n" -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  echo "$(basename "$f") EXIT=$code FAIL=$n"
done
echo "PROBES_OK=$PASS PROBLEM=$FAIL"
```

> 探针脚本不读 `.env`、不含业务代码，仅做浏览器交互与断言，跑完会按「精确主键回收」清理自造数据（契约 §17 探针清理铁律），数据库回到跑前基线。

---

## 2. 环境变量 / 排错

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ACCEPTANCE_FRONTEND` | `http://localhost:5173` | 前端地址 |
| `ACCEPTANCE_API` | `http://127.0.0.1:3000/api` | 后端 API |
| `CDP_PORT` | `9222` | CDP 调试端口 |
| `CHROME_PATH` | 自动搜索 | 指定 chrome.exe |
| `ACCEPTANCE_ADMIN_ID` / `ACCEPTANCE_DEMO_ID` | `2` / `1` | 两个会话用户 |
| `ACCEPTANCE_SHOTS` | `%TEMP%/lin-blog-acceptance-shots` | 截图目录 |

排错：

- **「前端探不到」**：确认 dev server 是 5173；**它只监听 IPv6 `[::1]:5173`**，用 `127.0.0.1:5173` 探会失败；手工用 curl 探本机要加 `--noproxy '*'`（本机 curl 默认走代理，否则看到代理返回的 502）。
- **「找不到 chrome.exe」**：设 `CHROME_PATH`，或先跑一次 `agent-browser install` 下载。
- **「需要 Node ≥ 22」**：CDP 客户端用了 Node 内置的全局 `WebSocket`。

---

## 3. 最新验收结论

- **全量验收（2026-10-18 收官）**：`run.mjs` **50/50** + 33 个探针 **全部 exit=0、FAIL=0**，合计 **738 条断言全绿、0 FAIL**。
- 终验后数据库基线零漂移（users 6 / articles 17（可见 14）/ likes 3 / follows 1，其余表为空），无脏数据。
- 历史上一共出现过 2 条 FAIL，**都是脚本断言写错、不是产品问题**，已修复：① 把评论接口错写成 `/api/articles/:id/comments`（实际顶层 `/api/comments`）；② 把「评论总数 +1」写死成「共 2 条」（应先读发表前总数再比 +1）。
