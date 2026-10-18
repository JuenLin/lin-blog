<template>
  <div class="login">
    <el-card class="login-card" shadow="never">
      <template #header>
        <span>登录 Lin's Blog</span>
      </template>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="72px" @submit.prevent="handleLogin">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username" />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            show-password
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <!-- label-width="0"：这一项没有 label，若继承表单的 72px 会被整体右推，
             居中前先归零，否则居中的是「右推 72px 后」的剩余区域，视觉上仍然偏右。
             form-actions：与 ChangePassword.vue 保持一致，提交按钮居中。 -->
        <el-form-item label-width="0" class="form-actions">
          <el-button type="primary" :loading="loading" @click="handleLogin">登录</el-button>
          <el-button text @click="toggleMode">{{ isRegister ? '去登录' : '去注册' }}</el-button>
        </el-form-item>
      </el-form>

      <el-form-item v-if="isRegister" label="昵称" prop="nickname">
        <el-input v-model="form.nickname" placeholder="选填" />
      </el-form-item>
    </el-card>
  </div>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useUserStore } from '../stores/user.js';

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

const formRef = ref(null);
const loading = ref(false);
const isRegister = ref(false);

const form = reactive({
  username: '',
  password: '',
  nickname: '',
});

const rules = computed(() => {
  const base = {
    username: [
      { required: true, message: '请输入用户名', trigger: 'blur' },
      { min: 3, max: 50, message: '长度 3 到 50 个字符', trigger: 'blur' },
    ],
    password: [
      { required: true, message: '请输入密码', trigger: 'blur' },
      { min: 6, max: 100, message: '长度 6 到 100 个字符', trigger: 'blur' },
    ],
  };

  if (isRegister.value) {
    base.nickname = [{ max: 50, message: '最多 50 个字符', trigger: 'blur' }];
  }

  return base;
});

function toggleMode() {
  isRegister.value = !isRegister.value;
  form.nickname = '';

  if (formRef.value) {
    formRef.value.clearValidate();
  }
}

async function handleLogin() {
  if (!formRef.value) {
    return;
  }

  try {
    await formRef.value.validate();
  } catch (error) {
    return;
  }

  loading.value = true;

  try {
    if (isRegister.value) {
      await userStore.register({
        username: form.username,
        password: form.password,
        nickname: form.nickname || undefined,
      });

      ElMessage.success('注册成功，请登录');
      toggleMode();
    } else {
      await userStore.login({
        username: form.username,
        password: form.password,
      });

      ElMessage.success('登录成功');

      const redirect = route.query.redirect;
      await router.push(typeof redirect === 'string' && redirect ? redirect : { name: 'home' });
    }
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 16px;
}

.login-card {
  width: 420px;
}

/* 提交区按钮居中，与 ChangePassword.vue 一致。
   el-form-item 的 content 是 flex 容器且默认 justify-content: flex-start，
   给 content 加 justify-content: center 比给 item 加 text-align: center 更可靠
   （flex 子元素会忽略 text-align）。 */
.form-actions :deep(.el-form-item__content) {
  justify-content: center;
}
</style>
