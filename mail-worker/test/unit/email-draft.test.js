import { describe, expect, it } from 'vitest';
import { buildDraftRow } from '../../src/service/email-service';
import { emailConst, isDel } from '../../src/const/entity-const';

describe('AI email draft persistence', () => {
	it('stores the recipient in both searchable and native email formats', () => {
		const row = buildDraftRow({
			userId: 7,
			accountId: 3,
			toEmail: ' sender@example.com ',
			toName: 'Sender',
			subject: 'Re: Received?',
			content: '<p>Received.</p>',
			text: 'Received.',
			inReplyTo: '<message@example.com>',
			relation: '<message@example.com>',
			aiMetadata: '{"source":"tool"}',
		});

		expect(row).toMatchObject({
			userId: 7,
			accountId: 3,
			toEmail: 'sender@example.com',
			toName: 'Sender',
			cc: '[]',
			bcc: '[]',
			type: emailConst.type.SEND,
			status: emailConst.status.SAVING,
			isDel: isDel.NORMAL,
		});
		expect(JSON.parse(row.recipient)).toEqual([
			{ address: 'sender@example.com', name: 'Sender' },
		]);
	});

	it('never writes a null recipient collection', () => {
		const row = buildDraftRow({ userId: 7 });
		expect(row.recipient).toBe('[]');
		expect(row.cc).toBe('[]');
		expect(row.bcc).toBe('[]');
	});
});
