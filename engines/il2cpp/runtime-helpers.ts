import { functionKinds } from './csharp-names';

// the exports of IL2CPP's API whose work a helper of the generated code does, with the helper's name in IL2CPP's
// il2cpp-codegen.h and the return type and parameters of its C signature, or without them for a helper whose functions
// differ in their parameters
const exportedHelpers: [exported: string, name: string, kind: number, returnType?: string, parameters?: string][] = [
    ['il2cpp_runtime_class_init', 'il2cpp_codegen_runtime_class_init', functionKinds.classInit, 'void ', 'void *klass'],
    ['il2cpp_object_new', 'il2cpp_codegen_object_new', functionKinds.objectNew, 'void *', 'void *klass'],
    ['il2cpp_gc_wbarrier_set_field', 'Il2CppCodeGenWriteBarrier', functionKinds.writeBarrier],
    ['il2cpp_raise_exception', 'il2cpp_codegen_raise_exception', functionKinds.raise, 'void ', 'void *exception'],
];

// the exceptions of `System` that the runtime raises for the generated code's checks, by the class's name in the
// raising function's code, with the name of the generated code's helper in il2cpp-codegen.h
const raisedExceptions: [exception: string, name: string][] = [
    ['NullReferenceException', 'il2cpp_codegen_raise_null_reference_exception'],
    ['IndexOutOfRangeException', 'il2cpp_codegen_raise_index_out_of_range_exception'],
    ['InvalidCastException', 'il2cpp_codegen_raise_invalid_cast_exception'],
    ['DivideByZeroException', 'il2cpp_codegen_raise_divide_by_zero_exception'],
    ['OverflowException', 'il2cpp_codegen_raise_overflow_exception'],
    ['ArrayTypeMismatchException', 'il2cpp_codegen_raise_array_type_mismatch_exception'],
];

const metadataHelper = 'il2cpp_codegen_initialize_runtime_metadata';

/**
 * Writes the lines of the runtime's helpers for the native engine's names, which finds each helper's functions by an
 * export of IL2CPP's API, by the name of the exception that the function raises or by the metadata global whose
 * address the function takes.
 */
export function writeHelperLines(): string[] {
    return [
        ...exportedHelpers.map(([exported, name, kind, returnType, parameters]) => {
            return `!${exported}\t${name}\t${kind}\t${parameters === undefined ? '' : `${returnType}${name}(${parameters})`}\n`;
        }),
        ...raisedExceptions.map(([exception, name]) => `^${exception}\t${name}\t${functionKinds.raise}\t\n`),
        `&\t${metadataHelper}\t${functionKinds.metadataInit}\tvoid ${metadataHelper}(void *usage)\n`,
    ];
}
