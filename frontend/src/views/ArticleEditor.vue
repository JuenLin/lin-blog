<template>
  <div class="editor">
    <div class="editor-inner">
      <h1 class="editor-title">{{ pageTitle }}</h1>

      <!-- B1：骨架屏贴形 —— 按「标签 + 标题输入框 + 标签 + 正文大文本框 + 按钮」的真实结构画，
           编辑页加载完就填值，骨架尺寸对得上才不会抖。 -->
      <el-skeleton v-if="loading" animated>
        <template #template>
          <div class="el-skeleton__item sk-line" style="width: 56px; margin-bottom: 10px"></div>
          <div
            class="el-skeleton__item sk-line"
            style="height: 32px; border-radius: var(--radius-panel); margin-bottom: 22px"
          ></div>

          <div class="el-skeleton__item sk-line" style="width: 56px; margin-bottom: 10px"></div>
          <div
            class="el-skeleton__item sk-line"
            style="height: 356px; border-radius: var(--radius-panel); margin-bottom: 22px"
          ></div>

          <div class="sk-row">
            <div class="el-skeleton__item sk-line" style="width: 72px; height: 32px; border-radius: var(--radius-panel)"></div>
            <div class="el-skeleton__item sk-line" style="width: 72px; height: 32px; border-radius: var(--radius-panel)"></div>
          </div>
        </template>
      </el-skeleton>

      <div v-else-if="notAllowed" class="editor-forbidden">
        <EmptyState description="只有作者本人可以编辑这篇文章" />
        <div class="editor-forbidden-foot">
          <el-button @click="goBack">返回</el-button>
        </div>
      </div>

      <template v-else>
        <el-form label-position="top" @submit.prevent="handleSubmit">
          <el-form-item label="标题">
            <el-input
              v-model="form.title"
              maxlength="100"
              show-word-limit
              placeholder="请输入标题（1–100 字）"
            />
          </el-form-item>

          <el-form-item label="正文">
            <el-input
              v-model="form.content"
              type="textarea"
              :rows="16"
              maxlength="20000"
              show-word-limit
              placeholder="请输入正文（1–20000 字）"
            />
          </el-form-item>

          <el-form-item label="分类">
            <el-select v-model="form.category" placeholder="请选择分类">
              <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
            </el-select>
          </el-form-item>

          <!-- 第 6 批：自动保存状态条。四态：idle / saving / saved / error。
               idle 是「还没形成草稿」（标题空或正文 < 10 字），不显示具体时间避免误导。 -->
          <div class="autosave-bar" :class="`is-${saveState}`" data-testid="autosave-bar" role="status">
            <span class="autosave-dot" aria-hidden="true"></span>
            <span v-if="saveState === 'idle'">草稿会在输入标题和正文后自动保存</span>
            <span v-else-if="saveState === 'saving'">正在保存草稿…</span>
            <span v-else-if="saveState === 'saved'">草稿已自动保存 {{ savedAt }}</span>
            <span v-else>草稿保存失败，继续编辑时会自动重试</span>
          </div>

          <!-- 本期正文按纯文本展示（white-space: pre-wrap），不做 Markdown 渲染，所以也没有预览区。
               第 6 批双按钮：主按钮「发表/保存」走发布语义；「存草稿」立即落一次草稿（不等防抖）。 -->
          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="handleSubmit">
              {{ submitText }}
            </el-button>
            <el-button :disabled="draftSaving" @click="handleSaveDraft">存草稿</el-button>
            <el-button @click="goBack">取消</el-button>
          </el-form-item>
        </el-form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  autoSaveArticle,
  createArticle,
  deleteDraft,
  getArticle,
  listMyDrafts,
  updateArticle,
} from '../api/article.js';
import { useUserStore } from '../stores/user.js';
import EmptyState from '../components/EmptyState.vue';

const TITLE_MAX = 100;
const CONTENT_MAX = 20000;
// 自动保存防抖：停手 700ms 才发请求。太短打字过程会连发一串请求，
// 太长则关闭页面时丢字。700ms 是「打字停顿」与「请求量」的折中。
const AUTOSAVE_DELAY = 700;
// 建草稿门槛（补丁 3 第一道闸，与后端一致）：正文至少 10 个字符（按码点计）。
const IDLE_GATE_CONTENT_MIN = 10;

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

