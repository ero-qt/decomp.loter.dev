import { testEngine } from '../../contract/conformance';
import { elfFixture, peFixture } from './fixture';
import { useNativeEngine } from './testing';

const connect = useNativeEngine();

testEngine('native engine with an elf file', connect, elfFixture, 120000);
testEngine('native engine with a pe file', connect, peFixture, 120000);
