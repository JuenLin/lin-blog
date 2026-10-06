<template>
  <div class="profile-edit">
    <el-card class="profile-edit-card" shadow="never">
      <template #header>
        <span>编辑资料</span>
      </template>

      <el-alert type="info" :closable="false" show-icon class="profile-edit-tip">
        头像<strong>直接上传</strong>（JPG / PNG / WebP，不超过 2MB），
        <strong>上传与清除都是立即生效的</strong>，不必再点保存；简介仍要点保存。
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
            图片加载失败（文件可能已被删除），其他位置也会显示成文字头像。
          </p>
          <p v-else-if="!previewSrc" class="avatar-preview-hint">
            还没有头像，将使用昵称首字。
          </p>
          <p v-else class="avatar-preview-hint">
            换图直接传新的即可，旧文件会被自动删掉。
          </p>
        </div>
      </div>

      <!-- 头像操作区。原生 input 用 CSS 藏起来，靠按钮代触发 click：
           这样可以完全控制按钮文案 / loading 态，而不用去改 el-upload 的 DOM 结构
           （也避免为了一个上传框引入 Element Plus 的 upload 组件）。
           「清除头像」也放在这里：外链下线后三态只剩「清空」一支，它与上传同属
           「立即生效区」，不再挂进下面的表单里等保存。 -->
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
          :disabled="uploading || clearing"
          @click="pickFile"
        >
          {{ uploading ? '上传中…' : '上传图片' }}
        </el-button>
        <el-button
          size="small"
          text
          type="danger"
          :loading="clearing"
          :disabled="uploading || clearing || !hasAvatar"
          @click="handleClearAvatar"
        >
          {{ hasAvatar ? '清除头像' : '暂无头像' }}
        </el-button>
        <span class="avatar-upload-hint">支持 JPG / PNG / WebP，不超过 2MB</span>
      </div>

      <!-- label-width 给足：「个人简介」不至于贴边；
           label-position 默认 right 会让标签位置随内容跳动，这里显式 left。
           label-width="0"：提交区没有 label，不归零会被右推 100px。 -->
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        label-position="left"
        @submit.prevent="handleSubmit"
      >
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
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { updateMyProfile, uploadAvatar } from '../api/user.js';
import { useUserStore } from '../stores/user.js';
import { getAvatarColor, getAvatarText, resolveAvatarUrl } from '../utils/format.js';

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

// 头像的两种操作（上传 / 清除）都立即发请求，各自一个 loading 态。
// 与「保存资料」的 loading 互不干扰：头像操作中仍可编辑简介，各按钮各管各的禁用态。
const uploading = ref(false);
const clearing = ref(false);
const fileInput = ref(null);

const displayName = computed(() => {
  if (!userStore.user) {
    return '我';
  }

  return userStore.user.nickname || userStore.user.username || '我';
});

// 「原始值」：进页面时的简介。用于判断用户到底改了没有。
//
// 头像**不在表单里**（外链下线后没有可编辑的头像控件了）：上传与清除都立即写库，
// 所以头像直接读 store，没有「本地草稿 vs 已保存值」这个区分。
const originalBio = ref(null);

const form = reactive({
  bio: '',
});

function initFromStore() {
  const user = userStore.user;

  originalBio.value = user && user.bio !== undefined ? user.bio : null;
  form.bio = originalBio.value || '';
}

initFromStore();

const previewBroken = ref(false);

// 当前头像：直接取自 store（上传 / 清除成功后都由 uploadAvatar / updateMyProfile 回写的 user 驱动）。
const currentAvatar = computed(() => (userStore.user ? userStore.user.avatar : null));
const hasAvatar = computed(() => Boolean(currentAvatar.value));

