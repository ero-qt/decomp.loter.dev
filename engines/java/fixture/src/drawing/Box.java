package drawing;

import java.util.List;
import shapes.Base;

@Marker("box")
public class Box<T> extends Base {
    private T item;
    private List<Level> levels;

    public Box(T item) {
        super(4);
        this.item = item;
    }

    public T get() {
        return item;
    }

    public int corners() {
        return sides;
    }
}
