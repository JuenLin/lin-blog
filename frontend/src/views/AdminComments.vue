<template>
  <!-- 第 5 批：评论管理。默认含软删，deleted 可筛选；删除是软删、
       无视作者权限（公开接口的「评论作者 ∨ 文章作者」规则不适用）。
       articleTitle 让管理端知道评论归属哪篇文章。 -->
  <div class="admin-comments">
    <h2 class="admin-page-title">评论管理</h2>

    <div class="admin-toolbar">
      <el-input
        v-model="keyword"
        class="admin-toolbar-keyword"
        placeholder="搜索评论内容"
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
      <el-table-column label="内容" min-width="260" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'admin-deleted-text': row.deletedAt }">{{ row.content }}</span>
        </template>
      </el-table-column>
      <el-table-column label="作者" min-width="120">
        <template #default="{ row }">
          <span class="admin-author-cell">
            <UserBadge :role="row.author?.role" />
            {{ row.author?.nickname || row.author?.username || '匿名' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="所属文章" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">{{ row.articleTitle || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.deletedAt ? 'info' : 'success'" size="small">
            {{ row.deletedAt ? '已删除' : '正常' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" min-width="170">
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
import { listAdminComments, deleteAdminComment } from '../api/admin.js';
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
    const data = await listAdminComments({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value || undefined,
      deleted: deletedFilter.value || undefined,
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    ElMessage.error(error.message || '加载评论列表失败');
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
    await ElMessageBox.confirm('确定要删除这条评论吗？删除后公开页面不可见（软删）。', '删除评论', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  try {
    await deleteAdminComment(row.id);

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
