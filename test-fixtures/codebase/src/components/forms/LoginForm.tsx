/**
 * Login form component for user authentication.
 * Handles email and password submission.
 */
import React, {useState} from 'react';
import {Input} from '../Input';
import {Button} from '../Button';

type LoginFormProps = {
	onSubmit: (email: string, password: string) => Promise<void>;
};

export function LoginForm({onSubmit}: LoginFormProps) {
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [loading, setLoading] = useState(false);

	const handleSubmit = async () => {
		setLoading(true);
		try {
			await onSubmit(email, password);
		} finally {
			setLoading(false);
		}
	};

	return (
		<form className="login-form">
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
			<Button variant="primary" onClick={handleSubmit} disabled={loading}>
				{loading ? 'Logging in...' : 'Login'}
			</Button>
		</form>
	);
}

export default LoginForm;
