<template>
  <div class="editor">
    <div class="editor-inner">
      <h1 class="editor-title">{{ isEdit ? '编辑文章' : '写文章' }}</h1>

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

          <!-- 本期正文按纯文本展示（white-space: pre-wrap），不做 Markdown 渲染，所以也没有预览区。 -->
          <el-form-item>
            <el-button type="primary" :loading="submitting" @click="handleSubmit">
              {{ isEdit ? '保存' : '发表' }}
            </el-button>
            <el-button @click="goBack">取消</el-button>
          </el-form-item>
        </el-form>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { createArticle, getArticle, updateArticle } from '../api/article.js';
import { useUserStore } from '../stores/user.js';
import EmptyState from '../components/EmptyState.vue';

const TITLE_MAX = 100;
const CONTENT_MAX = 20000;

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

// 同一个组件服务两条路由：/editor 新建，/editor/:id 编辑（契约锁定 4 个页面，不拆组件）。
const isEdit = computed(() => Boolean(route.params.id));
const articleId = computed(() => Number(route.params.id));

async function load() {
  if (!isEdit.value) {
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

    form.title = data.title;
    form.content = data.content;
    // 后端未返回 category（理论不会）时兜底成「未分类」，避免 el-select 出现空白选中项。
    form.category = data.category || '未分类';
  } catch (error) {
    ElMessage.error(error.message);
    notAllowed.value = true;
  } finally {
    loading.value = false;
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

async function handleSubmit() {
  if (!validate()) {
    return;
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

    if (isEdit.value) {
      const data = await updateArticle(articleId.value, payload);

      ElMessage.success('已保存');
      router.push({ name: 'article-detail', params: { id: data.id } });
    } else {
      const data = await createArticle(payload);

      ElMessage.success('已发表');
      router.push({ name: 'article-detail', params: { id: data.id } });
    }
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    submitting.value = false;
  }
}

function goBack() {
  if (isEdit.value) {
    router.push({ name: 'article-detail', params: { id: articleId.value } });
    return;
  }

  router.push({ name: 'home' });
}

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
</style>
