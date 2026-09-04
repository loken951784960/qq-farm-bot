/**
 * 抓包登录集成层
 *
 * 新版仓库（liyangpengs/qq-farm-bot 20260902）本身不含抓包模块。
 * 这里把旧版本内置的 MITM 抓包登录能力重新接入：
 * - 注入进程内 capture core（createCaptureCore，常驻待机代理）
 * - 为新版 store 补齐抓包相关配置方法（新版原版没有）
 * - 提供旧路由需要的鉴权 / 账号访问回调
 */
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_CAPTURE_CONFIG = Object.freeze({
  enabled: true,
  embedded: true,
  apiBase: 'http://127.0.0.1:8450',
  apiToken: '',
})

function resolveDataDir() {
  try {
    const { getDataDir } = require('../../config/runtime-paths')
    return getDataDir()
  } catch {
    return path.join(__dirname, '..', '..', '..', 'data')
  }
}

function getCaptureConfigPath() {
  return path.join(resolveDataDir(), 'capture', 'config.json')
}

function readCaptureConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCaptureConfigPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCaptureConfig(patch) {
  const file = getCaptureConfigPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const next = Object.assign({}, readCaptureConfig(), patch)
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch {
    return Object.assign({}, readCaptureConfig(), patch)
  }
}

function buildStoreAdapter(store) {
  return Object.assign(Object.create(null), store, {
    DEFAULT_CAPTURE_CONFIG,
    getCaptureConfig: () => Object.assign({}, DEFAULT_CAPTURE_CONFIG, readCaptureConfig()),
    setCaptureConfig: patch => writeCaptureConfig(patch),
    getAccountsByUser: () =>
      typeof store.getAccounts === 'function' ? store.getAccounts() : { accounts: [] },
  })
}

function mountCaptureIntegration(app, ctx) {
  let captureRoutes
  try {
    captureRoutes = require('../admin-capture-routes')
  } catch (error) {
    console.warn('[capture] 抓包路由模块缺失，已跳过抓包登录:', error.message)
    return null
  }

  let logger
  try {
    const { createModuleLogger } = require('../../services/logger')
    logger = createModuleLogger('capture')
  } catch {
    logger = {
      info: (...args) => console.log('[capture]', ...args),
      warn: (...args) => console.warn('[capture]', ...args),
      error: (...args) => console.error('[capture]', ...args),
    }
  }

  const store = require('../../models/store')
  const { createAuthRequired } = require('./middleware')
  const storeAdapter = buildStoreAdapter(store)

  // 旧版依赖 req.currentUser；新版为单一管理员，这里注入等价身份
  app.use(['/api/capture', '/api/admin/capture-config'], (req, _res, next) => {
    if (!req.currentUser) {
      req.currentUser = {
        username: 'admin',
        role: 'admin',
        accountLimit: Number.MAX_SAFE_INTEGER,
      }
    }
    next()
  })

  let core = null

  async function ensureEmbeddedCaptureService() {
    if (core) return core
    try {
      const { createCaptureCore } = require('../../capture')
      core = createCaptureCore({})
      captureRoutes.setEmbeddedCapture(core)
      logger.info('抓包服务已启动（嵌入模式）', {
        proxyPort: core && core.config && core.config.proxyPortFrom,
      })
    } catch (error) {
      logger.warn('抓包服务启动失败', { error: error.message })
      core = null
    }
    return core
  }

  async function stopEmbeddedCaptureService() {
    if (!core) return
    try {
      if (typeof core.stop === 'function') await core.stop()
    } catch (error) {
      logger.warn('抓包服务停止失败', { error: error.message })
    } finally {
      core = null
      captureRoutes.setEmbeddedCapture(null)
    }
  }

  try {
    captureRoutes.registerAdminCaptureRoutes({
      app,
      store: storeAdapter,
      provider: ctx && ctx.provider,
      userStore: { DEFAULT_ACCOUNT_LIMIT: Number.MAX_SAFE_INTEGER },
      logger,
      requireAdminRole: createAuthRequired(ctx),
      requireDangerConfirmation: () => true,
      canAccessAccount: () => true,
      resolveAccountReference: ref => ref,
      ensureEmbeddedCaptureService,
      stopEmbeddedCaptureService,
    })
    logger.info('抓包登录路由已挂载')
  } catch (error) {
    logger.warn('抓包登录路由挂载失败', { error: error.message })
    return null
  }

  // 立即拉起常驻 MITM 代理，保证手机端代理判定不会回退直连
  void ensureEmbeddedCaptureService()

  return {
    ensureEmbeddedCaptureService,
    stopEmbeddedCaptureService,
    getCore: () => core,
  }
}

module.exports = { mountCaptureIntegration, DEFAULT_CAPTURE_CONFIG }
