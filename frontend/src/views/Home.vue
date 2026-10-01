<template>
  <div class="home">
    <div class="home-header">
      <h1 class="home-title">workbuddy</h1>
      <el-button type="danger" plain @click="handleLogout">退出登录</el-button>
    </div>

    <el-card shadow="never">
      <template #header>
        <span>当前用户</span>
      </template>

      <el-descriptions v-if="userStore.user" :column="1" border>
        <el-descriptions-item label="ID">{{ userStore.user.id }}</el-descriptions-item>
        <el-descriptions-item label="用户名">{{ userStore.user.username }}</el-descriptions-item>
        <el-descriptions-item label="昵称">{{ userStore.user.nickname || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatTime(userStore.user.createdAt) }}</el-descriptions-item>
      </el-descriptions>

      <el-empty v-else description="暂无用户信息" />
    </el-card>

    <el-alert v-if="errorMessage" class="home-alert" type="warning" :closable="false" :title="errorMessage" />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '../stores/user.js';

const router = useRouter();
const userStore = useUserStore();

const errorMessage = ref('');

function formatTime(value) {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleString();
}

async function handleLogout() {
  userStore.logout();
  await router.push({ name: 'login' });
}

onMounted(async () => {
  try {
    await userStore.fetchMe();
  } catch (error) {
    errorMessage.value = error.message;
  }
});
</script>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 16px;
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.home-title {
  margin: 0;
  font-size: 28px;
}

.home-alert {
  margin-top: 24px;
}
</style>
