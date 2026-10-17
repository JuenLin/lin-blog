<template>
  <!-- 第 5 批：管理后台壳。左侧导航 + 右侧子视图，模式与 Settings.vue 相同
       （侧栏只有一份，加第五个管理项只改这里一处）。
       进入权限在 router 的 beforeEnter 守卫：非 ADMIN 直接重定向回首页，
       组件内部不再做角色判断（避免刷新时序下误判）。 -->
  <div class="admin">
    <aside class="admin-side">
      <h1 class="admin-title">管理后台</h1>

      <nav class="admin-nav">
        <!-- 用 name 跳转；高亮交给 router-link-active（同 Settings.vue 的做法）。 -->
        <router-link class="admin-link" :to="{ name: 'admin-stats' }">数据概览</router-link>
        <router-link class="admin-link" :to="{ name: 'admin-users' }">用户管理</router-link>
        <router-link class="admin-link" :to="{ name: 'admin-articles' }">文章管理</router-link>
        <router-link class="admin-link" :to="{ name: 'admin-comments' }">评论管理</router-link>
      </nav>

      <router-link class="admin-back" :to="{ name: 'home' }">← 返回博客</router-link>
    </aside>

    <main class="admin-main">
      <router-view />
    </main>
  </div>
</template>

<script setup>
// 壳不做任何数据请求，也不重复实现「返回」逻辑 —— 单一职责（同 Settings.vue）。
</script>

<style scoped>
.admin {
  display: flex;
  gap: 24px;
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}

.admin-side {
  width: 180px;
  flex-shrink: 0;
}

.admin-title {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-strong);
}

.admin-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.admin-link {
  padding: 8px 12px;
  border-radius: var(--radius-panel);
  font-size: 14px;
  color: var(--text-regular);
  text-decoration: none;
  transition: background var(--transition-base), color var(--transition-base);
}

.admin-link:hover {
  background: var(--bg-subtle);
  color: var(--text-strong);
}

.admin-link.router-link-active {
  background: var(--chip-bg);
  color: var(--chip-text);
  font-weight: 600;
}

.admin-link:focus-visible {
  outline: 2px solid var(--chip-text);
  outline-offset: 2px;
}

.admin-back {
  display: inline-block;
  margin-top: 20px;
  font-size: 13px;
  color: var(--text-muted);
  text-decoration: none;
}

.admin-back:hover {
  color: var(--chip-text);
}

/* min-width: 0 —— flex 子项默认 min-width:auto，宽表格会撑破容器（Settings.vue 同款教训）。 */
.admin-main {
  flex: 1;
  min-width: 0;
}

@media (max-width: 720px) {
  .admin {
    flex-direction: column;
    gap: 16px;
  }

  .admin-side {
    width: auto;
  }

  .admin-nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
