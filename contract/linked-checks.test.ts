import { test } from 'bun:test';
import { checkLinkedFile } from './conformance';
import { fixture, testFailure, useBrokenHandlers, withoutMissingFiles } from './conformance-testing';
import { areaOutside, useFakeEngine } from './fake-testing';
import { ok } from './reply';

const connect = useFakeEngine();
const withoutMissingFile = { ...fixture, linked: { ...fixture.linked, withoutMissingFile: true } };

test('checkLinkedFile passes for an engine without missing files for a fixture whose linked file has no missing file', async () => {
    useBrokenHandlers(withoutMissingFiles);

    await checkLinkedFile(connect(), withoutMissingFile);
});

testFailure(
    'a linked file as a missing file though the fixture has withoutMissingFile',
    handlers => ({ describe: withoutMissingFiles(handlers).describe }),
    checkLinkedFile,
    "drawing.fake lists shapes.fake as a missing file, though the fixture's linked file has withoutMissingFile",
    withoutMissingFile,
);

testFailure(
    'a description with a linked file as the missing file though the fixture has withoutMissingFile',
    handlers => ({ list: withoutMissingFiles(handlers).list }),
    checkLinkedFile,
    `the description of ${areaOutside} has the missing file shapes.fake and not null`,
    withoutMissingFile,
);

testFailure(
    'a missing description of a symbol outside the open files',
    handlers => ({ ...withoutMissingFiles(handlers), describe: () => ok(null) }),
    checkLinkedFile,
    `the engine doesn't describe ${areaOutside}`,
    withoutMissingFile,
);
