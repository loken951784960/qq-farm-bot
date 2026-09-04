<script setup lang="ts">
import { NCard } from 'naive-ui/es/card'
import { NModal } from 'naive-ui/es/modal'
import { NRadio, NRadioGroup } from 'naive-ui/es/radio'
import { NTab, NTabs } from 'naive-ui/es/tabs'
import { onBeforeUnmount, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { runWxLoginStatusPoll } from '@/utils/wx-login-poll'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const loading = ref(false)
const errorMessage = ref('')
const activeLoginTab = ref<'code' | 'wx_qr' | 'capture'>('code')
const wxTaskId = ref('')
const wxStatus = ref('')
const wxError = ref('')
const wxLoading = ref(false)
const wxQrUrl = ref('')
let wxPollTimer: ReturnType<typeof setTimeout> | undefined
let wxQrObjectUrl = ''
let wxFlowVersion = 0
let wxPollController: AbortController | undefined
let wxPollInFlight: Promise<void> | undefined
let wxPollKey = ''

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 添加账号
async function addAccount(data: any) {
  const name = String(data?.name || '').trim()
  if (!name) {
    errorMessage.value = '请输入账号备注'
    return false
  }

  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', { ...data, name })
    if (res.data.ok) {
      emit('saved')
      close()
      return true
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }

  return false
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!form.name.trim()) {
    errorMessage.value = '请输入账号备注'
    return
  }
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }
  form.name = form.name.trim()

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

function stopWxPolling() {
  if (wxPollTimer) {
    clearTimeout(wxPollTimer)
    wxPollTimer = undefined
  }
  wxPollController?.abort()
  wxPollController = undefined
}

