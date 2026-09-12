<script setup lang="ts">
import type { Socket } from 'socket.io-client'
import { NButton } from 'naive-ui'
import { useStorage } from '@vueuse/core'
import { io } from 'socket.io-client'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

type LineKind = 'output' | 'input' | 'info' | 'error'

interface TerminalLine {
  id: number
  text: string
  kind: LineKind
}

const MAX_LINES = 1500

const tokenRef = useStorage('admin_token', '')
const lines = ref<TerminalLine[]>([])
const input = ref('')
const busy = ref(false)
const connected = ref(false)
const cwd = ref('')
const root = ref('')
const user = ref('')
const host = ref('')
const platform = ref('')

const bodyRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const userRole = ref('admin')

let socket: Socket | null = null
let lineSeq = 0
let carry = ''
const history: string[] = []
let historyIndex = -1

const quickCommands = [
  { label: 'pwd', cmd: 'pwd' },
  { label: 'ls', cmd: 'ls -la' },
  { label: 'git status', cmd: 'git status' },
  { label: 'git pull', cmd: 'git pull' },
  { label: 'pnpm install', cmd: 'pnpm install --frozen-lockfile' },
  { label: '构建', cmd: 'pnpm run build' },
  { label: '重启服务', cmd: 'bash ./stop.sh && bash ./start.sh' },
  { label: '查看日志', cmd: 'tail -n 100 app_dev.log' },
]

const shortCwd = computed(() => {
  const value = cwd.value || ''
  const base = root.value || ''
  if (base && value.startsWith(base))
    return `~${value.slice(base.length)}` || '~'
  return value
})

const promptText = computed(() => `${user.value || 'user'}@${host.value || 'server'}:${shortCwd.value}$`)

function pushLine(text: string, kind: LineKind = 'output') {
  lines.value.push({ id: ++lineSeq, text, kind })
  if (lines.value.length > MAX_LINES)
    lines.value = lines.value.slice(-MAX_LINES)
  scrollToBottom()
}

function scrollToBottom() {
  nextTick(() => {
    const el = bodyRef.value
    if (el)
      el.scrollTop = el.scrollHeight
  })
}

function appendOutput(text: string) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const merged = carry + normalized
  const parts = merged.split('\n')
  carry = parts.pop() || ''
  for (const part of parts)
    pushLine(part)
}

function flushCarry() {
  if (carry) {
    pushLine(carry)
    carry = ''
  }
}

function sendCommand(command: string) {
  const cmd = String(command || '')
  if (!socket || !connected.value)
    return

  pushLine(`${promptText.value} ${cmd}`, 'input')
  history.push(cmd)
  historyIndex = history.length

  if (!cmd.trim()) {
    showPrompt()
    return
  }

  busy.value = true
  socket.emit('terminal:run', { command: cmd })
}

function submitInput() {
  const cmd = input.value
  input.value = ''
  sendCommand(cmd)
}

function runQuick(cmd: string) {
  input.value = ''
  sendCommand(cmd)
}

function showPrompt() {
  // 提示符由输入行的前缀实时渲染，这里仅用于空命令回显
  pushLine(`${promptText.value}`, 'input')
}

function interrupt() {
  if (!socket)
    return
  socket.emit('terminal:signal', { signal: 'SIGINT' })
  pushLine('^C', 'info')
}

function clearScreen() {
  lines.value = []
  carry = ''
}

function applyHistory(direction: 'up' | 'down') {
  if (!history.length)
    return
  if (direction === 'up') {
    historyIndex = Math.max(0, historyIndex - 1)
    input.value = history[historyIndex] || ''
  }
  else {
    historyIndex = Math.min(history.length, historyIndex + 1)
    input.value = historyIndex >= history.length ? '' : (history[historyIndex] || '')
  }
  nextTick(() => {
    const el = inputRef.value
    if (el)
      el.setSelectionRange(el.value.length, el.value.length)
  })
}

function bindSocket() {
  if (!socket)
    return

  socket.on('connect', () => {
    connected.value = true
    socket?.emit('terminal:hello')
  })

  socket.on('disconnect', (reason: string) => {
    connected.value = false
    busy.value = false
    pushLine(`[已断开] ${reason}`, 'info')
  })

  socket.on('connect_error', (err: Error) => {
    connected.value = false
    busy.value = false
    pushLine(`[连接失败] ${err && err.message ? err.message : 'unknown error'}`, 'error')
  })

  socket.on('terminal:ready', (payload: any) => {
    cwd.value = String(payload?.cwd || '')
    root.value = String(payload?.root || '')
    user.value = String(payload?.user || '')
    host.value = String(payload?.host || '')
    platform.value = String(payload?.platform || '')
    pushLine('网页终端已连接（仅管理员可用）', 'info')
    pushLine(`工作目录: ${cwd.value}    平台: ${platform.value}`, 'info')
    pushLine('提示：命令最长执行 30 分钟，可用「中断」按钮发送 Ctrl+C', 'info')
  })

  socket.on('terminal:output', (payload: any) => {
    appendOutput(String(payload?.data || ''))
  })

  socket.on('terminal:exit', (payload: any) => {
    flushCarry()
    busy.value = false
    if (payload?.cwd)
      cwd.value = String(payload.cwd)
    if (payload?.shellExited)
      pushLine('[shell 已退出，下次执行命令会自动重启]', 'info')
    else if (Number(payload?.code) !== 0)
      pushLine(`[退出码 ${payload?.code}]`, 'info')
  })

  socket.on('terminal:error', (payload: any) => {
    flushCarry()
    busy.value = false
    pushLine(`[错误] ${String(payload?.message || 'unknown error')}`, 'error')
  })
}

