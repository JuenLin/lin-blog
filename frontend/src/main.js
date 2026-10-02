import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './style.css';
import App from './App.vue';
import router from './router/index.js';

const app = createApp(App);

app.use(createPinia());
app.use(router);
// 必须传 locale：不传时 el-pagination 等组件会显示英文（Total / Go to previous page）。
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');
