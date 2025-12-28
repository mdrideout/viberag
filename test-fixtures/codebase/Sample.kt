package sample

/**
 * Sample Kotlin file for testing.
 * Demonstrates various Kotlin features including annotations.
 */

/**
 * A greeter class that holds a name.
 * Used for generating greeting messages.
 */
data class Greeter(private val name: String) {
    /**
     * Returns a greeting message.
     */
    fun greet(): String {
        return "Hello, $name!"
    }

    private fun privateMethod(): String {
        return name
    }
}

/**
 * Internal helper class.
 */
internal class PrivateHelper(private val value: Int) {
    fun calculate(x: Int): Int {
        return value + x
    }

    private fun internalHelper(): Int {
        return value * 2
    }
}

/**
 * Add two numbers together.
 * @param a First number
 * @param b Second number
 * @return The sum of a and b
 */
@Suppress("unused")
fun add(a: Int, b: Int): Int {
    return a + b
}

private fun privateFunction(): Int {
    return 42
}

/**
 * Process data with validation.
 */
@Deprecated("Use processDataV2 instead", ReplaceWith("processDataV2(data)"))
fun processData(data: String): String? {
    return if (data.isEmpty()) null else data.uppercase()
}

/**
 * Public interface for services.
 */
interface Service {
    /**
     * Executes the service.
     */
    fun execute()
}

/**
 * Object declaration for utilities.
 */
@JvmStatic
object MathUtils {
    /**
     * Multiplies two integers.
     */
    fun multiply(a: Int, b: Int): Int {
        return a * b
    }
}