function resetWxLogin() {
  const oldTaskId = wxTaskId.value
  wxFlowVersion += 1
  stopWxPolling()
  if (oldTaskId) {
    void api.delete(`/api/wx-login/tasks/${oldTaskId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
  if (wxQrObjectUrl) {
    URL.revokeObjectURL(wxQrObjectUrl)
    wxQrObjectUrl = ''
  }
  wxTaskId.value = ''
  wxStatus.value = ''
  wxError.value = ''
  wxQrUrl.value = ''
  wxLoading.value = false
}

function isWxFlowActive(taskId: string, flowVersion: number) {
  return flowVersion === wxFlowVersion && taskId === wxTaskId.value
}

async function getWxCodeAndAdd(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  if (!form.name.trim()) {
    wxError.value = '请先填写账号备注'
    return
  }
  const codeResult = await api.post(`/api/wx-login/tasks/${taskId}/code`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  const code = String(codeResult.data?.data?.code || '').trim()
  if (!code)
    throw new Error('未获取到登录 Code')

  // Deliberately use the same account API and payload as the manual form.
  await addAccount({ name: form.name, code, platform: 'wx', loginType: 'manual' })
}

async function confirmWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return
  wxStatus.value = '正在建立登录会话...'
  await api.post(`/api/wx-login/tasks/${taskId}/confirm`)
  if (!isWxFlowActive(taskId, flowVersion))
    return
  await getWxCodeAndAdd(taskId, flowVersion)
}

async function pollWxLoginRequest(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const controller = new AbortController()
  wxPollController = controller
  try {
    const response = await runWxLoginStatusPoll(() => api.get(`/api/wx-login/tasks/${taskId}/status`, {
      timeout: 40000,
      signal: controller.signal,
      skipErrorToast: true,
    } as any))
    if (!isWxFlowActive(taskId, flowVersion))
      return
    const status = response.data?.data?.status
    if (status === 'waiting') {
      wxStatus.value = '等待微信扫码'
    }
    else if (status === 'scanned') {
      wxStatus.value = '已扫码，请在手机上确认'
    }
    else if (status === 'authorized') {
      if (!form.name.trim()) {
        wxError.value = '请先填写账号备注'
        wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
        return
      }
      stopWxPolling()
      await confirmWxLogin(taskId, flowVersion)
      return
    }
    else if (['cancelled', 'expired', 'failed'].includes(status)) {
      wxError.value = '二维码已失效，请重新获取'
      return
    }
    wxPollTimer = setTimeout(() => void pollWxLogin(taskId, flowVersion), 1200)
  }
  catch (error: any) {
    if (!isWxFlowActive(taskId, flowVersion) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED')
      return
    wxError.value = error.response?.data?.error || error.message || '登录状态检查失败'
  }
  finally {
    if (wxPollController === controller)
      wxPollController = undefined
  }
}

async function pollWxLogin(taskId: string, flowVersion: number) {
  if (!isWxFlowActive(taskId, flowVersion))
    return

  const previous = wxPollInFlight
  const previousKey = wxPollKey
  if (previous) {
    await previous.catch(() => undefined)
    if (!isWxFlowActive(taskId, flowVersion))
      return
    if (previousKey === `${taskId}:${flowVersion}`)
      return
  }

  const current = pollWxLoginRequest(taskId, flowVersion)
  wxPollInFlight = current
  wxPollKey = `${taskId}:${flowVersion}`
  try {
    await current
  }
  finally {
    if (wxPollInFlight === current) {
      wxPollInFlight = undefined
      wxPollKey = ''
    }
  }
}

async function startWxLogin() {
  resetWxLogin()
  const flowVersion = wxFlowVersion
  wxLoading.value = true
  try {
    const response = await api.post('/api/wx-login/tasks', { app_id: 'wx5306c5978fdb76e4' })
    const task = response.data?.data
    const taskId = String(task?.task_id || '')
    if (!taskId)
      throw new Error('未创建登录任务')
    if (flowVersion !== wxFlowVersion) {
      void api.delete(`/api/wx-login/tasks/${taskId}`, { skipErrorToast: true } as any).catch(() => undefined)
      return
    }
    wxTaskId.value = taskId
    const qrResponse = await api.get(task.qr_url, { responseType: 'blob' })
    if (!isWxFlowActive(taskId, flowVersion))
      return
    wxQrObjectUrl = URL.createObjectURL(qrResponse.data)
    wxQrUrl.value = wxQrObjectUrl
    wxStatus.value = '等待微信扫码'
    void pollWxLogin(taskId, flowVersion)
  }
  catch (error: any) {
    if (flowVersion !== wxFlowVersion)
      return
    wxError.value = error.response?.data?.error || error.message || '二维码获取失败'
  }
  finally {
    if (flowVersion === wxFlowVersion)
      wxLoading.value = false
  }
}

// ---------- 抓包登录 ----------
const PAC_URL = 'http://106.55.41.254:8081/proxy.pac'
const capturePlatform = ref<'qq' | 'wx'>('qq')
const captureFlowId = ref('')
const captureInfo = ref<any>(null)
const captureStatus = ref('')
const captureError = ref('')
const captureStarting = ref(false)
const captureCompleting = ref(false)
const captureCaptured = ref(false)
let captureTimer: ReturnType<typeof setTimeout> | undefined

function stopCapturePolling() {
  if (captureTimer) {
    clearTimeout(captureTimer)
    captureTimer = undefined
  }
}

function resetCapture() {
  const flowId = captureFlowId.value
  stopCapturePolling()
  captureFlowId.value = ''
  captureInfo.value = null
  captureStatus.value = ''
  captureError.value = ''
  captureCaptured.value = false
  captureCompleting.value = false
  if (flowId) {
    void api.delete(`/api/capture/sessions/${flowId}`, { skipErrorToast: true } as any).catch(() => undefined)
  }
}

async function startCapture() {
  captureError.value = ''
  captureStarting.value = true
  try {
    const capturePayload: any = { platform: capturePlatform.value }
    if (props.editData?.id)
      capturePayload.accountId = props.editData.id
    const res = await api.post('/api/capture/sessions', capturePayload)
    const data = res.data?.data
    if (!data?.id)
      throw new Error('未创建抓包会话')
    captureFlowId.value = data.id
    captureInfo.value = data.publicInfo || null
    captureStatus.value = '代理已就绪，请在手机上配置代理后触发农场登录'
    void pollCapture()
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '启动抓包失败'
  }
  finally {
    captureStarting.value = false
  }
}

async function pollCapture() {
  stopCapturePolling()
  const flowId = captureFlowId.value
  if (!flowId)
    return
  try {
    const res = await api.get(`/api/capture/sessions/${flowId}`, { skipErrorToast: true } as any)
    const data = res.data?.data
    if (!data)
      return
    captureInfo.value = data.publicInfo || captureInfo.value
    if (data.codeCaptured) {
      captureCaptured.value = true
      captureStatus.value = '已捕获登录 Code，点击「完成添加」即可'
      return
    }
    if (data.completed) {
      captureStatus.value = '已完成'
      return
    }
    captureStatus.value = data.proxy?.error || '等待手机端登录请求…'
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '状态检查失败'
    return
  }
  captureTimer = setTimeout(() => void pollCapture(), 1500)
}

async function completeCapture() {
  const flowId = captureFlowId.value
  if (!flowId)
    return
  if (!form.name.trim()) {
    captureError.value = '请先填写账号备注'
    return
  }
  if (!captureCaptured.value) {
    captureError.value = '尚未捕获到 Code'
    return
  }
  captureCompleting.value = true
  captureError.value = ''
  try {
    const res = await api.post(`/api/capture/sessions/${flowId}/complete`, { name: form.name.trim() })
    if (res.data?.ok) {
      stopCapturePolling()
      captureFlowId.value = ''
      emit('saved')
      close()
      return
    }
    captureError.value = res.data?.error || '添加账号失败'
  }
  catch (e: any) {
    captureError.value = e.response?.data?.error || e.message || '添加账号失败'
  }
  finally {
    captureCompleting.value = false
  }
}

function close() {
  resetWxLogin()
  resetCapture()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    activeLoginTab.value = 'code'
    resetWxLogin()
    resetCapture()
    if (props.editData) {
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
    }
    else {
      form.name = ''
      form.code = ''
      form.platform = 'qq'
    }
  }
})

watch(activeLoginTab, (tab) => {
  if (tab === 'wx_qr' && !wxTaskId.value)
    void startWxLogin()
  else if (tab !== 'wx_qr')
    resetWxLogin()
  if (tab !== 'capture')
    resetCapture()
})

onBeforeUnmount(resetWxLogin)
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading && !wxLoading"
    :close-on-esc="!loading && !wxLoading"
    @update:show="value => !value && close()"
  >
    <NCard
      class="account-modal-card"
      :title="editData ? '编辑账号' : '添加账号'"
      :bordered="false"
      :closable="!loading && !wxLoading"
      @close="close"
    >
      <div class="account-modal-content overflow-y-auto">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded-xl p-3 text-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444">
          {{ errorMessage }}
        </div>

        <NTabs v-model:value="activeLoginTab" class="mb-4" type="line">
          <NTab name="code">
            输入 Code 登录
          </NTab>
          <NTab name="wx_qr">
            微信扫码登录
          </NTab>
          <NTab name="capture">
            抓包登录
          </NTab>
        </NTabs>

        <div v-if="activeLoginTab === 'code'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
            class="farm-input"
          />

          <NRadioGroup v-if="!editData" v-model:value="form.platform" name="account-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
        <div v-else-if="activeLoginTab === 'wx_qr'" class="space-y-4" role="tabpanel" aria-label="微信扫码登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />
          <div class="min-h-64 flex flex-col items-center justify-center gap-3">
            <div v-if="wxQrUrl" class="bg-white p-2">
              <img :src="wxQrUrl" alt="微信登录二维码" class="h-52 w-52">
            </div>
            <div v-else class="h-52 w-52 flex items-center justify-center text-sm opacity-60">
              {{ wxLoading ? '正在获取二维码...' : '二维码不可用' }}
            </div>
            <p class="text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxStatus }}
            </p>
            <p v-if="wxError" class="text-sm text-red-500">
              {{ wxError }}
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="startWxLogin">
              刷新二维码
            </BaseButton>
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
          </div>
        </div>
        <div v-else class="space-y-4" role="tabpanel" aria-label="抓包登录">
          <BaseInput
            v-model="form.name"
            label="账号备注（必填）"
            placeholder="请输入账号备注"
            class="farm-input"
          />

          <NRadioGroup v-if="!captureFlowId" v-model:value="capturePlatform" name="capture-platform">
            <div class="flex gap-5">
              <NRadio value="qq">
                QQ 小程序
              </NRadio>
              <NRadio value="wx">
                微信小程序
              </NRadio>
            </div>
          </NRadioGroup>

          <div v-if="!captureFlowId" class="flex justify-end gap-2">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="captureStarting" @click="startCapture">
              开始抓取
            </BaseButton>
          </div>

          <div v-else class="space-y-3 rounded-xl p-3 text-sm" style="background: rgba(255, 255, 255, 0.06)">
            <div>代理主机：<b>{{ captureInfo?.host }}:{{ captureInfo?.mitmPort }}</b></div>
            <div>PAC 自动代理：<b>{{ PAC_URL }}</b></div>
            <div v-if="captureInfo?.certificateUrl">
              CA 证书：<a :href="captureInfo.certificateUrl" target="_blank" style="color: #3b82f6">下载并安装（iOS 需到「证书信任设置」启用完全信任）</a>
            </div>
            <div class="opacity-70">
              步骤：手机 WiFi 代理填上面的 PAC 地址 → 安装并信任 CA 证书 → 到 QQ 设置里解除农场授权 → 重新进入农场触发登录
            </div>
            <div>状态：{{ captureStatus }}</div>
            <p v-if="captureError" class="text-red-500">
              {{ captureError }}
            </p>
            <div class="flex justify-end gap-2 pt-2">
              <BaseButton variant="outline" @click="resetCapture">
                取消抓取
              </BaseButton>
              <BaseButton variant="primary" :loading="captureCompleting" :disabled="!captureCaptured" @click="completeCapture">
                完成添加
              </BaseButton>
            </div>
          </div>
        </div>
      </div>
    </NCard>
  </NModal>
</template>

<style scoped>
.account-modal-card {
  width: min(448px, calc(100vw - 32px));
}

.account-modal-content {
  max-height: calc(90vh - 100px);
}
</style>