function connect() {
  disconnect()
  socket = io({
    path: '/socket.io',
    auth: { token: String(tokenRef.value || '') },
    transports: ['websocket', 'polling'],
  })
  bindSocket()
}

function disconnect() {
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
  connected.value = false
  busy.value = false
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    submitInput()
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    applyHistory('up')
    return
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    applyHistory('down')
    return
  }
  if (event.ctrlKey && (event.key === 'c' || event.key === 'C')) {
    const selection = window.getSelection()?.toString() || ''
    if (!selection) {
      event.preventDefault()
      interrupt()
    }
    return
  }
  if (event.ctrlKey && (event.key === 'l' || event.key === 'L')) {
    event.preventDefault()
    clearScreen()
  }
}

onMounted(() => {
  try {
    userRole.value = (JSON.parse(localStorage.getItem('user_info') || 'null'))?.role || 'admin'
  }
  catch {
    userRole.value = 'admin'
  }
  if (userRole.value !== 'admin') {
    pushLine('[无权限] 网页终端仅管理员可用', 'error')
    return
  }
  connect()
  nextTick(() => inputRef.value?.focus())
})

onBeforeUnmount(() => {
  disconnect()
})
</script>

<template>
  <div v-if="userRole !== 'admin'" class="terminal-page w-full flex flex-col items-center justify-center gap-2 p-6 text-sm opacity-80">
    <span class="i-carbon-locked text-2xl" />
    <span>网页终端仅管理员可用</span>
  </div>
  <div v-else class="terminal-page w-full flex flex-col gap-3 p-3 md:p-4">
    <div class="terminal-toolbar flex flex-wrap items-center gap-2">
      <span class="inline-flex items-center gap-1 text-sm font-medium">
        <span
          class="h-2 w-2 rounded-full"
          :class="connected ? 'bg-green-500' : 'bg-gray-400'"
        />
        {{ connected ? '已连接' : '未连接' }}
      </span>
      <span class="i-carbon-terminal text-lg opacity-70" />
      <span class="truncate text-xs opacity-70">{{ cwd || '等待连接…' }}</span>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <NButton size="tiny" secondary :disabled="!connected" @click="interrupt">
          中断 (Ctrl+C)
        </NButton>
        <NButton size="tiny" secondary @click="clearScreen">
          清屏
        </NButton>
        <NButton size="tiny" secondary @click="connect">
          重连
        </NButton>
      </div>
    </div>

    <div class="terminal-quick flex flex-wrap items-center gap-2">
      <NButton
        v-for="item in quickCommands"
        :key="item.cmd"
        size="tiny"
        tertiary
        :disabled="!connected || busy"
        @click="runQuick(item.cmd)"
      >
        {{ item.label }}
      </NButton>
    </div>

    <div
      ref="bodyRef"
      class="terminal-body custom-scrollbar flex-1 overflow-auto rounded-xl p-3 text-[13px] leading-[1.55]"
      @click="inputRef?.focus()"
    >
      <div
        v-for="line in lines"
        :key="line.id"
        class="terminal-line"
        :class="line.kind"
      >{{ line.text }}</div>

      <div class="terminal-inputline flex items-center gap-2 whitespace-pre-wrap">
        <span class="terminal-prompt">{{ promptText }}</span>
        <input
          ref="inputRef"
          v-model="input"
          class="terminal-input flex-1 bg-transparent text-[13px] outline-none"
          :disabled="!connected"
          :placeholder="busy ? '命令执行中…（可直接输入交互内容，回车发送）' : '输入命令后回车执行'"
          spellcheck="false"
          autocomplete="off"
          @keydown="onKeydown"
        >
      </div>
    </div>

    <p class="text-xs opacity-60">
      该终端以服务端进程身份执行命令，仅管理员可见；请勿在生产环境执行破坏性命令。
    </p>
  </div>
</template>

<style scoped>
.terminal-page {
  min-height: 560px;
}

.terminal-body {
  min-height: 320px;
  background: #0b1015;
  border: 1px solid rgba(120, 140, 130, 0.25);
  color: #d7e3dc;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace;
}

.terminal-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.terminal-line.output {
  color: #d7e3dc;
}

.terminal-line.input {
  color: #6ee7b7;
}

.terminal-line.info {
  color: #fcd34d;
}

.terminal-line.error {
  color: #f87171;
}

.terminal-prompt {
  color: #6ee7b7;
  font-family: inherit;
}

.terminal-input {
  color: #eaf3ee;
  font-family: inherit;
  border: none;
}

.terminal-input:disabled {
  opacity: 0.6;
}
</style>
