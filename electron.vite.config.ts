import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** Fonts always ship as files; anything else keeps Vite's default inlining. */
export const rendererAssetsInlineLimit = (file: string): boolean | undefined => /\.(?:woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined;

const nixNodeModules = process.env.npmDeps ? resolve(process.env.npmDeps, 'node_modules') : null;
const frontendRoot = resolve(__dirname, 'frontend');
const loadModule = createRequire(import.meta.url);
const { expandRendererMarkup } = loadModule(resolve(__dirname, 'scripts/read-renderer-markup.cjs'));

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as files in the asar.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'backend/main.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'backend/preload/index.ts'),
          'integrated-browser': resolve(__dirname, 'backend/preload/integrated-browser.ts'),
          'integrated-browser-worker': resolve(__dirname, 'backend/preload/integrated-browser-worker.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'frontend'),
    plugins: [{
      name: 'neuraflok-renderer-markup',
      transformIndexHtml: (html: string) => expandRendererMarkup(html, frontendRoot)
    }],
    // Allow the exact nixpkgs npmDeps derivation because Vite resolves its node_modules symlink before the filesystem check.
    server: nixNodeModules
      ? {
          fs: {
            allow: [resolve(__dirname), nixNodeModules]
          }
        }
      : undefined,
    build: {
      // Keep fonts as files because font-src 'self' blocks Vite's inlined data URLs.
      assetsInlineLimit: rendererAssetsInlineLimit,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'frontend/index.html'),
          'integrated-browser': resolve(__dirname, 'frontend/features/browser/integrated-browser.html')
        }
      }
    }
  }
});
