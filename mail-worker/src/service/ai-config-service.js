import { generateText } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import settingService from './setting-service';
import orm from '../entity/orm';
import setting from '../entity/setting';
import BizError from '../error/biz-error';
import { encryptSecret, decryptSecret } from '../utils/secret-crypto';
import { createOpenAICompatibleModel } from '../agent/openai-compatible-language-model';

export const AI_PROVIDER = Object.freeze({
	WORKERS: 'workers-ai',
	OPENAI_COMPATIBLE: 'openai-compatible',
});

export const DEFAULT_WORKERS_AI_MODEL = '@cf/zai-org/glm-4.7-flash';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

const PAID_WORKERS_AI_MODELS = new Set([
	'@cf/moonshotai/kimi-k2.6',
	'@cf/moonshotai/kimi-k2.7-code',
	'@cf/zai-org/glm-5.2',
]);

function normalizeProvider(value) {
	if (value === AI_PROVIDER.WORKERS || value === AI_PROVIDER.OPENAI_COMPATIBLE) return value;
	throw new BizError('Unsupported AI provider', 400);
}

function normalizeModel(value, fallback) {
	const model = String(value || fallback || '').trim();
	if (!model || model.length > 200 || /[\r\n\0]/.test(model)) {
		throw new BizError('Invalid AI model name', 400);
	}
	return model;
}

function normalizeBaseUrl(value) {
	const raw = String(value || DEFAULT_OPENAI_BASE_URL).trim();
	if (raw.length > 2048) throw new BizError('AI API Base URL is too long', 400);
	let url;
	try { url = new URL(raw); }
	catch { throw new BizError('Invalid AI API Base URL', 400); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		throw new BizError('AI API Base URL must be a public HTTPS URL without credentials, query, or fragment', 400);
	}
	const host = url.hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) {
		throw new BizError('AI API Base URL must use a public hostname', 400);
	}
	url.pathname = url.pathname.replace(/\/+$/, '');
	return url.toString().replace(/\/$/, '');
}

function rowConfig(row) {
	return {
		provider: row.aiProvider || AI_PROVIDER.WORKERS,
		model: row.aiModel || DEFAULT_WORKERS_AI_MODEL,
		baseUrl: row.aiBaseUrl || DEFAULT_OPENAI_BASE_URL,
		apiKeyEncrypted: row.aiApiKeyEncrypted || '',
	};
}

async function databaseConfig(c) {
	const row = await orm(c).select().from(setting).get();
	if (!row) throw new BizError('Database not initialized', 503);
	return rowConfig(row);
}

async function plaintextApiKey(c, encrypted) {
	if (!encrypted) return '';
	try {
		return await decryptSecret(encrypted, c.env.jwt_secret);
	} catch (error) {
		console.error('[ai-config] unable to decrypt saved API key:', error.message);
		throw new BizError('Saved AI API key cannot be decrypted; enter it again in System Settings', 503);
	}
}

const aiConfigService = {
	isPaidWorkersModel(model) {
		return PAID_WORKERS_AI_MODELS.has(model);
	},

	async publicConfig(c) {
		// AI credentials must be read from D1, the source of truth. The general
		// settings cache lives in eventually-consistent KV and can briefly return
		// the previous provider/key after an administrator saves AI settings.
		const config = await databaseConfig(c);
		const workersAiAvailable = Boolean(c.env.AI);
		const aiApiKeyConfigured = Boolean(config.apiKeyEncrypted);
		return {
			aiProvider: config.provider,
			aiModel: config.model,
			aiBaseUrl: config.baseUrl,
			aiApiKeyConfigured,
			workersAiAvailable,
			aiReady: config.provider === AI_PROVIDER.WORKERS ? workersAiAvailable : aiApiKeyConfigured,
			aiRequiresPaidPlan: config.provider === AI_PROVIDER.WORKERS && this.isPaidWorkersModel(config.model),
		};
	},

	async save(c, input = {}) {
		const current = await databaseConfig(c);
		const provider = normalizeProvider(input.aiProvider ?? current.provider);
		const model = normalizeModel(
			input.aiModel,
			provider === AI_PROVIDER.WORKERS ? DEFAULT_WORKERS_AI_MODEL : DEFAULT_OPENAI_MODEL,
		);
		const baseUrl = normalizeBaseUrl(input.aiBaseUrl ?? current.baseUrl);
		let apiKeyEncrypted = current.apiKeyEncrypted;
		if (input.clearAiApiKey === true) apiKeyEncrypted = '';
		if (typeof input.aiApiKey === 'string' && input.aiApiKey.trim()) {
			const apiKey = input.aiApiKey.trim();
			if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new BizError('Invalid AI API key', 400);
			apiKeyEncrypted = await encryptSecret(apiKey, c.env.jwt_secret);
		}
		if (provider === AI_PROVIDER.OPENAI_COMPATIBLE && !apiKeyEncrypted) {
			throw new BizError('An API key is required for the OpenAI-compatible provider', 400);
		}

		await orm(c).update(setting).set({
			aiProvider: provider,
			aiModel: model,
			aiBaseUrl: baseUrl,
			aiApiKeyEncrypted: apiKeyEncrypted,
		}).run();
		await settingService.refresh(c);
		return this.publicConfig(c);
	},

	async resolveModel(c, override = null) {
		const saved = await databaseConfig(c);
		const provider = normalizeProvider(override?.aiProvider ?? saved.provider);
		const modelId = normalizeModel(
			override?.aiModel ?? saved.model,
			provider === AI_PROVIDER.WORKERS ? DEFAULT_WORKERS_AI_MODEL : DEFAULT_OPENAI_MODEL,
		);

		if (provider === AI_PROVIDER.WORKERS) {
			if (!c.env.AI) throw new BizError('Cloudflare Workers AI binding is not configured', 503);
			const workersai = createWorkersAI({ binding: c.env.AI });
			return { provider, modelId, model: workersai(modelId) };
		}

		const baseURL = normalizeBaseUrl(override?.aiBaseUrl ?? saved.baseUrl);
		let apiKey = typeof override?.aiApiKey === 'string' ? override.aiApiKey.trim() : '';
		if (!apiKey) apiKey = await plaintextApiKey(c, saved.apiKeyEncrypted);
		if (!apiKey) throw new BizError('OpenAI-compatible API key is not configured', 503);
		return {
			provider,
			modelId,
			model: createOpenAICompatibleModel({ baseURL, apiKey, modelId }),
		};
	},

	async generate(c, options, override = null) {
		const runtime = await this.resolveModel(c, override);
		const generated = await generateText({ model: runtime.model, ...options });
		return { ...generated, provider: runtime.provider, modelId: runtime.modelId };
	},

	async test(c, input = {}) {
		const { text, provider, modelId } = await this.generate(c, {
			prompt: 'Reply with exactly: OK',
			maxOutputTokens: 16,
		}, input);
		return { provider, model: modelId, response: (text || '').trim().slice(0, 200) };
	},
};

export { normalizeBaseUrl, normalizeModel };
export default aiConfigService;
