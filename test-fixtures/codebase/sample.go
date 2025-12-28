// Package sample provides example Go code for testing.
package sample

import "fmt"

// Greeter is an exported struct for greeting users.
// It holds a name to use in greetings.
type Greeter struct {
	name string
}

// unexportedStruct is private to this package.
type unexportedStruct struct {
	value int
}

// NewGreeter creates a new Greeter instance.
// This is a constructor function.
func NewGreeter(name string) *Greeter {
	return &Greeter{name: name}
}

// Greet returns a greeting message.
func (g *Greeter) Greet() string {
	return fmt.Sprintf("Hello, %s!", g.name)
}

// privateHelper is not exported.
func privateHelper() int {
	return 42
}

// Add adds two integers together.
func Add(a, b int) int {
	return a + b
}

// multiply is a private function.
func multiply(a, b int) int {
	return a * b
}

// ProcessData handles data processing.
// It takes a map and returns processed results.
func ProcessData(data map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})
	for k, v := range data {
		result[k] = v
	}
	return result
}
