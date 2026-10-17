<template>
  <!-- 第 5 批：用户管理。列表 + keyword 搜索 + status 筛选 + 封禁/解禁。
       一刀切防呆：role === 'ADMIN' 的行禁用操作按钮（后端同样拦，
       这里是体验层提前挡，避免用户点了才吃 400）。 -->
  <div class="admin-users">
    <h2 class="admin-page-title">用户管理</h2>

    <div class="admin-toolbar">
      <el-input
        v-model="keyword"
        class="admin-toolbar-keyword"
        placeholder="搜索用户名 / 昵称"
        clearable
        @keyup.enter="handleSearch"
        @clear="handleSearch"
      />
      <el-select v-model="statusFilter" placeholder="状态" clearable class="admin-toolbar-status" @change="handleSearch">
        <el-option label="正常" value="ACTIVE" />
        <el-option label="已封禁" value="BANNED" />
      </el-select>
      <el-button type="primary" @click="handleSearch">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="list" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="username" label="用户名" min-width="140" />
      <el-table-column label="昵称" min-width="120">
        <template #default="{ row }">{{ row.nickname || '—' }}</template>
      </el-table-column>
      <el-table-column label="角色" width="100">
        <template #default="{ row }">
          <UserBadge :role="row.role" />
          <span v-if="row.role !== 'ADMIN'" class="admin-role-plain">用户</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'danger'" size="small">
            {{ row.status === 'ACTIVE' ? '正常' : '已封禁' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="注册时间" min-width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <!-- ADMIN 行禁用：不能封禁或解禁管理员账号（后端 40000，这里提前挡）。 -->
          <el-button
            v-if="row.role !== 'ADMIN'"
            :type="row.status === 'ACTIVE' ? 'danger' : 'success'"
            size="small"
            @click="handleToggleStatus(row)"
          >
            {{ row.status === 'ACTIVE' ? '封禁' : '解禁' }}
          </el-button>
          <span v-else class="admin-op-disabled">不可操作</span>
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
import { listAdminUsers, updateUserStatus } from '../api/admin.js';
import UserBadge from '../components/UserBadge.vue';

const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');
const statusFilter = ref('');

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function load() {
  loading.value = true;

  try {
    const data = await listAdminUsers({
      page: page.value,
      pageSize: pageSize.value,
      keyword: keyword.value || undefined,
      status: statusFilter.value || undefined,
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    ElMessage.error(error.message || '加载用户列表失败');
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  page.value = 1;
  load();
}

async function handleToggleStatus(row) {
  const next = row.status === 'ACTIVE' ? 'BANNED' : 'ACTIVE';
  const action = next === 'BANNED' ? '封禁' : '解禁';

  try {
    await ElMessageBox.confirm(`确定要${action}用户「${row.nickname || row.username}」吗？`, action, {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户取消
  }

  try {
    await updateUserStatus(row.id, next);

    ElMessage.success(`已${action}`);
    await load();
  } catch (error) {
    ElMessage.error(error.message || `${action}失败`);
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

.admin-role-plain {
  font-size: 13px;
  color: var(--text-regular);
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
