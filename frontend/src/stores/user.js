import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getMe, login as loginApi, register as registerApi } from '../api/auth.js';

const TOKEN_KEY = 'token';

export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem(TOKEN_KEY) || '');
  const user = ref(null);

  const isLogin = computed(() => Boolean(token.value));

  function setToken(value) {
    token.value = value || '';

    if (token.value) {
      localStorage.setItem(TOKEN_KEY, token.value);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  function setUser(value) {
    user.value = value || null;
  }

  async function login(payload) {
    const data = await loginApi(payload);

    setToken(data.token);
    setUser(data.user);

    return data;
  }

  async function register(payload) {
    return registerApi(payload);
  }

  async function fetchMe() {
    const data = await getMe();

    setUser(data);

    return data;
  }

  function logout() {
    setToken('');
    setUser(null);
  }

  return {
    token,
    user,
    isLogin,
    setToken,
    setUser,
    login,
    register,
    fetchMe,
    logout,
  };
});
