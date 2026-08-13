import { and, eq, inArray } from 'drizzle-orm';
import orm from '../entity/orm';
import ssoIdentity from '../entity/sso-identity';

const ssoIdentityService = {
	findByProviderSubject(c, issuer, subject) {
		return orm(c)
			.select()
			.from(ssoIdentity)
			.where(and(eq(ssoIdentity.issuer, issuer), eq(ssoIdentity.subject, subject)))
			.get();
	},

	async bindOrGet(c, { issuer, subject, userId, email }) {
		await orm(c)
			.insert(ssoIdentity)
			.values({ issuer, subject, userId, email })
			.onConflictDoNothing({ target: [ssoIdentity.issuer, ssoIdentity.subject] })
			.run();

		const identity = await this.findByProviderSubject(c, issuer, subject);
		if (identity?.userId === userId && identity.email !== email) {
			await orm(c)
				.update(ssoIdentity)
				.set({ email, updateTime: new Date().toISOString() })
				.where(eq(ssoIdentity.identityId, identity.identityId))
				.run();
			identity.email = email;
		}

		return identity;
	},

	async updateEmail(c, identityId, email) {
		await orm(c)
			.update(ssoIdentity)
			.set({ email, updateTime: new Date().toISOString() })
			.where(eq(ssoIdentity.identityId, identityId))
			.run();
	},

	async deleteByUserIds(c, userIds) {
		if (!userIds.length) return;
		await orm(c).delete(ssoIdentity).where(inArray(ssoIdentity.userId, userIds)).run();
	},
};

export default ssoIdentityService;
