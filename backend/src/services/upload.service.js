import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { CODE, httpError } from '../utils/response.js';
import {
  UPLOAD_DIR,
  AVATAR_SUBDIR,
  AVATAR_URL_PREFIX,
  AVATAR_FIELD,
  MAX_AVATAR_SIZE,
  ALLOWED_MIME_TYPES,
  MIME_TO_EXT,
} from '../utils/upload.js';

/**
 * 头像上传：multer 配置 + 落盘后的收尾（写库失败回滚 / 删旧文件）。
 *
 * 对应 docs/API.md 的 POST /api/users/me/avatar，目录与命名规则见
 * docs/DB.md 的「第十一批：头像文件存储」。
 */

/**
 * 磁盘存储：**目录按 userId 分，文件名服务端生成**。
 *
 * destination 在 filename 之前被调用，同一个请求里 req 是共享的，
 * 但这里两个回调各自独立算路径，不依赖执行顺序（减少隐式耦合）。
 */
const storage = multer.diskStorage({
  destination(req, file, cb) {
    // req.user 一定存在：路由上 auth 中间件排在 multer 之前，
    // 未登录的请求根本走不到这里。
    const dir = path.join(UPLOAD_DIR, AVATAR_SUBDIR, String(req.user.userId));

    try {
      // 目录不进 git，clone 下来是不存在的，必须按需创建。
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return cb(error);
    }

    return cb(null, dir);
  },

  filename(req, file, cb) {
    // {毫秒时间戳}-{16 位随机 hex}.{扩展名}
    // randomBytes 来自 node:crypto（内置模块，不加依赖）；
    // 随机值保证文件名不可枚举，时间戳保证同一毫秒内也不撞名。
    const ext = MIME_TO_EXT[file.mimetype] || '';
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

    return cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_AVATAR_SIZE, // 超出 → MulterError LIMIT_FILE_SIZE
    files: 1, // 只收一个文件
  },
  fileFilter(req, file, cb) {
    // fileFilter 抛的 err 会被 multer 原样 next(err) 出去，
    // 所以直接给 httpError，错误码/状态码一步到位。
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(httpError(400, CODE.PARAM_ERROR, '只支持 JPG / PNG / WebP 格式'), false);
    }

    return cb(null, true);
  },
});

/**
 * 把 multer 的错误翻译成业务错误。
 *
 * 不翻译的话会落到 errorHandler，变成 HTTP 500 / 50000，
 * 而「图片太大」「没选文件」明明是客户端问题（40000）。
 */
function translateUploadError(error) {
  // 我们自己在 fileFilter 里抛的 httpError：原样透传
  if (error && error.status) return error;

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return httpError(400, CODE.PARAM_ERROR, '图片不能超过 2MB');
      // 字段名不对（不是 avatar）或多传了文件：对前端来说就是「没按要求传头像」
      case 'LIMIT_UNEXPECTED_FILE':
      case 'LIMIT_FILE_COUNT':
      case 'MISSING_FIELD_NAME':
        return httpError(400, CODE.PARAM_ERROR, `请选择要上传的图片（字段名 ${AVATAR_FIELD}）`);
      default:
        return httpError(400, CODE.PARAM_ERROR, '图片上传失败，请重试');
    }
  }

  return error;
}

/**
 * 路由中间件：解析 multipart 里的头像文件。
 *
 * 包一层而不用 `upload.single()` 直接挂路由，就是为了在这里吃掉 multer 的错误并翻译。
 * 另外注意：multer 对**非 multipart** 请求会直接 next() 放行（见 make-middleware.js 的
 * `if (!is(req, ['multipart'])) return next()`），此时 req.file 为 undefined，
 * 由 controller 统一报「请选择要上传的图片」。
 */
export function avatarUpload(req, res, next) {
  return upload.single(AVATAR_FIELD)(req, res, (error) => {
    if (error) return next(translateUploadError(error));
    return next();
  });
}

/**
 * 落盘后的文件 → 存进 users.avatar 的站内相对 URL。
 *
 * @param {object} file multer 的 file 对象（diskStorage 下必有 path）
 * @returns {string} 形如 `/uploads/avatars/1/1759516800000-3f2a9c7e1b4d8065.png`
 */
export function toAvatarUrl(file) {
  // Windows 下 path.relative 返回 `avatars\1\x.png`，URL 里必须是正斜杠。
  const rel = path.relative(UPLOAD_DIR, file.path).split(path.sep).join('/');

  return AVATAR_URL_PREFIX + rel;
}

/**
 * 删除一个已落盘的文件。**只记日志，不抛错**。
 *
 * 这是「清理」动作，不是业务动作：删不掉只意味着多一个垃圾文件，
 * 返回给用户一个 500 反而把「头像已经换好了」这件事实掩盖掉。
 *
 * @param {string} absolutePath 磁盘绝对路径
 */
export function deleteUploadedFile(absolutePath) {
  if (!absolutePath) return;

  try {
    fs.unlinkSync(absolutePath);
  } catch (error) {
    // ENOENT 最常见：文件本来就不在（例如手工清过盘）。不算异常。
    console.warn(`[upload] 删除文件失败（忽略）：${absolutePath} - ${error.code || error.message}`);
  }
}

/**
 * 删除**站内**旧头像。判定依据只有一个：旧值是否以 `/uploads/` 开头。
 *
 * ## ⚠️ 这个前缀判断不要删（外链下线后它的角色变了）
 * 外链下线后，库里只要是**新写入**的合法值就一定是 `/uploads/` 开头，这个判断
 * 看起来就多余了。它必须保留，两个理由：
 *   ① **历史脏值**：收紧校验只能保证*新的*脏值写不进来，**读**的时候仍要按同一
 *      条规则处理老值（第九批可能留下过外链，手工改库也会产生）。
 *   ② **rm 之前唯一的防线**：这个判断等价于「这文件是我们的吗」。去掉它，
 *      就成了「按库里的字符串无条件删磁盘文件」——而现在下面还有一道
 *      「必须在 UPLOAD_DIR 内」的路径校验，两道加起来才是完整的。
 *
 * 一句话：它的角色从「区分外链」变成了**脏值防御**。
 *
 * - 空 / `null` → 本来就没头像，跳过
 * - 非 `/uploads/` 开头（历史外链等脏值）→ 跳过，文件不在我们的磁盘上
 *
 * @param {string|null} avatar 旧的 users.avatar 值
 */
export function deleteLocalAvatar(avatar) {
  if (typeof avatar !== 'string' || !avatar.startsWith(AVATAR_URL_PREFIX)) return;

  const rel = avatar.slice(AVATAR_URL_PREFIX.length);
  const abs = path.resolve(UPLOAD_DIR, rel);

  // 防御：解析后的路径必须仍在 UPLOAD_DIR 内。
  // 正常流程产生的路径不会越界，但 users.avatar 也可能被手工改过，
  // 与其指望上游，不如在真正 rm 的这一行前面挡一道。
  if (!abs.startsWith(UPLOAD_DIR + path.sep)) {
    console.warn(`[upload] 拒绝删除越界路径：${avatar}`);
    return;
  }

  deleteUploadedFile(abs);
}
