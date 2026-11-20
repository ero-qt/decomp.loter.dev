import { expect, test } from 'bun:test';
import { openCircle, readUntil, readWordColor } from '../editor-testing';
import { startWorkbench, testTimeoutMs } from '../page-testing';
import { ownTokenTypes, tokenLegend } from '../tokens';
import darkTheme from './dark.json';
import { deriveLightTheme } from './light';

const openWorkbench = startWorkbench();
const themes: Record<'dark' | 'light', { semanticTokenColors: Record<string, string> }> = {
    dark: darkTheme,
    light: deriveLightTheme(darkTheme),
};
const scaling = `fake
namespace Drawing
 public class Circle
  public method Scale
   type_parameter Unit
   parameter factor
`;

test("dark theme colors only the legend's token types and the types above them, with the legend's modifiers", () => {
    const types = [...tokenLegend.tokenTypes, ...ownTokenTypes.map(type => type.superType)];
    const legendModifiers: string[] = tokenLegend.tokenModifiers;
    const keys = Object.keys(darkTheme.semanticTokenColors).filter(key => {
        const [type, ...modifiers] = key.split('.');

        return !types.includes(type) || !modifiers.every(modifier => legendModifiers.includes(modifier));
    });

    expect(keys).toEqual([]);
});

for (const colorScheme of ['dark', 'light'] as const) {
    test(`type parameter and parameter names in a document have the ${colorScheme} theme's colors`, async () => {
        const { page } = await openWorkbench(colorScheme);
        const colors = themes[colorScheme].semanticTokenColors;

        await openCircle(page, scaling, 'Scale');

        const words = [
            ['type_parameter Unit', 'Unit', colors.typeParameter],
            ['parameter factor', 'factor', colors.parameter],
        ];
        for (const [lineText, word, color] of words) {
            expect(await readUntil(() => readWordColor(page, lineText, word), color.toLowerCase())).toBe(color.toLowerCase());
        }
    }, testTimeoutMs);
}
