<template>
  <div class="profile-edit">
    <el-card class="profile-edit-card" shadow="never">
      <template #header>
        <span>编辑资料</span>
      </template>

      <el-alert type="info" :closable="false" show-icon class="profile-edit-tip">
        头像可以<strong>直接上传</strong>（JPG / PNG / WebP，不超过 2MB），也可以<strong>填图片外链</strong>。
        <strong>上传是立即生效的</strong>，不必再点保存；简介仍要点保存。外链方式系统不托管图片，也不会检查链接是否真的能打开。
      </el-alert>

      <div class="avatar-preview">
        <!-- 预览同样有两种形态（第九批）：有链接渲染 <img>，否则回退色块 + 首字。
             这里的 src 是「用户当前输入的链接」，还没保存，所以要用本地状态而不是 store。 -->
        <img
          v-if="previewSrc && !previewBroken"
          class="avatar-preview-img"
          :src="previewSrc"
          :alt="displayName"
          @error="previewBroken = true"
        />
        <span
          v-else
          class="avatar-preview-text"
          :style="{ backgroundColor: previewColor }"
        >{{ previewText }}</span>

        <div class="avatar-preview-meta">
          <p class="avatar-preview-label">当前头像</p>
          <p v-if="previewBroken" class="avatar-preview-warn">
            链接加载失败（可能不存在或被防盗链拦截），保存后其他位置也会显示成文字头像。
          </p>
          <p v-else-if="!previewSrc" class="avatar-preview-hint">
            还没有头像，将使用昵称首字。
          </p>
        </div>
      </div>

      <!-- 上传区（第十一批）。原生 input 用 CSS 藏起来，靠按钮代触发 click：
           这样可以完全控制按钮文案 / loading 态，而不用去改 el-upload 的 DOM 结构
           （也避免为了一个上传框引入 Element Plus 的 upload 组件）。 -->
      <div class="avatar-upload">
        <input
          ref="fileInput"
          class="avatar-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          @change="handleFileChange"
        />
        <el-button
          size="small"
          type="primary"
          :loading="uploading"
          :disabled="uploading"
          @click="pickFile"
        >
          {{ uploading ? '上传中…' : '上传图片' }}
        </el-button>
        <span class="avatar-upload-hint">支持 JPG / PNG / WebP，不超过 2MB</span>
      </div>

      <!-- label-width 给足：「头像链接」与「个人简介」长度不同，
           label-position 默认 right 会让长短标签参差不齐，这里显式 left。
           label-width="0"：提交区没有 label，不归零会被右推 100px。 -->
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        label-position="left"
        @submit.prevent="handleSubmit"
      >
        <el-form-item label="或图片外链" prop="avatar">
          <el-input
            v-model="form.avatar"
            placeholder="https://example.com/avatar.png，留空表示不改"
            clearable
          />
          <p v-if="isUploadedAvatar" class="avatar-uploaded-tip">
            当前是已上传的站内图片（服务端生成的路径，不建议手改）。
          </p>
          <div class="avatar-actions">
            <el-button size="small" text type="primary" @click="clearAvatar">
              {{ form.avatar ? '清除头像' : '已是清除状态' }}
            </el-button>
            <el-button
              v-if="form.avatar"
              size="small"
              text
              @click="form.avatar = originalAvatar || ''"
            >
              撤销修改
            </el-button>
          </div>
        </el-form-item>

        <el-form-item label="个人简介" prop="bio">
          <el-input
            v-model="form.bio"
            type="textarea"
            :rows="4"
            maxlength="200"
            show-word-limit
            placeholder="介绍一下你自己，留空表示不改"
          />
        </el-form-item>

        <el-form-item label-width="0" class="form-actions">
          <el-button type="primary" :loading="loading" :disabled="loading" @click="handleSubmit">
            保存
          </el-button>
          <el-button text :disabled="loading" @click="goBack">取消</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { updateMyProfile, uploadAvatar } from '../api/user.js';
import { useUserStore } from '../stores/user.js';
import { getAvatarColor, getAvatarText, resolveAvatarUrl } from '../utils/format.js';

const AVATAR_MAX_LENGTH = 255;
const BIO_MAX_LENGTH = 200;

// 与后端 utils/upload.js 的白名单、services/upload.service.js 的 limits 保持一致。
// 前端先拦一道是为了**体验**（选错文件立刻提示，不用等上传完），
// 不是为了安全——服务端会再拦一次，前端这层绕过毫无难度。
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

const router = useRouter();
const userStore = useUserStore();
const formRef = ref(null);
const loading = ref(false);

// 上传是独立的一次请求，与「保存资料」的 loading 互不干扰：
// 上传中仍可编辑简介，两个按钮各管各的禁用态。
const uploading = ref(false);
const fileInput = ref(null);

const displayName = computed(() => {
  if (!userStore.user) {
    return '我';
  }

  return userStore.user.nickname || userStore.user.username || '我';
});

