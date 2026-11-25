// the symbols of an operator's name, like `()` in `operator()(int)` or `<<` in `operator<<(int)`, which would else
// count as parameters or template arguments
const operatorSymbols = /^(\(\)|\[\]|[-+*/%^&|~!=<>,]+)/;
// the word `operator` as a whole, so a name like `operators` or `operator_table` isn't an operator
const operatorWord = /operator(?![A-Za-z0-9_])/y;
const opening = '<([{`';
const closing = ">)]}'";

/**
 * Splits a demangled name into its scopes and drops its parameters and return type, like `int a::B<c::D>::f(int)` into
 * `a`, `B<c::D>` and `f`. Keeps `::` inside template arguments, parameters and MSVC quotes like
 * `` `anonymous namespace' ``.
 */
export function splitName(name: string): string[] {
    const scopes: string[] = [];
    let start = 0;
    let depth = 0;
    let isOperator = false;

    let index = 0;
    for (; index < name.length; index++) {
        const character = name[index];
        operatorWord.lastIndex = index;
        if (depth === 0 && index === start && operatorWord.test(name)) {
            isOperator = true;
            index += 'operator'.length + (operatorSymbols.exec(name.slice(index + 'operator'.length))?.[0].length ?? 0) - 1;
        } else if (character === '(' && depth === 0 && index > start) {
            break;
        } else if (opening.includes(character)) {
            depth++;
        } else if (closing.includes(character)) {
            depth--;
        } else if (depth === 0 && name.startsWith('::', index) && !isOperator) {
            // keeps the scopes of a conversion operator's type, like `std::string` in `operator std::string`, because
            // an operator is the last scope
            scopes.push(name.slice(start, index));
            start = index + 2;
            index++;
        } else if (depth === 0 && character === ' ' && !isOperator) {
            // drops the return type or the qualifier in front of the name, like `int` or `const`
            scopes.length = 0;
            start = index + 1;
        }
    }

    scopes.push(name.slice(start, index).trimEnd());

    return scopes;
}