const loading = ref(false);
const notAllowed = ref(false);
const submitting = ref(false);

// 分类写死 4 个字符串（与后端 ARTICLE_CATEGORIES 一致，按用户拍板前端不抽常量文件）。
const CATEGORIES = ['技术', '生活', '随笔', '未分类'];

const form = reactive({
  title: '',
  content: '',
  category: '未分类',
});

/**
 * 第 6 批：同一组件服务三种模式。
 *   - new           /editor            从空白新建
 *   - editPublished /editor/:id 且 getArticle 成功（公开详情只可能返回 PUBLISHED，
 *                   草稿一律 404）—— 编辑已发布文章，自动保存走「独立草稿」（补丁 1）
 *   - editDraft     /editor/:id 且 getArticle 404、草稿箱里能找到 —— 编辑已有草稿
 */
const mode = ref('new');
const articleId = computed(() => (route.params.id ? Number(route.params.id) : null));

// 自动保存状态机（补丁 3）：
//   - draftId === null（idle 档）：必须 title 非空 **且** content ≥ 10 字才发「新建草稿」请求；
//     门槛不过就保持安静，一个请求都不发。
//   - draftId !== null（drafting 档）：任何内容变化（含清空到 0 字）都必须发请求，
//     不再受门槛限制 —— 保证「清空内容后保存」不丢。
const draftId = ref(null);
const saveState = ref('idle'); // idle | saving | saved | error
const savedAt = ref('');

// 防抖句柄与并发闸。
let saveTimer = null;
const draftSaving = ref(false); // 有一笔自动保存 / 手动存草稿在途
// 「上次已发送」的表单快照：防止回填赋值触发一轮多余的自动保存，
// 也让「改回已保存过的值」不再重复发请求。
let lastSentSnapshot = '';
// 回填完成标志：置 true 之前的变化一律忽略。
const hydrated = ref(false);
// 发布 / 离开进行中：此后不再触发自动保存（发布路径有自己的写请求，别混进来）。
let leaving = false;

const isEdit = computed(() => mode.value !== 'new');

const pageTitle = computed(() => {
  if (mode.value === 'editDraft') return '编辑草稿';
  return isEdit.value ? '编辑文章' : '写文章';
});

// 主按钮文案：new 与 editDraft 都是「发表」（后者是把草稿翻成已发布）；
// editPublished 是覆盖线上文章，叫「保存」。
const submitText = computed(() => (mode.value === 'editPublished' ? '保存' : '发表'));

function snapshotForm() {
  return JSON.stringify([form.title, form.content, form.category]);
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ---------------- 自动保存状态机 ---------------- */

function scheduleAutoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    runAutoSave();
  }, AUTOSAVE_DELAY);
}

/**
 * 执行一次自动保存。
 *
 * 门槛判断（补丁 3）只看「有没有 draftId」，不看模式：
 *   - 没有 draftId：title 非空且 content ≥ 10 字才发新建请求；否则保持 idle 不发。
 *   - 已有 draftId：无条件发送（title 可以清空、content 可以是 0 字）。
 */
async function runAutoSave() {
  if (leaving || draftSaving.value || notAllowed.value) return;

  if (draftId.value === null) {
    const titleOk = form.title.trim() !== '';
    const contentOk = [...form.content].length >= IDLE_GATE_CONTENT_MIN;
    if (!titleOk || !contentOk) {
      saveState.value = 'idle';
      return;
    }
  }

  const payload = {
    title: form.title,
    content: form.content,
    category: form.category,
  };
  if (draftId.value !== null) {
    payload.draftId = draftId.value;
  } else if (mode.value === 'editPublished') {
    // 补丁 1：编辑已发布文章时，第一笔自动保存带 sourceArticleId 建独立草稿，
    // 线上原文完全不受影响；该字段仅作归属校验，后端不落库。
    payload.sourceArticleId = articleId.value;
  }

  draftSaving.value = true;
  saveState.value = 'saving';

  try {
    const data = await autoSaveArticle(payload);
    lastSentSnapshot = snapshotForm();

    if (data && data.saved && data.id) {
      draftId.value = data.id;
      saveState.value = 'saved';
      savedAt.value = nowTime();
    } else {
      // 后端门槛拦截（理论到不了这里，门槛在前置判断里已挡），保持 idle。
      saveState.value = 'idle';
    }
  } catch (error) {
    saveState.value = 'error';
    // 自动保存失败不弹 ElMessage 打断打字，状态条展示错误即可；
    // 用户下一次输入会再次触发（error 档自动重试）。
  } finally {
    draftSaving.value = false;
  }
}

