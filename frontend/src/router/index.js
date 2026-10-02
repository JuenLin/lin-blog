import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '../stores/user.js';

// H1：路由懒加载。
// 只有 Home 是静态引入 —— 它是落地页，同步加载才能首屏直接出列表，改成异步会先白一下。
// 其余三个页面按需拉 chunk（登录页、详情页、编辑器），首屏 JS 因此变小。
// 用的是 Vue Router 原生支持的动态 import，不加任何依赖、不改任何路由配置。
import HomeView from '../views/Home.vue';

const LoginView = () => import('../views/Login.vue');
const ArticleDetailView = () => import('../views/ArticleDetail.vue');
const ArticleEditorView = () => import('../views/ArticleEditor.vue');
// 第一步 ①：个人主页，按 authorId 前端过滤现有列表，公开页不要求登录。
const UserProfileView = () => import('../views/UserProfile.vue');

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
  {
    // 个人主页（第一步 ①）：公开页，按 author.id 在前端过滤现有列表窗口。
    // 不做后端筛选（契约 §13 + API.md 未实现 /users），100 篇窗口上限已知。
    path: '/user/:id',
    name: 'user-profile',
    component: UserProfileView,
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
