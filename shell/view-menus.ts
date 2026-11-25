import type { Manifest } from '#contract/manifest';
import { documentScheme, symbolsViewId } from './config';

type MenuItem = { command: string; when: string; group: string };

/** Writes the id of the command that shows a view of an engine to the side. */
export function formatShowBesideCommand(engineId: string, viewId: string): string {
    return `decomp.showBeside.${engineId}.${viewId}`;
}

/**
 * Writes each view's command that shows a document in the view to the side. The engine's documents in the other views
 * get the command as a button and in the tab's menu. The Symbols view's rows get the commands of the views after the
 * first.
 */
export function writeViewContributions(manifests: Manifest[]) {
    const commands: { command: string; title: string; shortTitle: string }[] = [];
    const editorItems: MenuItem[] = [];
    const rowItems: MenuItem[] = [];
    for (const { id: engineId, views } of manifests) {
        for (const [index, { id, title }] of views.entries()) {
            const command = formatShowBesideCommand(engineId, id);
            // keeps the manifest's order through the group's order because the workbench sorts a group's items by title
            const group = `navigation@${index}`;
            commands.push({ command, title: `Show ${title} to the Side`, shortTitle: title });
            // matches the engine's id and any other view's id because a document's path starts with both, like
            // `/fake/code/`
            const otherView = `/^\\/${engineId}\\/(?!${id}\\/)/`;
            editorItems.push({ command, when: `resourceScheme == ${documentScheme} && resourcePath =~ ${otherView}`, group });
            if (index > 0) {
                rowItems.push({ command, when: `view == ${symbolsViewId} && viewItem == 'document ${engineId}'`, group });
            }
        }
    }

    return {
        commands,
        menus: {
            'editor/title': editorItems,
            'editor/title/context': editorItems,
            'view/item/context': rowItems,
            commandPalette: editorItems.map(({ command, when }) => ({ command, when })),
        },
    };
}
