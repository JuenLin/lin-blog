<template>
  <header class="app-header">
    <div class="app-header-inner">
      <router-link class="app-logo" :to="{ name: 'home' }">workbuddy</router-link>

      <!-- ⑦ 搜索框：全站常驻。放头部而不是 Home 内部，详情页 / 个人主页 / 写文章页都能直接搜。
           搜索结果统一落在首页（Home.vue 读 ?keyword=），所以这里不重复放第二个输入框。 -->
      <SearchBar />

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
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AUTH_CLEARED_EVENT } from '../api/request.js';
import { useUserStore } from '../stores/user.js';
import { useLikedStore } from '../stores/liked.js';
import { useFollowingStore } from '../stores/following.js';
import SearchBar from './SearchBar.vue';
import UserDropdown from './UserDropdown.vue';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const likedStore = useLikedStore();
const followingStore = useFollowingStore();

// 401 拦截器不流经 userStore（会引循环依赖），改为派发事件；这里监听并调 setToken('')。
// 既把 token ref 置空（isLogin=false → 头部退回「登录」按钮），又触发 likedStore.reset()
// （清空已赞集合，否则 401 后头部仍显示登录态、列表卡片错误变红 —— 真 bug）。
function handleAuthCleared() {
  useUserStore().setToken('');
}

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
//
// 放在 AppHeader 而不是某个列表页：这四个列表点位都要用到这份缓存
// （广场 / 用户文章 Tab / 点赞 Tab / 详情页的「作者其他文章」），
// 放列表页会漏点位，放 App.vue 则与已有的「登录态初始化」模式分散。
onMounted(async () => {
  isDark.value = document.documentElement.classList.contains('dark');

  if (userStore.isLogin && !userStore.user) {
    try {
      await userStore.fetchMe();
    } catch (error) {
      // 401 已由 request.js 处理；其余错误不影响页面渲染。
    }
  }

  // 已赞集合：整个 SPA 生命周期只真拉一次（store 内部有 initialized 幂等）。
  // 未登录**决不能调** —— 会吃 401 从而被 request.js 踢去登录页；这与
  // 详情页 getArticleLiked 是同一条纪律（见 api/like.js 注释）。
  //
  // 注意这里不 await 到阻塞渲染：卡片做的是「命中即红」，集合晚到位只会让爱心
  // 晚一拍变红，不影响列表本身渲染。失败了也是退化为旧行为，不是错态。
  if (userStore.isLogin) {
    try {
      await likedStore.ensureLoaded();
    } catch (error) {
      // ensureLoaded 内部已兜住，这里是双保险：绝不让初始化失败冒泡到 App 挂掉。
    }
  }

  // 第 4 批：「我关注的人」集合（用途：关注按钮初始态 + 自己主页那个免费计数）。
  // ⚠️ 这里依赖的是 **userStore.user?.id 而不是 token** —— 拉的是 GET /users/{id}/following，
  // 必须知道"我"的 id；而 user 是 fetchMe() 异步到位的，首屏大概率还是 null。
  // 所以：这里能做就做（刷新页面且 token 还在时会先 await fetchMe），
  // 做不了就交给下面那个 watch(user.id) 兜 —— user 一到立刻补拉。
  if (userStore.isLogin && userStore.user) {
    try {
      await followingStore.ensureLoaded(userStore.user.id);
    } catch (error) {
      // 同 ensureLoaded：内部已兜住，这里只是别让失败冒泡。
    }
  }

  // 监听 401 拦截器派发的「登录态已失效」事件（request.js 为避免循环依赖改用事件而非直接调 store）。
  window.addEventListener(AUTH_CLEARED_EVENT, handleAuthCleared);
});

onUnmounted(() => {
  window.removeEventListener(AUTH_CLEARED_EVENT, handleAuthCleared);
});

// 换账号：token 被换成别人的那一刻，旧的已赞集合已经在 setToken() 里清掉了，
// 这里负责把新账号那份拉回来。
//
// 不用 immediate —— 首次进页面由上面的 onMounted 负责（那时 token 是从 localStorage
// 读出来的初始值，watch 不会触发）。
// 也不在这里处理登出：setToken('') 已清空，下面的 isLogin 判断会让这次回调什么都不做。
watch(
  () => userStore.token,
  async (next) => {
    if (!next) return;

    try {
      await likedStore.ensureLoaded();
    } catch (error) {
      // 同上：初始化失败只退化为「全是空心」，不影响页面。
    }
  },
);

// 第 4 批：换账号时补拉「我关注的人」。
// source 用 `userStore.user?.id` 而不是 token：列表已按顺序清空（setToken 里 reset），
// 但新账号那份必须等 user 到位才知道 id —— 用 token 会在 user 还是 null 时白跑一趟。
// 登出时不处理：setToken('') 已清空，而 user 会被 setUser(null)，id 为空，这里自然不做事。
watch(
  () => (userStore.user ? userStore.user.id : null),
  async (next) => {
    if (!next) return;

    try {
      await followingStore.ensureLoaded(next);
    } catch (error) {
      // 同上：失败只退化为「按钮按未关注显示」，点了才知道已关注，不是错态。
    }
  },
);

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
  /* ⑦ 有了搜索框这一项，space-between 会把 logo / 搜索框 / 右侧按钮均分，
     加 gap 保证 logo 和搜索框之间不会被撑得过散。 */
  gap: 16px;
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
