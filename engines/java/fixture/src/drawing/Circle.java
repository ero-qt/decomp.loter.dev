package drawing;

import shapes.Shape;

public record Circle(double radius) implements Shape {
    public Circle {
        if (radius < 0) {
            throw new IllegalArgumentException("negative radius");
        }
    }

    @Override
    public double area() {
        return Math.PI * radius * radius;
    }
}
