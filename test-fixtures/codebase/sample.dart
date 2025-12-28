/// Sample Dart library for testing.
///
/// This library demonstrates various Dart features.
library sample;

/// A greeter class that holds a name.
/// Used for generating greeting messages.
class Greeter {
  final String _name;

  /// Creates a new Greeter instance.
  Greeter(this._name);

  /// Returns a greeting message.
  String greet() {
    return 'Hello, $_name!';
  }

  void _privateMethod() {
    // Private method
  }
}

/// Private helper class (underscore prefix).
class _PrivateHelper {
  final int value;

  _PrivateHelper(this.value);

  int calculate(int x) {
    return value + x;
  }
}

/// Add two numbers together.
/// Returns the sum of a and b.
@pragma('vm:prefer-inline')
int add(int a, int b) {
  return a + b;
}

int _privateFunction() {
  return 42;
}

/// Process data with validation.
@Deprecated('Use processDataV2 instead')
String? processData(String data) {
  if (data.isEmpty) {
    return null;
  }
  return data.toUpperCase();
}

/// Public interface for services.
abstract class Service {
  /// Executes the service.
  void execute();
}

/// Data processor mixin.
@pragma('vm:entry-point')
mixin DataProcessorMixin {
  /// Processes the given input.
  void process(String input) {
    print(input);
  }
}
