<template>
  <!-- 第 5 批：文章管理。默认含软删（管理页职责），deleted 可筛选；
       删除是软删、无视作者权限。 -->
  <div class="admin-articles">
    <h2 class="admin-page-title">文章管理</h2>

    <div class="admin-toolbar">
      <el-input
        v-model="keyword"
        class="admin-toolbar-keyword"
        placeholder="搜索标题 / 正文"
        clearable
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select v-model="deletedFilter" placeholder="删除状态" clearable class="admin-toolbar-status" @change="handleSearch">
        <el-option label="未删除" value="false" />
        <el-option label="已删除" value="true" />
      </el-select>
      <el-button type="primary" @click="handleSearch">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="list" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column label="标题" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'admin-deleted-text': row.deletedAt }">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column label="作者" min-width="120">
        <template #default="{ row }">
          <span class="admin-author-cell">
            <UserBadge :role="row.author?.role" />
            {{ row.author?.nickname || row.author?.username || '—' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="likeCount" label="点赞" width="70" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.deletedAt ? 'info' : 'success'" size="small">
            {{ row.deletedAt ? '已删除' : '正常' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="发布时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button v-if="!row.deletedAt" type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          <span v-else class="admin-op-disabled">—</span>
        </template>
      </el-table-column>
    </el-table>

    <div class="admin-pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="load"
        @size-change="load"
      />
    </div>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listAdminArticles, deleteAdminArticle } from '../api/admin.js';
import UserBadge from '../components/UserBadge.vue';

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');
const deletedFilter = ref('');

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load() {
  loading.value = true;

  try {
    const data = await listAdminArticles({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value || undefined,
      deleted: deletedFilter.value || undefined,
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    ElMessage.error(error.message || '加载文章列表失败');
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  page.value = 1;
  load();
}

async function handleDelete(row) {
  try {
    await ElMessageBox.confirm(`确定要删除文章「${row.title}」吗？删除后公开页面不可见（软删）。`, '删除文章', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  try {
    await deleteAdminArticle(row.id);

    ElMessage.success('已删除');
    await load();
  } catch (error) {
    ElMessage.error(error.message || '删除失败');
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

.admin-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.admin-toolbar-keyword {
  width: 240px;
}

.admin-toolbar-status {
  width: 140px;
}

.admin-author-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.admin-deleted-text {
  color: var(--text-muted);
  text-decoration: line-through;
}

.admin-op-disabled {
  font-size: 13px;
  color: var(--text-muted);
}

.admin-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
