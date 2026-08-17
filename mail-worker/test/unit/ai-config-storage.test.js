import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	row: {},
	refresh: vi.fn(),
}));

vi.mock('../../src/service/setting-service', () => ({
	default: {
		query: async () => state.row,
		refresh: state.refresh,
	},
}));

vi.mock('../../src/entity/setting', () => ({ default: {} }));

vi.mock('../../src/entity/orm', () => ({
	default: () => ({
		update: () => ({
			set: values => ({
				run: async () => { Object.assign(state.row, values); },
			}),
		}),
	}),
}));

const { default: aiConfigService } = await import('../../src/service/ai-config-service');

beforeEach(() => {
	state.row = {
		aiProvider: 'workers-ai',
		aiModel: '@cf/zai-org/glm-4.7-flash',
		aiBaseUrl: 'https://api.openai.com/v1',
		aiApiKeyEncrypted: '',
	};
	state.refresh.mockReset();
});

describe('AI configuration storage', () => {
	it('encrypts API keys and returns only a configured flag', async () => {
		const c = { env: { jwt_secret: 'a'.repeat(64) } };
		const saved = await aiConfigService.save(c, {
			aiProvider: 'openai-compatible',
			aiModel: 'gpt-5.6-terra',
			aiBaseUrl: 'https://api.openai.com/v1',
			aiApiKey: 'sk-private-value',
		});

		expect(state.row.aiApiKeyEncrypted).toMatch(/^v1:/);
		expect(state.row.aiApiKeyEncrypted).not.toContain('sk-private-value');
		expect(saved).toMatchObject({
			aiProvider: 'openai-compatible',
			aiModel: 'gpt-5.6-terra',
			aiApiKeyConfigured: true,
			aiReady: true,
		});
		expect(saved).not.toHaveProperty('aiApiKeyEncrypted');
		expect(saved).not.toHaveProperty('aiApiKey');
		expect(state.refresh).toHaveBeenCalledOnce();
	});

	it('does not erase a saved key when the password field is left blank', async () => {
		const c = { env: { jwt_secret: 'a'.repeat(64) } };
		await aiConfigService.save(c, {
			aiProvider: 'openai-compatible', aiModel: 'model', aiApiKey: 'first-key',
		});
		const encrypted = state.row.aiApiKeyEncrypted;
		await aiConfigService.save(c, {
			aiProvider: 'openai-compatible', aiModel: 'model', aiApiKey: '',
		});
		expect(state.row.aiApiKeyEncrypted).toBe(encrypted);
	});
});
