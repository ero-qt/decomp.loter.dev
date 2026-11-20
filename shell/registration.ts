/// <reference types="vite/client" />
import { ExtensionHostKind, type IExtensionManifest, registerExtension } from '@codingame/monaco-vscode-api/extensions';
// registers the Explorer view container because only the Outline view's package, which the site doesn't load, imports
// this module
import '@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/files/browser/explorerViewlet';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { Extensions, type IViewsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/views';
import { darkThemeName, lightThemeName, symbolsViewId } from './config';
import darkThemeUrl from './themes/dark.json?url';
import lightThemeUrl from './themes/light.json?url';

const manifest: IExtensionManifest = {
    name: 'decomp-loter-dev',
    publisher: 'decomp-loter-dev',
    version: '1.0.0',
    engines: { vscode: '*' },
    contributes: {
        commands: [
            { command: 'decomp.openFiles', title: 'Open Files...', category: 'File', icon: '$(go-to-file)' },
            { command: 'decomp.openFolder', title: 'Open Folder...', category: 'File', icon: '$(folder-opened)' },
            { command: 'decomp.close', title: 'Close' },
        ],
        views: {
            explorer: [{ id: symbolsViewId, name: 'Symbols' }],
        },
        menus: {
            'view/title': [
                { command: 'decomp.openFiles', when: `view == ${symbolsViewId}`, group: 'navigation@1' },
                { command: 'decomp.openFolder', when: `view == ${symbolsViewId}`, group: 'navigation@2' },
            ],
            'view/item/context': [{ command: 'decomp.close', when: `view == ${symbolsViewId} && viewItem == file` }],
            commandPalette: [{ command: 'decomp.close', when: 'false' }],
        },
        keybindings: [{ command: 'decomp.close', key: 'delete', when: `focusedView == ${symbolsViewId}` }],
        themes: [
            { id: darkThemeName, label: darkThemeName, uiTheme: 'vs-dark', path: './themes/dark.json' },
            { id: lightThemeName, label: lightThemeName, uiTheme: 'vs', path: './themes/light.json' },
        ],
    },
};

export const registration = registerExtension(manifest, ExtensionHostKind.LocalProcess);
registration.registerFileUrl('/themes/dark.json', darkThemeUrl);
registration.registerFileUrl('/themes/light.json', lightThemeUrl);

/**
 * Adds the empty Symbols view's text through the views registry, because the workbench doesn't read an extension's
 * `viewsWelcome` contribution. The buttons work only after the commands that open files are registered. Each error text
 * shows below the buttons.
 */
export function addSymbolsWelcome(errorTexts: string[]) {
    const lines = [
        'Open or drop files to list their symbols.',
        '[Open Files](command:decomp.openFiles)',
        '[Open Folder](command:decomp.openFolder)',
        ...errorTexts,
    ];
    Registry.as<IViewsRegistry>(Extensions.ViewsRegistry).registerViewWelcomeContent(symbolsViewId, { content: lines.join('\n') });
}
