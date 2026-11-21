import { Glob } from 'bun';

const suffix = Bun.argv[2] ?? 'test';
// leaves out the submodules in engines/native/vendor, whose tests belong to their own projects
const paths = (await Array.fromAsync(new Glob(`{contract,engines,host,release,shell}/**/*.${suffix}.ts`).scan()))
    .filter(path => !path.startsWith('engines/native/vendor/'))
    .sort();
// runs each file in its own process because a file's browser and rows then free their memory before the next file
// starts
const failedPaths = paths.filter(path => {
    return Bun.spawnSync([process.execPath, 'test', `./${path}`], { stdout: 'inherit', stderr: 'inherit' }).exitCode !== 0;
});
if (failedPaths.length > 0) {
    console.error(`${failedPaths.join(', ')} failed`);
    process.exit(1);
}
