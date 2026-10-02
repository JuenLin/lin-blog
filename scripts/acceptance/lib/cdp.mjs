// 自带 CDP（Chrome DevTools Protocol）客户端：Node 22 内置 fetch + WebSocket 就够，不引第三方库。
// 之所以不用 agent-browser / puppeteer：agent-browser 的 CLI 在本机会无限挂起（见 docs/ACCEPTANCE.md）。
import { CONFIG } from './config.mjs';

const BASE = () => `http://127.0.0.1:${CONFIG.cdpPort}`;

export async function getPages() {
  const res = await fetch(`${BASE()}/json/list`);
  return res.json();
}

export async function cdpAlive() {
  try {
    const res = await fetch(`${BASE()}/json/version`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.listeners) fn(msg);
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 20000);
    });
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  offEvent(fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
    }
    return r.result.value;
  }

  async goto(url) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

export async function attach() {
  const info = await cdpAlive();
  if (!info) throw new Error(`CDP 端口 ${CONFIG.cdpPort} 无响应`);
  const pages = await getPages();
  // 初始页面可能是 about:blank，不能拿 url 开头来筛 —— 只认 type。
  const page = pages.find((p) => p.type === 'page') || pages[0];
  if (!page) throw new Error('没有可用页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const s = new Session(ws);
  await s.send('Runtime.enable');
  return s;
}