// 「原始值」：进页面时的头像与简介。用于判断用户到底改了没有，
// 以及「撤销修改」按钮回退到它。**必须是 null 而不是 ''**——
// null 与 '' 在接口语义上完全不同（null 是清空，'' 对 bio 等价清空、对 avatar 是非法值）。
const originalAvatar = ref(null);
const originalBio = ref(null);

const form = reactive({
  avatar: '',
  bio: '',
});

// 初始化一次：把 store 里的现值搬进表单。
// 注意 avatar 存的是 null 时，表单里显示为空字符串（用户看到「没填」），
// 但「有没有头像」这件事由 avatarCleared 单独记录，不会因此丢掉三态语义。
function initFromStore() {
  const user = userStore.user;

  originalAvatar.value = user && user.avatar !== undefined ? user.avatar : null;
  originalBio.value = user && user.bio !== undefined ? user.bio : null;
  form.avatar = originalAvatar.value || '';
  form.bio = originalBio.value || '';
}

initFromStore();

// 用户是否点了「清除头像」。这个标志位是三态语义里 null 的来源，
// 不能靠「form.avatar 是空串」来推断——空串既可能表示「没动过」，也可能表示「清了」。
const avatarCleared = ref(false);

const previewBroken = ref(false);

// 预览源：清除状态 或 用户填了链接 才用链接，否则回退文字头像。
//
// 第十一批：值可能是站内相对路径（/uploads/avatars/1/xxx.png），
// 必须过 resolveAvatarUrl 补上后端 origin，否则浏览器会去前端自己的 5173 端口找图。
// 补 origin 只在这一个地方做（format.js 里），其它组件走 resolveAvatar 同样是这一处。
const previewSrc = computed(() => {
  if (avatarCleared.value) return '';
  return resolveAvatarUrl(form.avatar.trim());
});
const previewText = computed(() => getAvatarText(displayName.value));
const previewColor = computed(() => getAvatarColor(displayName.value));

// 当前头像是不是「上传得来的站内路径」：是的话给一句提示，别让用户手改这个路径。
const isUploadedAvatar = computed(() => !avatarCleared.value && form.avatar.trim().startsWith('/uploads/'));

// 前端只做「格式」校验，「是否真的存在」「是否与他人重复」等一律以服务端为准。
const rules = computed(() => ({
  avatar: [
    {
      validator: (_rule, value, callback) => {
        const text = (value || '').trim();

        // 清空状态不校验；空串（没动过）也不校验——服务端会因「键不出现」而跳过。
        if (!text || avatarCleared.value) {
          return callback();
        }

        // 与后端 user.validator.js 同一套规则：接受 http(s) 外链，
        // 或第十一批上传产生的站内路径（/uploads/ 开头）。
        // javascript: / data: 等伪协议仍然要挡——它们会被渲染进 <img src>，等同于 XSS。
        if (!/^https?:\/\//i.test(text) && !text.startsWith('/uploads/')) {
          return callback(new Error('必须是 http(s):// 外链，或 /uploads/ 开头的站内路径'));
        }

        if (text.length > AVATAR_MAX_LENGTH) {
          return callback(new Error(`不能超过 ${AVATAR_MAX_LENGTH} 个字符`));
        }

        return callback();
      },
      trigger: 'blur',
    },
  ],
  bio: [
    {
      validator: (_rule, value, callback) => {
        const text = value == null ? '' : String(value);

        if (text.length > BIO_MAX_LENGTH) {
          return callback(new Error(`不能超过 ${BIO_MAX_LENGTH} 个字符`));
        }

        return callback();
      },
      trigger: 'blur',
    },
  ],
}));

/**
 * 上传头像（第十一批）。
 *
 * 与「保存」是两条独立路径：上传**立即写库**（后端一步到位，见 docs/API.md），
 * 不走 buildPayload / 不点保存。所以成功后要同步三件事，否则表单会「以为没改」：
 *   ① store（顶部下拉、文章卡片等处立刻显示新头像）
 *   ② originalAvatar（buildPayload 的比对基准，不同步会把新头像误判成「用户改了」再提交一次）
 *   ③ form.avatar（输入框与预览的源）
 *
 * @param {Event} event input[type=file] 的 change 事件
 */
async function handleFileChange(event) {
  const input = event.target;
  const file = input.files && input.files[0];

  // 无论成败都清空 input.value：否则用户第二次选**同一个文件**不会触发 change，
  // 表现为「点了没反应」——这是原生 file input 的经典坑。
  const reset = () => {
    input.value = '';
  };

  if (!file) {
    reset();
    return;
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    ElMessage.error('只支持 JPG / PNG / WebP 格式');
    reset();
    return;
  }

  if (file.size > MAX_AVATAR_SIZE) {
    ElMessage.error('图片不能超过 2MB');
    reset();
    return;
  }

  uploading.value = true;

  try {
    const user = await uploadAvatar(file);

    userStore.setUser(user);
    originalAvatar.value = user.avatar !== undefined ? user.avatar : null;
    form.avatar = originalAvatar.value || '';
    avatarCleared.value = false;
    previewBroken.value = false;

    // 清掉之前的校验报错（例如原先填过非法外链留下的红字）
    formRef.value && formRef.value.clearValidate('avatar');

    ElMessage.success('头像已更新');
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出，这里不重复处理 code。
    ElMessage.error(error.message);
  } finally {
    uploading.value = false;
    reset();
  }
}

