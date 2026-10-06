<template>
  <!-- 第十四批 A5：「账号设置」的父级壳。
       只负责左侧导航 + 右侧子视图，两个子页面（编辑资料 / 修改密码）的
       路径、name、组件全都不变，因此它们内部的逻辑一行都没动。 -->
  <div class="settings">
    <aside class="settings-side">
      <h1 class="settings-title">设置</h1>

      <nav class="settings-nav">
        <!-- 用 name 跳转，路径将来再改也不受影响。
             高亮交给 Vue Router 自带的 router-link-active / -exact-active，
             不自己算 $route.fullPath —— 手算容易漏掉带 query 的情况。 -->
        <router-link class="settings-link" :to="{ name: 'settings-profile' }">编辑资料</router-link>
        <router-link class="settings-link" :to="{ name: 'settings-password' }">修改密码</router-link>
      </nav>
    </aside>

    <main class="settings-main">
      <router-view />
    </main>
  </div>
</template>

<script setup>
// 子页面各自带 el-card 与自己的 padding，这里不做任何数据请求，
// 也不重复实现「返回」逻辑 —— 保持壳的单一职责。
</script>

<style scoped>
.settings {
  display: flex;
  gap: 24px;
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 16px 48px;
}

.settings-side {
  width: 180px;
  flex-shrink: 0;
}

.settings-title {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-strong);
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 导航项：默认弱化，hover 给浅底，当前项用主色系 chip 令牌点亮。
   与文章卡片的 chip 用同一套令牌，全站「选中态」观感一致。 */
.settings-link {
  padding: 8px 12px;
  border-radius: var(--radius-panel);
  font-size: 14px;
  color: var(--text-regular);
  text-decoration: none;
  transition: background var(--transition-base), color var(--transition-base);
}

.settings-link:hover {
  background: var(--bg-subtle);
  color: var(--text-strong);
}

.settings-link.router-link-active {
  background: var(--chip-bg);
  color: var(--chip-text);
  font-weight: 600;
}

.settings-link:focus-visible {
  outline: 2px solid var(--chip-text);
  outline-offset: 2px;
}

/* min-width: 0 —— flex 子项默认 min-width:auto，右侧的表单卡片在窄屏下会撑破容器不换行。
   （两个子页的卡片现在都是 width:100% + max-width:520px 弹性宽度，窄屏自己会收缩。） */
.settings-main {
  flex: 1;
  min-width: 0;
}

/* 窄屏：侧栏改成横向一排，纵向堆叠省出的宽度留给表单卡片。 */
@media (max-width: 720px) {
  .settings {
    flex-direction: column;
    gap: 16px;
  }

  .settings-side {
    width: auto;
  }

  .settings-nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
}
</style>
