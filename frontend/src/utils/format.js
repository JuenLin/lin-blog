// 前端通用格式化工具（契约第 3 节：工具函数放 src/utils）。

// 暂无调用点，保留作通用工具；如需本地化短格式用 formatRelativeTime。
// 注意它走 toLocaleString()，输出随浏览器语言变化，不要用它拼需要稳定格式的绝对时间
// （那用 formatAbsoluteTime）。
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

/* ---------- 头像渲染分支（第九批，第十一批扩展） ---------- */

// 静态资源的 origin。
//
// `VITE_API_BASE_URL` 是**接口**基址（http://localhost:3000/api），而头像文件挂在
// `/uploads`（不是 /api/uploads —— 它是静态资源，不是接口）。所以这里要**去掉末尾的 /api**：
//   /uploads/avatars/1/x.png  →  http://localhost:3000/uploads/avatars/1/x.png
// 少去掉这一步，浏览器就会去 http://localhost:5173/uploads/... 找图（前端自己的端口），必然 404。
//
// 与 api/request.js 用同一个环境变量、同一份兜底值，改一处即可。
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
const ASSET_ORIGIN = API_BASE.replace(/\/api\/?$/, '');

/**
 * 把 `avatar` 字段的值变成可直接塞进 `<img src>` 的 URL。
 *
 * 第十一批起 `users.avatar` 有**两种取值形态**：
 *   - 外链：`https://cdn.example.com/a/1.png` → 原样返回
 *   - 站内相对路径：`/uploads/avatars/1/xxx.png` → 前面补上后端 origin
 *
 * 只在这个函数里补一次 origin，其它地方一律不重复拼——
 * 「在哪补」这个问题如果有第二个答案，迟早会出现补两次的 `http://.../uploads/uploads/...`。
 *
 * @param {string} src avatar 原值
 * @returns {string} 可直接用于 <img src> 的 URL；空值返回 ''
 */
export function resolveAvatarUrl(src) {
  if (!src) {
    return '';
  }

  // 外链原样返回：http(s)://
  if (/^https?:\/\//i.test(src)) {
    return src;
  }

  // 站内路径：补 origin。src 理论上以 /uploads/ 开头（服务端保证），
  // 这里只保证「少一个斜杠不会拼出 3000uploads 这种怪东西」。
  return `${ASSET_ORIGIN}${src.startsWith('/') ? '' : '/'}${src}`;
}

/**
 * 解析一个用户对象应该怎么渲染头像。
 *
 * ## 为什么要这个 helper
 * 第九批给users 加了 `avatar` 字段（外链 URL）之后，头像有两种形态：
 * 有 URL 渲染 `<img>`，没有则回退到「色块 + 首字」。**两种形态必须二选一**，
 * 不能只写一个分支——否则 `avatar` 为 `null`（用户没设头像）时会渲染出破图。
 *
 * 更麻烦的是 `avatar` **可能连键都没有**：验收探针造出来的 author 对象
 * （见 scripts/acceptance 下的 probe-batch2 / batch3 / probe-author-others）
 * 只有 `{ id, username, nickname }`，根本没有 avatar 这个键。所以判断条件
 * 必须是 **truthy 检查**（`if (avatar)`），`null` 和 `undefined` 会被一并处理。
 *
 * ## 第十一批：外链与站内路径并存
 * `avatar` 现在可能是 `/uploads/avatars/{userId}/xxx.png` 这种**相对路径**，
 * 直接塞进 `<img src>` 会被浏览器解析成前端自己的域（localhost:5173）而 404。
 * 所以 image 分支统一过一遍 `resolveAvatarUrl()` 补 origin。
 *
 * ## 为什么不能直接写 `<img :src="user.avatar">`
 * 那样 null / undefined 会渲染成破图；`<el-avatar :src="user.avatar">` 同理
 * （Element Plus 的 el-avatar 在 src 为空时不会回退成文字块）。
 * **必须用 v-if 先分出分支。**
 *
 * ## 注意
 * `src` 返回的 URL **不做可达性保证**——服务端只校验「以 http/https 开头」，
 * 不发请求验证图片是否真的存在。所以调用方应给 `<img>` 绑 `@error` 回退到
 * 文字头像（本项目各处均已实现，见 ProfileEdit.vue 的 previewImage）。
 *
 * @param {object} user 含 avatar 字段的用户/作者对象（也可为 null）
 * @param {string} name 用于生成文字头像与颜色的显示名（昵称或用户名）
 * @returns {{type: 'image', src: string} | {type: 'text', text: string, color: string}}
 *   - `{ type: 'image', src }`：渲染 <img>
 *   - `{ type: 'text', text, color }`：渲染色块 + 首字
 */
