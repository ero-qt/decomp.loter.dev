// types the package's JavaScript build, which the engine imports because the package's loader tries the wasm build
// first
declare module '@run-slicer/vf/vf.runtime.js' {
    export { decompile } from '@run-slicer/vf';
}
