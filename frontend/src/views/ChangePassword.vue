<template>
  <div class="change-password">
    <el-card class="change-password-card" shadow="never">
      <template #header>
        <span>修改密码</span>
      </template>

      <!-- 旧 token 语义（docs/API.md）：改完密码服务端不强制失效已签发的 token，
           所以本地必须主动清 token 跳登录，见 handleSubmit 的收尾。 -->
      <el-alert type="info" :closable="false" show-icon class="change-password-tip">
        修改成功后需要重新登录。已登录的其他设备不会立即失效，密码变更请谨慎。
      </el-alert>

      <!-- label-width 必须显式给足：「确认新密码」5 个汉字（约 70px）+ 必填星号，
           再加label 自带的 padding-right: 12px，88px 会撑不下导致标签换行、按钮被挤到右边。
           label-position 默认是right，标签长短不一會右对齐得参差不齐，这里显式改成 left。 -->
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="100px"
        label-position="left"
        @submit.prevent="handleSubmit"
      >
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input
            v-model="form.oldPassword"
            type="password"
            placeholder="请输入当前密码"
            autocomplete="current-password"
            show-password
          />
        </el-form-item>

        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="form.newPassword"
            type="password"
            placeholder="6 到 100 个字符"
            autocomplete="new-password"
            show-password
          />
        </el-form-item>

        <el-form-item label="确认新密码" prop="confirmPassword">
          <el-input
            v-model="form.confirmPassword"
            type="password"
            placeholder="再输入一次新密码"
            autocomplete="new-password"
            show-password
          />
        </el-form-item>

        <!-- label-width="0"：这一项没有 label，若继承表单的 100px，
             按钮会被整体右推 100px。显式归零让按钮回到卡片左边。
             form-actions：把提交区按钮居中，和下方 .form-actions 样式配对。 -->
        <el-form-item label-width="0" class="form-actions">
          <!-- 防连点：改密码不可逆，连点两次第二次会用「新密码当旧密码」，
               必然失败且让用户困惑，所以提交中直接禁用。 -->
          <el-button type="primary" :loading="loading" :disabled="loading" @click="handleSubmit">
            确认修改
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
import { changePassword } from '../api/auth.js';
import { useUserStore } from '../stores/user.js';

// 长度上限与后端 auth.validator.js /注册接口一致（100 字符）。
// 服务端还会额外卡 bcrypt 的 72 字节上限（后端为权威，前端不重复这个字节换算）。
const NEW_PASSWORD_MIN = 6;
const NEW_PASSWORD_MAX = 100;

const router = useRouter();
const userStore = useUserStore();

const formRef = ref(null);
const loading = ref(false);

const form = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
});

// 前端只做「长度」与「两次输入一致」两项校验。
// 「当前密码是否正确」「新密码是否与旧密码相同」一律以服务端返回为准——
// 前端拿不到密码的哈希，无法可靠判断（docs/API.md 有对应说明）。
const rules = computed(() => ({
  oldPassword: [
    { required: true, message: '请输入当前密码', trigger: 'blur' },
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    {
      min: NEW_PASSWORD_MIN,
      max: NEW_PASSWORD_MAX,
      message: `长度 ${NEW_PASSWORD_MIN} 到 ${NEW_PASSWORD_MAX} 个字符`,
      trigger: 'blur',
    },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (!value) {
          return callback();
        }

        if (value !== form.newPassword) {
          return callback(new Error('两次输入的新密码不一致'));
        }

        return callback();
      },
      trigger: 'blur',
    },
  ],
}));

async function handleSubmit() {
  if (!formRef.value || loading.value) {
    return;
  }

  try {
    await formRef.value.validate();
  } catch (error) {
    return;
  }

  loading.value = true;

  try {
    await changePassword({
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
    });

    ElMessage.success('密码已修改，请重新登录');

    // 服务端不失效旧 token，这里主动清本地登录态。
    // userStore.logout() 内部是 setToken('') + setUser(null)，
    // setToken 会同步清掉 localStorage 的 token，与 request.js 的 401 分支口径一致。
    userStore.logout();
    await router.push({ name: 'login' });
  } catch (error) {
    // 不依赖 error.businessCode：request.js 的 HTTP 层分支
    // 返回的是 new Error(message)，businessCode 在那里被丢掉了。
    // 直接用 message 提示，401 清 token 跳登录由 request.js 拦截器兜住。
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

function goBack() {
  router.back();
}
</script>

<style scoped>
.change-password {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 16px;
}

.change-password-card {
  /* 同 .profile-edit-card：宽度改为「弹性 + 520 封顶」，与资料页同宽。 */
  width: 100%;
  max-width: 520px;
  /* min-height 540 与资料页对齐：本页内容只有 374，拉高后留白，
     换来两页切换时底边不动（原来要上收 108px）。 */
  min-height: 540px;
}

.change-password-tip {
  margin-bottom: 16px;
}

/* 兜底：即使在很窄的视口下，标签也不折行（label 已有 100px 固定宽，
   nowrap 保证「确认新密码」永远单行，超出时宁可溢出也不换行把行高撑乱）。 */
.change-password :deep(.el-form-item__label) {
  white-space: nowrap;
}

/* 提交区按钮居中。el-form-item 的 content 是 flex 容器且默认 justify-content: flex-start，
   直接给 content 加 justify-content: center 比给 item 加 text-align: center 更可靠
   （flex 子元素会忽略 text-align）。 */
.form-actions :deep(.el-form-item__content) {
  justify-content: center;
}
</style>