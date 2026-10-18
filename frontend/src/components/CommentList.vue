<template>
  <div class="comment-list">
    <h3 class="comment-title">评论 {{ total }}</h3>

    <!-- B1：骨架屏贴形 —— 按「头像 + 昵称/时间 + 一行正文」的评论结构画，跟真实评论同高。
         B2：骨架只在首次出现；翻页 / 发表后刷新时保留旧评论。 -->
    <el-skeleton v-if="loading && !initialized" animated>
      <template #template>
        <div v-for="i in 3" :key="i" class="comment-item">
          <div class="sk-row">
            <div class="el-skeleton__item sk-avatar"></div>
            <div class="el-skeleton__item sk-line" style="width: 88px"></div>
            <div class="el-skeleton__item sk-line" style="width: 68px"></div>
          </div>
          <div class="el-skeleton__item sk-line" style="width: 64%; margin-top: 10px"></div>
        </div>
      </template>
    </el-skeleton>

    <template v-else>
      <EmptyState v-if="!list.length && !total" description="还没有评论，来说两句吧" />

      <template v-else>
        <!-- B2：刷新期间旧评论留在原地，变淡 + 不可交互 -->
        <div class="comment-items" :class="{ 'is-refreshing': loading }">
          <!-- 第 7 批：v-for 的数据源从扁平 list 换成组树后的 tree.roots。
               树是纯展示层概念：接口保持扁平分页（契约只增字段不改结构），
               这里按 parentId 组装两层；父评论不在当前页的回复按顶楼降级（isOrphan）。 -->
          <template v-for="item in tree.roots" :key="item.id">
            <div class="comment-item">
              <div class="comment-item-head">
                <!-- 入口：评论者头像+昵称可点进 /user/:id。评论区没有外层 router-link，
                     这里不用 @click.stop 也不会误触发跳转。author 缺失时退化为纯展示（不可点）。 -->
                <span
                  class="comment-author-link"
                  :class="{ 'is-clickable': commentAuthorId(item) != null }"
                  :role="commentAuthorId(item) != null ? 'link' : null"
                  :tabindex="commentAuthorId(item) != null ? 0 : null"
                  @click="goToProfile(commentAuthorId(item))"
                  @keydown.enter="goToProfile(commentAuthorId(item))"
                >
                  <!-- 头像两种形态（第九批）：有 avatar 站内路径渲染 <img>，否则回退色块 + 首字。
                       列表里每个作者是独立一条，所以失败状态按评论 id 记在 brokenAvatars 里，
                       不能用单个 ref ——否则一个作者的图片加载失败会让整页都显示成色块。 -->
                  <img
                    v-if="commentAvatar(item).type === 'image' && !brokenAvatars[item.id]"
                    class="comment-avatar-img"
                    :src="commentAvatar(item).src"
                    :alt="authorName(item)"
                    @error="markAvatarBroken(item)"
                  />
                  <span
                    v-else
                    class="comment-avatar"
                    :style="{ backgroundColor: commentAvatar(item).color }"
                  >
                    {{ commentAvatar(item).text }}
                  </span>
                  <span class="comment-author">
                    {{ authorName(item) }}
                    <!-- 第 5 批：管理员徽章挂在作者名旁（author.role 透出）。 -->
                    <UserBadge :role="item.author?.role" />
                  </span>
                </span>
                <!-- 方案 D：评论时间同样改相对时间（列表里绝对时间又长又占位），
                     悬停 tooltip 给绝对时间。 -->
                <el-tooltip
                  :content="formatAbsoluteTime(item.createdAt)"
                  placement="top"
                >
                  <span class="comment-time">{{ formatRelativeTime(item.createdAt) }}</span>
                </el-tooltip>
                <!-- 第 7 批：「回复」按钮。仅顶层评论显示（parentId 为 null）——
                     孤儿降级项（isOrphan）的父评论不在本页，回复它会违反两层硬限制，
                     后端会拦，前端干脆不给入口。未登录不显示（登录后 fetchMe 完成自然出现）。 -->
                <el-button
                  v-if="canReply(item)"
                  class="comment-reply-btn"
                  link
                  type="primary"
                  size="small"
                  @click="startReply(item)"
                >回复</el-button>
                <el-button
                  v-if="canDelete(item)"
                  class="comment-delete-btn"
                  link
                  type="danger"
                  size="small"
                  @click="handleDelete(item)"
                >删除</el-button>
              </div>

              <!-- 第 7 批：孤儿降级前缀 —— 父评论不在当前页（分页拆树），靠后端给的
                   replyToAuthor 渲染「回复 @某某」，用户不会莫名其妙。 -->
              <div class="comment-content">
                <span v-if="item.isOrphan" class="comment-reply-prefix">回复 @{{ item.replyToAuthor }}：</span>{{ item.content }}
              </div>

              <!-- 第 7 批：子回复区（缩进）。两层硬限制下这里只会有一层，不再递归。 -->
              <div v-if="item.replies.length" class="comment-replies">
                <div v-for="reply in item.replies" :key="reply.id" class="comment-item comment-reply">
                  <div class="comment-item-head">
                    <span
                      class="comment-author-link"
                      :class="{ 'is-clickable': commentAuthorId(reply) != null }"
                      :role="commentAuthorId(reply) != null ? 'link' : null"
                      :tabindex="commentAuthorId(reply) != null ? 0 : null"
                      @click="goToProfile(commentAuthorId(reply))"
                      @keydown.enter="goToProfile(commentAuthorId(reply))"
                    >
                      <img
                        v-if="commentAvatar(reply).type === 'image' && !brokenAvatars[reply.id]"
                        class="comment-avatar-img"
                        :src="commentAvatar(reply).src"
                        :alt="authorName(reply)"
                        @error="markAvatarBroken(reply)"
                      />
                      <span
                        v-else
                        class="comment-avatar"
                        :style="{ backgroundColor: commentAvatar(reply).color }"
                      >
                        {{ commentAvatar(reply).text }}
                      </span>
                      <span class="comment-author">
                        {{ authorName(reply) }}
                        <UserBadge :role="reply.author?.role" />
                      </span>
                    </span>
                    <el-tooltip :content="formatAbsoluteTime(reply.createdAt)" placement="top">
                      <span class="comment-time">{{ formatRelativeTime(reply.createdAt) }}</span>
                    </el-tooltip>
                    <el-button
                      v-if="canDelete(reply)"
                      class="comment-delete-btn"
                      link
                      type="danger"
                      size="small"
                      @click="handleDelete(reply)"
                    >删除</el-button>
                  </div>
                  <div class="comment-content">{{ reply.content }}</div>
                </div>
              </div>

              <!-- 第 7 批：回复输入框（行内展开，不弹窗）。只挂在被点击回复的顶层评论下；
                   成功后回第一页（与顶层评论发表后的 reload 行为一致）。 -->
              <div v-if="replyTargetId === item.id" class="comment-reply-editor">
                <el-input
                  ref="replyInput"
                  v-model="replyDraft"
                  type="textarea"
                  :rows="2"
                  maxlength="500"
                  show-word-limit
                  :placeholder="`回复 @${authorName(item)}（1–500 字）`"
                />
                <div class="comment-reply-editor-foot">
                  <el-button type="primary" size="small" :loading="replySubmitting" @click="submitReply(item)">回复</el-button>
                  <el-button size="small" @click="cancelReply">取消</el-button>
                </div>
              </div>
            </div>
          </template>
        </div>

        <Pagination
          v-if="total > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="total"
          @change="handlePageChange"
        />
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { listComments, deleteComment, createComment } from '../api/comment.js';
import { useUserStore } from '../stores/user.js';
import { ElMessage, ElMessageBox } from 'element-plus';
import { formatAbsoluteTime, formatRelativeTime, resolveAvatar } from '../utils/format.js';
import EmptyState from './EmptyState.vue';
import Pagination from './Pagination.vue';
import UserBadge from './UserBadge.vue';

