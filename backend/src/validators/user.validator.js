import { z } from 'zod';
import { AVATAR_URL_PREFIX } from '../utils/upload.js';

// docs/API.md 的 PUT /api/users/me：
//   avatar  1–255 字符，**必须是 /uploads/ 站内路径**，可为 null（清空）
//   bio     1–200 字符，可为 null（清空）；空串在入口转成 null
//
// 长度上限与 DB.md 的列定义严格一致（avatar VARCHAR(255) / bio VARCHAR(200)），
// 避免出现「接口过了但数据库截断」的静默数据丢失。

const AVATAR_MAX_LENGTH = 255;
const BIO_MAX_LENGTH = 200;

/**
 * 头像取值：**只接受 /uploads/ 站内路径**（图片外链下线后收窄）。
 *
 * 演进：第九批这里只放行 http(s) 外链；第十一批加了上传（两种并存）；
 * 现在外链下线，**只认一个前缀**。列定义与 null（未设头像）语义始终没变。
 *
 * ## 为什么只放行 /uploads/
 * 这个值会被前端直接渲染进 <img src> / background-image，所以必须是**服务端能担保
 * 来源**的。`javascript:` / `data:` 这类伪协议等于把 XSS 的执行权交给用户输入，
 * 必须挡；而 /uploads/ 路径由上传接口生成，来源可信。
 *
 * ## 为什么「来源可信」成立（四层约束）
 * 前缀被钉死成 `/uploads/`，后面那截**不是用户自由输入的**：
 *   ① 文件名由服务端生成（时间戳 + randomBytes），`file.originalname` 不参与命名或拼路径
 *   ② 扩展名由服务端按 mimetype 白名单映射，只有 .jpg / .png / .webp 三种
 *   ③ 目录按 token 里的 userId 分，用户碰不到别人的目录
 *   ④ express.static 关了目录列表与点文件
 * 所以「只认一个前缀」不等于「放开任意路径」。这里校验的是「形态」，不是「内容」。
 *
 * ## 为什么外链也被拒（而不是只挡伪协议）
 * 外链不构成 XSS，但**已无必要**：头像可以直传之后，再留一条「用户自填 URL」的旁路，
 * 只会让「头像从哪来」有两个答案，清理逻辑 / 渲染逻辑 / 验收断言都得各写两套。
 * 去掉之后规则也更简单——**不必再区分「正常外链」与「伪协议」，只认一个前缀**。
 * 附带的好处：`PUT /api/users/me` 的 avatar 现在只用于清空（传 null），
 * 设置头像统一走 `POST /api/users/me/avatar`，职责清晰。
 *
 * 注意：只校验「长得像不像」，**不读磁盘、不查库**——所以可能出现「DB 有路径、
 * 磁盘没文件」的悬空引用（例如手工删了文件），由前端 <img> 的 error 事件回退文字头像兜底。
 * 这个取舍登记在 docs/DB.md 的「已知限制」。
 *
 * 补充：`users.avatar` 理论上仍可被手工写成 `/uploads/../../xx`，但取文件时
 * express.static 会把解析后越出 root 的路径挡成 403，且 services/upload.service.js
 * 的 deleteLocalAvatar 在真正 rm 之前还有一道「必须在 UPLOAD_DIR 内」的校验。
 */
const isLocalAvatarPath = (value) => value.startsWith(AVATAR_URL_PREFIX);

const avatarSchema = z
  .string()
  .max(AVATAR_MAX_LENGTH, `不能超过 ${AVATAR_MAX_LENGTH} 个字符`)
  .refine(
    (value) => value.length > 0,
    '不能为空字符串，清空头像请传 null'
  )
  .refine(
    isLocalAvatarPath,
    `必须是 ${AVATAR_URL_PREFIX} 开头的站内路径（头像请用 POST /api/users/me/avatar 上传，外链已下线）`
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
