import 'vscode/localExtensionHost';
import { initialize } from '@codingame/monaco-vscode-api';
import editorWorkerUrl from '@codingame/monaco-vscode-api/workers/editor.worker?worker&url';
import configurationOverride from '@codingame/monaco-vscode-configuration-service-override';
import { createIndexedDBProviders } from '@codingame/monaco-vscode-files-service-override';
import languagesOverride from '@codingame/monaco-vscode-languages-service-override';
import modelOverride from '@codingame/monaco-vscode-model-service-override';
import notificationsOverride from '@codingame/monaco-vscode-notifications-service-override';
import outlineOverride from '@codingame/monaco-vscode-outline-service-override';
import preferencesOverride from '@codingame/monaco-vscode-preferences-service-override';
import textmateOverride from '@codingame/monaco-vscode-textmate-service-override';
import textMateWorkerUrl from '@codingame/monaco-vscode-textmate-service-override/worker?worker&url';
import themeOverride from '@codingame/monaco-vscode-theme-service-override';
import workbenchOverride from '@codingame/monaco-vscode-workbench-service-override';
import { startAbout } from './about';
import { configurationDefaults, defaultLayout, productConfiguration } from './config';
import { deferHoverDelegates } from './hovers';
import './registration';
import './privacy-tab';
import './support-tab';
import { type IMonacoEnvironment, ISplashStorageService } from './workbench';
// registers Go to File and Go to Symbol in Workspace without the search service because its override makes the start
// much bigger
import '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/search/browser/searchQuickAccess.contribution';

// worker label -> the worker's URL
const workerUrls: Record<string, string> = { editorWorkerService: editorWorkerUrl, TextMateWorker: textMateWorkerUrl };
const knownUrls = new Set(Object.values(workerUrls));

// passes each worker's URL through a trusted types policy because the site's content security policy blocks an
// untrusted worker URL
const workerPolicy = self.trustedTypes?.createPolicy('editor-worker', {
    createScriptURL(url: string) {
        if (!knownUrls.has(url)) {
            throw new TypeError(`'${url}' isn't the URL of an editor's worker`);
        }

        return url;
    },
});
const environment: IMonacoEnvironment = {
    getWorker(_, label) {
        const url = workerUrls[label];
        // casts the trusted URL to a string because TypeScript's `Worker` doesn't take a `TrustedScriptURL`
        const workerUrl = url && ((workerPolicy?.createScriptURL(url) ?? url) as string);

        return workerUrl ? new Worker(workerUrl, { type: 'module' }) : undefined;
    },
};
Object.assign(globalThis, { MonacoEnvironment: environment });
deferHoverDelegates();
// keeps the user's settings and keybindings in the browser's IndexedDB like vscode.dev, so they stay after a reload
await createIndexedDBProviders();

await initialize(
    {
        ...configurationOverride(),
        ...themeOverride(),
        ...languagesOverride(),
        ...modelOverride(),
        ...notificationsOverride(),
        ...outlineOverride(),
        ...preferencesOverride(),
        ...textmateOverride(),
        ...workbenchOverride(),
        // drops the colors that the workbench saves for a splash screen because the page doesn't have a splash screen
        [ISplashStorageService.toString()]: { async saveWindowSplash() {} },
    },
    document.getElementById('workbench')!,
    {
        productConfiguration,
        configurationDefaults,
        defaultLayout,
    },
);

await startAbout();
await import('./extension');
