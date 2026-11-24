// lists the address of a global 262,144 times, so the dll has a base relocation for each, like a game's binary
static int target;

#define P4 &target, &target, &target, &target
#define P64 P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4, P4
#define P1024 P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64, P64
#define P16384 P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024, P1024
#define P262144 P16384, P16384, P16384, P16384, P16384, P16384, P16384, P16384, \
    P16384, P16384, P16384, P16384, P16384, P16384, P16384, P16384

__declspec(dllexport) int *addresses[] = { P262144 };
