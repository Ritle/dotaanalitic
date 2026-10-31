import { createRouter, createWebHistory } from 'vue-router';
import LoginView from './views/LoginView.vue';
import HomeView from './views/HomeView.vue';
import EntityView from './views/EntityView.vue';
import CompareView from './views/CompareView.vue';
import ScenariosView from './views/ScenariosView.vue';
import { ownerAuth, restoreAuth } from './auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: HomeView, meta: { requiresAuth: true } },
    { path: '/compare', name: 'compare', component: CompareView, meta: { requiresAuth: true } },
    { path: '/scenarios', component: ScenariosView, meta: { requiresAuth: true } },
    { path: '/scenarios/:id', component: ScenariosView, meta: { requiresAuth: true } },
    { path: '/teams/:id', name: 'team', component: EntityView, meta: { requiresAuth: true } },
    { path: '/players/:id', name: 'player', component: EntityView, meta: { requiresAuth: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
});
let restored = false;
router.beforeEach(async to => {
  if (!restored) {
    try { await restoreAuth(); } catch { /* Login view provides retry/error state. */ }
    restored = true;
  }
  if (to.meta.requiresAuth && !ownerAuth.value) return '/login';
  if (to.path === '/login' && ownerAuth.value) return '/';
});
