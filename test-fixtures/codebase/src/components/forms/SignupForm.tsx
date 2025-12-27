/**
 * Signup form component for user registration.
 * Includes email, password, and password confirmation.
 */
import React, {useState} from 'react';
import {Input} from '../Input';
import {Button} from '../Button';

type SignupFormProps = {
	onSubmit: (email: string, password: string) => Promise<void>;
};

export function SignupForm({onSubmit}: SignupFormProps) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async () => {
		if (password !== confirmPassword) {
			setError('Passwords do not match');
			return;
		}
		await onSubmit(email, password);
	};

	return (
		<form className="signup-form">
			<Input
				type="email"
				value={email}
				onChange={setEmail}
				placeholder="Email"
			/>
			<Input
				type="password"
				value={password}
				onChange={setPassword}
				placeholder="Password"
			/>
			<Input
				type="password"
				value={confirmPassword}
				onChange={setConfirmPassword}
				placeholder="Confirm Password"
				error={error ?? undefined}
			/>
			<Button variant="primary" onClick={handleSubmit}>
				Sign Up
			</Button>
		</form>
	);
}

export default SignupForm;
