package drawing;

import java.util.ArrayList;
import java.util.List;
import shapes.Shape;

public final class Main {
    public static final String GREETING = "héllo ✓";
    private transient int hits;
    private volatile boolean done;
    private final List<String> names = new ArrayList<>();

    public static String classify(Shape shape) {
        return shape.area() > 10 ? "large" : "small";
    }

    public static String describe(Object value) {
        return switch (value) {
            case Circle circle -> "circle of " + circle.radius() + " cm";
            case Point point -> "point";
            default -> "other";
        };
    }

    public synchronized void count() {
        hits++;
    }

    public static int sum(int... values) {
        int total = 0;
        for (int value : values) {
            total += value;
        }
        return total;
    }

    public void run() {
        Runnable task = new Runnable() {
            @Override
            public void run() {
                done = true;
            }
        };
        task.run();
        names.forEach(name -> System.out.println(name.trim()));
    }

    public static int parse(String text) {
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    public static class Entry {
        public String key;
    }

    public class Cursor {
        public int position() {
            return hits;
        }
    }
}
