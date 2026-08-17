<script setup>
import { ref, computed, onMounted, watch, nextTick, shallowRef } from 'vue';
import { Chat } from '@ai-sdk/vue';
import { DefaultChatTransport } from 'ai';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { useAgentStore } from '@/store/agent';
import ToolConfirmation from './ToolConfirmation.vue';
import http from '@/axios/index.js';
import db from '@/db/db.js';
import { userDraftStore } from '@/store/draft.js';
import { useUserStore } from '@/store/user.js';
import { useAccountStore } from '@/store/account.js';
import { useEmailStore } from '@/store/email.js';
import { useRoute } from 'vue-router';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const props = defineProps({ visible: Boolean });
const emit = defineEmits(['close']);

const store = useAgentStore();
const draftStore = userDraftStore();
const userStore = useUserStore();
const accountStore = useAccountStore();
const emailStore = useEmailStore();
const route = useRoute();
const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists);
const scroller = ref(null);
const input = ref('');

// Token-aware transport so the JWT travels with each chat request.
const transport = new DefaultChatTransport({
  api: '/api/agent/chat',
  prepareSendMessagesRequest: ({ id, messages, body, trigger, messageId }) => ({
    body: {
      ...body,
      id,
      messages,
      trigger,
      messageId,
      currentEmailId: route.name === 'content'
        ? Number(emailStore.contentData.email?.emailId) || null
        : null,
    },
  }),
  fetch: (url, init) => {
    const headers = new Headers(init?.headers || {});
    const token = localStorage.getItem('token');
    if (token) headers.set('Authorization', token);
    return fetch(url, { ...init, headers }).then(async response => {
      const contentType = response.headers.get('content-type') || '';
      if (response.ok && contentType.includes('text/event-stream')) return response;

      let message = '';
      try {
        const payload = await response.clone().json();
        message = payload?.message || payload?.error?.message || '';
      } catch {
        try { message = await response.clone().text(); }
        catch { message = ''; }
      }
      throw new Error(message || `AI request failed (${response.status})`);
    });
  },
});

// Chat is a class. shallowRef tracks identity; the class manages internal reactivity.
function createChat(messages = []) {
  return new Chat({
    transport,
    messages,
    onFinish: ({ message }) => {
      void syncAgentDrafts([message]).then(async () => {
        await nextTick();
        if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
      }).catch(error => {
        console.warn('[draft] unable to synchronize completed AI draft', error);
      });
    },
  });
}

const chat = shallowRef(createChat(store.messages || []));

const syncingDraftIds = new Set();

function toolName(part) {
  if (part.toolName) return part.toolName;
  return typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice(5) : '';
}

async function syncAgentDrafts(messages) {
  for (const message of messages || []) {
    for (const part of message.parts || []) {
      if (!['draftReply', 'draftNew'].includes(toolName(part))) continue;
      const output = part.output || part.result;
      const draft = output?.draft;
      const serverDraftId = Number(draft?.serverDraftId || output?.draftId);
      await syncAgentDraft(draft, serverDraftId);
    }
  }
}

async function syncAgentDraft(draft, serverDraftId = Number(draft?.serverDraftId)) {
  if (!draft || !Number.isInteger(serverDraftId) || serverDraftId <= 0 || syncingDraftIds.has(serverDraftId)) return;

  syncingDraftIds.add(serverDraftId);
  try {
    const existing = await db.value.draft.where('serverDraftId').equals(serverDraftId).first();
    if (existing) return;

    const account = accountStore.currentAccount?.email
      ? accountStore.currentAccount
      : userStore.user?.account;
    const localDraft = {
      ...draft,
      serverDraftId,
      createTime: dayjs().utc().format('YYYY-MM-DD HH:mm:ss'),
    };
    if (!(Number(localDraft.accountId) > 0) && account) {
      localDraft.accountId = account.accountId;
      localDraft.sendEmail = account.email;
      localDraft.name = account.name || userStore.user?.name || '';
    }
    const attachments = Array.isArray(localDraft.attachments) ? localDraft.attachments : [];
    delete localDraft.attachments;
    delete localDraft.draftId;
    const localDraftId = await db.value.draft.add(localDraft);
    await db.value.att.put({ draftId: localDraftId, attachments });
    draftStore.refreshList++;
  } finally {
    syncingDraftIds.delete(serverDraftId);
  }
}

async function removeLocalAgentDraft(serverDraftId) {
  const local = await db.value.draft.where('serverDraftId').equals(Number(serverDraftId)).first();
  if (!local) return;
  await Promise.all([
    db.value.draft.delete(local.draftId),
    db.value.att.delete(local.draftId),
  ]);
  draftStore.refreshList++;
}

watch(() => chat.value.messages, async () => {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}, { deep: true });

