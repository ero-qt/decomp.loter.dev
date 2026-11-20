/// <reference types="vite/client" />
import { ExtensionHostKind, type IExtensionManifest, registerExtension } from '@codingame/monaco-vscode-api/extensions';
import { darkThemeName, lightThemeName } from './config';
import darkThemeUrl from './themes/dark.json?url';
import lightThemeUrl from './themes/light.json?url';

const manifest: IExtensionManifest = {
    name: 'decomp-loter-dev',
    publisher: 'decomp-loter-dev',
    version: '1.0.0',
    engines: { vscode: '*' },
    contributes: {
        themes: [
            { id: darkThemeName, label: darkThemeName, uiTheme: 'vs-dark', path: './themes/dark.json' },
            { id: lightThemeName, label: lightThemeName, uiTheme: 'vs', path: './themes/light.json' },
        ],
    },
};

const registration = registerExtension(manifest, ExtensionHostKind.LocalProcess);
registration.registerFileUrl('/themes/dark.json', darkThemeUrl);
registration.registerFileUrl('/themes/light.json', lightThemeUrl);
