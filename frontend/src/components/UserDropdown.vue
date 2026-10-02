<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <span class="user-dropdown">
      <span class="user-avatar" :style="{ backgroundColor: avatarColor }">{{ avatarText }}</span>
      <span class="user-name">{{ displayName }}</span>
      <span class="user-caret">▾</span>
    </span>

    <template #dropdown>
      <el-dropdown-menu>
        <!-- 本期只有退出登录：/user/:id 个人主页与 /settings 设置页已确认延后，
             后端也没有对应接口，先不占位。以后加菜单项只改这里，不用动 AppHeader。 -->
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

// 登出是纯前端清理：契约第 5 节没有 /api/auth/logout，后端也没这个路由，
// 不新增接口，只清 Pinia 与 localStorage 并回首页。
function handleCommand(command) {
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
