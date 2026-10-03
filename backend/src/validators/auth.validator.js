import { z } from 'zod';

// docs/API.md 的 PUT /api/auth/password：
// oldPassword 1–100 字符、newPassword 6–100 字符，两者都不 trim（密码首尾空格有意义）。
//
// 为什么都不 trim：登录接口（POST /api/auth/login）比对密码时也不 trim，
// 如果这里 trim 再比对，用户设了 ' abc ' 之后就得输入 ' abc ' 才能通过校验，
// 但校验通过后写入库的是trim 过的 'abc'，两边口径会不一致。
//
// 长度上限 100 与 POST /api/auth/register 的 password 规则刻意保持一致
// （见 routes/auth.routes.js 的 registerSchema），
// 避免出现「能注册却不能改成同一个密码」的荒谬情况。

// bcrypt 只取密码前 72 字节，超出部分静默丢弃。若不在入口拦截，
// 一个 72 字节之后的字符根本不参与哈希计算，攻击者提交前 72 字节即可通过校验。
export const BCRYPT_MAX_BYTES = 72;

const oldPasswordSchema = z
  .string()
  .refine((value) => value.length > 0, '不能为空')
  .refine((value) => value.length <= 100, '不能超过 100 个字符');

const newPasswordSchema = z
  .string()
  .refine((value) => value.length >= 6, '不能少于 6 个字符')
  .refine((value) => value.length <= 100, '不能超过 100 个字符')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_BYTES,
    `不能超过 ${BCRYPT_MAX_BYTES} 字节`
  );

/**
 * 修改密码请求体的校验规则。
 *
 * 「与旧密码相同」这条校验只在服务端做：前端拿不到当前密码的哈希，
 * 无法可靠判断，前端只做长度与「两次输入一致」的即时校验。
 *
 * **禁传 userId / id / username 的实现方式**：docs/API.md 规定身份只能来自 token。
 * 这三个字段声明为 .optional().superRefine(...)—— 只在「出现了」时才报错。
 *
 * 踩过的坑：最初写成 z.undefined('不允许修改其他用户的密码')，结果 zod 4 对
 * **字段缺失**和**字段显式为 undefined** 都会报 'expected nonoptional'，
 * 导致不带这三个字段的正常请求也被拒。.optional() 才是正确写法——
 * 缺失放行，携带才报错。
 */
const forbiddenIdentityFields = ['userId', 'id', 'username'];

export const changePasswordSchema = z
  .object({
    oldPassword: oldPasswordSchema,
    newPassword: newPasswordSchema,
    // .optional()：缺失放行；带值会在下面的 superRefine 里被拒。
    userId: z.any().optional(),
    id: z.any().optional(),
    username: z.any().optional(),
  })
  .superRefine((value, ctx) => {
    for (const field of forbiddenIdentityFields) {
      if (value[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: '不允许修改其他用户的密码',
        });
      }
    }

    if (value.oldPassword !== undefined && value.oldPassword === value.newPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newPassword'],
        message: '不能与当前密码相同',
      });
    }
  });