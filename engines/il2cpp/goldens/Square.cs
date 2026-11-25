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

		iVar1 = this.shared_0();
		return iVar1 * 2;
	}
}
