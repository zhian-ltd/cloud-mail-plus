import app from '../hono/hono';
import userContext from '../security/user-context';
import userService from '../service/user-service';
import result from '../model/result';
import { streamText, stepCountIs } from 'ai';
import { buildTools, executeConfirmedTool } from '../agent/tools';
import { buildSystemPrompt } from '../agent/system-prompt';
import aiConfigService from '../service/ai-config-service';
import emailService from '../service/email-service';
import { uiMessagesToModelMessages } from '../agent/message-utils';
import { currentEmailDraftStep, latestUserText, requestsCurrentEmailReplyDraft } from '../agent/draft-intent';

// ---- chat: AI SDK v6 streaming, direct (no DO routing — protocol mismatch with AIChatAgent) ----
app.post('/agent/chat', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);

  const user = await userService.findById(c, userId);
  if (!user?.agentEnabled) return c.json(result.fail('agent-disabled'), 403);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json(result.fail('invalid-body'), 400); }

  // Accept both shapes: UI messages array or already-converted model messages
  const uiMessages = Array.isArray(body?.messages) ? body.messages : [];
  const requestedCurrentEmailId = Number(body?.currentEmailId);
  const currentEmailId = Number.isInteger(requestedCurrentEmailId) && requestedCurrentEmailId > 0
    ? requestedCurrentEmailId
    : 0;
  const forceCurrentEmailDraft = currentEmailId > 0 &&
    requestsCurrentEmailReplyDraft(latestUserText(uiMessages));
  console.log('[agent/chat] request body keys:', Object.keys(body || {}), 'msg count:', uiMessages.length);

  // Build ModelMessage[] manually — convertToModelMessages in AI SDK v6 produces
  // unexpected shapes for the @ai-sdk/vue Chat payload format on Workers runtime.
  const modelMessages = uiMessagesToModelMessages(uiMessages);

  if (modelMessages.length === 0) {
    return c.json(result.fail('no-messages-in-request'), 400);
  }

  // Diagnostic logs
  console.log('[agent/chat] model messages:', JSON.stringify(modelMessages).slice(0, 500));
  console.log('[agent/chat] is array:', Array.isArray(modelMessages), 'len:', modelMessages.length);

  const aiRuntime = await aiConfigService.resolveModel(c);
  const tools = buildTools({
    env: c.env,
    userId,
    userEmail: user.email,
    aiModel: aiRuntime.model,
    aiModelId: aiRuntime.modelId,
  });

  try {
    const stream = streamText({
      model: aiRuntime.model,
      system: buildSystemPrompt({
        userEmail: user.email,
        persona: user.agentPersona || '',
        currentBoxName: c.req.query('box') || 'inbox',
        currentEmailId,
        locale: c.req.header('Accept-Language')?.split(',')[0] || 'en',
      }),
      messages: modelMessages,
      tools,
      prepareStep: ({ steps }) => currentEmailDraftStep({
        steps,
        forceDraftReply: forceCurrentEmailDraft,
      }),
      stopWhen: stepCountIs(8),
      onError: (err) => {
        const msg = err?.error?.message || err?.message || JSON.stringify(err);
        console.error('[agent/chat] streamText onError:', msg);
        console.error('[agent/chat] stack:', err?.error?.stack || err?.stack);
      },
    });
    return stream.toUIMessageStreamResponse();
  } catch (err) {
    console.error('[agent/chat] outer catch:', err?.message, err?.stack);
    return c.json(result.fail('streamText-failed: ' + err?.message), 500);
  }
});

app.post('/agent/confirm', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const user = await userService.findById(c, userId);
  if (!user) return c.json(result.fail('user-not-found'), 404);
  const { name, args } = await c.req.json();
  if (!['sendDraft', 'deleteEmail'].includes(name)) return c.json(result.fail('unknown-tool'), 400);
  const r = await executeConfirmedTool({ env: c.env, userId, userEmail: user.email, name, args });
  return c.json(result.ok(r));
});

app.put('/agent/draft/:draftId', async (c) => {
  const userId = userContext.getUserId(c);
  const draftId = Number(c.req.param('draftId'));
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  if (!Number.isInteger(draftId) || draftId <= 0) return c.json(result.fail('invalid-draft-id'), 400);
  const updated = await emailService.updateDraft(c, draftId, userId, await c.req.json());
  if (!updated) return c.json(result.fail('draft-not-found'), 404);
  return c.json(result.ok({ updated: true }));
});

app.delete('/agent/draft/:draftId', async (c) => {
  const userId = userContext.getUserId(c);
  const draftId = Number(c.req.param('draftId'));
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  if (!Number.isInteger(draftId) || draftId <= 0) return c.json(result.fail('invalid-draft-id'), 400);
  const deleted = await emailService.deleteDraft(c, draftId, userId);
  return c.json(result.ok({ deleted }));
});

app.get('/agent/drafts', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const rows = await emailService.listDrafts(c, userId);
  const drafts = rows.map(row => {
    let recipients = [];
    try { recipients = JSON.parse(row.recipient || '[]'); }
    catch { recipients = []; }
    let metadata = {};
    try { metadata = JSON.parse(row.aiMetadata || '{}'); }
    catch { metadata = {}; }
    const receiveEmail = recipients.map(item => item?.address).filter(Boolean);
    if (!receiveEmail.length && row.toEmail) receiveEmail.push(row.toEmail);
    return {
      serverDraftId: row.emailId,
      sendEmail: row.sendEmail || '',
      receiveEmail,
      accountId: row.accountId,
      name: row.name || '',
      subject: row.subject || '',
      content: row.content || '',
      text: row.text || '',
      sendType: row.inReplyTo ? 'reply' : '',
      emailId: Number(metadata.sourceEmailId) || 0,
      inReplyTo: row.inReplyTo || '',
      relation: row.relation || '',
      attachments: [],
    };
  });
  return c.json(result.ok(drafts));
});

app.get('/agent/state', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  // Stateless for now — frontend Chat class keeps history in-memory.
  // Persistent history can be added later by reading from agent_message table.
  return c.json(result.ok({ messages: [] }));
});

app.get('/agent/settings', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const u = await userService.findById(c, userId);
  const aiConfig = await aiConfigService.publicConfig(c);
  return c.json(result.ok({
    agentEnabled: !!u?.agentEnabled,
    agentAutoDraft: !!u?.agentAutoDraft,
    agentPersona: u?.agentPersona || '',
    bindingAvailable: !!c.env.EMAIL_AGENT,
    aiProvider: aiConfig.aiProvider,
    aiModel: aiConfig.aiModel,
    aiReady: aiConfig.aiReady,
  }));
});

app.post('/agent/clear', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  // Frontend handles its own in-memory clear; this is a no-op until D1 history is added.
  return c.json(result.ok({}));
});

app.put('/agent/settings', async (c) => {
  const userId = userContext.getUserId(c);
  if (!userId) return c.json(result.fail('unauthorized'), 401);
  const { agentEnabled, agentAutoDraft, agentPersona } = await c.req.json();
  await userService.updateAgentSettings(c, userId, {
    agentEnabled: agentEnabled ? 1 : 0,
    agentAutoDraft: agentAutoDraft ? 1 : 0,
    agentPersona: (agentPersona || '').slice(0, 4000),
  });
  return c.json(result.ok({}));
});