/** 「存草稿」按钮：取消防抖等待，立即落一次草稿。 */
async function handleSaveDraft() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  if (draftSaving.value) return;

  await runAutoSave();

  if (saveState.value === 'saved') {
    ElMessage.success('草稿已保存，可在「我的主页 · 草稿」继续编辑');
    leaving = true;
    goBack();
  } else if (saveState.value === 'idle') {
    ElMessage.warning('标题为空且正文不足 10 字，还没有形成草稿');
  } else if (saveState.value === 'error') {
    ElMessage.error('草稿保存失败，请稍后重试');
  }
}

/* ---------------- 加载与发布 ---------------- */

async function load() {
  if (!route.params.id) {
    mode.value = 'new';
    hydrated.value = true;
    lastSentSnapshot = snapshotForm();
    return;
  }

  loading.value = true;

  try {
    const data = await getArticle(route.params.id);
    const author = data.author;

    // 后端 PUT 会对非作者返回 403，这里提前拦一次，避免用户填半天才被拒。
    if (!userStore.user || !author || userStore.user.id !== author.id) {
      notAllowed.value = true;
      return;
    }

    // 公开详情只返回 PUBLISHED（草稿一律 404，坑 3），所以走到这里必然是编辑已发布文章。
    mode.value = 'editPublished';
    form.title = data.title;
    form.content = data.content;
    // 后端未返回 category（理论不会）时兜底成「未分类」，避免 el-select 出现空白选中项。
    form.category = data.category || '未分类';
  } catch (error) {
    // 404 有两种可能：文章真的不存在 / 已软删，或者它是**自己的草稿**（公开详情对
    // DRAFT 一律 404）。先查草稿箱再下结论 —— 草稿箱列表带 content 全文，直接回填。
    if (error.httpStatus === 404) {
      const found = await tryLoadDraft(route.params.id);
      if (found) return;
      ElMessage.error('文章不存在或已被删除');
    } else {
      ElMessage.error(error.message);
    }
    notAllowed.value = true;
  } finally {
    loading.value = false;
    hydrated.value = true;
    lastSentSnapshot = snapshotForm();
  }
}

/** 从草稿箱找指定 id 的草稿并回填；找到返回 true（mode 置 editDraft）。 */
async function tryLoadDraft(id) {
  try {
    // pageSize 100：草稿箱分页上限。极端情况（>100 篇草稿且目标不在第一页）
    // 会找不到 —— 草稿列表默认 updatedAt 倒序，正在编辑的草稿几乎总在第一页。
    const data = await listMyDrafts({ page: 1, pageSize: 100 });
    const draft = ((data && data.list) || []).find((d) => Number(d.id) === Number(id));

    if (!draft) return false;

    mode.value = 'editDraft';
    draftId.value = draft.id;
    form.title = draft.title || '';
    form.content = draft.content || '';
    form.category = draft.category || '未分类';
    saveState.value = 'saved';
    savedAt.value = nowTime();
    return true;
  } catch {
    // 草稿箱拉取失败（401 会由 request.js 统一处理跳登录）按找不到处理。
    return false;
  }
}

// 表单必须有基本校验（契约第 10 节）：标题非空 + 长度，正文非空 + 长度。后端还会再校验一次。
function validate() {
  const title = form.title.trim();

  if (!title) {
    ElMessage.warning('标题不能为空');
    return false;
  }

  if (title.length > TITLE_MAX) {
    ElMessage.warning(`标题最多 ${TITLE_MAX} 个字`);
    return false;
  }

  if (!form.content.trim()) {
    ElMessage.warning('正文不能为空');
    return false;
  }

  if (form.content.length > CONTENT_MAX) {
    ElMessage.warning(`正文最多 ${CONTENT_MAX} 个字`);
    return false;
  }

  return true;
}

