function emptyUsage(raw) {
	const cachedTokens = raw?.prompt_tokens_details?.cached_tokens;
	return {
		inputTokens: {
			total: raw?.prompt_tokens,
			noCache: raw?.prompt_tokens === undefined
				? undefined
				: Math.max(0, raw.prompt_tokens - (cachedTokens || 0)),
			cacheRead: cachedTokens,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: raw?.completion_tokens,
			text: raw?.completion_tokens,
			reasoning: raw?.completion_tokens_details?.reasoning_tokens,
		},
		raw: raw || undefined,
	};
}

function mapFinishReason(reason) {
	const unified = {
		stop: 'stop',
		length: 'length',
		content_filter: 'content-filter',
		tool_calls: 'tool-calls',
		function_call: 'tool-calls',
	}[reason] || 'other';
	return { unified, raw: reason || undefined };
}

function resultToText(output) {
	if (!output) return '';
	if (output.type === 'text' || output.type === 'error-text') return output.value;
	if (output.type === 'json' || output.type === 'error-json') return JSON.stringify(output.value);
	if (output.type === 'execution-denied') return output.reason || 'Tool execution denied';
	if (output.type === 'content') {
		return output.value.filter(part => part.type === 'text').map(part => part.text).join('\n');
	}
	return JSON.stringify(output) ?? '';
}

function userContent(parts) {
	const content = [];
	for (const part of parts) {
		if (part.type === 'text') {
			content.push({ type: 'text', text: part.text });
			continue;
		}
		if (part.type === 'file') {
			const source = part.data instanceof URL
				? part.data.toString()
				: (typeof part.data === 'string'
					? part.data
					: `data:${part.mediaType};base64,${bytesToBase64(part.data)}`);
			if (part.mediaType?.startsWith('image/')) {
				content.push({ type: 'image_url', image_url: { url: source } });
			} else {
				content.push({ type: 'text', text: `[Unsupported attachment: ${part.filename || part.mediaType}]` });
			}
		}
	}
	if (content.length === 1 && content[0].type === 'text') return content[0].text;
	return content;
}

function bytesToBase64(bytes) {
	let binary = '';
	for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
	return btoa(binary);
}

function convertPrompt(prompt, useDeveloperRole) {
	const messages = [];
	for (const message of prompt) {
		if (message.role === 'system') {
			messages.push({ role: useDeveloperRole ? 'developer' : 'system', content: message.content });
			continue;
		}
		if (message.role === 'user') {
			messages.push({ role: 'user', content: userContent(message.content) });
			continue;
		}
		if (message.role === 'assistant') {
			const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
			const toolCalls = message.content.filter(part => part.type === 'tool-call').map(part => ({
				id: part.toolCallId,
				type: 'function',
				function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
			}));
			messages.push({
				role: 'assistant',
				content: text || null,
				...(toolCalls.length ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}
		if (message.role === 'tool') {
			for (const part of message.content) {
				if (part.type !== 'tool-result') continue;
				messages.push({
					role: 'tool',
					tool_call_id: part.toolCallId,
					content: resultToText(part.output),
				});
			}
		}
	}
	return messages;
}

function hasUnsupportedRegexFeature(pattern) {
	// OpenAI's JSON Schema regex engine does not support lookarounds or
	// backreferences. Zod's built-in email regex currently contains negative
	// lookaheads, even though the original Zod schema remains valid for local
	// tool-argument validation inside the AI SDK.
	return /\(\?(?:[=!]|<[=!])|\\[1-9]/.test(pattern);
}

function compatibleJsonSchema(value) {
	if (Array.isArray(value)) return value.map(compatibleJsonSchema);
	if (!value || typeof value !== 'object') return value;
	const compatible = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === 'pattern' && typeof child === 'string' && hasUnsupportedRegexFeature(child)) continue;
		compatible[key] = compatibleJsonSchema(child);
	}
	return compatible;
}

function convertTools(tools = []) {
	return tools.filter(tool => tool.type === 'function').map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: compatibleJsonSchema(tool.inputSchema),
			...(tool.strict === undefined ? {} : { strict: tool.strict }),
		},
	}));
}

function convertToolChoice(choice) {
	if (!choice || choice.type === 'auto') return 'auto';
	if (choice.type === 'none') return 'none';
	if (choice.type === 'required') return 'required';
	return { type: 'function', function: { name: choice.toolName } };
}

