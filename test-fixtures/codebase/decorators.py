"""
Decorator examples for testing decorator extraction.

This module contains functions with decorators to test
the decorator_names metadata field extraction.
"""

from functools import wraps
from typing import Callable, Any


def log_call(func: Callable) -> Callable:
    """
    Logging decorator that prints function calls.
    """
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        print(f"Calling {func.__name__}")
        result = func(*args, **kwargs)
        print(f"Finished {func.__name__}")
        return result
    return wrapper


def validate_input(func: Callable) -> Callable:
    """
    Input validation decorator.
    """
    @wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        for arg in args:
            if arg is None:
                raise ValueError("None values not allowed")
        return func(*args, **kwargs)
    return wrapper


def retry(times: int = 3):
    """
    Retry decorator with configurable attempts.
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            for i in range(times):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    if i == times - 1:
                        raise
        return wrapper
    return decorator


@log_call
def process_data(data: dict) -> dict:
    """
    Process incoming data with logging.
    Single decorator example.
    """
    return {"processed": True, **data}


@log_call
@validate_input
def transform_value(value: str) -> str:
    """
    Transform a value with multiple decorators.
    Tests multiple decorator extraction.
    """
    return value.upper()


@retry(times=5)
def fetch_remote_data(url: str) -> dict:
    """
    Fetch data from remote URL with retry.
    Tests decorator with arguments.
    """
    # Simulated fetch
    return {"url": url, "data": "fetched"}


@log_call
@validate_input
@retry(times=3)
def complex_operation(input_data: dict) -> dict:
    """
    Complex operation with multiple decorators.
    Tests extraction of many decorators.
    """
    return {"result": "success", "input": input_data}


def plain_function(x: int, y: int) -> int:
    """
    A plain function without decorators.
    Should have empty decorator_names.
    """
    return x + y
