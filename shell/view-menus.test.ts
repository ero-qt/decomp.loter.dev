import { fakeManifest } from '#contract/fake';
import type { Manifest } from '#contract/manifest';
import { ContextKeyExpr } from '@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey';
import { expect, test } from 'bun:test';
import { formatShowBesideCommand, writeViewContributions } from './view-menus';

const [codeView] = fakeManifest.views;
const oneView: Manifest = { ...fakeManifest, id: 'single', views: [codeView] };
const longerIds: Manifest = { ...fakeManifest, id: 'fake2', views: [codeView, { ...codeView, id: 'code2', extension: '.code2' }] };

/** Lists the commands of a menu whose `when` clause is true for the context keys. */
function listShownCommands(menu: { command: string; when: string }[], keys: Record<string, string>): string[] {
    // casts each key's value because the context's `getValue` returns the type that the caller picks
    const context = { getValue: <Value>(key: string) => keys[key] as Value };

    return menu.filter(({ when }) => ContextKeyExpr.deserialize(when)!.evaluate(context)).map(item => item.command);
}

function readDocumentKeys(path: string) {
    return { resourceScheme: 'decomp', resourcePath: path };
}

test('writeViewContributions contributes the command Show <title> to the Side with the short title <title> for each view', () => {
    expect(writeViewContributions([fakeManifest, oneView]).commands).toEqual([
        { command: formatShowBesideCommand('fake', 'code'), title: 'Show Code to the Side', shortTitle: 'Code' },
        { command: formatShowBesideCommand('fake', 'ops'), title: 'Show Ops to the Side', shortTitle: 'Ops' },
        { command: formatShowBesideCommand('single', 'code'), title: 'Show Code to the Side', shortTitle: 'Code' },
    ]);
});

test("editor title and command palette show a view's command for the engine's documents in the other views", () => {
    const { menus } = writeViewContributions([fakeManifest, oneView, longerIds]);
    const longerIdsDocument = readDocumentKeys('/fake2/code2/1:2/Circle.code2');

    for (const menu of [menus['editor/title'], menus['editor/title/context'], menus.commandPalette]) {
        expect(listShownCommands(menu, readDocumentKeys('/fake/code/1:2/Circle.code'))).toEqual([formatShowBesideCommand('fake', 'ops')]);
        expect(listShownCommands(menu, readDocumentKeys('/fake/ops/1:2/Circle.ops'))).toEqual([formatShowBesideCommand('fake', 'code')]);
        expect(listShownCommands(menu, readDocumentKeys('/single/code/1:2/Circle.code'))).toEqual([]);
        expect(listShownCommands(menu, longerIdsDocument)).toEqual([formatShowBesideCommand('fake2', 'code')]);
        expect(listShownCommands(menu, { resourceScheme: 'file', resourcePath: '/fake/code/1:2/Circle.code' })).toEqual([]);
    }
});

test("Symbols view's row menu shows the engine's views after the first for the engine's rows with a document", () => {
    const menu = writeViewContributions([fakeManifest, oneView]).menus['view/item/context'];
    const shown = listShownCommands(menu, { view: 'decomp.symbols', viewItem: 'document fake' });

    expect(shown).toEqual([formatShowBesideCommand('fake', 'ops')]);
    expect(listShownCommands(menu, { view: 'decomp.symbols', viewItem: 'document single' })).toEqual([]);
    expect(listShownCommands(menu, { view: 'decomp.symbols', viewItem: 'file' })).toEqual([]);
});

test("menus keep the order of the manifest's views", () => {
    const views = ['First', 'Zed', 'Alpha'].map(title => ({ ...codeView, id: title.toLowerCase(), title, extension: `.${title}` }));
    const { commands, menus } = writeViewContributions([{ ...fakeManifest, views }]);
    const titles = new Map(commands.map(({ command, shortTitle }) => [command, shortTitle]));

    for (const menu of [menus['editor/title'], menus['editor/title/context'], menus['view/item/context']]) {
        // sorts the items by the order after the group's `@` and then by title because the workbench sorts a menu that
        // way
        const sorted = menu.toSorted((first, second) => {
            const order = Number(first.group?.split('@')[1] ?? 0) - Number(second.group?.split('@')[1] ?? 0);

            return order || titles.get(first.command)!.localeCompare(titles.get(second.command)!);
        });

        expect(sorted.map(({ command }) => titles.get(command))).toEqual(views.slice(menu.length === 2 ? 1 : 0).map(view => view.title));
    }
});
