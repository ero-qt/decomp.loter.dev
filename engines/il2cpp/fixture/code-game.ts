import { fieldAttributes, type FixtureImage, type FixtureMethod, type FixtureType, images, methodAttributes, typeAttributes } from './model';

const instance = methodAttributes.public | methodAttributes.hideBySig;
const special = instance | methodAttributes.specialName;
const constructor = special | methodAttributes.rtSpecialName;
const internal = methodAttributes.assembly | methodAttributes.hideBySig;

function method(
    owner: string,
    name: string,
    returnType: string,
    flags: number,
    parameters: [name: string, type: string][] = [],
    code = `${owner}__${name}`.replace(/[^A-Za-z0-9_]/g, '_'),
): FixtureMethod {
    return { name, returnType, parameters: parameters.map(([name, type]) => ({ name, type })), flags, hasBody: true, code };
}

function type(fullName: string, base: string, parts: Partial<FixtureType>): FixtureType {
    const dot = fullName.lastIndexOf('.');

    return {
        namespace: fullName.slice(0, dot),
        name: fullName.slice(dot + 1),
        kind: 'class',
        flags: typeAttributes.public,
        base,
        interfaces: [],
        declaringType: null,
        fields: [],
        methods: [],
        properties: [],
        ...parts,
    };
}

// each export of the API and each helper of the generated code only calls the runtime's own function, like in a build
const runtime = `
// hides the functions and globals like Unity's build of an ELF file, so the code reaches them without the linker's stubs
#ifndef _WIN32
#pragma GCC visibility push(hidden)
#endif

struct Class {
	void *head[23];
	void *static_fields;
	void *rgctx_data;
	void *typeHierarchy;
	void *unity_user_data;
	unsigned initializationExceptionGCHandle;
	unsigned cctor_started;
	unsigned cctor_finished;
};

static usize vm_state;

__attribute__((noinline)) void vm_class_init(struct Class *klass)
{
	if (!klass->cctor_started) {
		klass->cctor_started = 1;
		vm_state += 3;
	}
	klass->cctor_finished = 1;
}

__attribute__((noinline)) void *vm_object_new(struct Class *klass)
{
	vm_state += 5;
	klass->initializationExceptionGCHandle++;
	return klass->unity_user_data;
}

__attribute__((noinline)) void vm_write_barrier(void **slot)
{
	if (vm_state & 1) {
		vm_state += (usize)slot;
	}
}

__attribute__((noinline, noreturn)) void vm_raise(void *exception)
{
	for (;;) {
		vm_state = (usize)exception;
	}
}

__attribute__((noinline)) void *vm_exception_from_name(const char *name)
{
	vm_state += (usize)name[0];
	return &vm_state;
}

__attribute__((noinline)) void vm_initialize_metadata(usize *usage)
{
	if (*usage & 1) {
		vm_state ^= *usage;
		*usage = (usize)&vm_state;
	}
}

EXPORT void il2cpp_runtime_class_init(struct Class *klass) { vm_class_init(klass); }
EXPORT void *il2cpp_object_new(struct Class *klass) { return vm_object_new(klass); }
EXPORT void il2cpp_raise_exception(void *exception) { vm_raise(exception); }
EXPORT void il2cpp_gc_wbarrier_set_field(void *object, void **slot, void *value)
{
	(void)object;
	*slot = value;
	vm_write_barrier(slot);
}

__attribute__((noinline)) void codegen_class_init(struct Class *klass) { vm_class_init(klass); }
__attribute__((noinline)) void *codegen_object_new(struct Class *klass) { return vm_object_new(klass); }
__attribute__((noinline)) void codegen_write_barrier(void **slot) { vm_write_barrier(slot); }
__attribute__((noinline)) void codegen_initialize_metadata(usize *usage) { vm_initialize_metadata(usage); }
__attribute__((noinline, noreturn)) void codegen_raise_null(void) { vm_raise(vm_exception_from_name("NullReferenceException")); }
`;

