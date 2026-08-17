import { describe, expect, it, vi } from 'vitest';
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';
import { createOpenAICompatibleModel } from '../../src/agent/openai-compatible-language-model';

function jsonResponse(body, init = {}) {
	return new Response(JSON.stringify(body), {
		status: init.status || 200,
		headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
	});
}

describe('OpenAI-compatible LanguageModelV3 adapter', () => {
	it('calls fetch with the Cloudflare-compatible global receiver', async () => {
		const receiverSensitiveFetch = vi.fn(function () {
			if (this !== globalThis) throw new TypeError('Illegal invocation');
			return jsonResponse({
				choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
				usage: {},
			});
		});
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1', apiKey: 'key', modelId: 'compatible-model',
			fetch: receiverSensitiveFetch,
		});
		await expect(model.doGenerate({ prompt: [] })).resolves.toMatchObject({
			content: [{ type: 'text', text: 'OK' }],
		});
		expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
	});

	it('works through AI SDK generateText and uses GPT-5 request conventions', async () => {
		const fetchMock = vi.fn(async (_url, init) => {
			const request = JSON.parse(init.body);
			expect(request.model).toBe('gpt-5.6-terra');
			expect(request.messages[0]).toEqual({ role: 'developer', content: 'Be concise.' });
			expect(request.max_completion_tokens).toBe(32);
			expect(request).not.toHaveProperty('temperature');
			expect(init.headers.Authorization).toBe('Bearer sk-secret');
			return jsonResponse({
				id: 'chatcmpl-1', model: 'gpt-5.6-terra', created: 1,
				choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 4, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1 } },
			});
		});
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1/', apiKey: 'sk-secret', modelId: 'gpt-5.6-terra', fetch: fetchMock,
		});

		const generated = await generateText({
			model,
			system: 'Be concise.',
			prompt: 'Say OK',
			maxOutputTokens: 32,
			temperature: 0.8,
		});

		expect(generated.text).toBe('OK');
		expect(generated.usage.inputTokens).toBe(4);
		expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/chat/completions', expect.any(Object));
	});

	it('converts non-streaming tool calls', async () => {
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1', apiKey: 'key', modelId: 'compatible-model',
			fetch: async () => jsonResponse({
				choices: [{
					message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":7}' } }] },
					finish_reason: 'tool_calls',
				}],
				usage: {},
			}),
		});
		const result = await model.doGenerate({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Find it' }] }],
			tools: [{ type: 'function', name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
		});
		expect(result.content).toContainEqual({
			type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: '{"id":7}',
		});
		expect(result.finishReason.unified).toBe('tool-calls');
	});

	it('parses SSE text and buffered tool-call deltas', async () => {
		const chunks = [
			'data: {"id":"chatcmpl-2","model":"compatible-model","choices":[{"delta":{"content":"Hi "}}]}\n\n',
			'data: {"choices":[{"delta":{"content":"there","tool_calls":[{"index":0,"id":"call-2","function":{"name":"look","arguments":"{\\"id\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"9}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n',
			'data: [DONE]\n\n',
		];
		const body = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1', apiKey: 'key', modelId: 'compatible-model',
			fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
		});
		const result = await model.doStream({
			prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
		});
		const parts = [];
		for await (const part of result.stream) parts.push(part);
		expect(parts.filter(part => part.type === 'text-delta').map(part => part.delta).join('')).toBe('Hi there');
		expect(parts).toContainEqual({
			type: 'tool-call', toolCallId: 'call-2', toolName: 'lookup', input: '{"id":9}',
		});
		expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } });
	});

	it('executes streamed tool calls through AI SDK', async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(
					'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-3","function":{"name":"lookup","arguments":"{\\"id\\":9}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
					'data: [DONE]\n\n',
				));
				controller.close();
			},
		});
		const execute = vi.fn(async ({ id }) => ({ found: id }));
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1', apiKey: 'key', modelId: 'compatible-model',
			fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
		});
		const generated = streamText({
			model,
			prompt: 'Find 9',
			tools: {
				lookup: tool({
					description: 'Lookup by id',
					inputSchema: z.object({ id: z.number() }),
					execute,
				}),
			},
		});
		const parts = [];
		for await (const part of generated.fullStream) parts.push(part);
		expect(execute).toHaveBeenCalledWith({ id: 9 }, expect.any(Object));
		expect(parts.some(part => part.type === 'tool-result')).toBe(true);
	});

	it('returns provider errors without exposing the API key', async () => {
		const model = createOpenAICompatibleModel({
			baseURL: 'https://api.example.com/v1', apiKey: 'super-secret-key', modelId: 'model',
			fetch: async () => jsonResponse({ error: { message: 'quota exceeded' } }, { status: 429 }),
		});
		await expect(model.doGenerate({ prompt: [] })).rejects.toMatchObject({ message: 'quota exceeded', statusCode: 429 });
		await expect(model.doGenerate({ prompt: [] })).rejects.not.toThrow(/super-secret-key/);
	});
});
