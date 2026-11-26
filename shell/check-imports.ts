import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
// uses TypeScript 6's language service, because TypeScript 7's only runs as a server and sorts a re-export from a
// relative path before one from a package
import ts from 'typescript-6';

// checks the folder with the tsconfig.json, which a test passes, else the repo
const args = Bun.argv.slice(2);
const shouldFix = args.includes('--fix');
const root = resolve(args.find(arg => arg !== '--fix') ?? new URL('../', import.meta.url).pathname);

// sorts like VS Code's Organize Imports without case, and a type by its name among the other names
const preferences: ts.UserPreferences = { organizeImportsIgnoreCase: true, organizeImportsTypeOrder: 'inline' };
const formatSettings = ts.getDefaultFormatCodeSettings('\n');

const { config } = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
const { fileNames, options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
const service = ts.createLanguageService({
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: fileName => (ts.sys.fileExists(fileName) ? ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8')) : undefined),
    getCurrentDirectory: () => root,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
});

function importsForEffects(fileName: string): boolean {
    const statements = service.getProgram()?.getSourceFile(fileName)?.statements ?? [];

    return statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause === undefined);
}

// sorts a file's imports without removing one, because an import that only a type uses can look unused. Leaves a file
// with an import for its effects alone because the order of such imports decides what runs first
function organize(fileName: string, text: string): string {
    if (importsForEffects(fileName)) {
        return text;
    }

    const changes = service.organizeImports({ type: 'file', fileName, mode: ts.OrganizeImportsMode.SortAndCombine }, formatSettings, preferences);
    const edits = changes.flatMap(change => change.textChanges).sort((first, second) => second.span.start - first.span.start);

    return edits.reduce((organized, { span, newText }) => organized.slice(0, span.start) + newText + organized.slice(span.start + span.length), text);
}

const unsorted = fileNames.filter(fileName => {
    const text = readFileSync(fileName, 'utf8');
    const organized = organize(fileName, text);
    if (organized !== text && shouldFix) {
        writeFileSync(fileName, organized);
    }

    return organized !== text;
});

if (unsorted.length > 0 && !shouldFix) {
    const paths = unsorted.map(fileName => relative(root, fileName)).join('\n');
    console.error(`These files' imports aren't sorted. \`bun shell/check-imports.ts --fix\` sorts them.\n${paths}`);
    process.exit(1);
}
