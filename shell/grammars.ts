/// <reference types="vite/client" />

/**
 * A language's TextMate grammar and language configuration, which the workbench fetches for the language's first
 * document.
 */
export interface Grammar {
    scopeName: string;
    grammarUrl: string;
    configurationUrl: string;
}

/**
 * Maps a view's language to its grammar. Takes only the files' URLs from the default extension because its module
 * would add snippets and texts to the start.
 */
export const grammars: Record<string, Grammar> = {
};
