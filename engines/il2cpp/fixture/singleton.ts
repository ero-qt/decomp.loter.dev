import { fieldAttributes, type FixtureImage, type FixtureType, methodAttributes, rgctxKinds, typeAttributes } from './model';

const accessor = methodAttributes.public | methodAttributes.hideBySig | methodAttributes.specialName | methodAttributes.static;
const singleton = 'Shapes.Singleton`1';
const parameter = `${singleton}!0`;

function classType(fullName: string, parts: Partial<FixtureType>): FixtureType {
    const dot = fullName.lastIndexOf('.');

    return {
        namespace: fullName.slice(0, dot),
        name: fullName.slice(dot + 1),
        kind: 'class',
        flags: typeAttributes.public,
        base: 'System.Object',
        interfaces: [],
        declaringType: null,
        fields: [],
        methods: [],
        properties: [],
        ...parts,
    };
}

// the code of `Board.Largest`, which reads `Singleton<Circle>.Instance.Radius` like the code that IL2CPP inlines from
// the code that the instances of `Singleton<T>` share. That code finds the class `Singleton<Circle>` in the runtime
// generic context of the class of the getter's `MethodInfo`, and runs each class's static constructor first.
const code = `
// has the members of Unity 2022.3's \`Il2CppClass\` from \`static_fields\` to the bit fields
struct RuntimeClass {
	void *head[23];
	void *static_fields;
	struct RuntimeClass **rgctx_data;
	void *typeHierarchy;
	void *unity_user_data;
	unsigned initializationExceptionGCHandle;
	unsigned cctor_started;
	unsigned cctor_finished;
	__attribute__((aligned(8))) usize cctor_thread;
	void *genericContainerHandle;
	unsigned sizes[10];
	unsigned short counts[8];
	unsigned char depths[5];
	unsigned char bitflags1;
};

struct MethodInfo {
	void *methodPointer;
	void *virtualMethodPointer;
	void *invoker_method;
	const char *name;
	struct RuntimeClass *klass;
};

struct SingletonStatics { struct Circle *instance; };

// the global of the first method spec, \`Singleton<Circle>.get_Instance\`
const struct MethodInfo *Singleton_get_Instance_Method = (const struct MethodInfo *)USAGE(6, 0);

__attribute__((noinline)) void vm_class_setup(struct RuntimeClass *klass)
{
	klass->bitflags1 |= 1;
	vm_state += 7;
}

// returns the class once its static constructor ran, like IL2CPP's \`InitFromCodegenSlow\`, which raises the error of a
// static constructor that failed. The empty asm hides that the class comes back, so the callers use the returned class
// like a build's code.
__attribute__((noinline)) struct RuntimeClass *codegen_initialized_type_info(struct RuntimeClass *klass)
{
	vm_class_setup(klass);
	if (klass->initializationExceptionGCHandle) {
		vm_raise(klass->unity_user_data);
	}
	__asm__ volatile("" : "+r"(klass));
	return klass;
}

static inline struct RuntimeClass *initialized_type_info(struct RuntimeClass *klass)
{
	return klass->bitflags1 & 1 ? klass : codegen_initialized_type_info(klass);
}

METHOD int Shapes_Board__get_Largest(const void *method)
{
	struct RuntimeClass *singleton = initialized_type_info(initialized_type_info(Singleton_get_Instance_Method->klass)->rgctx_data[0]);
	struct Circle *circle = ((struct SingletonStatics *)singleton->static_fields)->instance;
	if (!circle) {
		codegen_raise_null();
	}
	return circle->radius;
}
`;

/**
 * The types of a generic singleton, `Singleton<T>` with the static field `instance` and its property `Instance`, and
 * of `Board`, whose static property `Largest` reads `Singleton<Circle>.Instance.Radius` through the runtime generic
 * context of `Singleton<Circle>`, with the code of `Largest`.
 */
export const singletonGame: Required<Pick<FixtureImage, 'types' | 'code' | 'methodSpecs'>> = {
    types: [
        classType(singleton, {
            genericParameters: ['T'],
            fields: [{ name: 'instance', type: parameter, flags: fieldAttributes.private | fieldAttributes.static }],
            methods: [{ name: 'get_Instance', returnType: parameter, parameters: [], flags: accessor, hasBody: false }],
            properties: [{ name: 'Instance', getter: 'get_Instance', setter: null }],
            rgctx: [{ kind: rgctxKinds.class, type: `${singleton}<${parameter}>` }],
        }),
        classType('Shapes.Board', {
            methods: [
                {
                    name: 'get_Largest',
                    returnType: 'System.Int32',
                    parameters: [],
                    flags: accessor,
                    hasBody: true,
                    code: 'Shapes_Board__get_Largest',
                },
            ],
            properties: [{ name: 'Largest', getter: 'get_Largest', setter: null }],
        }),
    ],
    code,
    methodSpecs: [{ method: `${singleton}.get_Instance`, classArguments: ['Shapes.Circle'] }],
};