function responseFormat(format) {
	if (!format || format.type === 'text') return undefined;
	if (!format.schema) return { type: 'json_object' };
	return {
		type: 'json_schema',
		json_schema: {
			name: format.name || 'response',
			description: format.description,
			schema: compatibleJsonSchema(format.schema),
			strict: true,
		},
	};
}

function warningsFor(options) {
	const warnings = [];
	if (options.topK !== undefined) warnings.push({ type: 'unsupported', feature: 'topK' });
	if (options.seed !== undefined) warnings.push({ type: 'unsupported', feature: 'seed' });
	if (options.tools?.some(tool => tool.type === 'provider')) {
		warnings.push({ type: 'unsupported', feature: 'provider-defined tools' });
	}
	return warnings;
}

function headersObject(headers) {
	return Object.fromEntries(headers.entries());
}

function errorMessage(body, status) {
	return body?.error?.message || body?.message || `OpenAI-compatible API request failed (${status})`;
}

function isTransientError(error) {
	const status = Number(error?.statusCode || 0);
	if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
	return /(network connection lost|connection|fetch failed|socket|timed?\s*out|terminated|unexpected eof|before eof)/i
		.test(String(error?.message || error || ''));
}

async function withTransientRetry(operation, maxAttempts = 3) {
	let lastError;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			return await operation(attempt);
		} catch (error) {
			lastError = error;
			if (!isTransientError(error) || attempt === maxAttempts - 1) throw error;
			await new Promise(resolve => setTimeout(resolve, 50 * (2 ** attempt)));
		}
	}
	throw lastError;
}

