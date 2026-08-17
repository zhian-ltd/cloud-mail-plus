import { describe, expect, it, vi } from 'vitest';
import { dbInit } from '../../src/init/init';

describe('AI configuration migration', () => {
	it('adds only missing setting columns and propagates database failures', async () => {
		const executed = [];
		const columns = new Set(['ai_provider']);
		const db = {
			prepare: vi.fn(sql => ({
				all: async () => ({ results: [...columns].map(name => ({ name })) }),
				run: async () => {
					executed.push(sql);
					const added = sql.match(/ADD COLUMN\s+(\w+)/i)?.[1];
					if (added) columns.add(added);
				},
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

	it('refuses to report success when D1 does not expose the migrated columns', async () => {
		const db = {
			prepare: () => ({
				all: async () => ({ results: [] }),
				run: async () => ({}),
			}),
		};
		await expect(dbInit.v3_5DB({ env: { db } })).rejects.toThrow(/migration incomplete/i);
	});
});
