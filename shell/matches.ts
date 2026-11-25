import { prepareQuery, scoreFuzzy2 } from './workbench-common';

/** An item whose text matches a query, with the match's score, which is higher for a better match. */
export interface ScoredMatch<Item> {
    item: Item;
    score: number;
}

/**
 * Scores the items whose text matches the query like a name in Go to Symbol in Workspace, where `GtAr` matches
 * `GetArea`, in the items' order.
 */
export function scoreMatches<Item extends { text: string }>(items: Item[], query: string): ScoredMatch<Item>[] {
    const preparedQuery = prepareQuery(query);

    return items.flatMap(item => {
        const [score] = scoreFuzzy2(item.text, preparedQuery);

        return score === undefined ? [] : [{ item, score }];
    });
}

/** Sorts scored matches with the best scores first and keeps the order of matches with the same score. */
export function sortMatches<Item>(matches: ScoredMatch<Item>[]): ScoredMatch<Item>[] {
    return matches.sort((first, second) => second.score - first.score);
}

/**
 * Picks at most `count` items whose text matches the query like `scoreMatches`. The items with the best scores come
 * first, items with the same score in the items' order.
 */
export function pickMatches<Item extends { text: string }>(items: Item[], query: string, count: number): Item[] {
    return sortMatches(scoreMatches(items, query)).slice(0, count).map(({ item }) => item);
}
