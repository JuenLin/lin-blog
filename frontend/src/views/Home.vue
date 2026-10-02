<template>
  <div class="home">
    <div class="home-inner">
      <div class="home-head">
        <h1 class="home-title">博客广场</h1>

        <el-tabs v-model="activeTab" class="home-tabs" @tab-change="handleTabChange">
          <el-tab-pane label="最新" name="createdAt" />
          <el-tab-pane label="最近更新" name="updatedAt" />
        </el-tabs>
      </div>

      <el-skeleton v-if="loading" :rows="5" animated />

      <template v-else>
        <EmptyState v-if="!list.length" description="还没有文章，去写第一篇吧" />

        <template v-else>
          <ArticleCard v-for="item in list" :key="item.id" :article="item" />

          <Pagination
            v-model:page="page"
            v-model:page-size="pageSize"
            :total="total"
            @change="handlePageChange"
          />
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { listArticles } from '../api/article.js';
import ArticleCard from '../components/ArticleCard.vue';
import EmptyState from '../components/EmptyState.vue';
import Pagination from '../components/Pagination.vue';

// Tab 只保留「最新 / 最近更新」两个，对应 sortBy 白名单里的 createdAt / updatedAt
// （docs/API.md 的 sortBy 白名单为 createdAt / updatedAt / id，越界后端返回 40000）。
// 本期不做「热门」Tab：没有阅读量 / 点赞字段，做出来也是假的。
const activeTab = ref('createdAt');

const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

async function load() {
  loading.value = true;

  try {
    const data = await listArticles({
      page: page.value,
      pageSize: pageSize.value,
      sortBy: activeTab.value,
      order: 'desc',
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出，这里只保证列表停在空态而不是卡在 loading。
    list.value = [];
    total.value = 0;
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}

// 严格遵守 Pagination.vue 的约定：只在 @change 里发请求，不 watch 分页状态。
function handlePageChange({ page: nextPage, pageSize: nextPageSize }) {
  page.value = nextPage;
  pageSize.value = nextPageSize;
  load();
}

// 切 Tab 等于换排序，回到第一页：不重置的话第 3 页切 Tab 可能直接越界成空列表。
function handleTabChange() {
  page.value = 1;
  load();
}

onMounted(load);
</script>

<style scoped>
.home {
  padding: 24px 16px 48px;
}

.home-inner {
  max-width: 1120px;
  margin: 0 auto;
  text-align: left;
}

.home-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
}

.home-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
}

.home-tabs {
  margin-bottom: -8px;
}
</style>
