// repeats a step 8,192 times that the compiler can't fold, so the function has more than 64 KB of code
#define STEP(n)  sink = sink * 31 + value + n;
#define STEP4(n) STEP(n) STEP(n + 1) STEP(n + 2) STEP(n + 3)
#define STEP16(n) STEP4(n) STEP4(n + 4) STEP4(n + 8) STEP4(n + 12)
#define STEP256(n) STEP16(n) STEP16(n + 16) STEP16(n + 32) STEP16(n + 48) STEP16(n + 64) STEP16(n + 80) STEP16(n + 96) \
    STEP16(n + 112) STEP16(n + 128) STEP16(n + 144) STEP16(n + 160) STEP16(n + 176) STEP16(n + 192) STEP16(n + 208) \
    STEP16(n + 224) STEP16(n + 240)
#define STEP1024(n) STEP256(n) STEP256(n + 256) STEP256(n + 512) STEP256(n + 768)

__attribute__((visibility("default"))) int big_sum(int value) {
    volatile int sink = 0;
    STEP1024(0) STEP1024(1024) STEP1024(2048) STEP1024(3072) STEP1024(4096) STEP1024(5120) STEP1024(6144) STEP1024(7168)
    return sink;
}