const props = defineProps({
  articleId: {
    type: Number,
    required: true,
  },
  // B1：文章作者 id 由父组件（ArticleDetail）传入，用于「文章作者也能删评论」的权限判定。
  // 不在此组件内自查文章，避免与详情页重复请求（详情页已拉过 article）。
  articleAuthorId: {
    type: Number,
    default: null,
  },
});

const router = useRouter();
const userStore = useUserStore();

const list = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

// B2：区分「首次加载」和「刷新」—— 骨架屏只在首次出现。
const initialized = ref(false);

/* ---------------- 第 7 批：扁平列表 → 两层树（纯展示层组装） ---------------- */

/**
 * 按 parentId 组装两层树。接口保持扁平（契约不破坏、探针兼容），树在这里组装：
 *   - parentId 为 null → 顶楼，子回复挂 node.replies；
 *   - parentId 非空且父在本页 → 挂到父节点 replies（缩进渲染）；
 *   - parentId 非空但父**不在本页**（分页把父子拆开）→ isOrphan 降级为顶楼，
 *     模板用「回复 @replyToAuthor」前缀说明语境，不给回复按钮（再回复会违反两层限制）。
 * 扁平 list 本身按 createdAt desc 排，组树保持原有相对顺序（回复天然在父之后）。
 */
