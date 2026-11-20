/// <reference types="vite/client" />
import javaGrammarUrl from '@codingame/monaco-vscode-java-default-extension/resources/java.tmLanguage.json?url';
import javaConfigurationUrl from '@codingame/monaco-vscode-java-default-extension/resources/language-configuration.json?url';

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
    java: { scopeName: 'source.java', grammarUrl: javaGrammarUrl, configurationUrl: javaConfigurationUrl },
};
