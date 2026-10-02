<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <span class="user-dropdown">
      <span class="user-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>
      <span class="user-name">{{ displayName }}</span>
      <span class="user-caret">▾</span>
    </span>

    <template #dropdown>
      <el-dropdown-menu>
        <!-- 个人主页入口（/user/:id，纯前端跳转，不改接口）。
             /settings 设置页仍未做，所以不放「编辑个人资料」；关注功能也没做，不放「关注」——
             宁可少一项，也不给点了没反应的死按钮。 -->
        <el-dropdown-item v-if="myProfileId" command="profile">我的主页</el-dropdown-item>
        <el-dropdown-item command="logout">退出登录</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import { getAvatarColor, getAvatarText } from '../utils/format.js';

const router = useRouter();
const userStore = useUserStore();

const displayName = computed(() => {
  if (!userStore.user) {
    return '我';
  }

  return userStore.user.nickname || userStore.user.username || '我';
});

const avatarText = computed(() => getAvatarText(displayName.value));
const avatarColor = computed(() => getAvatarColor(displayName.value));

// 当前登录用户 id：user 可能为 null（未登录 / fetchMe 还没回来），此时不显示「我的主页」，
// 避免拼出 /user/undefined 这种死链。
const myProfileId = computed(() => (userStore.user && userStore.user.id) || null);

// 登出是纯前端清理：契约第 5 节没有 /api/auth/logout，后端也没这个路由，
// 不新增接口，只清 Pinia 与 localStorage 并回首页。
function handleCommand(command) {
  if (command === 'profile' && myProfileId.value) {
    router.push({ name: 'user-profile', params: { id: myProfileId.value } });
    return;
  }

  if (command === 'logout') {
    userStore.logout();
    router.push({ name: 'home' });
  }
}
</script>

<style scoped>
.user-dropdown {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
}

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

.user-name {
  font-size: 14px;
  color: var(--text-strong);
}

.user-caret {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
