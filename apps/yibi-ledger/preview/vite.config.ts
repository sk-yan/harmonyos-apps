import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const assets = new Map<string, string>();
const tesseract = dirname(require.resolve('tesseract.js/package.json'));
const core = dirname(createRequire(join(tesseract, 'package.json')).resolve('tesseract.js-core/package.json'));
assets.set('ocr-assets/worker.min.js', join(tesseract, 'dist/worker.min.js'));
assets.set('ocr-assets/worker.min.js.LICENSE.txt', join(tesseract, 'dist/worker.min.js.LICENSE.txt'));
assets.set('ocr-assets/licenses/tesseract.js.txt', join(tesseract, 'LICENSE.md'));
assets.set('ocr-assets/licenses/tesseract-core.txt', join(core, 'LICENSE'));
for (const file of readdirSync(core)) {
  if (file.endsWith('.wasm.js')) assets.set(`ocr-assets/core/${file}`, join(core, file));
}
for (const language of ['chi_sim', 'eng']) {
  const directory = dirname(require.resolve(`@tesseract.js-data/${language}/package.json`));
  assets.set(`ocr-assets/lang/${language}.traineddata.gz`, join(directory, `4.0.0_best_int/${language}.traineddata.gz`));
  assets.set(`ocr-assets/licenses/${language}-package.json`, join(directory, 'package.json'));
}
assets.set('ocr-assets/licenses/THIRD_PARTY_NOTICES.md', join(dirname(fileURLToPath(import.meta.url)), 'THIRD_PARTY_NOTICES.md'));

export default defineConfig({
  base: './',
  plugins: [{
    name: 'same-origin-offline-ocr',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0].replace(/^\//, '');
        if (!path.startsWith('ocr-assets/')) return next();
        const file = assets.get(path);
        if (!file) { response.statusCode = 404; response.end(); return; }
        response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'application/javascript' : path.endsWith('.gz') ? 'application/gzip' : 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'public, max-age=3600');
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, path] of assets) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  }],
});
