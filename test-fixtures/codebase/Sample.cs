using System;

namespace Sample
{
    /// <summary>
    /// Sample C# class for testing.
    /// Demonstrates various C# features.
    /// </summary>
    public class Greeter
    {
        private string _name;

        /// <summary>
        /// Creates a new Greeter instance.
        /// </summary>
        /// <param name="name">The name to greet.</param>
        public Greeter(string name)
        {
            _name = name;
        }

        /// <summary>
        /// Returns a greeting message.
        /// </summary>
        /// <returns>A greeting string.</returns>
        [Obsolete("Use GreetFormal instead")]
        public string Greet()
        {
            return $"Hello, {_name}!";
        }

        /// <summary>
        /// Returns a formal greeting.
        /// </summary>
        public string GreetFormal()
        {
            return $"Greetings, {_name}.";
        }

        private void InternalMethod()
        {
            // Private method
        }
    }

    /// <summary>
    /// Internal helper class.
    /// </summary>
    internal class PrivateHelper
    {
        public static int Add(int a, int b)
        {
            return a + b;
        }

        private static int Multiply(int a, int b)
        {
            return a * b;
        }
    }

    /// <summary>
    /// Public interface for services.
    /// </summary>
    [Serializable]
    public interface IService
    {
        /// <summary>
        /// Executes the service.
        /// </summary>
        void Execute();
    }

    /// <summary>
    /// Data processor class.
    /// </summary>
    public static class DataProcessor
    {
        /// <summary>
        /// Processes input data.
        /// </summary>
        [System.Diagnostics.Conditional("DEBUG")]
        public static void Process(string data)
        {
            Console.WriteLine(data);
        }
    }
}
