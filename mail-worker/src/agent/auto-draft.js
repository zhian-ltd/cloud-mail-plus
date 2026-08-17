// Hook called from src/email/email.js after a received email is persisted.
// Looks up the recipient user, checks if AI auto-draft is enabled, and
// dispatches to the per-user EmailAgent Durable Object.
import userService from '../service/user-service';
import aiConfigService from '../service/ai-config-service';

export async function maybeAutoDraft(c, { emailId, userId }) {
  if (!c.env.EMAIL_AGENT) return;
  try {
    const user = await userService.findById(c, userId);
    if (!user || !user.agentEnabled || !user.agentAutoDraft) return;
    const aiConfig = await aiConfigService.publicConfig(c);
    if (!aiConfig.aiReady) return;

    const stub = c.env.EMAIL_AGENT.get(c.env.EMAIL_AGENT.idFromName(`user-${userId}`));

    // Ensure the DO has the user's context cached (cheap idempotent set)
    await stub.setContext({
      userId,
      userEmail: user.email,
      persona: user.agentPersona || '',
      locale: 'auto',
    });

    // Fire-and-forget — autoDraftReply is bounded by stepCountIs(2)
    c.executionCtx.waitUntil(
      stub.autoDraftReply({ emailId }).catch(err => {
        console.error('[auto-draft] failed for emailId', emailId, err);
      })
    );
  } catch (err) {
    console.error('[auto-draft] dispatch error', err);
  }
}
