//! Sample Rust module for testing.
//!
//! This module demonstrates various Rust features.

/// A greeter struct that holds a name.
/// Used for generating greeting messages.
#[derive(Debug, Clone)]
pub struct Greeter {
    name: String,
}

impl Greeter {
    /// Creates a new Greeter instance.
    pub fn new(name: &str) -> Self {
        Greeter {
            name: name.to_string(),
        }
    }

    /// Returns a greeting message.
    pub fn greet(&self) -> String {
        format!("Hello, {}!", self.name)
    }

    fn private_method(&self) -> &str {
        &self.name
    }
}

/// A private struct for internal use.
struct PrivateHelper {
    value: i32,
}

impl PrivateHelper {
    fn calculate(&self, x: i32) -> i32 {
        self.value + x
    }
}

/// Add two numbers together.
/// Returns the sum of a and b.
#[inline]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn private_function() -> i32 {
    42
}

/// Process data with validation.
#[must_use]
pub fn process_data(data: &str) -> Option<String> {
    if data.is_empty() {
        None
    } else {
        Some(data.to_uppercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(2, 2), 4);
    }

    #[test]
    fn test_greeter() {
        let g = Greeter::new("World");
        assert_eq!(g.greet(), "Hello, World!");
    }
}
