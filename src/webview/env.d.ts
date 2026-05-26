/// <reference types="vite/client" />

/* Shims para tsc/vue-tsc — vite los resuelve en build, pero
 * sin estas declaraciones el typecheck no encuentra los imports
 * de SFC ni del side-effect de style.css. */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module '*.css';
