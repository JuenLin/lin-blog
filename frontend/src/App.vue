<template>
  <div class="app">
    <AppHeader v-if="showLayout" />

    <main class="app-main">
      <router-view />
    </main>

    <AppFooter v-if="showLayout" />
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';

const route = useRoute();

// 布局由路由 meta.layout 控制，只有登录页是 blank，其余都带 Header + Footer。
const showLayout = computed(() => route.meta.layout !== 'blank');
</script>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  text-align: left;
}

/* 撑开中间区域，页脚才能贴在底部而不是跟着内容往上跑。 */
.app-main {
  flex: 1 1 auto;
}
</style>
