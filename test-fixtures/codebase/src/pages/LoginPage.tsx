/**
 * Minimal page that wires LoginForm to the auth service.
 *
 * Exists primarily as a fixture for usage extraction:
 * - import {login} from '../services/auth'
 * - login(email, password)
 */
import React from 'react';
import {LoginForm} from '../components/forms/LoginForm';
import {login} from '../services/auth';

export function LoginPage() {
	return (
		<LoginForm
			onSubmit={async (email, password) => {
				await login(email, password);
			}}
		/>
	);
}

export default LoginPage;
