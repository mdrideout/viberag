/**
 * Input component for form text fields.
 * Supports validation and error display.
 */
import React from 'react';

type InputProps = {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	error?: string;
	type?: 'text' | 'password' | 'email';
};

export function Input({
	value,
	onChange,
	placeholder,
	error,
	type = 'text',
}: InputProps) {
	return (
		<div className="input-wrapper">
			<input
				type={type}
				value={value}
				onChange={e => onChange(e.target.value)}
				placeholder={placeholder}
				className={error ? 'input-error' : ''}
			/>
			{error && <span className="error-message">{error}</span>}
		</div>
	);
}

export default Input;
