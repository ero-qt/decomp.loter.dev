import { Color, HSLA } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';

interface Theme {
    type: string;
    colors: Record<string, string>;
    tokenColors: { settings: { foreground?: string } }[];
    semanticTokenColors: Record<string, string>;
}

/** The contrast that text needs with its background in success criterion 1.4.3 of WCAG 2.2. */
export const minimumContrast = 4.5;

// lowers a color's lightness in steps of 0.005 until the color reaches `minimumContrast` on white
function darkenForWhite(hex: string): string {
    const { h, s, l } = Color.fromHex(hex).hsla;
    for (let lightness = l; lightness > 0; lightness -= 0.005) {
        const color = new Color(new HSLA(h, s, lightness, 1));
        if (color.getContrastRatio(Color.white) >= minimumContrast) {
            return Color.Format.CSS.formatHex(color);
        }
    }

    return '#000000';
}

/**
 * Derives the light theme from the dark theme. Each code color keeps its hue and saturation and gets darker until the
 * color reaches `minimumContrast` on white. The workbench's own light theme colors the workbench's parts.
 */
export function deriveLightTheme(dark: Theme): Theme {
    const semanticTokenColors = Object.entries(dark.semanticTokenColors).map(([selector, color]) => [selector, darkenForWhite(color)]);

    return {
        ...dark,
        type: 'light',
        colors: { 'editor.background': '#ffffff', 'editor.foreground': darkenForWhite(dark.colors['editor.foreground']) },
        tokenColors: dark.tokenColors.map(rule => ({
            ...rule,
            settings: { ...rule.settings, foreground: rule.settings.foreground && darkenForWhite(rule.settings.foreground) },
        })),
        semanticTokenColors: Object.fromEntries(semanticTokenColors),
    };
}
