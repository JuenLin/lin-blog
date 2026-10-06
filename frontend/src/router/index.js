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
// 第二步：修改密码，需登录，未登录由beforeEach 统一跳登录页（带 redirect）。
const ChangePasswordView = () => import('../views/ChangePassword.vue');
// 第十四批 A5：设置页壳（左侧导航 + 右侧子视图）。
// 下面两个子页面是它的 children，路径 /settings/profile、/settings/password 与
// 各自的 name 都**没变**，变的只是「多了一层壳」和下拉菜单的入口合并成一个。
const SettingsView = () => import('../views/Settings.vue');
const ProfileEditView = () => import('../views/ProfileEdit.vue');

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
  {
    // 第十四批 A5：/settings 本身只是个壳，进来默认落在「编辑资料」。
    // redirect 用 name 而不是写死 '/settings/profile'：路径以后调整不用改这里。
    //
    // 为什么改成嵌套而不是让两个页面各自复制一份侧栏：
    // 侧栏只有一份，加第三个设置项时只改 Settings.vue 一处。
    // 代价是两个子页面的根容器原本是「整页居中」，现在变成「右侧区域居中」，
    // 它们各自的 el-card 定宽不变，视觉上只是整体右移。
    path: '/settings',
    name: 'settings',
    component: SettingsView,
    redirect: { name: 'settings-profile' },
    meta: {
      requiresAuth: true,
    },
    children: [
      {
        // 修改密码（PUT /api/auth/password）：
        // 需登录——未登录时 beforeEach 跳登录页并带 redirect，登录后可直接回来。
        // 路径刻意用 /settings/password 而不是 /user/password：
        // 与「编辑资料」并列在 /settings 下，两个页面同级更清楚。
        path: 'password',
        name: 'settings-password',
        component: ChangePasswordView,
        meta: {
          requiresAuth: true,
        },
      },
      {
        // 编辑资料（第九批）：改头像与简介，走 PUT /api/users/me。
        // 路径沿用 /settings/* 的分组（与修改密码同级），而不是 /profile/edit——
        // 前者已经是「登录态下的账号操作」这一组，两个页面并列更清楚。
        path: 'profile',
        name: 'settings-profile',
        component: ProfileEditView,
        meta: {
          requiresAuth: true,
        },
      },
    ],
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
