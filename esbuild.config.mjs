import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const baseConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: [
    'vscode',
    // El SDK Anthropic NO se puede bundlear: incluye un binario nativo
    // (~227 MB) que el extension host invoca via spawn. Queda como dep
    // copiada al .vsix vía .vscodeignore.
    '@anthropic-ai/claude-agent-sdk',
    // ajv + ajv-formats usan require() con paths construidos en runtime
    // ("ajv/dist/runtime/equal", "ajv-formats/dist/formats") que esbuild
    // no puede resolver estáticamente. Si los bundleamos, los require()
    // dinámicos quedan literales en el output y fallan al ejecutar. La
    // alternativa es marcarlos como external y copiarlos al .vsix como
    // packages — esos require() en runtime sí los resuelve Node.
    'ajv',
    'ajv-formats',
  ],
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
