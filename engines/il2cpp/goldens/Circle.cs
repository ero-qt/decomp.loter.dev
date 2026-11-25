namespace Shapes;

public class Circle : Shape
{
	public static Circle unit;

	public static int[] sizes;

	public static int count;

	public int Radius { get; set; }

	public bool IsUnit
	{
		get
		{
			int iVar1;

			iVar1 = this.Radius;
			return iVar1 == 1;
		}
	}

	public Circle(int radius)
	{
		int *piVar1;

		base("shapes fixture");
		this.<Radius>k__BackingField = radius;
		piVar1 = &Circle.count;
		*piVar1 = *piVar1 + 1;
		return;
	}

	internal static void <Grow>g__Step|9_0()
	{
		return;
	}

	public static bool operator ==(Circle left, Circle right)
	{
		// Shares its code with Circle.Matches.
		return left.<Radius>k__BackingField == right.<Radius>k__BackingField;
	}

	public bool Same(Circle other)
	{
		bool bVar1;

		bVar1 = this == other;
		return bVar1;
	}

	public bool Differs(Circle other)
	{
		bool bVar1;

		bVar1 = other.IsUnit;
		return !bVar1;
	}

	public void Grow(Circle other)
	{
		int iVar1;

		if (other != null) {
			iVar1 = other.Radius;
			this.Radius = iVar1 + 2;
			return;
		}
		throw new NullReferenceException();
	}

	public override string Describe()
	{
		string pSVar1;

		pSVar1 = base.Describe();
		return pSVar1;
	}

	public static Circle Unit()
	{
		Circle __this;
		void *in_R8;

		__this = new Circle(1);
		Circle.unit = __this;
		return __this;
	}

	public static int Total()
	{
		int[] piVar1;
		int iVar2;
		long iVar3;

		piVar1 = Circle.sizes;
		if (piVar1 != null) {
			iVar2 = 0;
			if (0 < (long)piVar1.Length) {
				iVar3 = 0;
				do {
					iVar2 = iVar2 + piVar1[iVar3];
					iVar3 = iVar3 + 1;
				} while (piVar1.Length != iVar3);
			}
			return iVar2;
		}
		throw new NullReferenceException();
	}

	public static bool TryFind(int radius, ref bool found)
	{
		*found = radius == 1;
		return 0 < radius;
	}

	public static int Find(int radius)
	{
		int iVar1;
		void *in_R8;
		bool var_9h;

		var_9h = false;
		Circle.TryFind(radius, &var_9h);
		iVar1 = -1;
		if (var_9h != false) {
			iVar1 = radius;
		}
		return iVar1;
	}

	public static bool Matches(Circle left, Circle right)
	{
		// Shares its code with Circle.op_Equality.
		return left.<Radius>k__BackingField == right.<Radius>k__BackingField;
	}

	public static int Larger(int first, int second)
	{
		// Shares its code with Square.Bigger.
		if (second < first) {
			second = first;
		}
		return second;
	}

	public Circle()
	{
		// Shares its code with Square.Square, Square.Clear.
		return;
	}

	public void Wipe()
	{
		this.shared_0();
		return;
	}
}
