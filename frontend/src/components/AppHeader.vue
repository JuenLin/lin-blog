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

        <!-- 第 8 批：通知铃铛。仅登录态可见；红点 = 未读数（store 30s 轮询维护）。
             el-badge 的 :hidden 在 0 时自动隐藏，:max 超过 99 显示 99+。 -->
        <el-badge
          v-if="userStore.isLogin"
          class="bell-badge"
          :value="notificationStore.unreadCount"
          :max="99"
          :hidden="notificationStore.unreadCount === 0"
        >
          <el-button class="bell-btn" text :aria-label="'通知'" @click="openDrawer">
            <svg class="bell-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </el-button>
        </el-badge>

        <template v-if="userStore.isLogin">
          <el-button type="primary" @click="goEditor">写文章</el-button>
          <UserDropdown />
        </template>

        <el-button v-else @click="goLogin">登录</el-button>
      </div>
    </div>

    <!-- 第 8 批：通知抽屉。头部右侧「全部已读」按钮（决策点 4）。
         列表渲染后端拼好的 actorName + targetTitle，前端只组句子、不写业务 if-else（防坑 1）。
         点击跳转：FOLLOW→被关注者主页；COMMENT/REPLY/LIKE→文章详情；目标已删→ElMessage + 标已读（防坑 2）。 -->
    <el-drawer
      v-model="drawerVisible"
      direction="rtl"
      size="380px"
      :with-header="true"
    >
      <template #header>
        <div class="drawer-header">
          <span class="drawer-title">通知</span>
          <el-button
            text
            type="primary"
            :disabled="notificationStore.unreadCount === 0"
            @click="handleMarkAll"
          >
            全部已读
          </el-button>
        </div>
      </template>

      <div class="notif-list">
        <div v-if="loadingList" class="notif-loading">加载中…</div>
        <div v-else-if="notifications.length === 0" class="notif-empty">暂时还没有通知</div>
        <div
          v-for="n in notifications"
          :key="n.id"
          class="notif-item"
          :class="{ unread: !n.isRead }"
          @click="handleClick(n)"
        >
          <img
            v-if="n.actorAvatar"
            :src="resolveAvatarUrl(n.actorAvatar)"
            class="notif-avatar"
            alt=""
          />
          <div v-else class="notif-avatar-text">{{ avatarText(n.actorName) }}</div>

          <div class="notif-body">
            <div class="notif-text">{{ buildText(n) }}</div>
            <div class="notif-time">{{ formatTime(n.createdAt) }}</div>
          </div>

          <span v-if="!n.isRead" class="unread-dot" />
        </div>
      </div>
    </el-drawer>
  </header>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { AUTH_CLEARED_EVENT } from '../api/request.js';
import { useUserStore } from '../stores/user.js';
import { useLikedStore } from '../stores/liked.js';
import { useBookmarksStore } from '../stores/bookmarks.js';
import { useFollowingStore } from '../stores/following.js';
import { useNotificationStore } from '../stores/notification.js';
import { listNotifications } from '../api/notification.js';
import { getArticle } from '../api/article.js';
import { resolveAvatarUrl } from '../utils/format.js';
import { initHljsTheme, applyHljsTheme } from '../utils/hljsTheme.js';
import SearchBar from './SearchBar.vue';
import UserDropdown from './UserDropdown.vue';

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const likedStore = useLikedStore();
const bookmarksStore = useBookmarksStore();
const followingStore = useFollowingStore();
const notificationStore = useNotificationStore();

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
  // 第 5 批：highlight.js 主题跟着切（github.css 白底 / github-dark.css 深底），
  // 否则暗色下文章里的代码块会变成一块刺眼的亮斑。
  applyHljsTheme(dark);
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
  // 第 5 批：刷新后直接落在文章详情页时，hljs 主题也要按当前模式就位
  // （登录页是 blank 布局没有 AppHeader，但登录页没有代码块，不受影响）。
  initHljsTheme();

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

    // 第 9 批：「我收藏的文章」集合，用途与已赞集合完全相同（卡片星标初始态）。
    // 同样只在登录态拉；同样不 await 到阻塞渲染（命中即金星，晚一拍无感）。
    try {
      await bookmarksStore.ensureLoaded();
    } catch (error) {
      // 同上：双保险。
    }

    // 第 8 批：登录态直接开启通知轮询（30s 一次未读数）。startPolling 内部先停后建，幂等安全。
    notificationStore.startPolling();
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
  // 第 8 批：组件卸载（虽然本布局基本常驻，仍按纪律显式停轮询防泄漏）。
  notificationStore.stopPolling();
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
    // 登出 / 换号：token 变空 → 停轮询 + 清红点（reset 内部已停定时器）。
    if (!next) {
      notificationStore.reset();
      return;
    }

    try {
      await likedStore.ensureLoaded();
    } catch (error) {
      // 同上：初始化失败只退化为「全是空心」，不影响页面。
    }

    // 第 9 批：换号后同样要把新账号的收藏集合拉回来（旧集合已在 setToken 里清掉，
    // 不清就是串号：A 收藏的文章在 B 的卡片上也是金星）。
    try {
      await bookmarksStore.ensureLoaded();
    } catch (error) {
      // 同上。
    }

    // 第 8 批：token 到位（登录 / 换号）→ 重启轮询拉未读数。
    notificationStore.startPolling();
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

