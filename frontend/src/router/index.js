import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '../stores/user.js';
import HomeView from '../views/Home.vue';
import LoginView from '../views/Login.vue';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
  },
  {
    path: '/',
    name: 'home',
    component: HomeView,
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
