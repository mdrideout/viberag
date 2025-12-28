/// Sample Swift module for testing.
///
/// This module demonstrates various Swift features.

import Foundation

/// A greeter struct that holds a name.
/// Used for generating greeting messages.
@available(iOS 13.0, macOS 10.15, *)
public struct Greeter {
    private let name: String

    /// Creates a new Greeter instance.
    public init(name: String) {
        self.name = name
    }

    /// Returns a greeting message.
    public func greet() -> String {
        return "Hello, \(name)!"
    }

    private func privateMethod() -> String {
        return name
    }
}

/// Private helper struct.
struct PrivateHelper {
    let value: Int

    func calculate(x: Int) -> Int {
        return value + x
    }
}

/// Add two numbers together.
/// - Parameters:
///   - a: First number
///   - b: Second number
/// - Returns: The sum of a and b
@inlinable
public func add(_ a: Int, _ b: Int) -> Int {
    return a + b
}

private func privateFunction() -> Int {
    return 42
}

/// Process data with validation.
@discardableResult
public func processData(_ data: String) -> String? {
    guard !data.isEmpty else {
        return nil
    }
    return data.uppercased()
}

/// Public protocol for services.
public protocol Service {
    /// Executes the service.
    func execute()
}

/// Observable data processor class.
@MainActor
public class DataProcessor {
    /// Processes input data.
    @available(*, deprecated, message: "Use processV2 instead")
    public func process(_ data: String) {
        print(data)
    }
}
