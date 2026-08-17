import { describe, expect, it, vi } from 'vitest';
import { dbInit } from '../../src/init/init';

describe('AI configuration migration', () => {
	it('adds only missing setting columns and propagates database failures', async () => {
		const executed = [];
		const db = {
			prepare: vi.fn(sql => ({
				all: async () => ({ results: [{ name: 'ai_provider' }] }),
				run: async () => { executed.push(sql); },
			})),
		};
		await dbInit.v3_5DB({ env: { db } });
		expect(executed).toHaveLength(3);
		expect(executed.join('\n')).not.toMatch(/ADD COLUMN ai_provider/);
		expect(executed.join('\n')).toMatch(/ADD COLUMN ai_model/);

		const failingDb = {
			prepare: sql => ({
				all: async () => ({ results: [] }),
				run: async () => { throw new Error(`D1 failure for ${sql}`); },
			}),
		};
		await expect(dbInit.v3_5DB({ env: { db: failingDb } })).rejects.toThrow(/D1 failure/);
	});
});
