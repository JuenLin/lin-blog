<template>
  <!-- 第 12 批：举报管理。status 筛选 + targetPreview 快照（软删降级「内容已删除」）；
       处理是后端单事务（RESOLVED+deleteTarget 联动软删目标并闭环该目标全部 PENDING），
       前端只发一次调用，不做「先删内容再改状态」的编排（防坑 2）。 -->
  <div class="admin-reports">
    <h2 class="admin-page-title">举报管理</h2>

    <div class="admin-toolbar">
      <el-select v-model="statusFilter" placeholder="处理状态" clearable class="admin-toolbar-status" @change="handleSearch">
        <el-option label="待处理" value="PENDING" />
        <el-option label="已处理（违规成立）" value="RESOLVED" />
        <el-option label="已忽略（未违规）" value="REJECTED" />
      </el-select>
      <el-button type="primary" @click="handleSearch">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="list" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column label="类型" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="row.targetType === 'ARTICLE' ? 'primary' : 'warning'">
            {{ row.targetType === 'ARTICLE' ? '文章' : '评论' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="被举报内容" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'admin-deleted-text': row.targetPreview.deleted }">
            {{ row.targetPreview.title || '内容已删除' }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="内容作者" min-width="110">
        <template #default="{ row }">{{ row.targetPreview.authorName || '—' }}</template>
      </el-table-column>
      <el-table-column label="举报人" min-width="110">
        <template #default="{ row }">{{ row.reporter?.nickname || row.reporter?.username || '—' }}</template>
      </el-table-column>
      <el-table-column label="理由" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.reason || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="举报时间" min-width="150">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="处理时间" min-width="150">
        <template #default="{ row }">{{ formatTime(row.resolvedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'PENDING'">
            <el-button size="small" @click="handleReject(row)">忽略</el-button>
            <el-button type="danger" size="small" @click="handleResolve(row)">
              {{ row.targetPreview.deleted ? '标记违规已处理' : '删除违规内容并处理' }}
            </el-button>
          </template>
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
import { listAdminReports, resolveAdminReport } from '../api/report.js';

// 与 AdminComments 同骨架（表格 + 筛选 + 分页）。差异点：
//   - 「忽略」= REJECTED（核实未违规），不动目标内容；
//   - 「删除违规内容并处理」= RESOLVED + deleteTarget:true，后端单事务联动软删
//     （评论会级联子评论）并把该目标全部 PENDING 举报批转 RESOLVED；
//     目标已被作者先行软删时后端幂等跳过软删（targetDeleted=false），按钮文案相应换成
//     「标记违规已处理」，管理员不用关心目标是否还在。
const loading = ref(false);
const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const statusFilter = ref('');

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(status) {
  if (status === 'PENDING') return '待处理';
  if (status === 'RESOLVED') return '已处理';
  return '已忽略';
}

function statusTagType(status) {
  if (status === 'PENDING') return 'warning';
  if (status === 'RESOLVED') return 'danger';
  return 'info';
}

async function load() {
  loading.value = true;

  try {
    const data = await listAdminReports({
      page: page.value,
      pageSize: pageSize.value,
      status: statusFilter.value || undefined,
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    ElMessage.error(error.message || '加载举报列表失败');
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  page.value = 1;
  load();
}

async function handleReject(row) {
  try {
    await ElMessageBox.confirm('确定忽略这条举报吗？（核实为未违规，目标内容不受影响）', '忽略举报', {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  try {
    await resolveAdminReport(row.id, { status: 'REJECTED' });

    ElMessage.success('已忽略');
    await load();
  } catch (error) {
    ElMessage.error(error.message || '处理失败');
  }
}

async function handleResolve(row) {
  const targetGone = row.targetPreview.deleted;
  const tip = targetGone
    ? '该内容已被删除，将只把相关举报标记为已处理。'
    : '将删除该违规内容（评论会连带其子评论），并把针对它的所有待处理举报一并闭环。';
  const action = targetGone ? '标记违规已处理' : '删除违规内容并处理';

  try {
    await ElMessageBox.confirm(tip, action, {
      type: 'warning',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  try {
    const data = await resolveAdminReport(row.id, { status: 'RESOLVED', deleteTarget: true });

    ElMessage.success(
      data.targetDeleted ? `已删除违规内容，闭环 ${data.resolvedCount} 条举报` : `内容此前已删除，闭环 ${data.resolvedCount} 条举报`
    );
    await load();
  } catch (error) {
    ElMessage.error(error.message || '处理失败');
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

.admin-toolbar-status {
  width: 200px;
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
