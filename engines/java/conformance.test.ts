import { testEngine } from '#contract/conformance';
import { fixture } from './fixture';
import { useJavaEngine } from './testing';

testEngine('java engine', useJavaEngine(), fixture, 60000);
