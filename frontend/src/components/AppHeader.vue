<template>
  <header class="app-header">
    <div class="app-header-inner">
      <router-link class="app-logo" :to="{ name: 'home' }">workbuddy</router-link>

      <div class="app-header-right">
        <template v-if="userStore.isLogin">
          <el-button type="primary" @click="goEditor">写文章</el-button>
          <UserDropdown />
        </template>

        <el-button v-else @click="goLogin">登录</el-button>
      </div>
    </div>
  </header>
</template>

<script setup>
import { onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import UserDropdown from './UserDropdown.vue';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

// 刷新页面后 token 还在 localStorage，但 Pinia 里的 user 是空的，这里补拉一次。
// token 已过期时 request.js 会清 token 并跳登录，所以这里只需要保证不把错误抛到页面外。
onMounted(async () => {
  if (userStore.isLogin && !userStore.user) {
    try {
      await userStore.fetchMe();
    } catch (error) {
      // 401 已由 request.js 处理；其余错误不影响页面渲染。
    }
  }
});

function goLogin() {
  router.push({ name: 'login', query: { redirect: route.fullPath } });
}

function goEditor() {
  router.push({ name: 'editor-create' });
}
</script>

<style scoped>
.app-header {
  border-bottom: 1px solid var(--border-color, #e5e4e7);
  background: #fff;
}

.app-header-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-logo {
  font-size: 20px;
  font-weight: 600;
  color: #303133;
  text-decoration: none;
}

.app-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>
