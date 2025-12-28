package sample;

/**
 * Sample Java class for testing.
 * Demonstrates various Java features including annotations.
 */
public class Sample {
    private String name;

    /**
     * Creates a new Sample instance.
     * @param name the name to use
     */
    public Sample(String name) {
        this.name = name;
    }

    /**
     * Returns a greeting message.
     * @return the greeting string
     */
    @Override
    public String toString() {
        return "Hello, " + name + "!";
    }

    /**
     * Gets the name.
     */
    public String getName() {
        return name;
    }

    private void internalMethod() {
        // Private method for internal use
    }
}

/**
 * Utility class with static methods.
 */
@Deprecated
class PrivateHelper {
    static int calculate(int a, int b) {
        return a + b;
    }

    private static void internalHelper() {
        // Private static method
    }
}

/**
 * Public interface for greeting.
 */
public interface Greeter {
    /**
     * Returns a greeting.
     */
    String greet();
}

/**
 * Add two numbers together.
 */
class MathUtils {
    /**
     * Adds two integers.
     * @param a first number
     * @param b second number
     * @return the sum
     */
    @SuppressWarnings("unused")
    public static int add(int a, int b) {
        return a + b;
    }
}
