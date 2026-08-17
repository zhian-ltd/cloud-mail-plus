<template>
  <section class="push-card" v-loading="loading">
    <div class="push-title">{{ $t('personalEmailPush') }}</div>
    <p class="push-desc">{{ $t('personalEmailPushDesc') }}</p>

    <div class="push-item">
      <span>{{ $t('tgBot') }}</span>
      <div class="push-action">
        <span>{{ setting.tgBotStatus === 0 ? $t('enabled') : $t('disabled') }}</span>
        <el-button size="small" type="primary" @click="openTelegram">
          <Icon icon="fluent:settings-48-regular" width="18" height="18"/>
        </el-button>
      </div>
    </div>

    <div class="push-item">
      <span>{{ $t('otherEmail') }}</span>
      <div class="push-action">
        <span>{{ setting.forwardStatus === 0 ? $t('enabled') : $t('disabled') }}</span>
        <el-button size="small" type="primary" @click="openForwardEmail">
          <Icon icon="fluent:settings-48-regular" width="18" height="18"/>
        </el-button>
      </div>
    </div>

    <div class="push-item">
      <span>{{ $t('forwardingRules') }}</span>
      <div class="push-action">
        <span>{{ setting.ruleType === 0 ? $t('forwardAll') : $t('rules') }}</span>
        <el-button size="small" type="primary" @click="openRules">
          <Icon icon="fluent:settings-48-regular" width="18" height="18"/>
        </el-button>
      </div>
    </div>

    <p class="duplicate-note">{{ $t('personalPushDuplicateNotice') }}</p>
  </section>

  <el-dialog v-model="telegramShow" class="personal-push-dialog" width="min(520px, calc(100vw - 30px))">
    <template #header>
      <div class="dialog-title">
        <span>{{ $t('tgBot') }}</span>
        <el-tooltip effect="dark" :content="$t('personalTgBotDesc')">
          <Icon class="warning" icon="fe:warning" width="18" height="18"/>
        </el-tooltip>
      </div>
    </template>
    <div class="dialog-body">
      <el-input
          v-model="telegramForm.tgBotToken"
          type="password"
          show-password
          autocomplete="off"
          :placeholder="setting.tgBotTokenConfigured ? $t('botTokenConfigured') : $t('tgBotToken')"
          :disabled="telegramForm.clearTgBotToken"
      />
      <el-input-tag
          v-model="telegramForm.tgChatId"
          tag-type="warning"
          :placeholder="$t('toBotTokenDesc')"
          @add-tag="addChatTag"
      />
      <el-checkbox v-if="setting.tgBotTokenConfigured" v-model="telegramForm.clearTgBotToken">
        {{ $t('clearSavedToken') }}
      </el-checkbox>
      <div class="option-row">
        <span>{{ $t('from') }}</span>
        <el-select v-model="telegramForm.tgMsgFrom">
          <el-option :label="$t('show')" value="show"/>
          <el-option :label="$t('hide')" value="hide"/>
          <el-option :label="$t('onlyName')" value="only-name"/>
        </el-select>
      </div>
      <div class="option-row">
        <span>{{ $t('recipient') }}</span>
        <el-select v-model="telegramForm.tgMsgTo">
          <el-option :label="$t('show')" value="show"/>
          <el-option :label="$t('hide')" value="hide"/>
        </el-select>
      </div>
      <div class="option-row">
        <span>{{ $t('emailText') }}</span>
        <el-select v-model="telegramForm.tgMsgText">
          <el-option :label="$t('show')" value="show"/>
          <el-option :label="$t('hide')" value="hide"/>
        </el-select>
      </div>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <el-switch
            v-model="telegramForm.tgBotStatus"
            :active-value="0"
            :inactive-value="1"
            :active-text="$t('enable')"
            :inactive-text="$t('disable')"
            :disabled="telegramForm.clearTgBotToken"
        />
        <el-button type="primary" :loading="saving" @click="saveTelegram">{{ $t('save') }}</el-button>
      </div>
    </template>
  </el-dialog>

  <el-dialog v-model="forwardShow" class="personal-push-dialog" width="min(520px, calc(100vw - 30px))">
    <template #header>
      <div class="dialog-title">
        <span>{{ $t('otherEmail') }}</span>
        <el-tooltip effect="dark" :content="$t('personalOtherEmailDesc')">
          <Icon class="warning" icon="fe:warning" width="18" height="18"/>
        </el-tooltip>
      </div>
    </template>
    <div class="dialog-body">
      <el-input-tag
          v-model="forwardForm.forwardEmail"
          tag-type="warning"
          :placeholder="$t('otherEmailInputDesc')"
          @add-tag="addForwardEmailTag"
      />
    </div>
    <template #footer>
      <div class="dialog-footer">
        <el-switch
            v-model="forwardForm.forwardStatus"
            :active-value="0"
            :inactive-value="1"
            :active-text="$t('enable')"
            :inactive-text="$t('disable')"
        />
        <el-button type="primary" :loading="saving" @click="saveForwardEmail">{{ $t('save') }}</el-button>
      </div>
    </template>
  </el-dialog>

  <el-dialog v-model="rulesShow" class="personal-push-dialog" width="min(520px, calc(100vw - 30px))">
    <template #header>
      <div class="dialog-title">
        <span>{{ $t('forwardingRules') }}</span>
        <el-tooltip effect="dark" :content="$t('personalForwardingRulesDesc')">
          <Icon class="warning" icon="fe:warning" width="18" height="18"/>
        </el-tooltip>
      </div>
    </template>
    <div class="dialog-body">
      <el-radio-group v-model="rulesForm.ruleType">
        <el-radio :value="0">{{ $t('forwardAll') }}</el-radio>
        <el-radio :value="1">{{ $t('rules') }}</el-radio>
      </el-radio-group>
      <el-select
          v-if="rulesForm.ruleType === 1"
          v-model="rulesForm.ruleEmail"
          multiple
          filterable
          :placeholder="setting.accountEmails.length ? $t('ruleEmailsInputDesc') : $t('noOwnedMailbox')"
          :disabled="!setting.accountEmails.length"
      >
        <el-option v-for="email in setting.accountEmails" :key="email" :label="email" :value="email"/>
      </el-select>
    </div>
    <template #footer>
      <el-button type="primary" :loading="saving" @click="saveRules">{{ $t('save') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { personalPushSettingQuery, personalPushSettingSet } from '@/request/my.js';
import { isEmail } from '@/utils/verify-utils.js';

const { t } = useI18n();
const loading = ref(true);
const saving = ref(false);
const telegramShow = ref(false);
const forwardShow = ref(false);
const rulesShow = ref(false);

const setting = reactive({
  tgBotTokenConfigured: false,
  tgChatId: '',
  tgBotStatus: 1,
  tgMsgFrom: 'only-name',
  tgMsgTo: 'show',
  tgMsgText: 'hide',
  forwardEmail: '',
  forwardStatus: 1,
  ruleEmail: '',
  ruleType: 0,
  accountEmails: [],
});

const telegramForm = reactive({
  tgBotToken: '',
  tgChatId: [],
  tgBotStatus: 1,
  tgMsgFrom: 'only-name',
  tgMsgTo: 'show',
  tgMsgText: 'hide',
  clearTgBotToken: false,
});

const forwardForm = reactive({
  forwardEmail: [],
  forwardStatus: 1,
});

const rulesForm = reactive({
  ruleEmail: [],
  ruleType: 0,
});

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function applySetting(data) {
  Object.assign(setting, data, {
    accountEmails: Array.isArray(data.accountEmails) ? data.accountEmails : [],
  });
}

async function loadSetting() {
  loading.value = true;
  try {
    applySetting(await personalPushSettingQuery());
  } finally {
    loading.value = false;
  }
}

function openTelegram() {
  Object.assign(telegramForm, {
    tgBotToken: '',
    tgChatId: splitList(setting.tgChatId),
    tgBotStatus: setting.tgBotStatus,
    tgMsgFrom: setting.tgMsgFrom,
    tgMsgTo: setting.tgMsgTo,
    tgMsgText: setting.tgMsgText,
    clearTgBotToken: false,
  });
  telegramShow.value = true;
}

function openForwardEmail() {
  forwardForm.forwardEmail = splitList(setting.forwardEmail);
  forwardForm.forwardStatus = setting.forwardStatus;
  forwardShow.value = true;
}

function openRules() {
  rulesForm.ruleEmail = splitList(setting.ruleEmail);
  rulesForm.ruleType = setting.ruleType;
  rulesShow.value = true;
}

function addChatTag(value) {
  const ids = [...new Set(String(value).split(/[,，]/).map(item => item.trim()).filter(Boolean))];
  telegramForm.tgChatId.splice(telegramForm.tgChatId.length - 1, 1);
  ids.forEach(id => {
    if (/^-?\d{1,20}$/.test(id) && !telegramForm.tgChatId.includes(id)) telegramForm.tgChatId.push(id);
  });
}

function addForwardEmailTag(value) {
  const emails = [...new Set(String(value).split(/[,，]/).map(item => item.trim().toLowerCase()).filter(Boolean))];
  forwardForm.forwardEmail.splice(forwardForm.forwardEmail.length - 1, 1);
  emails.forEach(email => {
    if (isEmail(email) && !forwardForm.forwardEmail.includes(email)) forwardForm.forwardEmail.push(email);
  });
}

function showError(message) {
  ElMessage({ message, type: 'error', plain: true });
}

async function saveAndApply(params) {
  saving.value = true;
  try {
    applySetting(await personalPushSettingSet(params));
    ElMessage({ message: t('saveSuccessMsg'), type: 'success', plain: true });
    return true;
  } finally {
    saving.value = false;
  }
}

async function saveTelegram() {
  const enabled = telegramForm.tgBotStatus === 0 && !telegramForm.clearTgBotToken;
  if (enabled && !telegramForm.tgBotToken.trim() && !setting.tgBotTokenConfigured) {
    showError(t('botTokenRequired'));
    return;
  }
  if (enabled && telegramForm.tgChatId.length === 0) {
    showError(t('chatIdRequired'));
    return;
  }

  const params = {
    tgChatId: telegramForm.tgChatId.join(','),
    tgBotStatus: telegramForm.clearTgBotToken ? 1 : telegramForm.tgBotStatus,
    tgMsgFrom: telegramForm.tgMsgFrom,
    tgMsgTo: telegramForm.tgMsgTo,
    tgMsgText: telegramForm.tgMsgText,
    clearTgBotToken: telegramForm.clearTgBotToken,
  };
  if (telegramForm.tgBotToken.trim()) params.tgBotToken = telegramForm.tgBotToken.trim();
  if (await saveAndApply(params)) telegramShow.value = false;
}

async function saveForwardEmail() {
  if (forwardForm.forwardStatus === 0 && forwardForm.forwardEmail.length === 0) {
    showError(t('forwardEmailRequired'));
    return;
  }
  if (await saveAndApply({
    forwardStatus: forwardForm.forwardStatus,
    forwardEmail: forwardForm.forwardEmail.join(','),
  })) forwardShow.value = false;
}

async function saveRules() {
  if (await saveAndApply({
    ruleType: rulesForm.ruleType,
    ruleEmail: rulesForm.ruleEmail.join(','),
  })) rulesShow.value = false;
}

onMounted(loadSetting);
</script>

<style scoped lang="scss">
.push-card {
  max-width: 900px;
  margin-bottom: 40px;
  padding: 24px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.push-title {
  font-size: 18px;
  font-weight: bold;
}

.push-desc,
.duplicate-note {
  color: var(--regular-text-color);
  line-height: 1.6;
}

.push-desc {
  margin: 10px 0 18px;
}

.duplicate-note {
  margin: 16px 0 0;
  font-size: 12px;
}

.push-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  gap: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.push-action {
  display: flex;
  align-items: center;
  gap: 14px;
  white-space: nowrap;
}

.dialog-title,
.dialog-footer,
.option-row {
  display: flex;
  align-items: center;
}

.dialog-title {
  gap: 8px;
  font-weight: bold;
}

.warning {
  color: var(--el-color-warning);
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.option-row {
  justify-content: space-between;
  gap: 20px;

  .el-select {
    width: 180px;
  }
}

.dialog-footer {
  justify-content: space-between;
  gap: 20px;
}

@media (max-width: 767px) {
  .push-card {
    padding: 18px;
  }

  .push-item {
    align-items: flex-start;
    padding: 12px 0;
  }

  .push-action {
    gap: 8px;
  }
}
</style>
