import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import HomeView from '../views/Home.vue';
import LoginView from '../views/Login.vue';
import ArticleDetailView from '../views/ArticleDetail.vue';
import ArticleEditorView from '../views/ArticleEditor.vue';

// meta.layout 决定 App.vue 是否渲染 Header / Footer：
// - 默认（不写）：带 Header + Footer
// - 'blank'：不带，登录页用（登录页自己会居中，套 Header 会多出一块空白）
// 只认这两个值，App.vue 里的判断是 `!== 'blank'`，写错就退化成带壳布局，不会白屏。
const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: {
      layout: 'blank',
    },
  },
  {
    // 博客广场不要求登录：匿名也要能看文章列表，这是广场的意义。
    // 需要登录的入口在文章详情页的评论区与写文章按钮上，各自拦各自。
    path: '/',
    name: 'home',
    component: HomeView,
  },
  {
    path: '/article/:id',
    name: 'article-detail',
    component: ArticleDetailView,
  },
  {
    path: '/editor',
    name: 'editor-create',
    component: ArticleEditorView,
    meta: {
      requiresAuth: true,
    },
  },
  {
    // 与 /editor 共用 ArticleEditor.vue，靠 params.id 区分新建 / 编辑。
    path: '/editor/:id',
    name: 'editor-edit',
    component: ArticleEditorView,
    meta: {
      requiresAuth: true,
    },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const userStore = useUserStore();

  if (to.meta.requiresAuth && !userStore.isLogin) {
    return {
      name: 'login',
      query: {
        redirect: to.fullPath,
      },
    };
  }

  if (to.name === 'login' && userStore.isLogin) {
    return {
      name: 'home',
    };
  }

  return true;
});

export default router;
