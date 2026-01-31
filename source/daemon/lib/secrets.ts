/**
 * Secrets Store
 *
 * Global, per-user storage for API keys used by embedding providers.
 *
 * Path: ~/.local/share/viberag/secrets/secrets.json (override via $VIBERAG_HOME)
 *
 * Notes:
 * - Keys are stored as plain text JSON (no OS keychain integration).
 * - File permissions are set to 0600 on platforms that support chmod.
 * - Project configs reference keys by id; API keys never live in project configs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {getSecretsDir, getSecretsPath} from './constants.js';
import type {EmbeddingProviderType} from '../../common/types.js';

export type CloudProvider = Exclude<EmbeddingProviderType, 'local'>;

export type ApiKeyEntry = {
	id: string;
	label: string;
	apiKey: string;
	createdAt: string;
	lastUsedAt: string | null;
};

export type ProviderSecrets = {
	defaultKeyId: string | null;
	keys: ApiKeyEntry[];
};

export type SecretsFile = {
	schemaVersion: 1;
	providers: Record<CloudProvider, ProviderSecrets>;
};

function createEmptySecretsFile(): SecretsFile {
	return {
		schemaVersion: 1,
		providers: {
			gemini: {defaultKeyId: null, keys: []},
			mistral: {defaultKeyId: null, keys: []},
			openai: {defaultKeyId: null, keys: []},
		},
	};
}

function maskApiKey(apiKey: string): string {
	const trimmed = apiKey.trim();
	if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}…`;
	return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export type ApiKeySummary = {
	id: string;
	label: string;
	preview: string;
	createdAt: string;
	lastUsedAt: string | null;
};

export async function loadSecretsFile(): Promise<SecretsFile> {
	const secretsPath = getSecretsPath();
	try {
		const raw = await fs.readFile(secretsPath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<SecretsFile>;
		const empty = createEmptySecretsFile();

		return {
			schemaVersion: 1,
			providers: {
				gemini: {
					defaultKeyId:
						parsed.providers?.gemini?.defaultKeyId ??
						empty.providers.gemini.defaultKeyId,
					keys: (
						parsed.providers?.gemini?.keys ?? empty.providers.gemini.keys
					).filter(
						(k): k is ApiKeyEntry =>
							typeof (k as ApiKeyEntry).id === 'string' &&
							typeof (k as ApiKeyEntry).apiKey === 'string',
					),
				},
				mistral: {
					defaultKeyId:
						parsed.providers?.mistral?.defaultKeyId ??
						empty.providers.mistral.defaultKeyId,
					keys: (
						parsed.providers?.mistral?.keys ?? empty.providers.mistral.keys
					).filter(
						(k): k is ApiKeyEntry =>
							typeof (k as ApiKeyEntry).id === 'string' &&
							typeof (k as ApiKeyEntry).apiKey === 'string',
					),
				},
				openai: {
					defaultKeyId:
						parsed.providers?.openai?.defaultKeyId ??
						empty.providers.openai.defaultKeyId,
					keys: (
						parsed.providers?.openai?.keys ?? empty.providers.openai.keys
					).filter(
						(k): k is ApiKeyEntry =>
							typeof (k as ApiKeyEntry).id === 'string' &&
							typeof (k as ApiKeyEntry).apiKey === 'string',
					),
				},
			},
		};
	} catch (error) {
		if (error instanceof Error && 'code' in error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				return createEmptySecretsFile();
			}
		}
		throw error;
	}
}

export async function saveSecretsFile(secrets: SecretsFile): Promise<void> {
	const secretsDir = getSecretsDir();
	await fs.mkdir(secretsDir, {recursive: true});

	const secretsPath = getSecretsPath();
	await fs.writeFile(secretsPath, JSON.stringify(secrets, null, '\t') + '\n');

	// Best-effort: restrict permissions (ignored on Windows)
	try {
		await fs.chmod(secretsPath, 0o600);
	} catch {
		// Ignore
	}
}

export async function listApiKeys(
	provider: CloudProvider,
): Promise<ApiKeySummary[]> {
	const secrets = await loadSecretsFile();
	return secrets.providers[provider].keys.map(k => ({
		id: k.id,
		label: k.label,
		preview: maskApiKey(k.apiKey),
		createdAt: k.createdAt,
		lastUsedAt: k.lastUsedAt,
	}));
}

export async function addApiKey(args: {
	provider: CloudProvider;
	apiKey: string;
	label?: string;
	makeDefault?: boolean;
}): Promise<{keyId: string}> {
	const secrets = await loadSecretsFile();
	const now = new Date().toISOString();
	const keyId = `key_${crypto.randomUUID()}`;

	const trimmed = args.apiKey.trim();
	if (!trimmed) {
		throw new Error('API key is required');
	}

	const label =
		args.label?.trim() ||
		`${args.provider}-${maskApiKey(trimmed).replace('…', '-')}`;

	secrets.providers[args.provider].keys.push({
		id: keyId,
		label,
		apiKey: trimmed,
		createdAt: now,
		lastUsedAt: null,
	});

	if (args.makeDefault ?? true) {
		secrets.providers[args.provider].defaultKeyId = keyId;
	}

	await saveSecretsFile(secrets);
	return {keyId};
}

export async function resolveApiKey(args: {
	provider: CloudProvider;
	keyId?: string;
}): Promise<string | null> {
	const secrets = await loadSecretsFile();
	const providerSecrets = secrets.providers[args.provider];
	const effectiveKeyId = args.keyId ?? providerSecrets.defaultKeyId;
	if (!effectiveKeyId) return null;

	const entry = providerSecrets.keys.find(k => k.id === effectiveKeyId);
	if (!entry) return null;
	return entry.apiKey;
}