const tree = computed(() => {
  const items = list.value;
  const byId = new Map();
  const roots = [];

  for (const item of items) {
    byId.set(item.id, { ...item, replies: [], isOrphan: false });
  }

  for (const item of items) {
    const node = byId.get(item.id);

    if (item.parentId == null) {
      roots.push(node);
      continue;
    }

    const parent = byId.get(item.parentId);
    if (parent) {
      parent.replies.push(node);
    } else {
      // 父不在当前页：降级为顶楼（保序挂尾），渲染「回复 @某某」前缀。
      node.isOrphan = true;
      roots.push(node);
    }
  }

  return { roots };
});

// 入口：取评论者展示名 / id。API 保证内嵌 author（docs/API.md），
// 这里仍做空值兜底，避免 author 缺失时整页报错。
function authorName(item) {
  const a = item && item.author;
  return (a && (a.nickname || a.username)) || '匿名';
}

function commentAuthorId(item) {
  const a = item && item.author;
  return a && a.id != null ? a.id : null;
}

// 头像形态（第九批）。resolveAvatar 用 truthy 检查，**author 没有 avatar 键时**
// （探针造的对象就是这种）会自然落到 text 分支。
// image 分支返回 { src }，text 分支返回 { text, color }，模板按type 取对应字段。
function commentAvatar(item) {
  const a = item && item.author;
  const info = resolveAvatar(a, authorName(item));

  if (info.type === 'image') {
    return info;
  }

  return { type: 'text', text: info.text, color: info.color };
}

// 外链图片加载失败的记录：key 是评论 id。
// 为什么按评论 id 而不是作者 id：同一个人可能评论多条，用评论 id 粒度最简单，
// 且一条评论的图片失败不影响同作者的其他评论。
// 换页/刷新时整体清空（见 load 的 finally）。
const brokenAvatars = reactive({});

function markAvatarBroken(item) {
  brokenAvatars[item.id] = true;
}

function goToProfile(id) {
  if (id == null) return;
  router.push({ name: 'user-profile', params: { id } });
}

/* ---------------- 第 7 批：回复 ---------------- */

// 正在回复的顶层评论 id（null = 没有展开任何回复框）。
const replyTargetId = ref(null);
const replyDraft = ref('');
const replySubmitting = ref(false);
// 行内回复输入框的组件 ref（同一时刻最多只有一个回复框展开，单 ref 安全）。
const replyInput = ref(null);

// 回复权限：已登录 + 顶层评论（parentId 为 null）。
// 孤儿降级项（isOrphan）parentId 非空，天然被排除 —— 两层硬限制的前端表达。
function canReply(item) {
  return userStore.isLogin && item.parentId == null;
}

