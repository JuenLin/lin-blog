// 前端通用格式化工具（契约第 3 节：工具函数放 src/utils）。

/**
 * 把后端返回的 ISO 8601（UTC）时间转成本地时间字符串用于展示。
 * 数据库存 UTC、接口返回 ISO 8601，转本地时间的活由前端做（契约第 9 节「时间」）。
 *
 * @param {string} value ISO 8601 字符串
 * @returns {string} 本地时间字符串，空值或非法值返回 '-'
 */
export function formatTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString();
}

// 头像色板取自「浅色科技感」主色系（靛蓝 / 紫 / 青 / 蓝 / 墨绿），
// 与 style.css 的设计令牌同色系，避免原先 Element Plus 默认色（含橙、大红）破坏整体调性。
const AVATAR_COLORS = [
  '#4f46e5',
  '#7c3aed',
  '#06b6d4',
  '#0ea5e9',
  '#6366f1',
  '#8b5cf6',
  '#0d9488',
];

/**
 * 头像占位文字：取昵称或用户名的首字符。
 * users 表没有头像字段（docs/DB.md），头像一律用纯 CSS 色块 + 首字代替，不新增字段。
 *
 * @param {string} name 昵称或用户名
 * @returns {string}
 */
export function getAvatarText(name) {
  const text = String(name || '').trim();

  return text ? text.charAt(0).toUpperCase() : '?';
}

/**
 * 头像色块背景色：按名字算一个稳定下标，保证同一个用户每次渲染颜色一致。
 *
 * @param {string} name 昵称或用户名
 * @returns {string} 十六进制颜色
 */
export function getAvatarColor(name) {
  const text = String(name || '');
  let sum = 0;

  for (let index = 0; index < text.length; index += 1) {
    sum += text.charCodeAt(index);
  }

  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/* ---------- 阅读时长（④ 卡片视觉丰富） ---------- */

// 中文阅读速度约 400 字/分钟（常见区间 300~500，取中值），不足 1 分钟按 1 分钟算。
// 纯前端估算：卡片只能用列表接口给的 summary 估算，详情页才有完整 content。
const READING_CPM = 400;

/**
 * 估算一段文本的阅读时长。
 * 只做「字符数 / 阅读速度」的粗估，不区分中英文单词、不扣图片时间——目的是给读者一个量级感知，
 * 不是精确统计。空文本返回空串，调用方据此隐藏 chip。
 *
 * @param {string} text 文本内容（卡片传 summary，详情页传 content）
 * @returns {string} 形如 '3 分钟'，空文本返回 ''
 */
export function getReadingTime(text) {
  const content = String(text || '').trim();

  if (!content) {
    return '';
  }

  // 去掉所有空白字符后再数，避免格式化换行 / 缩进把时长算高
  const chars = content.replace(/\s+/g, '').length;

  if (chars === 0) {
    return '';
  }

  const minutes = Math.max(1, Math.ceil(chars / READING_CPM));

  return `${minutes} 分钟`;
}
