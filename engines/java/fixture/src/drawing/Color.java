package drawing;

public enum Color implements Named {
    RED("red"),
    GREEN("green");

    private final String code;

    Color(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }
}
