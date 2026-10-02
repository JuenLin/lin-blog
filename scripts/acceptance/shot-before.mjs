// 拍「修改前」对照图。
//
// 背景：第一批优化前的截图（batch1-before）曾被外部进程删掉，且 git 里没有「4 页已完成 + 未做优化」
// 这个中间态（85f75ee 还没有 ArticleCard 等组件，7163efc 已经带上了 A1/A2/A3），所以无法从版本库还原。
// 这里退而求其次：**不改任何源码**，只在浏览器里追加一段覆盖样式，把第一批改动（页面底色、卡片化、
// hover 抬升、渐变竖条）还原成旧观感，再按验收脚本同样的机位截图，用于前后对比。
//
// 覆盖样式只作用于本次 CDP 会话，刷新即失效，不落盘到 frontend/src。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

const OUT = 'D:/tools/acceptance-shots/batch1-before';

// 旧版观感的还原规则：白底页面 + 横线分隔的列表项（无卡片 / 无阴影 / 无圆角 / 无 hover 抬升）
const RESTORE_CSS = `
:root {
  --bg-page: #ffffff !important;
  --text-strong: #213547 !important;
  --text-regular: #606266 !important;
  --text-muted: #909399 !important;
}
body { background: #ffffff !important; }
.article-card {
  background: transparent !important;
  border: 0 !important;
  border-bottom: 1px solid #ebeef5 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  padding: 16px 0 !important;
  margin-bottom: 0 !important;
}
.article-card::before { display: none !important; }
.article-card:hover { transform: none !important; box-shadow: none !important; border-color: #ebeef5 !important; }
.article-card:hover .article-title { color: #213547 !important; }
.author-card { background: transparent !important; border: 0 !important; border-bottom: 1px solid #ebeef5 !important; border-radius: 0 !important; box-shadow: none !important; }
.comment-item { background: transparent !important; border: 0 !important; border-bottom: 1px solid #ebeef5 !important; box-shadow: none !important; }
`;

async function restore(s) {
  await s.evaluate(`(() => {
    const old = document.getElementById('__restore_old_look__');
    if (old) old.remove();
    const el = document.createElement('style');
    el.id = '__restore_old_look__';
    el.textContent = ${JSON.stringify(RESTORE_CSS)};
    document.head.appendChild(el);
    return true;
  })()`);
}

let chrome = null;
let s = null;

try {
  if (
    !(await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    chrome = await launchChrome();
    await sleep(1000);
  }

  s = await attach();

  // 机位要跟验收脚本的截图对得上：01 是「未登录」的首页，09 是「已登录」的详情页。
  // 所以先拍未登录的首页，再注入 token 拍详情页。
  await s.goto(CONFIG.frontend + '/');
  await sleep(2500);
  await restore(s);
  await sleep(400);
  await s.screenshot(`${OUT}/01-home-list.png`);
  console.log(`已保存 01-home-list.png（未登录）  ← ${CONFIG.frontend}/`);

  // 写 token（localStorage 是同源的，必须先在前端域下）
  const { token } = mintToken(2, 'admin');
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);

  // 取一篇真实文章用于详情页机位
  const res = await fetch(`${CONFIG.api}/articles?page=1&pageSize=1`);
  const json = await res.json();
  const articleId = json?.data?.list?.[0]?.id;
  if (!articleId) throw new Error('取不到文章 id，详情页截图跳过');

  const url = `${CONFIG.frontend}/article/${articleId}`;
  await s.goto(url);
  await sleep(2500);
  await restore(s);
  await sleep(400);
  await s.screenshot(`${OUT}/09-detail-admin.png`);
  console.log(`已保存 09-detail-admin.png（已登录）  ← ${url}`);

  console.log('说明：这是「旧观感还原」对照图，不是当时的原始截图（原始图已丢失，见 docs/ 说明）。');
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}