// the methods as IL2CPP compiles them, with `this` first and the method's \`MethodInfo\` last
const methods = `
struct String;
struct Shape { struct Class *klass; void *monitor; struct String *name; };
struct Circle { struct Class *klass; void *monitor; struct String *name; int radius; };
// has the low half of \`max_length\` as its length, which a build's code reads as C#'s \`int\`
struct IntArray { struct Class *klass; void *monitor; void *bounds; int length; int high_length; int items[1]; };
struct CircleStatics { struct Circle *unit; struct IntArray *sizes; int count; };

struct Class *Circle_TypeInfo = (struct Class *)USAGE(1, TYPE_Shapes_Circle);
struct Class *Square_TypeInfo = (struct Class *)USAGE(1, TYPE_Shapes_Square);
struct String *Literal_0 = (struct String *)USAGE(5, 0);
static unsigned char Unit_initialized;

#define METHOD __attribute__((noinline))
#define CLASS_INIT(klass) do { if (!(klass)->cctor_finished) codegen_class_init(klass); } while (0)

METHOD void Shapes_Shape___ctor(struct Shape *this, struct String *name, const void *method)
{
	this->name = name;
	codegen_write_barrier((void **)&this->name);
}

METHOD struct String *Shapes_Shape__Describe(struct Shape *this, const void *method)
{
	return this->name;
}

METHOD int Shapes_Circle__get_Radius(struct Circle *this, const void *method)
{
	return this->radius;
}

METHOD void Shapes_Circle__set_Radius(struct Circle *this, int value, const void *method)
{
	this->radius = value;
}

METHOD _Bool Shapes_Circle__get_IsUnit(struct Circle *this, const void *method)
{
	return Shapes_Circle__get_Radius(this, 0) == 1;
}

METHOD _Bool Shapes_Circle__op_Equality(struct Circle *left, struct Circle *right, const void *method)
{
	return left->radius == right->radius;
}

METHOD _Bool Shapes_Circle__Same(struct Circle *this, struct Circle *other, const void *method)
{
	return Shapes_Circle__op_Equality(this, other, 0);
}

METHOD _Bool Shapes_Circle__Differs(struct Circle *this, struct Circle *other, const void *method)
{
	return !Shapes_Circle__get_IsUnit(other, 0);
}

METHOD void Shapes_Circle__Grow(struct Circle *this, struct Circle *other, const void *method)
{
	if (!other) {
		codegen_raise_null();
	}
	Shapes_Circle__set_Radius(this, Shapes_Circle__get_Radius(other, 0) + 2, 0);
}

METHOD struct String *Shapes_Circle__Describe(struct Circle *this, const void *method)
{
	return Shapes_Shape__Describe((struct Shape *)this, 0);
}

METHOD void Shapes_Circle___ctor(struct Circle *this, int radius, const void *method)
{
	Shapes_Shape___ctor((struct Shape *)this, Literal_0, 0);
	this->radius = radius;
	CLASS_INIT(Circle_TypeInfo);
	((struct CircleStatics *)Circle_TypeInfo->static_fields)->count++;
}

METHOD struct Circle *Shapes_Circle__Unit(const void *method)
{
	if (!Unit_initialized) {
		codegen_initialize_metadata((usize *)&Circle_TypeInfo);
		codegen_initialize_metadata((usize *)&Literal_0);
		Unit_initialized = 1;
	}

	struct Circle *circle = codegen_object_new(Circle_TypeInfo);
	Shapes_Circle___ctor(circle, 1, 0);
	CLASS_INIT(Circle_TypeInfo);
	struct CircleStatics *statics = Circle_TypeInfo->static_fields;
	statics->unit = circle;
	codegen_write_barrier((void **)&statics->unit);
	return circle;
}

METHOD void Shapes_Circle___Grow_g__Step_9_0(const void *method)
{
}

METHOD int Shapes_Circle__Total(const void *method)
{
	CLASS_INIT(Circle_TypeInfo);
	struct IntArray *sizes = ((struct CircleStatics *)Circle_TypeInfo->static_fields)->sizes;
	if (!sizes) {
		codegen_raise_null();
	}

	int total = 0;
	for (int index = 0; index < sizes->length; index++) {
		total += sizes->items[index];
	}
	return total;
}

METHOD _Bool Shapes_Circle__TryFind(int radius, _Bool *found, const void *method)
{
	*found = radius == 1;
	return radius > 0;
}

METHOD int Shapes_Circle__Find(int radius, const void *method)
{
	_Bool found = 0;
	Shapes_Circle__TryFind(radius, &found, 0);
	return found ? radius : -1;
}

METHOD int Shapes_Square__Twice(struct Circle *this, const void *method)
{
	return Shapes_Circle__get_Radius(this, 0) * 2;
}

METHOD int Shapes_Circle__Larger(int first, int second, const void *method)
{
	return first > second ? first : second;
}

METHOD int Shapes_Square__Widest(struct Circle *this, int other, const void *method)
{
	return Shapes_Circle__Larger(other, 3, 0);
}

// reads its arguments in an empty asm, so the compiler keeps the calls and their arguments like a build's empty method
METHOD void Shapes_Square___ctor(struct Circle *this, const void *method)
{
	__asm__ volatile("" : : "r"(this), "r"(method));
}

METHOD struct Circle *Shapes_Square__Make(const void *method)
{
	struct Circle *square = codegen_object_new(Square_TypeInfo);
	Shapes_Square___ctor(square, 0);
	return square;
}

METHOD void Shapes_Circle__Wipe(struct Circle *this, const void *method)
{
	Shapes_Square___ctor(this, 0);
}
`;

const shape = 'Shapes.Shape';
const circle = 'Shapes.Circle';
const square = 'Shapes.Square';

