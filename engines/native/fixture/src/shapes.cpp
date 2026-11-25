// builds for every target because it uses no part of a C library
#if defined(_WIN32) && !defined(HIDDEN)
#define EXPORT extern "C" __declspec(dllexport) __attribute__((noinline))
#define MEMBER __declspec(dllexport) __attribute__((noinline))
#elif defined(HIDDEN)
// exports nothing, so a stripped file only keeps the RTTI of its classes
#define EXPORT extern "C" __attribute__((noinline))
#define MEMBER __attribute__((noinline))
#else
#define EXPORT extern "C" __attribute__((visibility("default"), noinline))
#define MEMBER __attribute__((visibility("default"), noinline))
#endif

namespace geometry {
class Rect {
public:
    class Corner {
    public:
        Corner(int x, int y) : x_(x), y_(y) {}
        MEMBER int distance() const;

    private:
        int x_;
        int y_;
    };

    Rect(int width, int height) : width_(width), height_(height) {}
    MEMBER long area(int scale) const;
    MEMBER Corner corner() const;

    static int count;

private:
    int width_;
    int height_;
};

int Rect::count = 3;

long Rect::area(int scale) const {
    return (long)width_ * height_ * scale + count;
}

Rect::Corner Rect::corner() const {
    return Corner(width_, height_);
}

int Rect::Corner::distance() const {
    return x_ + y_;
}

// gives the file a vtable and RTTI for each class, which a stripped file still has
class Shape {
public:
    MEMBER virtual int sides() const;
    MEMBER virtual long scaled(int scale) const;
};

class Circle : public Shape {
public:
    explicit Circle(int radius) : radius_(radius) {}
    MEMBER int sides() const override;
    MEMBER long scaled(int scale) const override;

private:
    int radius_;
};

int Shape::sides() const {
    return 0;
}

long Shape::scaled(int scale) const {
    return scale;
}

int Circle::sides() const {
    return 1;
}

long Circle::scaled(int scale) const {
    return (long)radius_ * radius_ * scale * 3;
}
}

int shape_total = 0;

// only the debug information has this function's name, because the file doesn't export it
static __attribute__((noinline)) int classify(int value) {
    switch (value) {
    case 0: return 10;
    case 1: return 22;
    case 2: return 37;
    case 3: return 41;
    default: return -1;
    }
}

EXPORT int add(int left, int right) {
    return left + right;
}

EXPORT int add_twice(int left, int right) {
    return add(add(left, right), right);
}

EXPORT long rect_area(int width, int height) {
    geometry::Rect rect(width, height);
    shape_total += 1;
    return rect.area(2) + rect.corner().distance() + classify(width);
}

EXPORT int circle_sides(int radius) {
    geometry::Circle circle(radius);
    geometry::Shape *shape = &circle;
    return shape->sides() + (int)shape->scaled(2);
}

EXPORT const char *fixture_name() {
    return "shapes fixture";
}

// ends with a jump to add in place of a call, which a decompiler that follows the jump shows as add's code
EXPORT int add_swapped(int left, int right) {
    [[clang::musttail]] return add(right, left);
}

// jumps into the middle of a loop, which C only shows with a goto
EXPORT int count_down(int value) {
    if (value > 10) {
        goto inside;
    }
    while (value > 0) {
        value -= 3;
    inside:
        value -= 1;
    }
    return value;
}
