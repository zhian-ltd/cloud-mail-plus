import { describe, expect, it } from 'vitest';
import {
	currentEmailDraftStep,
	latestUserText,
	requestsCurrentEmailReplyDraft,
} from '../../src/agent/draft-intent';

describe('agent draft intent', () => {
	it('reads the latest user text from UI message parts', () => {
		expect(latestUserText([
			{ role: 'user', parts: [{ type: 'text', text: 'old' }] },
			{ role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
			{ role: 'user', parts: [{ type: 'text', text: '拟稿左侧邮件的回复' }] },
		])).toBe('拟稿左侧邮件的回复');
	});

	it('recognizes an explicit request to draft the current email reply', () => {
		expect(requestsCurrentEmailReplyDraft('拟稿左侧邮件的回复')).toBe(true);
		expect(requestsCurrentEmailReplyDraft('Draft a reply to the current email')).toBe(true);
		expect(requestsCurrentEmailReplyDraft('总结左侧邮件')).toBe(false);
		expect(requestsCurrentEmailReplyDraft('不要拟稿，只显示这封邮件')).toBe(false);
	});

	it('forces one draftReply call and then disables further tool calls', () => {
		expect(currentEmailDraftStep({ steps: [], forceDraftReply: true })).toEqual({
			activeTools: ['draftReply'],
			toolChoice: { type: 'tool', toolName: 'draftReply' },
		});
		expect(currentEmailDraftStep({
			forceDraftReply: true,
			steps: [{ toolCalls: [{ toolName: 'draftReply' }] }],
		})).toEqual({ activeTools: [], toolChoice: 'none' });
		expect(currentEmailDraftStep({ steps: [], forceDraftReply: false })).toBeUndefined();
	});
});
