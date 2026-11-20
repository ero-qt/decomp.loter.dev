import { defineConfig } from 'vite';
import darkTheme from './themes/dark.json' with { type: 'json' };
import { deriveLightTheme } from './themes/light.ts';

export default defineConfig({
    root: import.meta.dirname,
    base: './',
    build: {
        outDir: '../artifacts/site',
        emptyOutDir: true,
        assetsInlineLimit: 0,
    },
    plugins: [
        {
            name: 'light-theme',
            enforce: 'pre',
            resolveId(source) {
                return source.endsWith('/light.json?url') ? '\0light-theme' : undefined;
            },
            // writes the light theme into the site because the workbench reads a theme from a URL
            load(id) {
                if (id === '\0light-theme') {
                    const source = `${JSON.stringify(deriveLightTheme(darkTheme), null, 2)}\n`;

                    return `export default import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: 'light.json', source })}`;
                }
            },
        },
    ],
});
