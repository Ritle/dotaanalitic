import './design-tokens.css';
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { router } from './router';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { queryClient } from './query-client';
createApp(App).use(VueQueryPlugin,{queryClient}).use(router).mount('#app');
