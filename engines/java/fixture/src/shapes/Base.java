package shapes;

public abstract class Base {
    public static final String UNIT = "cm";
    protected final int sides;

    protected Base(int sides) {
        this.sides = sides;
    }
}
