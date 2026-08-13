import { describe, expect, it } from 'vitest';
import loginService from '../../src/service/login-service';
import JwtUtils from '../../src/utils/jwt-utils';
import KvConst from '../../src/const/kv-const';
import constant from '../../src/const/constant';

const jwtSecret = 'logout-test-jwt-secret';

async function createContext(tokens, activeToken = tokens[0]) {
	const authInfo = {
		tokens: [...tokens],
		user: { userId: 42, email: 'user@example.com' },
		refreshTime: new Date().toISOString(),
	};
	const calls = { put: [], delete: [] };
	const jwt = await JwtUtils.generateToken(
		{ env: { jwt_secret: jwtSecret } },
		{ userId: 42, token: activeToken },
	);
	const context = {
		env: {
			jwt_secret: jwtSecret,
			kv: {
				get: async key => key === KvConst.AUTH_INFO + 42 ? structuredClone(authInfo) : null,
				put: async (...args) => calls.put.push(args),
				delete: async (...args) => calls.delete.push(args),
			},
		},
		req: {
			header: name => name === constant.TOKEN_HEADER ? jwt : undefined,
		},
	};
	return { context, calls };
}

describe('local logout session revocation', () => {
	it('removes only the current token and preserves other sessions', async () => {
		const { context, calls } = await createContext(['current-token', 'other-token']);

		await loginService.logout(context, 42);

		expect(calls.delete).toEqual([]);
		expect(calls.put).toHaveLength(1);
		expect(calls.put[0][0]).toBe(KvConst.AUTH_INFO + 42);
		expect(JSON.parse(calls.put[0][1]).tokens).toEqual(['other-token']);
		expect(calls.put[0][2]).toEqual({ expirationTtl: constant.TOKEN_EXPIRE });
	});

	it('deletes the KV login record after revoking the final session', async () => {
		const { context, calls } = await createContext(['current-token']);

		await loginService.logout(context, 42);

		expect(calls.put).toEqual([]);
		expect(calls.delete).toEqual([[KvConst.AUTH_INFO + 42]]);
	});

	it('does not revoke another session when the JWT is invalid', async () => {
		const { context, calls } = await createContext(['current-token']);
		context.req.header = () => 'invalid-jwt';

		await loginService.logout(context, 42);

		expect(calls.put).toEqual([]);
		expect(calls.delete).toEqual([]);
	});
});