function startReply(item) {
  replyTargetId.value = item.id;
  replyDraft.value = '';
  // 瑕疵修复：展开后自动聚焦，省掉「再点一下输入框」的那一步。
  // nextTick 等 v-if 的输入框真正挂载后再取 ref；ElInput 暴露 focus() 方法。
  // 草稿为空，聚焦后光标天然落在最前面（placeholder 不占光标位）。
  // focus 后顺手把 textarea 滚进可视区：移动端键盘弹起时输入框贴着可视区，不被遮挡。
  // 注意：ref 挂在 v-for 作用域内的组件上，Vue 3 会把它收成数组——取 [0] 归一化，
  // 否则 replyInput.value.focus 不是函数，会被下面的类型守卫静默跳过（光标不进来）。
  nextTick(() => {
    const raw = replyInput.value;
    const input = Array.isArray(raw) ? raw[0] : raw;
    if (!input || typeof input.focus !== 'function') return;
    input.focus();
    const textarea = input.textarea;
    if (textarea && typeof textarea.scrollIntoView === 'function') {
      textarea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

function cancelReply() {
  replyTargetId.value = null;
  replyDraft.value = '';
}

// 提交回复：parentId 指向被回复的顶层评论。成功后回第一页 reload
//（与顶层评论发表后的行为一致 —— 新回复出现在树上，用户能在第一页找到）。
async function submitReply(item) {
  const content = replyDraft.value.trim();

  if (!content) {
    ElMessage.warning('回复内容不能为空');
    return;
  }

  replySubmitting.value = true;
  try {
    await createComment({
      articleId: props.articleId,
      content,
      parentId: item.id,
    });
    ElMessage.success('回复成功');
    cancelReply();
    reload();
  } catch (error) {
    // 错误提示由 request.js 拦截器统一抛出（含 40000 两层限制等）。
  } finally {
    replySubmitting.value = false;
  }
}

// 删除权限：评论作者本人，或文章作者（文章未软删时）。
// 注意先判 !me 返回 false —— 登录后刷新页面时 fetchMe() 异步，user 在其返回前是 null，
// 此时删除按钮短暂不显示，属可接受行为（用户感知不到），等 fetchMe 完成按钮自然出现，非 bug。
function canDelete(item) {
  const me = userStore.user;
  if (!me) return false;
  if (item.author?.id === me.id) return true;                                  // 评论作者
  if (props.articleAuthorId != null && props.articleAuthorId === me.id) return true; // 文章作者
  return false;
}

// 二次确认 + 删除。
// 直接 await deleteComment：request.js 拦截器约定 code !== 0 抛 Error（走外层 catch 统一提示），
// 成功时 res 即 data（此处为 null），故不判 code（判 res.code 会访问 null.code 抛 TypeError 被吞）。
// 等删除响应成功后才动本地 state（正常更新，非乐观更新），不重拉列表（避免非首页删除弹回第一页）。
//
// 第 7 批树化更新：删除顶层评论时后端同事务级联软删其全部子评论，
// 前端把「本页内可见的子回复」一并移除、total 减去相同数量（后端口径与前端一致，
// docs/API.md DELETE /api/comments/:id 的「级联软删」小节）；删回复只减 1。
async function handleDelete(item) {
  try {
    await ElMessageBox.confirm('删除后评论将不再可见，确认删除？', '提示', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return; // 用户点取消
  }
  try {
    await deleteComment(item.id);

    const isRoot = item.parentId == null;
    // 本页内该评论的直接子回复数（两层硬限制：只可能有直接子级）。
    const removedReplies = isRoot
      ? list.value.filter((c) => c.parentId === item.id).length
      : 0;

    list.value = list.value.filter(
      (c) => c.id !== item.id && c.parentId !== item.id
    );
    total.value = Math.max(0, total.value - 1 - removedReplies);
  } catch (error) {
    // 错误提示由 request.js 的拦截器统一抛出；取消以外的异常也走这里，无需额外处理。
  }
}

async function load() {
  loading.value = true;

  try {
    const data = await listComments(props.articleId, {
      page: page.value,
      pageSize: pageSize.value,
      // 评论 sortBy 白名单只有 createdAt / id（docs/API.md），默认 createdAt desc。
      sortBy: 'createdAt',
      order: 'desc',
    });

    list.value = data.list;
    total.value = data.total;
  } catch (error) {
    // 错误提示由 request.js 的拦截器统一抛出。
    // B2：刷新失败时保留旧评论，不清空（同 Home.vue 的处理）。
  } finally {
    loading.value = false;
    initialized.value = true;
    // 换页/ 刷新后重置图片失败记录：新一页的头像重新尝试加载。
    // 不清的话，翻到下一页若有个别头像加载失败，会永久停留在色块形态。
    Object.keys(brokenAvatars).forEach((key) => {
      delete brokenAvatars[key];
    });
    // 换页 / 刷新后收起回复框（被回复对象可能已不在当前页）。
    cancelReply();
  }
}

// 严格遵守 Pagination.vue 的约定：只在 @change 里发请求，不 watch 分页状态。
function handlePageChange({ page: nextPage, pageSize: nextPageSize }) {
  page.value = nextPage;
  pageSize.value = nextPageSize;
  load();
}

onMounted(load);

// 发表评论后由详情页调用，重新拉第一页。
defineExpose({
  reload() {
    page.value = 1;
    load();
  },
});
</script>

<style scoped>
.comment-list {
  text-align: left;
}

.comment-title {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-strong);
}

.comment-item {
  padding: 14px 0;
  border-bottom: 1px solid var(--border-light);
}

/* 评论列表最后一条不画分隔线（同第一批 A2 的思路：列表末尾不留悬空线条）。
   注意：B2 把评论整体包进了 .comment-items，所以「最后一条」现在真的是最后一个 div ——
   之前 Pagination 和评论是同级，:last-of-type 命中的是分页条，这条规则其实没生效。 */
.comment-item:last-of-type {
  border-bottom: none;
}

/* B2：刷新中的旧评论，变淡 + 不可交互 */
.comment-items {
  transition: opacity var(--transition-base);
}

.comment-items.is-refreshing {
  opacity: 0.5;
  pointer-events: none;
}

.comment-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

/* 入口：评论者头像+昵称整体可点。只有 is-clickable（拿到 author.id）才给可点反馈，
   避免「看着能点却点了没反应」。 */
.comment-author-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: var(--chip-radius);
}

.comment-author-link.is-clickable {
  cursor: pointer;
  transition: background var(--transition-base);
}

.comment-author-link.is-clickable:hover,
.comment-author-link.is-clickable:focus-visible {
  background: rgba(var(--brand-rgb), 0.1);
  outline: none;
}

.comment-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-brand);
  font-size: 12px;
  font-weight: 600;
}

/* 图片头像（第九批）：与色块同尺寸，object-fit: cover 防变形 */
.comment-avatar-img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
}

