import type { IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api';

export const darkThemeName = 'decomp.loter.dev Dark';
export const lightThemeName = 'decomp.loter.dev Light';
export const symbolsViewId = 'decomp.symbols';

export const productConfiguration: IWorkbenchConstructionOptions['productConfiguration'] = {
    nameShort: 'decomp.loter.dev',
    nameLong: 'decomp.loter.dev',
};

/**
 * The settings that set the window's title, follow the system's color scheme with the site's themes and hide the unused
 * parts.
 */
export const configurationDefaults: Record<string, unknown> = {
    'window.title': '${activeEditorShort}${separator}${appName}',
    'workbench.preferredDarkColorTheme': darkThemeName,
    'workbench.preferredLightColorTheme': lightThemeName,
    'window.autoDetectColorScheme': true,
    'workbench.tips.enabled': false,
    'workbench.layoutControl.enabled': false,
    'workbench.activityBar.location': 'hidden',
};

// opens the side bar with the Symbols view because the workbench hides the side bar in a window without a folder
export const defaultLayout: IWorkbenchConstructionOptions['defaultLayout'] = {
    force: true,
    views: [{ id: symbolsViewId }],
};
