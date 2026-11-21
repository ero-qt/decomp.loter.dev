import { defineConfig } from 'vite';
import darkTheme from './themes/dark.json' with { type: 'json' };
import { deriveLightTheme } from './themes/light.ts';
import { drawTransferCode } from './transfer-code.ts';

// file's name -> the file's text, which the build writes into the site for an import of the file's name with `?url`
const builtFiles: Record<string, () => string> = {
    'light.json': () => `${JSON.stringify(deriveLightTheme(darkTheme), null, 2)}\n`,
    'support-code.svg': drawTransferCode,
};

export default defineConfig({
    root: import.meta.dirname,
    base: './',
    build: {
        outDir: '../artifacts/site',
        emptyOutDir: true,
        assetsInlineLimit: 0,
        // builds the privacy page as a page of its own because it has to work without the workbench's scripts
        rolldownOptions: {
            input: [`${import.meta.dirname}/index.html`, `${import.meta.dirname}/privacy.html`],
        },
    },
    plugins: [
        {
            name: 'built-files',
            enforce: 'pre',
            resolveId(source) {
                const name = Object.keys(builtFiles).find(name => source.endsWith(`/${name}?url`));

                // ends the module's id with `-built` because Vite's JSON plugin parses each module whose id ends with
                // `.json`
                return name && `\0${name}-built`;
            },
            // writes each built file into the site because the workbench and the support note read the files from URLs
            load(id) {
                const [, name] = /^\0(.+)-built$/.exec(id) ?? [];
                if (name) {
                    const fileId = this.emitFile({ type: 'asset', name, source: builtFiles[name]() });

                    return `export default import.meta.ROLLUP_FILE_URL_${fileId}`;
                }
            },
        },
    ],
});
