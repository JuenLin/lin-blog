<script setup>
// 列表页分页组件：封装 el-pagination，固定布局与每页条数选项。
//
// 改这个组件前先读这两条约定：
// 1. 父组件只在 @change 里发请求，不要再 watch(page) / watch(pageSize) 触发请求，
//    否则一次操作会打两遍接口。v-model:page / v-model:pageSize 只负责同步状态。
// 2. change 只在「确实需要重新请求」时 emit，不转发 el-pagination 原生 change 事件：
//    Element Plus 的 change 是个 flush:'post' 的 watcher，页码或每页条数任意一端变化
//    都会触发（含内部越界钳制），语义不可控，转发会造成意外的重复请求。
//
// 另外两点：
// - 每页条数选项写死 [10, 20, 50, 100]，上限与后端 MAX_PAGE_SIZE=100 对齐（契约 §7 / §11）。
// - 切换每页条数时把页码强置为 1。el-pagination 自身不做这件事，它只在页码越界时
//   钳到最后一页（源码 handleSizeChange），从大 pageSize 切小时会停在原页码。

const props = defineProps({
  total: {
    type: Number,
    required: true,
  },
  page: {
    type: Number,
    required: true,
  },
  pageSize: {
    type: Number,
    required: true,
  },
});

const emit = defineEmits(['update:page', 'update:pageSize', 'change']);

// 固定约定，不开放为 props：等真有页面需要改，再提成 prop。
const LAYOUT = 'total, sizes, prev, pager, next, jumper';
const PAGE_SIZES = [10, 20, 50, 100];

function emitChange(nextPage, nextPageSize) {
  emit('update:page', nextPage);
  emit('update:pageSize', nextPageSize);
  emit('change', { page: nextPage, pageSize: nextPageSize });
}

function handleCurrentChange(nextPage) {
  emitChange(nextPage, props.pageSize);
}

function handleSizeChange(nextPageSize) {
  emitChange(1, nextPageSize);
}
</script>

<template>
  <div class="pagination">
    <el-pagination
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      :layout="LAYOUT"
      :page-sizes="PAGE_SIZES"
      background
      @current-change="handleCurrentChange"
      @size-change="handleSizeChange"
    />
  </div>
</template>

<style scoped>
.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
