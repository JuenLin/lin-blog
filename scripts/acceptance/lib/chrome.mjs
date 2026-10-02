// 找到可用的 chrome.exe 并拉起 headless 实例。
// !! 本机必须带 --no-sandbox：Chrome 沙箱会以「拒绝访问 (0x5)」拒绝执行可执行文件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG, TMP, sleep } from './config.mjs';
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

export async function launchChrome() {
  const exe = findChrome();
  if (!exe) {
    throw new Error('找不到 chrome.exe：可设置 CHROME_PATH 环境变量，或先执行 agent-browser install');
  }

  const profile = path.join(TMP, 'chrome-profile');
  fs.mkdirSync(profile, { recursive: true });

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

  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const info = await cdpAlive();
    if (info) return { exe, child, info };
  }
  return { exe, child, info: null };
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
}