onMounted(async () => {
  if (!store.hydrated) await store.hydrate();
  const serverDrafts = await http.get('/agent/drafts');
  for (const draft of serverDrafts || []) await syncAgentDraft(draft);
});

const pendingConfirm = computed(() => {
  const part = chat.value.messages
    .flatMap(m => m.parts || [])
    .find(p =>
      (p.type === 'tool-call' || (typeof p.type === 'string' && p.type.startsWith('tool-'))) &&
      ['sendDraft', 'deleteEmail'].includes(toolName(p)) &&
      !(p.output || p.result)
    );
  return part ? { ...part, toolName: toolName(part), args: part.args || part.input } : null;
});

async function onSubmit() {
  const text = input.value.trim();
  if (!text || chat.value.status === 'streaming') return;
  input.value = '';
  await chat.value.sendMessage({ text });
}

async function onConfirmTool({ accepted, toolCallId, toolName, args }) {
  if (!accepted) {
    chat.value.addToolResult({ toolCallId, output: { cancelled: true } });
    return;
  }
  const r = await http.post('/agent/confirm', { name: toolName, args });
  const output = r.data || r;
  if (toolName === 'sendDraft' && output?.sent) await removeLocalAgentDraft(args.draftId);
  chat.value.addToolResult({ toolCallId, output });
}

async function clearChat() {
  await store.clear();
  chat.value = createChat();
}

function renderPart(part) {
  if (part.type === 'text') return md.render(part.text || '');
  if (part.type === 'tool-call' || (typeof part.type === 'string' && part.type.startsWith('tool-'))) {
    const args = part.args || part.input;
    return `<div class="tool-call"><b>🔧 ${part.toolName || part.type}</b><pre>${escape(JSON.stringify(args, null, 2))}</pre></div>`;
  }
  if (part.type === 'tool-result' || part.output) {
    return `<div class="tool-result"><b>→ ${part.toolName || 'result'}</b><pre>${escape(JSON.stringify(part.output || part.result, null, 2))}</pre></div>`;
  }
  return '';
}
function escape(s) { return String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
</script>

<template>
  <Transition name="slide">
    <aside v-if="visible" class="agent-panel">
      <header class="agent-head">
        <span>✨ {{ $t('aiAgentChatTitle') }}</span>
        <div>
          <button @click="clearChat" :title="$t('aiAgentClearChat')">🗑</button>
          <button @click="$emit('close')" title="×">×</button>
        </div>
      </header>

      <div ref="scroller" class="agent-body">
        <div v-for="m in chat.messages" :key="m.id" :class="['msg', m.role]">
          <div v-for="(p, i) in (m.parts || [{type:'text', text:m.content}])"
               :key="i" v-html="renderPart(p)" />
        </div>
        <div v-if="chat.status === 'streaming' || chat.status === 'submitted'" class="msg assistant typing">…</div>
        <div v-if="chat.error" class="msg error">{{ chat.error.message }}</div>
      </div>

      <ToolConfirmation
        v-if="pendingConfirm"
        :tool="pendingConfirm"
        @decision="onConfirmTool" />

      <form class="agent-input" @submit.prevent="onSubmit">
        <textarea v-model="input"
                  :placeholder="$t('aiAgentChatPlaceholder')"
                  rows="2"
                  @keydown.enter.exact.prevent="onSubmit" />
        <button :disabled="chat.status === 'streaming' || !input.trim()">{{ $t('aiAgentSend') }}</button>
      </form>
    </aside>
  </Transition>
</template>

<style scoped>
.agent-panel {
  position: fixed; right: 0; top: 0; bottom: 0;
  width: min(400px, 100vw); background: var(--el-bg-color, #fff);
  border-left: 1px solid var(--el-border-color-light, #eee);
  display: flex; flex-direction: column;
  box-shadow: -4px 0 12px rgba(0,0,0,0.05); z-index: 1000;
}
.agent-head { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
.agent-body { flex: 1; overflow-y: auto; padding: 12px; }
.msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; }
.msg.user { background: #f0f7ff; }
.msg.assistant { background: #fafafa; }
.msg.error { background: #fee2e2; color: #b91c1c; font-size: 12px; }
.tool-call, .tool-result { font-size: 12px; background: #fff8e1; padding: 6px 8px; border-radius: 4px; margin: 4px 0; }
.tool-result { background: #e8f5e9; }
.tool-call pre, .tool-result pre { margin: 4px 0 0; max-height: 120px; overflow: auto; font-size: 11px; }
.agent-input { display: flex; gap: 8px; padding: 8px; border-top: 1px solid #eee; }
.agent-input textarea { flex: 1; resize: none; padding: 6px 8px; border-radius: 4px; border: 1px solid #ddd; }
.slide-enter-from, .slide-leave-to { transform: translateX(100%); }
.slide-enter-active, .slide-leave-active { transition: transform 0.2s ease; }
</style>
