/**
 * Entry point del webview. Crea la app Vue, instala Pinia y monta.
 *
 * Importa style.css para que Vite procese Tailwind v4 + el bloque
 * @theme con los tokens VS Code, y los empaqueta como un solo CSS en
 * out/webview/assets/index.css.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './style.css';

createApp(App).use(createPinia()).mount('#app');
