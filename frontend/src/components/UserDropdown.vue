<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <span class="user-dropdown">
      <!-- 头像分两种形态（第九批）：有 avatar 外链渲染 <img>，否则回退色块 + 首字。
           必须用 v-if 先分出分支，不能只写 :src —— avatar 为 null 或键不存在时会破图。
           imgBroken 是 @error 回退用的：服务端只校验 URL 格式、不校验可达性，
           所以外链可能真的加载不出来（见 docs/API.md 的 PUT /api/users/me）。 -->
      <img
        v-if="avatarInfo.type === 'image' && !avatarBroken"
        class="user-avatar-img"
        :src="avatarInfo.src"
        :alt="displayName"
        @error="avatarBroken = true"
      />
      <span v-else class="user-avatar" :style="{ backgroundColor: fallbackColor }">{{ fallbackText }}</span>
      <span class="user-name">{{ displayName }}</span>
      <span class="user-caret">▾</span>
    </span>

    <template #dropdown>
      <el-dropdown-menu>
        <!-- 个人主页入口（/user/:id，纯前端跳转，不改接口）。 -->
        <el-dropdown-item v-if="myProfileId" command="profile">我的主页</el-dropdown-item>
        <!-- 第十四批 A5：原来「编辑资料」「修改密码」两个平级项合并成一个「设置」，
             点进去是 /settings（默认显示编辑资料），由左侧导航在两项间切换。
             两项都还在，只是从「菜单里选一个」变成「进设置页再选」，
             将来加第三个设置项时菜单不再变长。 -->
        <el-dropdown-item command="settings">设置</el-dropdown-item>
        <!-- 第 5 批验收补：管理员专属入口，仅 ADMIN 可见（userStore.user.role === 'ADMIN'）。
             放在「设置」与「退出登录」之间，点击跳 /admin。普通用户（role=USER）不渲染此项。 -->
        <el-dropdown-item v-if="isAdmin" command="admin">管理后台</el-dropdown-item>
        <el-dropdown-item command="logout">退出登录</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import { getAvatarColor, getAvatarText, resolveAvatar } from '../utils/format.js';

const router = useRouter();
const userStore = useUserStore();

const displayName = computed(() => {
  if (!userStore.user) {
    return '我';
  }

  return userStore.user.nickname || userStore.user.username || '我';
});

// 头像形态由 resolveAvatar 统一决定：有 avatar 外链走 <img>，否则色块 + 首字。
// 这里存的是 userStore.user（含 avatar 字段）。
const avatarInfo = computed(() => resolveAvatar(userStore.user, displayName.value));
const fallbackText = computed(() => getAvatarText(displayName.value));
const fallbackColor = computed(() => getAvatarColor(displayName.value));

// 外链图片加载失败（404 / 防盗链 / 网络问题）时回退到色块 + 首字。
// 服务端只校验 URL 以 http/https 开头，**不保证图片真实存在**（docs/API.md 有说明），
// 所以这个回退不是兜底而是常态路径之一。
// 关键：avatar 变化时必须复位，否则换头像后仍会显示上一次的失败状态。
const avatarBroken = ref(false);

watch(
  () => (userStore.user ? userStore.user.avatar : null),
  () => {
    avatarBroken.value = false;
  },
);

// 当前登录用户 id：user 可能为 null（未登录 / fetchMe 还没回来），此时不显示「我的主页」，
// 避免拼出 /user/undefined 这种死链。
const myProfileId = computed(() => (userStore.user && userStore.user.id) || null);

// 管理员专属入口（第 5 批验收补）：仅 ADMIN 角色可见。
// 与后端 requireAdmin 守卫同源判断（role 实时来自 userStore.user，后端每次请求也实时查库），
// JWT 不缓存 role，所以这里用 store 里的实时 role，不读 localStorage / token 解析。
const isAdmin = computed(() => (userStore.user && userStore.user.role) === 'ADMIN');

// 登出是纯前端清理：契约第 5 节没有 /api/auth/logout，后端也没这个路由，
// 不新增接口，只清 Pinia 与 localStorage 并回首页。
function handleCommand(command) {
  if (command === 'profile' && myProfileId.value) {
    router.push({ name: 'user-profile', params: { id: myProfileId.value } });
    return;
  }

  // 第十四批 A5：走 /settings 壳，由 redirect 落到「编辑资料」子页。
  // 整个下拉菜单只在登录态渲染（AppHeader 的 v-if），所以直接推即可；
  // 真要手工兜一道，路由的 meta.requiresAuth 也会把未登录者弹去登录页。
  if (command === 'settings') {
    router.push({ name: 'settings' });
    return;
  }

  // 第 5 批验收补：管理员专属入口，跳 /admin（路由名 'admin'，带 requireAdmin 守卫）。
  if (command === 'admin') {
    router.push({ name: 'admin' });
    return;
  }

  if (command === 'logout') {
    userStore.logout();
    router.push({ name: 'home' });
  }
}
</script>

<style scoped>
/* 顶栏右上角的用户入口。第十四批补了三种状态的视觉反馈：
   hover / 菜单展开 / 键盘焦点 —— 改之前这三者都没有，鼠标移上去、
   点开菜单，用户名和倒三角都纹丝不动，看不出这是个能点的控件。
   全部走 style.css 的令牌（--chip-bg / --chip-text 浅暗各一套），不写死色值。 */
.user-dropdown {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  /* 底块只做视觉、不占布局：padding 撑出可点区域，再用等量负 margin 抵消，
     外边距盒尺寸与改前一致 —— 顶栏三个子元素的 x / w / 垂直中心都不变
     （改后实测过：见本次提交的验收记录）。 */
  padding: 6px 10px;
  margin: -6px -10px;
  border-radius: var(--radius-panel);
  cursor: pointer;
  outline: none;
  transition: background var(--transition-base), color var(--transition-base);
}

/* hover 与「菜单已展开」给同一套高亮，让用户知道菜单现在是开着的。
   aria-expanded 由 Element Plus 自己维护（收起 false / 展开 true），
   挂在它上面就能拿到展开态，template 与 script 一行都不用改。
   注意菜单面板是 teleport 到 body 的，不是本元素的兄弟或后代，
   所以除 aria-expanded 外没有别的纯 CSS 办法能选中展开态。 */
.user-dropdown:hover,
.user-dropdown[aria-expanded='true'] {
  background: var(--chip-bg);
}

.user-dropdown:hover .user-name,
.user-dropdown[aria-expanded='true'] .user-name,
.user-dropdown:hover .user-caret,
.user-dropdown[aria-expanded='true'] .user-caret {
  color: var(--chip-text);
}

/* 键盘焦点：上面为了鼠标点击不出描边写了 outline: none，
   这里必须补回来 —— 否则 Tab 到这个下拉时完全看不出焦点落在哪（既有缺陷）。 */
.user-dropdown:focus-visible {
  outline: 2px solid var(--chip-text);
  outline-offset: 3px;
}

/* 色块头像（无 avatar 时的回退形态） */
.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 14px;
  font-weight: 600;
}

/* 图片头像（第九批）：尺寸、圆角与色块保持一致，object-fit: cover 防拉伸变形 */
.user-avatar-img {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
}

.user-name {
  font-size: 14px;
  color: var(--text-strong);
  /* 与底块同步过渡，深浅两色都走 --transition-base（全站统一 200ms） */
  transition: color var(--transition-base);
}

.user-caret {
  font-size: 12px;
  color: var(--text-muted);
  transition: color var(--transition-base);
}
</style>
