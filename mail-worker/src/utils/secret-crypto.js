const ENCRYPTION_PREFIX = 'v1';
const KEY_CONTEXT = 'cloud-mail-plus:ai-config:v1';

function bytesToBase64Url(bytes) {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveKey(secret) {
	if (typeof secret !== 'string' || secret.length < 32) {
		throw new Error('Server encryption secret is not configured');
	}
	const material = new TextEncoder().encode(`${KEY_CONTEXT}\0${secret}`);
	const digest = await crypto.subtle.digest('SHA-256', material);
	return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value, serverSecret) {
	if (!value) return '';
	const key = await deriveKey(serverSecret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(value);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(KEY_CONTEXT) },
		key,
		plaintext,
	);
	return `${ENCRYPTION_PREFIX}:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(value, serverSecret) {
	if (!value) return '';
	const [version, encodedIv, encodedCiphertext, ...rest] = String(value).split(':');
	if (version !== ENCRYPTION_PREFIX || !encodedIv || !encodedCiphertext || rest.length > 0) {
		throw new Error('Encrypted secret has an unsupported format');
	}
	try {
		const key = await deriveKey(serverSecret);
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: base64UrlToBytes(encodedIv),
				additionalData: new TextEncoder().encode(KEY_CONTEXT),
			},
			key,
			base64UrlToBytes(encodedCiphertext),
		);
		return new TextDecoder().decode(plaintext);
	} catch (error) {
		throw new Error('Saved AI API key cannot be decrypted', { cause: error });
	}
}