// 预览源：过 resolveAvatarUrl 补上后端 origin（库里的值形如 /uploads/avatars/1/x.png，
// 直接塞进 <img src> 会被解析成前端自己的 5173 端口）。补 origin 只此一处。
const previewSrc = computed(() => resolveAvatarUrl(currentAvatar.value));
const previewText = computed(() => getAvatarText(displayName.value));
const previewColor = computed(() => getAvatarColor(displayName.value));

// 头像变了就复位「加载失败」标记：否则换上一张能用的图后，界面还停在
// 上一张的失败态（文字头像），看起来像上传没生效。
watch(currentAvatar, () => {
  previewBroken.value = false;
});

// 前端只做长度校验，其余一律以服务端为准。
// 注意：**这里不再有 avatar 规则** —— 没有头像输入框了，天然没有「格式非法」这个输入来源。
const rules = computed(() => ({
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
 * 上传头像。
 *
 * 与「保存」是两条独立路径：上传**立即写库**（后端一步到位，见 docs/API.md），
 * 不经过 buildPayload、不点保存。成功后只需把接口返回的完整 user 写回 store ——
 * 预览、顶部下拉、文章卡片都从 store 派生，一处更新全都跟着变。
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

    // 预览与其它 4 处头像都从 store 派生，写回 store 就够了。
    // previewBroken 由 watch(currentAvatar) 自动复位，这里不用手动清。
    userStore.setUser(user);

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
  if (uploading.value || clearing.value) {
    return;
  }

  // display:none 的 input 依然可以被程序触发 click —— 这是隐藏原生文件框的标准做法。
  fileInput.value && fileInput.value.click();
}

/**
 * 清除头像（传 avatar: null）。
 *
 * **立即生效**，不进 buildPayload、不等点保存 —— 与上传同属「立即生效区」，
 * 这样头像区的语义是自洽的（点了就变），简介区则仍是「改完点保存」。
 *
 * 「没有头像时点了」不用发请求：接口会把 `{ avatar: null }` 当成一次有效的清空操作，
 * 但状态没变，白跑一次网络没有意义（按钮此时也是 disabled 的，这里只是双保险）。
 */
async function handleClearAvatar() {
  if (clearing.value || uploading.value || !hasAvatar.value) {
    return;
  }

  clearing.value = true;

  try {
    const user = await updateMyProfile({ avatar: null });
    userStore.setUser(user);

    ElMessage.success('头像已清除');
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    clearing.value = false;
  }
}

function goBack() {
  router.back();
}

/**
 * 组装提交体 —— 实现 docs/API.md 的「只放改动过的键」。
 *
 * 外链下线后，**这里只剩 bio**：头像的两种操作（上传 / 清除）都在头像区立即生效，
 * 根本不经过本函数。所以 payload 里永远不会出现 avatar 键。
 *
 * 为什么仍要坚持「只放改动过的键」：接口靠「键是否出现」区分「不改」和「清空」。
 * 无脑把字段都带上，用户只动了一个字段却把另一个清掉——这正是 API.md 警告过的坑。
 */
function buildPayload() {
  const payload = {};

  const currentBio = originalBio.value == null ? '' : String(originalBio.value);
  const nextBio = form.bio == null ? '' : String(form.bio);

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

  // 没改动：后端会拒（40000「至少要传一个」），这里提前拦下并给明确提示，
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
    originalBio.value = user.bio !== undefined ? user.bio : null;

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
  /* width:100% + max-width 而不是写死 520px：窄屏下先收缩到容器宽度，
     宽屏封顶 520，与「修改密码」页同宽 —— 两页切换时左边缘不再横移。 */
  width: 100%;
  max-width: 520px;
  /* min-height 540：实测本页内容高桌面 482 / 754 宽 503 / 480 宽 531，
     540 覆盖最坏值，与密码页等高 —— 切换时卡片底边不再上收 108px。 */
  min-height: 540px;
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
  /* 卡片固定 520px，正常一行放得下；窄屏 / 长文案时允许换行，别把按钮挤变形 */
  flex-wrap: wrap;
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
