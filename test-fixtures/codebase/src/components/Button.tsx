/**
 * Button component for user interactions.
 * Supports primary, secondary, and danger variants.
 */
import React from 'react';

type ButtonProps = {
	variant: 'primary' | 'secondary' | 'danger';
	onClick: () => void;
	children: React.ReactNode;
	disabled?: boolean;
};

export function Button({variant, onClick, children, disabled}: ButtonProps) {
	const className = `btn btn-${variant}`;
	return (
		<button className={className} onClick={onClick} disabled={disabled}>
			{children}
		</button>
	);
}

export default Button;
