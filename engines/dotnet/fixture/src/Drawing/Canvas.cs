using Shapes;
using System;

namespace Drawing;

public class Canvas
{
    private static int created;

    private readonly Shape[] shapes;

    static Canvas()
    {
        created = Environment.ProcessorCount;
    }

    public Canvas(int size)
    {
        shapes = new Shape[size];
        created++;
    }

    public static int Created
    {
        get { return created; }
    }

    public int Size => shapes.Length;

    public Shape this[int index]
    {
        get => shapes[index];
        set => shapes[index] = value;
    }
}
