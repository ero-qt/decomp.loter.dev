import { testEngine } from '../../contract/conformance';
import { fixture } from './fixture';
import { useDotnetEngine } from './testing';

testEngine('dotnet engine', useDotnetEngine(), fixture, 120000);
