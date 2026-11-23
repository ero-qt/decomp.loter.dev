namespace Shapes;

public abstract class Shape
{
	protected string name;

	public Shape(string name)
	{
		this.name = name;
		return;
	}

	public virtual string Describe()
	{
		return this.name;
	}
}