.comment-author {
  font-size: 13px;
  color: var(--text-regular);
}

.comment-time {
  font-size: 12px;
  color: var(--text-muted);
  cursor: help; /* 方案 D：走 tooltip 看绝对时间 */
}

/* 删除按钮贴 .comment-item-head 行尾（head 是 flex，margin-left:auto 推右）。
   第 7 批：「回复」按钮也推右（margin-left:auto），「删除」跟在它后面——
   两个按钮成组贴尾；只有删除时删除按钮自然推到行尾（回复按钮 v-if 不渲染）。 */
.comment-reply-btn {
  margin-left: auto;
}

.comment-delete-btn {
  margin-left: 0;
}

.comment-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-strong);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 第 7 批：孤儿降级前缀（「回复 @某某」），弱化色避免喧宾夺主。 */
.comment-reply-prefix {
  color: var(--text-muted);
}

/* 第 7 批：子回复区。左缩进 + 竖线引导，视觉上明确「这些是上面这条的回复」。 */
.comment-replies {
  margin: 4px 0 0 32px;
  padding-left: 12px;
  border-left: 2px solid var(--border-light);
}

.comment-replies .comment-item {
  padding: 10px 0 6px;
}

.comment-replies .comment-item:last-of-type {
  border-bottom: none;
}

.comment-replies .comment-avatar,
.comment-replies .comment-avatar-img {
  width: 20px;
  height: 20px;
}

.comment-replies .comment-content {
  font-size: 13px;
}

/* 第 7 批：行内回复输入框。挂在被回复评论下方，浅底色块与正文区分。 */
.comment-reply-editor {
  margin: 10px 0 4px;
  padding: 10px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-panel);
  background: rgba(var(--brand-rgb), 0.03);
}

.comment-reply-editor-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
</style>
