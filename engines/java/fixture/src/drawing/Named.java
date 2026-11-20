package drawing;

public sealed interface Named permits Color, Level {
    default String label() {
        return toString().toLowerCase();
    }
}
