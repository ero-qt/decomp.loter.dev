import { parseTarget } from './document';
import type { Engine } from './engine';

type Value<Method extends keyof Engine> = Awaited<ReturnType<Engine[Method]>>;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isStringOrNull(value: unknown): value is string | null {
    return value === null || isString(value);
}

function isRowTarget(value: unknown): value is string {
    try {
        return isString(value) && 'fileId' in parseTarget(value);
    } catch {
        return false;
    }
}

function isListOf(value: unknown, isItem: (item: unknown) => boolean): boolean {
    return Array.isArray(value) && value.every(item => isItem(item));
}

function isFactPair(value: unknown): boolean {
    return isListOf(value, isString) && (value as unknown[]).length === 2;
}

function isMissingFile(value: unknown): boolean {
    return isObject(value) && isString(value.name) && isString(value.reason) && typeof value.isCompanion === 'boolean';
}

function isRanges(value: unknown): boolean {
    return value instanceof Int32Array && value.length > 0 && value.length % 3 === 0 && value.every(item => item >= 0);
}

function isReference(value: unknown): boolean {
    return isObject(value) && isRowTarget(value.user) && (value.ranges === null || isRanges(value.ranges));
}

function isStringUse(value: unknown): boolean {
    return isObject(value) && isString(value.text) && (value.user === null || isRowTarget(value.user));
}

// field -> the test of the field's value and the text that describes a broken value
type FieldRules = Record<string, [test: (value: unknown) => boolean, broken: string]>;

const listingRules: FieldRules = {
    values: [value => value instanceof Int32Array, "values that aren't an Int32Array"],
    names: [Array.isArray, "names that aren't a list"],
    details: [Array.isArray, "details that aren't a list"],
    note: [isString, "a note that isn't a string"],
    missingFiles: [value => isListOf(value, isMissingFile), "a missing file that isn't a name, a reason and isCompanion"],
};

const documentRules: FieldRules = {
    text: [isString, "a text that isn't a string"],
    tokens: [value => value instanceof Int32Array, "tokens that aren't an Int32Array"],
    targets: [value => isListOf(value, isString), "targets that aren't a list of strings"],
    locals: [value => isListOf(value, isString), "locals that aren't a list of strings"],
};

const descriptionRules: FieldRules = {
    text: [isString, "a text that isn't a string"],
    container: [isStringOrNull, "a container that isn't a string or null"],
    facts: [value => isListOf(value, isFactPair), "facts that aren't a list of 2 strings each"],
    missingFile: [isStringOrNull, "a missing file that isn't a string or null"],
};

function readFields(method: string, value: unknown, rules: FieldRules): unknown {
    if (!isObject(value)) {
        throw new Error(`the reply of ${method} isn't an object`);
    }

    for (const [field, [test, broken]] of Object.entries(rules)) {
        if (!test(value[field])) {
            throw new Error(`the reply of ${method} has ${broken}`);
        }
    }

    return value;
}

function requireValue(method: string, value: unknown, test: (value: unknown) => boolean, broken: string): unknown {
    if (!test(value)) {
        throw new Error(`the reply of ${method} ${broken}`);
    }

    return value;
}

const brokenReferences = "isn't a list of row targets, each with ranges or null";
const brokenStrings = "isn't a list of texts, each with a row target or null as its user";

/**
 * Returns the value of an engine's reply to a call and throws an `Error`, not an `EngineError`, for a value that breaks
 * the contract, like a description whose container isn't a string or `null`. Doesn't check the values of `open`,
 * `close` and `provide`.
 */
export function readReplyValue<Method extends keyof Engine>(method: Method, value: unknown): Value<Method> {
    switch (method) {
        case 'claims':
            return requireValue(method, value, item => typeof item === 'boolean', "isn't a boolean") as Value<Method>;
        case 'list':
            return readFields(method, value, listingRules) as Value<Method>;
        case 'read':
            return readFields(method, value, documentRules) as Value<Method>;
        case 'describe':
            return (value === null ? null : readFields(method, value, descriptionRules)) as Value<Method>;
        case 'resolve':
            return requireValue(method, value, item => item === null || isRowTarget(item), "isn't a row target or null") as Value<Method>;
        case 'findReferences':
            return requireValue(method, value, item => isListOf(item, isReference), brokenReferences) as Value<Method>;
        case 'listStrings':
            return requireValue(method, value, item => isListOf(item, isStringUse), brokenStrings) as Value<Method>;
        default:
            return value as Value<Method>;
    }
}
