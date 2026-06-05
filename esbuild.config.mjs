import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const baseConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  // Solo `vscode` queda external (lo provee el extension host). El
  // viewer ya no depende del SDK Anthropic ni del MCP SDK; zod se
  // bundlea sin problema (JS puro).
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(baseConfig);
  await ctx.watch();
  console.log('[esbuild] watching for changes...');
} else {
  await build(baseConfig);
  console.log('[esbuild] build complete');
}
