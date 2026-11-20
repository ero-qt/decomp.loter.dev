import { expect, test } from 'bun:test';
import { Color } from '@codingame/monaco-vscode-api/vscode/vs/base/common/color';
import darkTheme from './dark.json';
import { deriveLightTheme, minimumContrast } from './light';

function listCodeColors(theme: ReturnType<typeof deriveLightTheme>): string[] {
    return [
        ...theme.tokenColors.flatMap(({ settings }) => settings.foreground ?? []),
        ...Object.values(theme.semanticTokenColors),
    ];
}

// allows a hue to move by 4 degrees because a darker color has fewer steps of 8-bit channels for the color's hue
const toleratedHueChange = 4;

test("deriveLightTheme keeps about each code color's hue and darkens the color until the color reaches `minimumContrast` on white", () => {
    const light = listCodeColors(deriveLightTheme(darkTheme));
    const dark = listCodeColors(darkTheme);
    const hueChanges = light.map((color, index) => {
        const change = Math.abs(Color.fromHex(color).hsla.h - Color.fromHex(dark[index]).hsla.h);

        return Math.min(change, 360 - change);
    });

    expect(light.filter(color => Color.fromHex(color).getContrastRatio(Color.white) < minimumContrast)).toEqual([]);
    expect(hueChanges.filter(change => change > toleratedHueChange)).toEqual([]);
});
