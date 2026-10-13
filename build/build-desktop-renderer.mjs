import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { validateDesktopRenderer } from './validate-desktop-renderer.mjs';

// build/build-desktop-renderer.mjs
// Always select the existing desktop branch of the real Vite config before packaging.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.ELECTRON = 'true';
process.env.ELECTRON_DEV = 'false';
let resolvedConfig;

await build({
  root,
  configFile: path.join(root, 'vite.config.ts'),
  plugins: [{
    name: 'folia-desktop-renderer-contract',
    configResolved(config) {
      if (config.base !== './') throw new Error(`Desktop renderer requires base './', received ${config.base}`);
      resolvedConfig = config;
    },
  }],
});
const input = resolvedConfig.build.rollupOptions.input;
const inputs = typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
const entrypoints = inputs.filter(file => file.endsWith('.html'))
  .map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));
console.log(JSON.stringify(validateDesktopRenderer(path.resolve(root, resolvedConfig.build.outDir), { entrypoints }), null, 2));
