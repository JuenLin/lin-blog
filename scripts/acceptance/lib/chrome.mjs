// 找到可用的 chrome.exe 并拉起 headless 实例。
// !! 本机必须带 --no-sandbox：Chrome 沙箱会以「拒绝访问 (0x5)」拒绝执行可执行文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG, sleep } from './config.mjs';
import { cdpAlive } from './cdp.mjs';

function expandPatterns() {
  const home = os.homedir();
  const patterns = [];
  if (process.env.CHROME_PATH) patterns.push(process.env.CHROME_PATH);
  // agent-browser 的默认缓存位置（本机实测）
  patterns.push(path.join(home, '.agent-browser', 'browsers'));
  // 用户搬到 D 盘的那份副本
  patterns.push('D:/tools/agent-browser-home/browsers');
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) patterns.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  patterns.push(path.join(home, 'AppData', 'Local', 'ms-playwright'));
  return patterns;
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function findChrome() {
  const direct = process.env.CHROME_PATH;
  if (direct && fs.existsSync(direct)) return direct;

  for (const root of expandPatterns()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of listDirSafe(root)) {
      const full = path.join(root, entry);
      const candidates = [
        path.join(full, 'chrome.exe'),
        path.join(full, 'chrome-win', 'chrome.exe'),
        path.join(full, 'chrome-win64', 'chrome.exe'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }

  const wellKnown = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of wellKnown) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// 临时 profile 的目录名前缀（每次都新建，见 launchChrome）。
const PROFILE_PREFIX = 'wb-chrome-profile-';

// 清扫上一次遗留的临时 profile。
// 正常路径由 stopChrome() 负责删；但脚本被中途杀掉（Ctrl+C / timeout）时 stopChrome 不会执行，
// 这里兜底。只删 15 分钟前的 —— 正在使用的目录 mtime 是新的，不会被误删。
function pruneStaleProfiles() {
  const dir = os.tmpdir();
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const name of listDirSafe(dir)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* 还被占用就跳过，下次再说 */
    }
  }
}

export async function launchChrome() {
  const exe = findChrome();
  if (!exe) {
    throw new Error('找不到 chrome.exe：可设置 CHROME_PATH 环境变量，或先执行 agent-browser install');
  }

  pruneStaleProfiles();

  // 每次启动用一个**全新的临时 profile**。
  //
  // 为什么不再复用固定目录：原实现是 `<TMP>/chrome-profile`（只 mkdir、从不清理），
  // 于是 localStorage **跨次运行、跨探针全部保留** —— 上一条探针写进去的 token / theme
  // 会被下一条看到，探针之间不再互相独立，「未登录初态」这类断言直接变得不可复现。
  // 2026-10-04 实测踩到：单独重跑 probe-batch2 时浏览器开局就是登录态（profile 里残留了
  // 一个 193 字符的 token），/login 被守卫重定向、/editor 直接加载编辑器，
  // 两条「未登录」断言必挂，而完整批跑时却是绿的。
  //
  // mkdtempSync 保证目录唯一，且每次都是干净状态 —— 这是「同一探针连续跑两次结果必须一致」
  // 的前提。清理由 stopChrome() 负责（见那里的注释：不能在 'exit' 事件里删）。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CONFIG.cdpPort}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ];

  const child = spawn(exe, args, { stdio: 'ignore', detached: false });
  child.on('error', () => {});
  // 把临时目录挂在 child 上，stopChrome() 收尾时删 —— 这样**调用方不必改签名**
  // （各探针仍然只写 `stopChrome(chrome.child)`）。
  child.profileDir = profile;

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const info = await cdpAlive();
    if (info) return { exe, child, info, profile };
  }
  return { exe, child, info: null, profile };
}

// 按契约 §13-17：脚本自己起的浏览器，脚本自己负责关掉。
export async function stopChrome(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* noop */
    }
  }

  // 删掉本次的临时 profile。
  //
  // ⚠️ 必须**在进程树真正退出之后**删。Chrome 是多进程的，主进程 exit 时子进程可能还占着
  // 文件句柄 —— 原实现在 child 的 'exit' 事件里立刻 rmSync，结果目录一个都没删掉
  // （2026-10-04 实测残留 16 个 wb-chrome-profile-*，而事后手动 rm 全部成功，
  // 说明就是时机问题、不是权限问题）。
  // taskkill /T /F 是同步的，返回时基本已清干净；仍删不掉就重试几次，最后放弃
  // （不影响正确性，遗留目录由下次 launchChrome 的 pruneStaleProfiles() 兜底）。
  const dir = child.profileDir;
  if (dir) {
    for (let i = 0; i < 12; i += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* noop */
      }
      if (!fs.existsSync(dir)) break;
      await sleep(250);
    }
  }
}
