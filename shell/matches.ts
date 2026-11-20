import { prepareQuery, scoreFuzzy2 } from '@codingame/monaco-vscode-api/vscode/vs/base/common/fuzzyScorer';

/**
 * Picks at most `count` items whose text matches the query like a name in Go to Symbol in Workspace, where `GtAr`
 * matches `GetArea`. The items with the best scores come first, items with the same score in the items' order.
 */
export function pickMatches<Item extends { text: string }>(items: Item[], query: string, count: number): Item[] {
    const preparedQuery = prepareQuery(query);
    const scored = items.flatMap(item => {
        const [score] = scoreFuzzy2(item.text, preparedQuery);

        return score === undefined ? [] : [{ item, score }];
    });

    return scored.sort((first, second) => second.score - first.score).slice(0, count).map(({ item }) => item);
}