// ─────────────────────────────────────────────────────────────
// 第 8 批：通知中心（铃铛 + 抽屉 + 轮询）
// ─────────────────────────────────────────────────────────────

const drawerVisible = ref(false);
const notifications = ref([]);
const loadingList = ref(false);

/**
 * 把一条通知拼成展示文案。后端只给 actorName / targetTitle / type（防坑 1：不冗余存快照，
 * 也不把整句塞给前端），前端用一份 type→模板映射组句——**单一来源、数据驱动**，
 * 不在渲染层到处写 if-else 分支。targetTitle 缺失（文章被删）时兜底「内容已删除」。
 */
function buildText(n) {
  const actor = n.actorName || '某人';

  switch (n.type) {
    case 'COMMENT':
      return `${actor} 评论了你的文章《${n.targetTitle || '内容已删除'}》`;
    case 'REPLY':
      return `${actor} 回复了你的评论（《${n.targetTitle || '内容已删除'}》）`;
    case 'FOLLOW':
      return `${actor} 关注了你`;
    case 'LIKE':
      return `${actor} 赞了你的文章《${n.targetTitle || '内容已删除'}》`;
    default:
      return `${actor} 与你互动了`;
  }
}

/** 没有头像时取昵称首字做文字头像。 */
function avatarText(name) {
  if (!name) return '?';
  return name.slice(0, 1);
}

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / MM-DD HH:mm。 */
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';

  const diff = Date.now() - d.getTime();
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;

  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/** 抽屉打开时拉第一页通知列表（pageSize 20，覆盖多数场景；如需分页以后再加）。 */
async function loadList() {
  loadingList.value = true;

  try {
    const data = await listNotifications({ page: 1, pageSize: 20 });
    notifications.value = data && data.list ? data.list : [];
  } catch (error) {
    // 失败退化为空列表；未读数由轮询独立维护，不受影响。
    notifications.value = [];
  } finally {
    loadingList.value = false;
  }
}

function openDrawer() {
  drawerVisible.value = true;
  loadList();
}

/** 全部已读（决策点 4）：store 把未读数清零，本地列表同步置已读避免红点消失但列表还亮的错位。 */
async function handleMarkAll() {
  await notificationStore.markAll();
  for (const n of notifications.value) {
    n.isRead = true;
  }
}

/**
 * 点击通知：先顺手标已读（满足防坑 2「标已读」要求），再跳转。
 *   - FOLLOW → 被关注者主页（actorId 即目标，API.md 明确）；
 *   - COMMENT / REPLY / LIKE → 文章详情，跳转前预检文章是否还在（防坑 2：已删不进报错页）。
 *
 * @param {object} n 通知对象
 */
async function handleClick(n) {
  // 顺手标已读：markOne 成功才 -1，失败不动；本地先置 isRead 让 UI 立即反馈。
  notificationStore.markOne(n.id);
  n.isRead = true;

  if (n.type === 'FOLLOW') {
    drawerVisible.value = false;
    router.push({ name: 'user-profile', params: { id: n.actorId } });
    return;
  }

  if (!n.articleId) {
    ElMessage.error('目标内容已不存在');
    return;
  }

  try {
    // 预检：文章已软删 / 不存在 → getArticle 抛 404（request.js 挂了 error.httpStatus）。
    await getArticle(n.articleId);
    drawerVisible.value = false;
    router.push({ name: 'article-detail', params: { id: n.articleId } });
  } catch (error) {
    if (error && error.httpStatus === 404) {
      ElMessage.error('目标内容已不存在');
    } else {
      ElMessage.error(error && error.message ? error.message : '打开失败');
    }
  }
}

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

/* 第 8 批：铃铛 */
.bell-btn {
  padding: 7px;
  height: auto;
}

.bell-icon {
  width: 18px;
  height: 18px;
  display: block;
}

.bell-badge {
  margin-right: 2px;
}

/* 抽屉头部：标题 + 全部已读 */
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.drawer-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

/* 通知列表 */
.notif-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.notif-loading,
.notif-empty {
  text-align: center;
  color: var(--text-muted, #909399);
  padding: 40px 0;
  font-size: 14px;
}

.notif-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  position: relative;
}

.notif-item:hover {
  background: var(--bg-hover, rgba(0, 0, 0, 0.04));
}

.notif-item.unread {
  background: var(--bg-unread, rgba(64, 158, 255, 0.06));
}

.notif-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex: 0 0 auto;
}

.notif-avatar-text {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--border, #dcdfe6);
  color: var(--text-strong, #303133);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex: 0 0 auto;
}

.notif-body {
  flex: 1 1 auto;
  min-width: 0;
}

.notif-text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text, #303133);
  word-break: break-word;
}

.notif-time {
  font-size: 12px;
  color: var(--text-muted, #909399);
  margin-top: 2px;
}

.unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-color-primary, #409eff);
  flex: 0 0 auto;
  margin-top: 6px;
}
</style>
