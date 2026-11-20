using System;

namespace Shapes;

public sealed class Circle : Shape, IMeasurable
{
    public Circle(double radius)
    {
        Radius = radius;
    }

    public double Radius { get; }

    public double Width => Radius * 2;

    public override double Area()
    {
        return Math.PI * Radius * Radius;
    }
}
