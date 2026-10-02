<template>
  <!-- 搜索框（第七批）：全站常驻在 AppHeader，回车触发，不做防抖。
       为什么不防抖：输入每个字符都打一次接口纯属浪费，回车触发语义也更明确。
       为什么不放 Home 里：AppHeader 是全站布局（App.vue 里只有登录页是 blank），
       放这里在详情页 / 个人主页也能搜。 -->
  <div class="search-bar">
    <el-input
      v-model="innerValue"
      class="search-input"
      placeholder="搜索文章标题或内容"
      aria-label="搜索文章"
      clearable
      @keyup.enter="submit"
      @clear="submit"
    >
      <template #prefix>
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="20" y1="20" x2="16.65" y2="16.65" />
        </svg>
      </template>
    </el-input>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

// 搜索词上限与后端一致（docs/API.md：keyword trim 后最长 50 字符）。
// 超长后端会返回 40000，这里先拦一道，避免用户白等一次往返。
const KEYWORD_MAX_LENGTH = 50;

const route = useRoute();
const router = useRouter();

const innerValue = ref('');

// 从 URL 恢复搜索词：刷新页面 / 浏览器前进后退时都要跟着变。
// 不用 v-model 直接绑 route.query —— 那是只读的，改了也不会触发请求。
watch(
  () => route.query.keyword,
  (value) => {
    innerValue.value = Array.isArray(value) ? value[0] || '' : value || '';
  },
  { immediate: true }
);

function submit() {
  const keyword = innerValue.value.trim().slice(0, KEYWORD_MAX_LENGTH);

  // 无关键词时回车等于「回到未搜索状态」，URL 上不留 keyword= 空参数。
  if (!keyword) {
    goHomeWithoutKeyword();
    return;
  }

  // 已经在首页且关键词没变时，不再重复 push —— 避免同参数重复导航。
  if (route.name === 'home' && route.query.keyword === keyword) {
    return;
  }

  router.push({ name: 'home', query: { ...route.query, keyword } });
}

// 清空搜索：回首页并丢掉 keyword 参数。
// 保留 pageSize 等其他 query，避免把用户刚调的分页大小也重置掉。
function goHomeWithoutKeyword() {
  const query = { ...route.query };
  delete query.keyword;

  router.push({ name: 'home', query });
}
</script>

<style scoped>
/* 宽度固定在 260px 左右：太宽会和右侧按钮抢视觉重心，太窄中文输入体验差。
 * flex: 0 0 auto 保证不被右侧按钮挤压变形。 */
.search-bar {
  flex: 0 1 260px;
  min-width: 140px;
  display: flex;
  align-items: center;
}

.search-input {
  width: 100%;
}

/* 搜索图标与输入框文字同色系（弱化），聚焦时由 el-input 自身高亮。 */
.search-icon {
  width: 16px;
  height: 16px;
  display: block;
  color: var(--text-muted);
}
</style>
