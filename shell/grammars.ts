/// <reference types="vite/client" />
import cConfigurationUrl from '@codingame/monaco-vscode-cpp-default-extension/resources/language-configuration.json?url';
import cGrammarUrl from '@codingame/monaco-vscode-cpp-default-extension/resources/c.tmLanguage.json?url';
import csharpGrammarUrl from '@codingame/monaco-vscode-csharp-default-extension/resources/csharp.tmLanguage.json?url';
import csharpConfigurationUrl from '@codingame/monaco-vscode-csharp-default-extension/resources/language-configuration.json?url';
import javaGrammarUrl from '@codingame/monaco-vscode-java-default-extension/resources/java.tmLanguage.json?url';
import javaConfigurationUrl from '@codingame/monaco-vscode-java-default-extension/resources/language-configuration.json?url';
import bytecodeConfigurationUrl from './grammars/bytecode.language-configuration.json?url';
import bytecodeGrammarUrl from './grammars/bytecode.tmLanguage.json?url';
import disassemblyConfigurationUrl from './grammars/disassembly.language-configuration.json?url';
import disassemblyGrammarUrl from './grammars/disassembly.tmLanguage.json?url';
import ilConfigurationUrl from './grammars/il.language-configuration.json?url';
import ilGrammarUrl from './grammars/il.tmLanguage.json?url';
import listingConfigurationUrl from './grammars/listing.language-configuration.json?url';
import listingGrammarUrl from './grammars/listing.tmLanguage.json?url';

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
 * Maps a view's language to its grammar, from a default extension or from the site's own files. Takes only the files'
 * URLs from a default extension because its module would add snippets and texts to the start.
 */
export const grammars: Record<string, Grammar> = {
    bytecode: { scopeName: 'source.bytecode', grammarUrl: bytecodeGrammarUrl, configurationUrl: bytecodeConfigurationUrl },
    c: { scopeName: 'source.c', grammarUrl: cGrammarUrl, configurationUrl: cConfigurationUrl },
    csharp: { scopeName: 'source.cs', grammarUrl: csharpGrammarUrl, configurationUrl: csharpConfigurationUrl },
    disassembly: { scopeName: 'source.disassembly', grammarUrl: disassemblyGrammarUrl, configurationUrl: disassemblyConfigurationUrl },
    il: { scopeName: 'source.il', grammarUrl: ilGrammarUrl, configurationUrl: ilConfigurationUrl },
    java: { scopeName: 'source.java', grammarUrl: javaGrammarUrl, configurationUrl: javaConfigurationUrl },
    listing: { scopeName: 'source.listing', grammarUrl: listingGrammarUrl, configurationUrl: listingConfigurationUrl },
};
