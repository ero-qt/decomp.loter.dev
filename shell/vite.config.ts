import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { readBuildVersion, writeVersionLine } from './build-version.ts';
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
        // builds the page for a missing file as a page of its own because it has to work without the workbench's scripts
        rolldownOptions: {
            input: ['index.html', '404.html'].map(name => `${import.meta.dirname}/${name}`),
        },
    },
    plugins: [
        {
            name: 'favicon',
            // writes the logo into the site's root because browsers look for a page's icon there
            buildStart() {
                this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: readFileSync(`${import.meta.dirname}/logo.svg`) });
            },
        },
        {
            name: 'version',
            // writes the version into the About tab's template because the version comes from the build's commit
            transformIndexHtml(html, { filename }) {
                if (!filename.endsWith('index.html')) {
                    return html;
                }

                const version = readBuildVersion(process.env, () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());

                return html.replace('<!-- version -->', writeVersionLine(version));
            },
        },
        {
            name: 'absolute-links',
            enforce: 'post',
            // links the page for a missing file's files from the site's root because the host serves the page at the
            // missing file's path, which can sit in a folder
            generateBundle(options, bundle) {
                const page = bundle['404.html'];
                if (page?.type === 'asset') {
                    page.source = String(page.source).replaceAll('="./', '="/');
                }
            },
        },
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
