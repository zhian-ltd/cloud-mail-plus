import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, normalizeModel } from '../../src/service/ai-config-service';

describe('AI config validation', () => {
	it('normalizes a public HTTPS API base URL', () => {
		expect(normalizeBaseUrl('https://api.example.com/openai/v1///')).toBe('https://api.example.com/openai/v1');
	});

	it.each([
		'http://api.example.com/v1',
		'https://localhost/v1',
		'https://127.0.0.1/v1',
		'https://user:pass@api.example.com/v1',
		'https://api.example.com/v1?token=secret',
	])('rejects unsafe base URL %s', value => {
		expect(() => normalizeBaseUrl(value)).toThrow();
	});

	it('validates model names', () => {
		expect(normalizeModel(' gpt-5.6-terra ', 'fallback')).toBe('gpt-5.6-terra');
		expect(() => normalizeModel('bad\nmodel', 'fallback')).toThrow();
	});
});