export function resolveAvatar(user, name) {
  const src = user && user.avatar;

  // truthy 检查而非 `user.avatar !== null`：这样 undefined（键不存在）
  // 与 ''（空串）、null 三种情况一次覆盖，少写两个分支。
  if (src) {
    return { type: 'image', src: resolveAvatarUrl(src) };
  }

  return { type: 'text', text: getAvatarText(name), color: getAvatarColor(name) };
}

/* ---------- 相对时间（方案 D） ---------- */

/**
 * 绝对时间的日期部分，形如 '2026/10/3'（月/日不补零）。
 *
 * ## 为什么不直接用 formatTime
 * formatTime 走 `toLocaleString()`，输出格式**随浏览器语言而变**
 * （en-US 下是 '10/3/2026, 1:49:50 AM'）。而绝对时间在这里有两处硬性要求：
 * tooltip 里要给人看、以及 ≥7 天时作为唯一的日期呈现，**格式必须稳定**，
 * 不能因为用户浏览器语言不同就长得不一样。所以自己拼，不用 toLocaleString。
 *
 * @param {Date} date 已确认合法的 Date 对象
 * @returns {string} 形如 '2026/10/3'
 */
function formatDatePart(date) {
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 绝对时间，形如 '2026/10/3 01:49:50'（时分秒补零，月/日不补零）。
 *
 * @param {string} value ISO 8601 字符串
 * @returns {string} 空值或非法值返回 '-'
 */
export function formatAbsoluteTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  const pad = (n) => String(n).padStart(2, '0');

  return `${formatDatePart(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 相对时间：距今多久。
 *
 * 档位（与需求一致）：
 *   < 1 分钟 → '刚刚'
 *   < 1 小时 → 'X 分钟前'
 *   < 24 小时 → 'X 小时前'
 *   < 7 天→ 'X 天前'
 *   ≥ 7 天   → '2026/10/3'（绝对日期，再长已经没有「多久前」的信息量了）
 *
 * ## 两个刻意这么定的边界
 * 1. **非法日期返回原字符串**（而不是 '-'）：这个函数可能拿到后端之外的脏值，
 *    返回 '-' 会把「接口返回了异常值」伪装成「接口没给值」，排查时分不出来。
 *    原样返回能让脏值直接暴露在界面上。合法但**空**的值才返回 '-'（与 formatTime 一致）。
 * 2. **未来时间返回 '刚刚'**：客户端与服务器有时钟差，或数据被手工改过，
 *    算出「-3 分钟前」这种负数区间在界面上没法解释，归到'刚刚'最自然。
 *
 * ## 已知取舍
 * 这是**纯函数、不订阅时间**——组件渲染那一刻算一次，页面挂着不动的话
 * '3 分钟前'会一直是 '3 分钟前'，不会自己长成 '4 分钟前'。
 * 论坛/博客类场景可接受（用户会刷新或跳走）；真要自动刷新得引入定时器，
 * 那是另一种设计，不在本次范围。
 *
 * @param {string} value ISO 8601 字符串
 * @returns {string} 相对时间描述；非法值返回原字符串，空值返回 '-'
 */
export function formatRelativeTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  // 非法日期：原样返回，让脏值可见（见上方说明 1）
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const diffMs = Date.now() - date.getTime();

  // 未来时间（时钟差 / 脏数据）→ '刚刚'（见上方说明 2）
  if (diffMs < 0) {
    return '刚刚';
  }

  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) {
    return '刚刚';
  }

  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);

  if (days < 7) {
    return `${days} 天前`;
  }

  return formatDatePart(date);
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
