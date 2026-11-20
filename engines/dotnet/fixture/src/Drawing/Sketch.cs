using Shapes;

namespace Drawing;

public class Sketch : ILayer
{
    private static readonly string[] names = { "draft", "final" };

    public string Name => names[0];

    public Point Origin { get; set; } = new Point(1, 2) + 3;
}