function pickFile() {
  if (uploading.value) {
    return;
  }

  // display:none 的 input 依然可以被程序触发 click —— 这是隐藏原生文件框的标准做法。
  fileInput.value && fileInput.value.click();
}

function clearAvatar() {
  avatarCleared.value = true;
  form.avatar = '';
  previewBroken.value = false;
  // 手动清掉校验状态，否则之前的红色报错会留在界面上。
  formRef.value && formRef.value.clearValidate('avatar');
}

function goBack() {
  router.back();
}

/**
 * 组装提交体—— 本组件最核心的逻辑，实现 docs/API.md 的三态语义。
 *
 * **只放用户实际改动过的键**：
 *   - 头像没动过（没碰清除、也没改链接）→ **不传 avatar 键**（不是传 null！）
 *   - 点了「清除头像」→ 传 avatar: null
 *   - 改了链接 → 传 avatar: 'https://...'
 *   - 简介没动过 → 不传 bio 键；改成空 → 传 bio: null（清空）
 *
 * 为什么这么写：接口靠「键是否出现」区分「不改」和「清空」。
 * 如果无脑把两个字段都带上，用户只改简介就会把头像被清空——这正是
 * API.md 里专门警告过的坑。宁可少传键，也不要替用户做决定。
 */
function buildPayload() {
  const payload = {};

  const trimmedAvatar = form.avatar.trim();
  const currentAvatar = originalAvatar.value || '';
  const currentBio = originalBio.value == null ? '' : String(originalBio.value);
  const nextBio = form.bio == null ? '' : String(form.bio);

  if (avatarCleared.value) {
    // 原本就没有头像、用户又点了一次清除 → 状态没变，不必发请求。
    if (currentAvatar) {
      payload.avatar = null;
    }
  } else if (trimmedAvatar !== currentAvatar) {
    payload.avatar = trimmedAvatar;
  }

  if (nextBio !== currentBio) {
    // 空串按「清空」提交（后端会把 '' 转成 null 存储）。
    payload.bio = nextBio === '' ? null : nextBio;
  }

  return payload;
}

async function handleSubmit() {
  if (!formRef.value || loading.value) {
    return;
  }

  try {
    await formRef.value.validate();
  } catch (error) {
    return;
  }

  const payload = buildPayload();

  // 一个键都没变：后端会拒（40000「至少要传一个」），这里提前拦下并给明确提示，
  // 避免用户对着表单点保存却收到一句看不懂的报错。
  if (Object.keys(payload).length === 0) {
    ElMessage.info('没有改动');
    return;
  }

  loading.value = true;

  try {
    const user = await updateMyProfile(payload);

    // 接口返回完整 public user，直接更新 store ——
    // 不必再发一次 GET /auth/me（docs/API.md 的响应约定）。
    userStore.setUser(user);

    // 更新「原始值」：连续保存时不能拿旧值当基准，否则第二次会误判为「又改了」。
    originalAvatar.value = user.avatar !== undefined ? user.avatar : null;
    originalBio.value = user.bio !== undefined ? user.bio : null;
    avatarCleared.value = false;
    previewBroken.value = false;

    ElMessage.success('资料已更新');
  } catch (error) {
    // 错误提示由 request.js 的拦截器统一抛出，这里不重复处理 code。
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.profile-edit {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.profile-edit-card {
  width: 520px;
}

.profile-edit-tip {
  margin-bottom: 16px;
}

.avatar-preview {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

/* 与 UserDropdown 的 32px 不同：编辑页是「看清自己头像」的场景，放大到 56px */
.avatar-preview-img,
.avatar-preview-text {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  flex-shrink: 0;
}

.avatar-preview-img {
  object-fit: cover;
  display: block;
}

.avatar-preview-text {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 22px;
  font-weight: 600;
}

.avatar-preview-meta {
  min-width: 0;
}

.avatar-preview-label {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
}

.avatar-preview-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

/* 项目没定义警告色变量（style.css 里只有 --border / --text-* / --chip-* 等），
   这里用 Element Plus 的 warning 色值直接写，不自造变量名。 */
.avatar-preview-warn {
  margin: 0;
  font-size: 12px;
  color: #e6a23c;
}

.avatar-upload {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -8px 0 20px;
}

/* 原生文件框藏起来，只留按钮。display:none 不影响程序化 click()。 */
.avatar-file-input {
  display: none;
}

.avatar-upload-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.avatar-uploaded-tip {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.avatar-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* 兜底：标签不折行（label-width 已固定 100px） */
.profile-edit :deep(.el-form-item__label) {
  white-space: nowrap;
}

/* 提交区按钮居中，与 Login.vue / ChangePassword.vue 一致。
   content 是 flex 容器，flex 子元素会忽略 text-align，必须用 justify-content。 */
.form-actions :deep(.el-form-item__content) {
  justify-content: center;
}
</style>
