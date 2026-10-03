import { z } from 'zod';

// docs/API.md 的 PUT /api/users/me：
//   avatar  1–255 字符，必须以 http:// 或 https:// 开头，可为 null（清空）
//   bio     1–200 字符，可为 null（清空）；空串在入口转成 null
//
// 长度上限与 DB.md 的列定义严格一致（avatar VARCHAR(255) / bio VARCHAR(200)），
// 避免出现「接口过了但数据库截断」的静默数据丢失。

const AVATAR_MAX_LENGTH = 255;
const BIO_MAX_LENGTH = 200;

/**
 * 头像 URL 的协议白名单。
 *
 * 为什么必须挡伪协议：零依赖方案下服务端不上传图片，前端会把这个 URL
 * 直接渲染进 <img src> / background-image。若允许 javascript: 或 data:，
 * 就等于把 XSS 的执行权交给用户输入。限定 http / https 两种即可挡住这两类，
 * 且不影响正常图床链接。
 *
 * 注意：这里只校验「长得像不像 URL」，**不校验可达性**——校验可达性要发外部
 * HTTP 请求，会让本接口耗时不可控（外部站点超时/挂掉会拖住我们），也违背
 * 「零依赖、不发额外网络请求」的约束。代价是服务端不保证图片真实存在。
 */
const avatarSchema = z
  .string()
  .max(AVATAR_MAX_LENGTH, `不能超过 ${AVATAR_MAX_LENGTH} 个字符`)
  .refine(
    (value) => value.length > 0,
    '不能为空字符串，清空头像请传 null'
  )
  .refine(
    (value) => /^https?:\/\//i.test(value),
    '必须以 http:// 或 https:// 开头'
  );

const bioSchema = z.string().max(BIO_MAX_LENGTH, `不能超过 ${BIO_MAX_LENGTH} 个字符`);

/**
 * 禁传的身份字段。
 *
 * 身份只能来自 token，这四个字段出现即报错，**不做静默忽略**
 * （静默忽略会让调用方误以为参数生效了）。沿用 PUT /api/auth/password 的口径。
 *
 * 写法说明：声明为 `z.any().optional()`，只在「出现了」时才报错。
 *踩过的坑：最初用过 z.undefined()，但 zod 4 对「字段缺失」和「字段显式为
 * undefined」都会报 expected nonoptional，导致不带这些字段的正常请求也被拒。
 */
const forbiddenIdentityFields = ['id', 'userId', 'username', 'password'];

/**
 * 修改当前用户资料（头像 / 简介）的请求体校验规则。
 *
 * **三态语义靠「键是否存在」区分，不靠值判断**（docs/API.md 的核心约定）：
 *   - 键不出现 → undefined → 不改这个字段
 *   - 值为 null → null→ 清空（写 NULL）
 *   - 值为字符串 → 设置
 *
 * 为什么要用 hasOwnProperty 而不是「值是否为 null」：
 * `{ "avatar": null }` 是一次**有效的清空操作**，若按「至少一个非 null 值」
 * 来判空操作就会把用户无法清空头像。所以判据必须是键的数量。
 *
 * 另一个关键点：zod 的 `.optional()` 对「键缺失」和「键存在但值为 undefined」
 * 都返回 undefined，**无法区分这两种情况**。所以这里在 superRefine 里
 * 用 hasOwnProperty 二次确认键是否真的出现过，并把结果放进 ctx 的元数据里，
 * 由 service 层读取后决定要写哪些列。
 */
export const updateProfileSchema = z
  .object({
    avatar: avatarSchema.nullable().optional(),
    bio: bioSchema.nullable().optional(),
    // 禁传字段：.optional() + 下面的 superRefine，绝不用 z.undefined()。
    id: z.any().optional(),
    userId: z.any().optional(),
    username: z.any().optional(),
    password: z.any().optional(),
  })
  .superRefine((value, ctx) => {
    for (const field of forbiddenIdentityFields) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: '不允许修改其他用户的资料',
        });
      }
    }

    // 「至少有一个键出现」：判断依据是**自有键数量**，不是「有没有非 null 的值」。
    // { "avatar": null } 只有一个键，是有效的清空操作，必须放行。
    const hasAvatar = Object.prototype.hasOwnProperty.call(value, 'avatar');
    const hasBio = Object.prototype.hasOwnProperty.call(value, 'bio');

    if (!hasAvatar && !hasBio) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'avatar 与 bio 至少要传一个',
      });
    }

    // 注意：这里**不**通过 ctx 传递「键是否出现」——zod 的 superRefine 只能
    // 往 ctx.addIssue 里塞错误，拿不到可供service 层消费的元数据通道，
    // 硬塞会被当成校验结果污染。service 层直接用 hasField() 自行判断。
  });

/**
 * 判断某个字段是否「键出现过」，供 service 层构造 update 数据。
 *
 * 之所以要单独提供：zod 的 `.optional()` 会把「键缺失」和「显式 undefined」
 * 归一成同一个 undefined，service 层无法只靠 `value.avatar !== undefined`
 * 判断用户到底想不想改这个字段——那样「没传 avatar」就会被误当成「清空头像」。
 *
 * @param {object} body service 层拿到的请求体
 * @param {string} field 字段名
 * @returns {boolean} 键是否出现过
 */
export function hasField(body, field) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

export const USER_PROFILE_LIMITS = {
  AVATAR_MAX_LENGTH,
  BIO_MAX_LENGTH,
};