export class OpenAICompatibleLanguageModel {
	constructor({ baseURL, apiKey, modelId, fetch: fetchImpl = globalThis.fetch }) {
		this.specificationVersion = 'v3';
		this.defaultObjectGenerationMode = 'json';
		this.provider = 'openai-compatible';
		this.modelId = modelId;
		this.supportedUrls = { 'image/*': [/^https:\/\//i, /^data:image\//i] };
		this.baseURL = baseURL.replace(/\/+$/, '');
		this.apiKey = apiKey;
		// Cloudflare's global fetch validates its receiver. Calling a stored
		// reference as `this.fetch()` changes that receiver to this model and
		// results in an "Illegal invocation" error at runtime.
		this.fetch = fetchImpl.bind(globalThis);
	}

	buildRequest(options, stream) {
		const tools = convertTools(options.tools);
		const body = {
			model: this.modelId,
			messages: convertPrompt(options.prompt, /^gpt-5(?:\.|-|$)/i.test(this.modelId)),
			stream,
		};
		if (options.maxOutputTokens !== undefined) {
			body[/^gpt-5(?:\.|-|$)/i.test(this.modelId) ? 'max_completion_tokens' : 'max_tokens'] = options.maxOutputTokens;
		}
		if (options.temperature !== undefined && !/^gpt-5(?:\.|-|$)/i.test(this.modelId)) body.temperature = options.temperature;
		if (options.topP !== undefined) body.top_p = options.topP;
		if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty;
		if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty;
		if (options.stopSequences?.length) body.stop = options.stopSequences;
		if (tools.length) {
			body.tools = tools;
			body.tool_choice = convertToolChoice(options.toolChoice);
		}
		const format = responseFormat(options.responseFormat);
		if (format) body.response_format = format;
		return body;
	}

	async request(options, stream) {
		const body = this.buildRequest(options, stream);
		const response = await this.fetch(`${this.baseURL}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...options.headers,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: options.abortSignal,
		});
		if (!response.ok) {
			let errorBody;
			try { errorBody = await response.json(); } catch { errorBody = undefined; }
			const error = new Error(errorMessage(errorBody, response.status));
			error.statusCode = response.status;
			throw error;
		}
		return { response, body };
	}

	async doGenerate(options) {
		return withTransientRetry(async () => {
			const { response, body } = await this.request(options, false);
			const data = await response.json();
			const choice = data.choices?.[0] || {};
			const message = choice.message || {};
			const content = [];
			const text = typeof message.content === 'string'
				? message.content
				: (Array.isArray(message.content) ? message.content.map(part => part.text || '').join('') : '');
			if (text) content.push({ type: 'text', text });
			for (const call of message.tool_calls || []) {
				content.push({
					type: 'tool-call',
					toolCallId: call.id || crypto.randomUUID(),
					toolName: call.function?.name || '',
					input: call.function?.arguments || '{}',
				});
			}
			return {
				content,
				finishReason: mapFinishReason(choice.finish_reason),
				usage: emptyUsage(data.usage),
				request: { body },
				response: {
					id: data.id,
					modelId: data.model,
					timestamp: data.created ? new Date(data.created * 1000) : undefined,
					headers: headersObject(response.headers),
					body: data,
				},
				warnings: warningsFor(options),
			};
		});
	}

	async doStream(options) {
		const warnings = warningsFor(options);
		const model = this;
		const body = this.buildRequest(options, true);
		// Buffer each upstream attempt until it reaches a valid finish signal.
		// This makes it safe to retry a dropped provider stream without emitting
		// duplicated partial text or incomplete tool-call JSON to the browser.
		const stream = new ReadableStream({
			async start(controller) {
				controller.enqueue({ type: 'stream-start', warnings });
				try {
					const parts = await withTransientRetry(async () => {
						const { response } = await model.request(options, true);
						if (!response.body) throw new Error('OpenAI-compatible API returned an empty stream');
						return collectOpenAIStream(response.body);
					});
					for (const part of parts) controller.enqueue(part);
				} catch (error) {
					controller.enqueue({ type: 'error', error });
				} finally {
					controller.close();
				}
			},
		});
		return {
			stream,
			request: { body },
			response: {},
		};
	}
}

async function collectOpenAIStream(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parts = [];
	let buffer = '';
	let textStarted = false;
	let metadataSent = false;
	let doneSignal = false;
	let finishReason;
	let usage;
	const toolCalls = new Map();

	const handleData = dataText => {
		if (!dataText) return;
		if (dataText === '[DONE]') {
			doneSignal = true;
			return;
		}
		let data;
		try { data = JSON.parse(dataText); }
		catch { return; }
		if (!metadataSent && (data.id || data.model || data.created)) {
			parts.push({
				type: 'response-metadata',
				id: data.id,
				modelId: data.model,
				timestamp: data.created ? new Date(data.created * 1000) : undefined,
			});
			metadataSent = true;
		}
		if (data.usage) usage = data.usage;
		for (const choice of data.choices || []) {
			const delta = choice.delta || {};
			if (typeof delta.content === 'string' && delta.content) {
				if (!textStarted) {
					parts.push({ type: 'text-start', id: 'text-0' });
					textStarted = true;
				}
				parts.push({ type: 'text-delta', id: 'text-0', delta: delta.content });
			}
			for (const callDelta of delta.tool_calls || []) {
				const key = callDelta.index ?? 0;
				const current = toolCalls.get(key) || { id: '', name: '', arguments: '' };
				if (callDelta.id) current.id = callDelta.id;
				if (callDelta.function?.name) current.name += callDelta.function.name;
				if (callDelta.function?.arguments) current.arguments += callDelta.function.arguments;
				toolCalls.set(key, current);
			}
			if (choice.finish_reason) finishReason = choice.finish_reason;
		}
	};

	while (!doneSignal) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() || '';
		for (const line of lines) {
			if (doneSignal) break;
			if (line.startsWith('data:')) handleData(line.slice(5).trim());
		}
	}
	if (!doneSignal && buffer.startsWith('data:')) handleData(buffer.slice(5).trim());
	if (!doneSignal && !finishReason) {
		throw new Error('OpenAI-compatible stream ended before a finish signal');
	}
	if (textStarted) parts.push({ type: 'text-end', id: 'text-0' });
	for (const call of toolCalls.values()) {
		parts.push({
			type: 'tool-call',
			toolCallId: call.id || crypto.randomUUID(),
			toolName: call.name || '',
			input: call.arguments || '{}',
		});
	}
	parts.push({
		type: 'finish',
		usage: emptyUsage(usage),
		finishReason: mapFinishReason(finishReason || (toolCalls.size ? 'tool_calls' : 'stop')),
	});
	return parts;
}

export function createOpenAICompatibleModel(config) {
	return new OpenAICompatibleLanguageModel(config);
}
