// 单独补拍「详情页标题随文章变」的截图（探针里那行没落盘，这里补上）。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

const OUT = process.argv[2] || 'D:/tools/acceptance-shots';

let chrome = null;
let s = null;
try {
  if (!(await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`).then((r) => r.ok).catch(() => false))) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');

  const { token } = mintToken(CONFIG.adminId, 'admin');
  await s.goto(CONFIG.frontend + '/');
  await sleep(1500);
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);

  const listJson = await (await fetch(`${CONFIG.api}/articles?page=1&pageSize=1`)).json();
  const art = listJson?.data?.list?.[0];
  if (!art) throw new Error('取不到可见文章');

  await s.goto(`${CONFIG.frontend}/article/${art.id}`);
  await sleep(2800);
  await s.screenshot(`${OUT}/92-detail-title.png`);
  console.log(`已保存 92-detail-title.png，标题="${await s.evaluate('document.title')}"`);
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}