/**
 * The images of a game whose methods have code like IL2CPP's, with the runtime's helpers, metadata globals, a property
 * with a backing field, an operator, a constructor, 2 getters that share their code, `Circle.Radius` and
 * `Square.Side`, a static method that shares the operator's code, 2 static methods with the same parameters that share
 * their code, 2 empty constructors and an empty method that share their code, a local function with the compiler's name and the class of the exception that the runtime's helper
 * raises.
 */
export const codeImages: FixtureImage[] = [
    { ...images[0], types: [...images[0].types, type('System.NullReferenceException', 'System.Object', {})] },
    {
        name: 'Assembly-CSharp.dll',
        code: runtime + methods,
        types: [
            type(shape, 'System.Object', {
                flags: typeAttributes.public | typeAttributes.abstract,
                fields: [{ name: 'name', type: 'System.String', flags: fieldAttributes.family }],
                methods: [
                    method(shape, '.ctor', 'System.Void', constructor, [['name', 'System.String']]),
                    method(shape, 'Describe', 'System.String', instance | methodAttributes.virtual | methodAttributes.newSlot),
                ],
            }),
            type(circle, shape, {
                fields: [
                    { name: '<Radius>k__BackingField', type: 'System.Int32', flags: fieldAttributes.private },
                    { name: 'unit', type: circle, flags: fieldAttributes.public | fieldAttributes.static },
                    { name: 'sizes', type: 'System.Int32[]', flags: fieldAttributes.public | fieldAttributes.static },
                    { name: 'count', type: 'System.Int32', flags: fieldAttributes.public | fieldAttributes.static },
                ],
                methods: [
                    method(circle, '.ctor', 'System.Void', constructor, [['radius', 'System.Int32']]),
                    method(circle, '<Grow>g__Step|9_0', 'System.Void', internal | methodAttributes.static),
                    method(circle, 'get_Radius', 'System.Int32', special),
                    method(circle, 'set_Radius', 'System.Void', special, [['value', 'System.Int32']]),
                    method(circle, 'get_IsUnit', 'System.Boolean', special),
                    method(circle, 'op_Equality', 'System.Boolean', special | methodAttributes.static, [
                        ['left', circle],
                        ['right', circle],
                    ]),
                    method(circle, 'Same', 'System.Boolean', instance, [['other', circle]]),
                    method(circle, 'Differs', 'System.Boolean', instance, [['other', circle]]),
                    method(circle, 'Grow', 'System.Void', instance, [['other', circle]]),
                    method(circle, 'Describe', 'System.String', instance | methodAttributes.virtual),
                    method(circle, 'Unit', circle, instance | methodAttributes.static),
                    method(circle, 'Total', 'System.Int32', instance | methodAttributes.static),
                    method(circle, 'TryFind', 'System.Boolean', instance | methodAttributes.static, [
                        ['radius', 'System.Int32'],
                        ['found', 'ref System.Boolean'],
                    ]),
                    method(circle, 'Find', 'System.Int32', instance | methodAttributes.static, [['radius', 'System.Int32']]),
                    method(
                        circle,
                        'Matches',
                        'System.Boolean',
                        instance | methodAttributes.static,
                        [
                            ['left', circle],
                            ['right', circle],
                        ],
                        'Shapes_Circle__op_Equality',
                    ),
                    method(circle, 'Larger', 'System.Int32', instance | methodAttributes.static, [
                        ['first', 'System.Int32'],
                        ['second', 'System.Int32'],
                    ]),
                    method(circle, '.ctor', 'System.Void', constructor, [], 'Shapes_Square___ctor'),
                    method(circle, 'Wipe', 'System.Void', instance),
                ],
                properties: [
                    { name: 'Radius', getter: 'get_Radius', setter: 'set_Radius' },
                    { name: 'IsUnit', getter: 'get_IsUnit', setter: null },
                ],
            }),
            type(square, shape, {
                fields: [{ name: 'side', type: 'System.Int32', flags: fieldAttributes.private }],
                methods: [
                    method(square, 'get_Side', 'System.Int32', special, [], 'Shapes_Circle__get_Radius'),
                    method(square, 'Twice', 'System.Int32', instance),
                    method(
                        square,
                        'Bigger',
                        'System.Int32',
                        instance | methodAttributes.static,
                        [
                            ['first', 'System.Int32'],
                            ['second', 'System.Int32'],
                        ],
                        'Shapes_Circle__Larger',
                    ),
                    method(square, 'Widest', 'System.Int32', instance, [['other', 'System.Int32']]),
                    method(square, '.ctor', 'System.Void', constructor),
                    method(square, 'Clear', 'System.Void', instance, [], 'Shapes_Square___ctor'),
                    method(square, 'Make', square, instance | methodAttributes.static),
                ],
                properties: [{ name: 'Side', getter: 'get_Side', setter: null }],
            }),
        ],
    },
];
