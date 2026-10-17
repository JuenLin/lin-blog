<template>
  <!-- 第 5 批：数据概览。6 个实时 COUNT（GET /api/admin/stats），
       全部来自一个接口，不再各自发列表数行数。 -->
  <div class="admin-stats" v-loading="loading">
    <h2 class="admin-page-title">数据概览</h2>

    <div class="admin-stats-grid">
      <el-card v-for="item in cards" :key="item.key" class="admin-stat-card" shadow="never">
        <div class="admin-stat-label">{{ item.label }}</div>
        <div class="admin-stat-value">{{ item.value }}</div>
        <div class="admin-stat-hint">{{ item.hint }}</div>
      </el-card>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { getAdminStats } from '../api/admin.js';

const loading = ref(false);
const stats = ref(null);

// deletedArticles 单独一张卡并注明口径：它是「已软删」文章数，
// 与 articles（未软删）是两个数，别混。
const cards = ref([]);

function renderCards(data) {
  cards.value = [
    { key: 'users', label: '用户数', value: data.users, hint: '未软删用户' },
    { key: 'articles', label: '文章数', value: data.articles, hint: '未软删文章' },
    { key: 'comments', label: '评论数', value: data.comments, hint: '未软删评论' },
    { key: 'likes', label: '点赞数', value: data.likes, hint: 'likes 表全量' },
    { key: 'follows', label: '关注数', value: data.follows, hint: 'follows 表全量' },
    { key: 'deletedArticles', label: '已删文章', value: data.deletedArticles, hint: '已软删，仅管理端可见' },
  ];
}

async function load() {
  loading.value = true;

  try {
    const data = await getAdminStats();

    stats.value = data;
    renderCards(data);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.admin-page-title {
  margin: 0 0 16px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

.admin-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 16px;
}

.admin-stat-label {
  font-size: 13px;
  color: var(--text-regular);
}

.admin-stat-value {
  margin: 6px 0 2px;
  font-size: 28px;
  font-weight: 700;
  color: var(--text-strong);
  font-variant-numeric: tabular-nums;
}

.admin-stat-hint {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
