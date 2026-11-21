// gives the tests what shapes.cpp doesn't have: overloads, a static method, a namespace whose name starts like an
// access, a call of an import and a string, and builds for every target because it uses no part of a C library
#ifdef _WIN32
#define EXPORT extern "C" __declspec(dllexport) __attribute__((noinline))
#define MEMBER __declspec(dllexport) __attribute__((noinline))
#else
#define EXPORT extern "C" __attribute__((visibility("default"), noinline))
#define MEMBER __attribute__((visibility("default"), noinline))
#endif

namespace extras {
MEMBER int scale(int value) {
    return value * 2;
}

MEMBER long scale(long value, int factor) {
    return value * factor;
}

class Counter {
public:
    MEMBER static int next(int value);
};

int Counter::next(int value) {
    return value + 1;
}
}

namespace privately {
MEMBER int helper(int value) {
    return value - 1;
}
}

EXPORT int scale_twice(int value) {
    return extras::scale(extras::scale(value)) + extras::Counter::next(value) + privately::helper(value);
}

EXPORT const char *extras_name() {
    return "extras fixture";
}

#ifndef _WIN32
// only a shared object can leave a function to the program that loads it, so only the ELF files import one
extern "C" int external_value(int value);

EXPORT int calls_external(int value) {
    return external_value(value) + 1;
}
#endif
