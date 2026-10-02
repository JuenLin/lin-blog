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
