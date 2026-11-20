/// <reference types="vite/client" />
import { ExtensionHostKind, type IExtensionManifest, registerExtension } from '@codingame/monaco-vscode-api/extensions';
import { Registry } from '@codingame/monaco-vscode-api/vscode/vs/platform/registry/common/platform';
import { Extensions, type IViewsRegistry } from '@codingame/monaco-vscode-api/vscode/vs/workbench/common/views';
import type { Manifest } from '../contract/manifest';
import { darkThemeName, lightThemeName, symbolsViewId } from './config';
import { grammars } from './grammars';
import darkThemeUrl from './themes/dark.json?url';
import lightThemeUrl from './themes/light.json?url';
import { ownTokenTypes } from './tokens';
import { writeViewContributions } from './view-menus';

const manifest: IExtensionManifest = {
    name: 'decomp-loter-dev',
    publisher: 'decomp-loter-dev',
    version: '1.0.0',
    engines: { vscode: '*' },
    contributes: {
        semanticTokenTypes: ownTokenTypes,
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
        keybindings: [
            { command: 'decomp.close', key: 'delete', when: `focusedView == ${symbolsViewId}` },
            // casts the query that finds the strings because the command takes a text while the manifest's type takes
            // an object
            { command: 'workbench.action.quickOpen', args: '#"' as never, key: 'ctrl+shift+f', mac: 'cmd+shift+f' },
        ],
        themes: [
            { id: darkThemeName, label: darkThemeName, uiTheme: 'vs-dark', path: './themes/dark.json' },
            { id: lightThemeName, label: lightThemeName, uiTheme: 'vs', path: './themes/light.json' },
        ],
    },
};

export const registration = registerExtension(manifest, ExtensionHostKind.LocalProcess);
registration.registerFileUrl('/themes/dark.json', darkThemeUrl);
registration.registerFileUrl('/themes/light.json', lightThemeUrl);

const viewsRegistry = Registry.as<IViewsRegistry>(Extensions.ViewsRegistry);

// gives the Symbols view the order 1 because the workbench puts a view without an order below the Outline view, whose
// order is 2
viewsRegistry.onViewsRegistered(registered => {
    const symbolsView = registered.flatMap(({ views }) => views).find(view => view.id === symbolsViewId);
    if (symbolsView) {
        (symbolsView as { order?: number }).order = 1;
    }
});

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
    viewsRegistry.registerViewWelcomeContent(symbolsViewId, { content: lines.join('\n') });
}

/**
 * Registers the commands and menus of `writeViewContributions` and each view's language with the view's extension, so a
 * document's language is the language of the document's view. Gives a language of `grammars` its grammar and its
 * configuration, which color the language's keywords, strings and numbers.
 */
export function registerViews(manifests: Manifest[]) {
    const views = manifests.flatMap(engine => engine.views);
    const languages = views.map(({ language, extension }) => {
        return { id: language, extensions: [extension], ...(grammars[language] && { configuration: `./grammars/${language}.json` }) };
    });

    const known = [...new Set(views.map(view => view.language))].filter(language => grammars[language]);
    const grammarContributions = known.map(language => {
        return { language, scopeName: grammars[language].scopeName, path: `./grammars/${language}.tmLanguage.json` };
    });

    const contributes = { languages, grammars: grammarContributions, ...writeViewContributions(manifests) };
    const registered = registerExtension({ ...manifest, name: 'decomp-loter-dev-views', contributes }, ExtensionHostKind.LocalProcess);

    for (const language of known) {
        registered.registerFileUrl(`/grammars/${language}.tmLanguage.json`, grammars[language].grammarUrl);
        registered.registerFileUrl(`/grammars/${language}.json`, grammars[language].configurationUrl);
    }
}
