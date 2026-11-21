import { checkWithFiles, type Fixture } from './checking';
import type { Engine } from './engine';
import { cutMark, maxStringLength, maxStrings } from './limits';

/**
 * Checks that the file lists at most `maxStrings` strings and that none is longer than `maxStringLength`, and for a
 * fixture with a cut string that the file lists it cut with the cut mark.
 */
export async function checkStringLimits(engine: Engine, { file, cutString }: Fixture): Promise<void> {
    await checkWithFiles(engine, [file], async fileId => {
        const texts = (await engine.listStrings(fileId)).map(({ text }) => text);
        const long = texts.find(text => text.length > maxStringLength);
        if (texts.length > maxStrings) {
            throw new Error(`${file.name} lists ${texts.length} strings, more than ${maxStrings}`);
        }
        if (long !== undefined) {
            throw new Error(`${file.name} has a string of ${long.length} characters, more than ${maxStringLength}`);
        }
        if (cutString !== undefined && !texts.some(text => text.startsWith(cutString) && text.endsWith(cutMark))) {
            throw new Error(`${file.name} doesn't list a string that starts with '${cutString}' and ends with the cut mark ${cutMark}`);
        }
    });
}
