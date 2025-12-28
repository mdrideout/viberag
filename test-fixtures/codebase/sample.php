<?php

declare(strict_types=1);

namespace Sample;

/**
 * Sample PHP file for testing.
 * Demonstrates various PHP 8 features including attributes.
 */

/**
 * A greeter class that holds a name.
 * Used for generating greeting messages.
 */
#[AllowDynamicProperties]
class Greeter
{
    private string $name;

    /**
     * Creates a new Greeter instance.
     */
    public function __construct(string $name)
    {
        $this->name = $name;
    }

    /**
     * Returns a greeting message.
     */
    public function greet(): string
    {
        return "Hello, {$this->name}!";
    }

    private function privateMethod(): void
    {
        // Private method
    }
}

/**
 * Internal helper class.
 */
class PrivateHelper
{
    private int $value;

    public function __construct(int $value)
    {
        $this->value = $value;
    }

    public function calculate(int $x): int
    {
        return $this->value + $x;
    }

    private function internalHelper(): int
    {
        return $this->value * 2;
    }
}

/**
 * Add two numbers together.
 *
 * @param int $a First number
 * @param int $b Second number
 * @return int The sum
 */
#[Pure]
function add(int $a, int $b): int
{
    return $a + $b;
}

/**
 * Process data with validation.
 */
#[Deprecated('Use processDataV2 instead')]
function processData(string $data): ?string
{
    if (empty($data)) {
        return null;
    }
    return strtoupper($data);
}

/**
 * Public interface for services.
 */
interface Service
{
    /**
     * Executes the service.
     */
    public function execute(): void;
}

/**
 * Trait for data processing.
 */
#[Attribute]
trait DataProcessorTrait
{
    /**
     * Processes the given input.
     */
    public function process(string $input): void
    {
        echo $input;
    }
}

/**
 * Enum for status values.
 */
enum Status: string
{
    case Active = 'active';
    case Inactive = 'inactive';
}
