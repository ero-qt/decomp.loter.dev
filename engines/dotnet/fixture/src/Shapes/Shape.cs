namespace Shapes;

public abstract class Shape
{
    public string Label { get; set; } = "shape";

    public abstract double Area();
}