/**
 * 发布 / 保存。三种模式的写路径（docs/API.md「编辑已发布文章的完整流程」）：
 *   - new + 已有草稿：PUT /:draftId + status=PUBLISHED（草稿翻发布，不产生快照）
 *   - new + 无草稿：POST /articles 直接发布
 *   - editDraft：PUT /:id + status=PUBLISHED（同上，草稿翻发布）
 *   - editPublished：PUT /:原id（先快照再覆盖）→ 成功后 DELETE 临时草稿
 */
async function handleSubmit() {
  if (!validate()) {
    return;
  }

  leaving = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  submitting.value = true;

  try {
    const payload = {
      title: form.title.trim(),
      // 正文不 trim：首尾空格是用户内容的一部分，后端也只对长度做校验。
      content: form.content,
      // 分类：el-select 默认已选「未分类」，省略时后端也会兜底，这里显式带上。
      category: form.category,
    };

    if (mode.value === 'editPublished') {
      // 覆盖线上文章：后端先快照当前版到 article_revisions，再更新。
      const data = await updateArticle(articleId.value, payload);

      // 补丁 1 收尾：删掉编辑过程产生的临时独立草稿（失败不阻塞发布，草稿留在
      // 草稿箱只是冗余，不是错误态）。
      if (draftId.value !== null) {
        deleteDraft(draftId.value).catch(() => {});
      }

      ElMessage.success('已保存');
      router.push({ name: 'article-detail', params: { id: data.id } });
      return;
    }

    if (mode.value === 'editDraft') {
      // 草稿翻发布：目标是 DRAFT，后端不快照（草稿本身即文章）。
      const data = await updateArticle(articleId.value, { ...payload, status: 'PUBLISHED' });

      ElMessage.success('已发表');
      router.push({ name: 'article-detail', params: { id: data.id } });
      return;
    }

    // new 模式。
    if (draftId.value !== null) {
      const data = await updateArticle(draftId.value, { ...payload, status: 'PUBLISHED' });

      ElMessage.success('已发表');
      router.push({ name: 'article-detail', params: { id: data.id } });
    } else {
      const data = await createArticle(payload);

      ElMessage.success('已发表');
      router.push({ name: 'article-detail', params: { id: data.id } });
    }
  } catch (error) {
    leaving = false;
    ElMessage.error(error.message);
  } finally {
    submitting.value = false;
  }
}

function goBack() {
  if (mode.value === 'editPublished') {
    router.push({ name: 'article-detail', params: { id: articleId.value } });
    return;
  }

  router.push({ name: 'home' });
}

// 内容变化 → 防抖自动保存。三个过滤条件：
//   1. hydrated 之前的变化是回填赋值，不是用户输入；
//   2. 与「上次已发送」快照一致的变化（改回去）不重复发；
//   3. leaving 之后（发布/存草稿跳转中）不再发。
watch(
  () => [form.title, form.content, form.category],
  () => {
    if (!hydrated.value || leaving) return;
    if (snapshotForm() === lastSentSnapshot) return;
    scheduleAutoSave();
  }
);

onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
});

onMounted(load);
</script>

<style scoped>
.editor {
  padding: 24px 16px 48px;
}

.editor-inner {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
}

.editor-title {
  margin: 0 0 20px;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-strong);
}

.editor-forbidden-foot {
  margin-top: 16px;
  text-align: center;
}

/* 第 6 批：自动保存状态条。弱化视觉（它不是主操作，是背景信息），
   只有 error 档才用警示色提醒。 */
.autosave-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -8px 0 16px;
  font-size: 12px;
  color: var(--text-faint);
}

.autosave-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border);
  flex: 0 0 auto;
}

.autosave-bar.is-saving {
  color: var(--text-muted);
}

.autosave-bar.is-saving .autosave-dot {
  background: var(--el-color-primary);
  animation: autosave-pulse 1s ease-in-out infinite;
}

.autosave-bar.is-saved {
  color: var(--text-muted);
}

.autosave-bar.is-saved .autosave-dot {
  background: var(--el-color-success);
}

.autosave-bar.is-error {
  color: var(--el-color-danger);
}

.autosave-bar.is-error .autosave-dot {
  background: var(--el-color-danger);
}

@keyframes autosave-pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.3;
  }
}
</style>
