// Markdown 渲染管线（第 5 批，依赖特批见 AGENTS.md / AI_CONTRACT §2 第 7 项）。
//
// 管线固定三步，顺序不能换：
//   marked.parse(content) → DOMPurify.sanitize(html) → v-html 渲染
//
// 为什么 DOMPurify 不可省略：marked **不转义** HTML 标签，正文里的
// <script>alert(1)</script> 会原样进入渲染结果。这是本项目第一次引入
// v-html 渲染面，净化不是可选项（用户在第 5 批草案里明确要求）。
//
// highlight.js 用 highlight.js/lib/common（预打包的常用语言集，约 40 种：
// js / json / bash / sql / xml(html) / python / css 等），比全量 import 小得多，
// 也不用逐个 registerLanguage。样式主题走 utils/hljsTheme.js 的双主题切换。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';

// breaks: true —— 单个换行渲染成 <br>。原 ArticleContent 是 pre-wrap
// （所有换行都显示），旧文章按 markdown 默认行为会把多行并成一段，
// breaks: true 才与替换前的观感一致。
marked.setOptions({ gfm: true, breaks: true });

/**
 * 渲染 Markdown 为**已净化**的 HTML 字符串。
 *
 * @param {string} content 文章正文（Markdown 原文）
 * @returns {string} 可安全 v-html 的 HTML
 */
export function renderMarkdown(content) {
  if (!content) {
    return '';
  }

  const raw = marked.parse(content);

  return DOMPurify.sanitize(raw);
}

/**
 * 标题文本 → 锚点 id。中文保留（\u4e00-\u9fa5），空格转连字符，
 * 其余符号剥掉；重名加序号后缀（由 extractHeadings 的去重表控制）。
 */
export function slugify(text) {
  const base = String(text)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return base || 'heading';
}

/**
 * 从 Markdown 原文提取 h1-h3 标题（**跳过代码块围栏内的 #**）。
 *
 * ArticleToc 的目录项与 ArticleContent 渲染后补的标题 id **同源**：
 * 两边都调这个函数，id 按顺序一一对应（el-anchor 靠 id 定位）。
 *
 * @param {string} content Markdown 原文
 * @returns {Array<{level: number, text: string, id: string}>}
 */
export function extractHeadings(content) {
  if (!content) {
    return [];
  }

  const lines = String(content).split('\n');
  const headings = [];
  const seen = new Map();
  let inCodeFence = false;

  for (const line of lines) {
    // 代码块围栏（``` 或 ~~~）切换状态：围栏里的 # 是注释，不是标题。
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      continue;
    }

    const match = /^(#{1,3})\s+(.+)$/.exec(line);

    if (!match) {
      continue;
    }

    const level = match[1].length;
    // 清掉标题里的 markdown 记号（**粗体** / `代码` / 链接语法），目录显示纯文本。
    const text = match[2].trim().replace(/[*`~[\]]/g, '').trim();
    const base = slugify(text);
    const count = seen.get(base) || 0;

    seen.set(base, count + 1);

    headings.push({
      level,
      text,
      id: count === 0 ? base : `${base}-${count}`,
    });
  }

  return headings;
}

/**
 * 给渲染后的 DOM 补两样 marked 不会给的东西：
 *   1. h1-h3 的 id（el-anchor 定位用，id 与 extractHeadings 同源同序）
 *   2. pre code 的 highlight.js 高亮（加 hljs class）
 *
 * @param {HTMLElement} root ArticleContent 的根元素
 * @param {string} content Markdown 原文（用于算标题 id）
 */
export function decorateRenderedContent(root, content) {
  if (!root) {
    return;
  }

  const headings = extractHeadings(content);
  const nodes = root.querySelectorAll('h1, h2, h3');

  nodes.forEach((node, index) => {
    if (headings[index]) {
      node.id = headings[index].id;
    }
  });

  root.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
}
