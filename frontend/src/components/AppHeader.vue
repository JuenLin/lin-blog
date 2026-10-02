<template>
  <header class="app-header">
    <div class="app-header-inner">
      <router-link class="app-logo" :to="{ name: 'home' }">workbuddy</router-link>

      <div class="app-header-right">
        <!-- 暗色模式切换（第五步 ⑤）：不引依赖，直接切 <html>.dark 类并落 localStorage -->
        <el-button
          class="theme-toggle"
          text
          :aria-label="isDark ? '切换到浅色模式' : '切换到深色模式'"
          @click="toggleTheme"
        >
          <svg v-if="isDark" class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <line x1="12" y1="2" x2="12" y2="4" />
            <line x1="12" y1="20" x2="12" y2="22" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="2" y1="12" x2="4" y2="12" />
            <line x1="20" y1="12" x2="22" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <svg v-else class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        </el-button>

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
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import UserDropdown from './UserDropdown.vue';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

// 暗色模式（第五步 ⑤）：状态即 <html> 上是否有 .dark 类。
// index.html 的内联脚本已在首帧前据此设置好 class，这里只同步按钮图标。
const isDark = ref(false);

function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch (e) {
    // 隐私模式等场景下 localStorage 不可写，不影响本次切换。
  }
  isDark.value = dark;
}

function toggleTheme() {
  applyTheme(!isDark.value);
}

// 刷新页面后 token 还在 localStorage，但 Pinia 里的 user 是空的，这里补拉一次。
// token 已过期时 request.js 会清 token 并跳登录，所以这里只需要保证不把错误抛到页面外。
onMounted(async () => {
  isDark.value = document.documentElement.classList.contains('dark');

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
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
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
  color: var(--text-strong);
  text-decoration: none;
}

.app-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 暗色切换按钮：去掉 el-button 默认内边距，只留图标，保持和右侧按钮同高对齐 */
.theme-toggle {
  padding: 7px;
  height: auto;
}

.theme-icon {
  width: 18px;
  height: 18px;
  display: block;
}
</style>
