namespace Shapes;

public class Square : Shape
{
	private int side;

	public int Side
	{
		get
		{
			// Shares its code with Circle.get_Radius.
			return *(int *)((long)this + 0x18);
		}
	}

	public int Twice()
	{
		int iVar1;

		iVar1 = this.Side;
		return iVar1 * 2;
	}

	public static int Bigger(int first, int second)
	{
		// Shares its code with Circle.Larger.
		if (second < first) {
			second = first;
		}
		return second;
	}

	public int Widest(int other)
	{
		int iVar1;

		iVar1 = shared_0(other, 3);
		return iVar1;
	}

	public Square()
	{
		// Shares its code with Circle..ctor, Square.Clear.
		return;
	}

	public void Clear()
	{
		// Shares its code with Circle..ctor, Square..ctor.
		return;
	}

	public static Square Make()
	{
		Square __this;

		__this = new Square();
		return __this;
	}
}
