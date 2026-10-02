<template>
  <footer class="app-footer">
    <div class="app-footer-inner">
      <span>workbuddy · 博客 MVP</span>
      <span>Vue 3 + Express + Prisma + MySQL</span>
    </div>
  </footer>
</template>

<script setup>
// 纯静态页脚，不发起任何请求。
</script>

<style scoped>
.app-footer {
  margin-top: 32px;
  border-top: 1px solid var(--border);
  background: var(--bg-card);
}

.app-footer-inner {
  max-width: 1120px;
  margin: 0 auto;
  padding: 20px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
