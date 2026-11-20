namespace Shapes;

public struct Point
{
    public const int Dimensions = 2;

    public int X;
    public int Y;

    public Point(int x, int y)
    {
        X = x;
        Y = y;
    }

    public static Point operator +(Point left, Point right)
    {
        return new(left.X + right.X, left.Y + right.Y);
    }

    public static implicit operator Point(int value)
    {
        return new(value, value);
    }
}
