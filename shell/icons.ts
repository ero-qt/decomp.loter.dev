/// <reference types="vite/client" />
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';
import { getColorRegistry } from '@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/colorUtils';
import type { Uri } from 'vscode';
import { type Accessibility, accessibilityOf, type Kind, modifiersOf } from '../contract/symbols';
import { vscode } from './api';
import { registration } from './registration';
import darkThemeUrl from './themes/dark.json?url';
import lightThemeUrl from './themes/light.json?url';

type ThemeType = 'light' | 'dark';

// kind -> the codicon and the symbol color of the kind's icon
const icons: Partial<Record<Kind, [codicon: string, color: string]>> = {
    namespace: ['symbol-namespace', 'namespace'],
    class: ['symbol-class', 'class'],
    struct: ['symbol-structure', 'struct'],
    interface: ['symbol-interface', 'interface'],
    enum: ['symbol-enum', 'enumerator'],
    delegate: ['symbol-class', 'class'],
    method: ['symbol-method', 'method'],
    constructor: ['symbol-method', 'constructor'],
    operator: ['symbol-operator', 'operator'],
    property: ['symbol-property', 'property'],
    indexer: ['symbol-property', 'property'],
    field: ['symbol-field', 'field'],
    enum_member: ['symbol-enum-member', 'enumeratorMember'],
    event: ['symbol-event', 'event'],
    record: ['symbol-class', 'class'],
    annotation: ['symbol-interface', 'interface'],
    section: ['folder', 'folder'],
    reference: ['library', 'reference'],
    resource: ['file-binary', 'file'],
    function: ['symbol-function', 'function'],
    variable: ['symbol-variable', 'variable'],
};

// accessibility -> the codicon and the chart color of the accessibility's badge
const badges: Partial<Record<Accessibility, [codicon: string, color: string]>> = {
    private: ['lock-small', 'red'],
    'private protected': ['lock-small', 'orange'],
    protected: ['shield', 'yellow'],
    internal: ['home', 'blue'],
    'protected internal': ['shield', 'green'],
    'package-private': ['home', 'blue'],
};

// codicon's file -> the codicon's SVG
const codicons = import.meta.glob<string>('./{symbol-*,folder,library,file-binary,lock-small,shield,home,circle-small-filled}.svg', {
    base: '../node_modules/@vscode/codicons/src/icons/',
    query: '?raw',
    import: 'default',
    eager: true,
});

// theme type -> the workbench colors that the site's theme sets
const themeColors: Record<ThemeType, Record<string, string>> = {
    light: (await (await fetch(lightThemeUrl)).json()).colors,
    dark: (await (await fetch(darkThemeUrl)).json()).colors,
};

const extensionUri = vscode.extensions.getExtension(registration.id)!.extensionUri;

// kind, accessibility and static mark -> the icon
const drawnIcons = new Map<string, { light: Uri; dark: Uri }>();

// resolves a color with the site's theme and the workbench's defaults because an icon's image can't use the theme's CSS
// colors
function resolveColor(colorId: string, themeType: ThemeType): string {
    const theme = {
        type: themeType,
        getColor(id: string): Color | undefined {
            const themeColor = themeColors[themeType][id];

            return themeColor ? Color.fromHex(themeColor) : getColorRegistry().resolveDefaultColor(id, theme as never);
        },
    };

    return Color.Format.CSS.formatHex(theme.getColor(colorId)!);
}

// leaves out the fill rule of the codicon's paths because the workbench's codicon font fills each path with the default
// rule
function drawCodicon(codicon: string, color: string, themeType: ThemeType, transform = ''): string {
    const svg = codicons[`./${codicon}.svg`].replace(/^<svg[^>]*>|<\/svg>$| fill-rule="evenodd"/g, '');

    return `<g fill="${resolveColor(color, themeType)}" transform="${transform}">${svg}</g>`;
}

// serves the icon at a short URL of the extension because a data URL on each row makes a large file's rows too large
// for the extension host
function registerIcon(name: string, svg: string): Uri {
    registration.registerFileUrl(`/icons/${name}`, `data:image/svg+xml;base64,${btoa(svg)}`);

    return vscode.Uri.joinPath(extensionUri, 'icons', name);
}

/**
 * Draws the icon of a symbol's kind with the accessibility's badge at the bottom right and a dot at the top right for a
 * static symbol. Draws each icon once and returns the same URLs for the same kind, accessibility and static mark.
 * Returns `undefined` for a kind without an icon.
 */
export function drawIcon(kind: Kind, flags: number): { light: Uri; dark: Uri } | undefined {
    const [codicon, color] = icons[kind] ?? [];
    const accessibility = accessibilityOf(flags);
    const badge = badges[accessibility];
    const isStatic = modifiersOf(flags).includes('static');
    const key = `${kind} ${accessibility} ${isStatic}`;
    if (!codicon || drawnIcons.has(key)) {
        return drawnIcons.get(key);
    }

    const marks = [
        badge ? {
            codicon: badge[0],
            color: `charts.${badge[1]}`,
            transform: 'translate(6.5 6.5) scale(.6875)',
            hole: '<circle cx="12" cy="12" r="5"/>',
        } : undefined,
        isStatic ? {
            codicon: 'circle-small-filled',
            color: 'foreground',
            transform: 'translate(5 -5)',
            hole: '<circle cx="13" cy="3" r="3"/>',
        } : undefined,
    ].filter(mark => mark !== undefined);

    function draw(themeType: ThemeType): Uri {
        // cuts a hole for each mark into the kind's codicon because a mark on top of the codicon isn't clear at 16
        // pixels
        const holes = `<mask id="holes"><rect width="16" height="16" fill="#fff"/>${marks.map(mark => mark.hole).join('')}</mask>`;
        const drawnMarks = marks.map(mark => drawCodicon(mark.codicon, mark.color, themeType, mark.transform));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${holes}`
            + `<g mask="url(#holes)">${drawCodicon(codicon!, `symbolIcon.${color}Foreground`, themeType)}</g>${drawnMarks.join('')}</svg>`;

        return registerIcon(`${drawnIcons.size}-${themeType}.svg`, svg);
    }

    const icon = { light: draw('light'), dark: draw('dark') };
    drawnIcons.set(key, icon);

    return icon;
}
