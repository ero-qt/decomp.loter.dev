using Shapes;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Drawing;

public class Painter
{
    public event ShapeChanged Painted;

    public int Count { get; private set; }

    public void Paint(Shape shape)
    {
        Console.WriteLine("héllo ✓");
        Console.WriteLine(shape.Area());
        Count++;
        Painted?.Invoke(shape);
    }

    public T Pick<T>(T first, T second)
    {
        return Count % 2 == 0 ? first : second;
    }

    public Func<int, int> Scale(int factor)
    {
        return value => value * factor;
    }

    public int Sum(int[] values)
    {
        int Add(int total, int value)
        {
            return total + value;
        }

        int sum = 0;
        foreach (int value in values)
        {
            sum = Add(sum, value);
        }

        return sum;
    }

    public IEnumerable<int> Steps(int count)
    {
        for (int step = 0; step < count; step++)
        {
            yield return step;
        }
    }

    public async Task<int> WaitAsync()
    {
        await Task.Yield();
        return Count;
    }

    public class Brush
    {
        public Color Color { get; set; } = Color.Red;
    }
}
