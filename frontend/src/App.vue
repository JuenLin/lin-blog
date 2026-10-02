<template>
  <div class="app">
    <AppHeader v-if="showLayout" />

    <main class="app-main">
      <router-view />
    </main>

    <AppFooter v-if="showLayout" />

    <!-- F1：返回顶部按钮。滚动超过阈值才出现，点击平滑滚回顶部。
         纯 CSS + 原生 scroll 事件，不加依赖；<button> 天然键盘可达。 -->
    <button
      class="back-to-top"
      :class="{ 'is-visible': showBackTop }"
      type="button"
      aria-label="返回顶部"
      @click="scrollTop"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from './components/AppHeader.vue';
import AppFooter from './components/AppFooter.vue';

const route = useRoute();

// 布局由路由 meta.layout 控制，只有登录页是 blank，其余都带 Header + Footer。
const showLayout = computed(() => route.meta.layout !== 'blank');

// F1：滚动超过 400px 显示返回顶部按钮。
const showBackTop = ref(false);
const SCROLL_THRESHOLD = 400;

function onScroll() {
  showBackTop.value = window.scrollY > SCROLL_THRESHOLD;
}

function scrollTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

onMounted(() => window.addEventListener('scroll', onScroll, { passive: true }));
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll));
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

/* F1：返回顶部按钮 —— 圆形、品牌渐变底、固定在右下角。
   默认隐藏（opacity + visibility + 下移），出现时淡入上移，统一 200ms 过渡。 */
.back-to-top {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--brand-gradient);
  color: var(--text-on-brand);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-card-hover);
  opacity: 0;
  visibility: hidden;
  transform: translateY(8px);
  pointer-events: none;
  transition:
    opacity var(--transition-base),
    transform var(--transition-base),
    visibility var(--transition-base);
  z-index: 50;
}

.back-to-top.is-visible {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  pointer-events: auto;
}

.back-to-top:focus-visible {
  outline: 2px solid var(--brand-start);
  outline-offset: 2px;
}

.back-to-top svg {
  width: 20px;
  height: 20px;
}
</style>
