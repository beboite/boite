import { defineConfig, type Plugin } from 'vitest/config';
import { compile, compileModule, preprocess } from 'svelte/compiler';
import ts from 'typescript';

const RUNE_MODULE = /\.svelte\.(?:ts|js)(?:\?.*)?$/;

/**
 * Vitest runs on its own Vite (7) while the app builds on Vite 8, so the svelte
 * plugin, which needs Vite 8, cannot be shared. Compiling components and rune
 * modules by hand is the whole of what the tests need from it. verbatimModuleSyntax
 * keeps the component imports a template uses but a script does not.
 */
function svelteForTests(): Plugin {
  return {
    name: 'boite:svelte-for-tests',
    async transform(code: string, id: string) {
      if (RUNE_MODULE.test(id)) {
        const compiled = compileModule(code, { filename: id, generate: 'client', dev: true });
        return { code: compiled.js.code, map: compiled.js.map };
      }
      if (!id.endsWith('.svelte')) return null;

      const processed = await preprocess(
        code,
        {
          script: ({ content, attributes }) => {
            if (attributes['lang'] !== 'ts') return { code: content };
            const out = ts.transpileModule(content, {
              fileName: id,
              compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                verbatimModuleSyntax: true,
                sourceMap: true
              }
            });
            return { code: out.outputText, map: out.sourceMapText };
          }
        },
        { filename: id }
      );
      const compiled = compile(processed.code, {
        filename: id,
        generate: 'client',
        dev: true,
        css: 'injected'
      });
      return { code: compiled.js.code, map: compiled.js.map };
    }
  };
}

export default defineConfig({
  plugins: [svelteForTests()],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
    /* lucide ships .svelte sources; inlined so the plugin above compiles them too */
    server: { deps: { inline: ['@lucide/svelte'] } }
  }
});
