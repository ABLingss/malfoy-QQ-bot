'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Schema, h } = require('koishi')
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../..')

exports.name = 'tts-voice'

exports.Config = Schema.object({
  configFile: Schema.string()
    .default(path.join(PROJECT_ROOT, 'config', 'tts.json'))
    .description('TTS 运行时配置（音色、语速、限流、缓存）'),
})

const DEFAULTS = {
  enabled: true,
  voice: 'zh-CN-XiaoyiNeural',
  rate: '-3%',
  pitch: '-6Hz',
  volume: '+0%',
  maxChars: 160,
  autoMaxChars: 120,
  minIntervalMs: 20000,
  retryDelayMs: 20000,
  retries: 2,
  timeoutMs: 30000,
  maxQueue: 6,
  cacheDir: path.join(PROJECT_ROOT, 'data', 'tts-cache'),
  cacheMaxFiles: 500,
  perUserPerMinute: 4,
  perUserPerDay: 80,
  groupWhitelist: [],
  readMode: true,
  answerMode: true,
}

const REQUEST_PREFIX =
  '^(?:那|那么)?\\s*(?:请)?\\s*(?:麻烦)?\\s*(?:你)?\\s*(?:能不能|可以|可不可以)?\\s*(?:给我|帮我|为我|对我)?\\s*(?:用语音|语音)?\\s*'

const READ_RE = new RegExp(`${REQUEST_PREFIX}(?:念|朗读|读)(?:一下|一遍|出来)?\\s*[：:，,]?\\s*([\\s\\S]+)$`)

const ANSWER_RE = new RegExp(
  `${REQUEST_PREFIX}(?:说一说|说一下|说说|讲一讲|讲一下|讲讲|聊一聊|聊一下|聊聊|说给我听|语音回答|回答)(?:一下)?\\s*[：:，,]?\\s*([\\s\\S]*)$`,
)

const LITERAL_RE = /^语音\s*[：:，,]?\s*([\s\S]+)$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function validRate(value, fallback) {
  return typeof value === 'string' && /^[+-]?\d+%$/.test(value) ? value : fallback
}

function validPitch(value, fallback) {
  return typeof value === 'string' && /^[+-]?\d+Hz$/.test(value) ? value : fallback
}

function normalizeConfig(raw) {
  return {
    ...DEFAULTS,
    ...raw,
    enabled: raw.enabled !== false,
    readMode: raw.readMode !== false,
    answerMode: raw.answerMode !== false,
    voice: typeof raw.voice === 'string' && raw.voice ? raw.voice : DEFAULTS.voice,
    rate: validRate(raw.rate, DEFAULTS.rate),
    pitch: validPitch(raw.pitch, DEFAULTS.pitch),
    volume: validRate(raw.volume, DEFAULTS.volume),
    maxChars: clampInt(raw.maxChars, 20, 500, DEFAULTS.maxChars),
    autoMaxChars: clampInt(raw.autoMaxChars, 20, 300, DEFAULTS.autoMaxChars),
    minIntervalMs: clampInt(raw.minIntervalMs, 0, 120000, DEFAULTS.minIntervalMs),
    retryDelayMs: clampInt(raw.retryDelayMs, 1000, 60000, DEFAULTS.retryDelayMs),
    retries: clampInt(raw.retries, 0, 5, DEFAULTS.retries),
    timeoutMs: clampInt(raw.timeoutMs, 5000, 120000, DEFAULTS.timeoutMs),
    maxQueue: clampInt(raw.maxQueue, 1, 20, DEFAULTS.maxQueue),
    cacheDir: typeof raw.cacheDir === 'string' && raw.cacheDir ? raw.cacheDir : DEFAULTS.cacheDir,
    cacheMaxFiles: clampInt(raw.cacheMaxFiles, 0, 5000, DEFAULTS.cacheMaxFiles),
    perUserPerMinute: clampInt(raw.perUserPerMinute, 1, 100, DEFAULTS.perUserPerMinute),
    perUserPerDay: clampInt(raw.perUserPerDay, 1, 1000, DEFAULTS.perUserPerDay),
    groupWhitelist: Array.isArray(raw.groupWhitelist)
      ? raw.groupWhitelist.map(String).map((id) => id.trim()).filter(Boolean)
      : [],
  }
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .join('')
  }
  return content == null ? '' : String(content)
}

function truncateAtSentence(text, limit) {
  if (text.length <= limit) return text
  const slice = text.slice(0, limit)
  const marks = ['。', '！', '？', '；', '.', '!', '?', ';']
  let cut = -1
  for (const mark of marks) cut = Math.max(cut, slice.lastIndexOf(mark))
  if (cut >= Math.floor(limit * 0.5)) return slice.slice(0, cut + 1)
  return `${slice.replace(/[，,、\s]+$/, '')}……`
}

function cleanForSpeech(value, limit) {
  let text = String(value == null ? '' : value)
  text = text.replace(/```[\s\S]*?```/g, ' ')
  text = text.replace(/`([^`]*)`/g, '$1')
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/\[CQ:[^\]]+\]/g, ' ')
  text = text.replace(/[*_~#>|]/g, ' ')
  text = text.replace(/[（(][^）)]{1,24}[）)]/g, ' ')
  text = text.replace(/^(?:马尔福|德拉科|助手|AI|本小姐)[：:]\s*/i, '')
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
  text = text.replace(/(^|\s)[-+]\s+/g, ' ')
  text = text.replace(/\s+([，。！？；：、])/g, '$1')
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return truncateAtSentence(text, limit)
}

function normalizeIncoming(value) {
  return String(value == null ? '' : value)
    .replace(/<quote[^>]*\/?>/g, ' ')
    .replace(/<at[^>]*\/?>/g, ' ')
    .trim()
}

function parseIntent(raw) {
  const text = String(raw || '').replace(/^\s+/, '')
  if (!text) return null

  let match = text.match(READ_RE)
  if (match) {
    const content = match[1].trim()
    if (content) return { mode: 'read', text: content }
  }

  match = text.match(ANSWER_RE)
  if (match) {
    return { mode: 'answer', text: (match[1] || '').trim() }
  }

  match = text.match(LITERAL_RE)
  if (match) {
    const content = match[1].trim()
    if (content) return { mode: 'read', text: content }
  }

  return null
}

function sessionKey(session) {
  if (session.fid) return String(session.fid)
  return [session.platform, session.channelId, session.userId].filter(Boolean).join(':')
}

exports.apply = function apply(ctx, config) {
  const logger = ctx.logger('tts-voice')
  const configFile = config.configFile || path.join(PROJECT_ROOT, 'config', 'tts.json')

  let cached = null
  let cachedMtime = -1
  let warnedMissing = false

  function loadConfig() {
    try {
      const stat = fs.statSync(configFile)
      if (cached && stat.mtimeMs === cachedMtime) return cached
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      cached = normalizeConfig(raw)
      cachedMtime = stat.mtimeMs
      warnedMissing = false
      return cached
    } catch (error) {
      if (!cached) {
        if (!warnedMissing) {
          logger.warn('TTS 配置读取失败，使用默认值：%s', error.message)
          warnedMissing = true
        }
        cached = normalizeConfig({})
      }
      return cached
    }
  }

  const cfg0 = loadConfig()
  const cacheDir = path.resolve(process.cwd(), cfg0.cacheDir)

  let lastStart = 0
  let queueTail = Promise.resolve()
  let queueSize = 0
  let lastPrune = 0

  const memoryCache = new Map()
  const userUsage = new Map()
  const pendingVoice = new Map()

  function remember(key, buffer) {
    memoryCache.delete(key)
    memoryCache.set(key, buffer)
    while (memoryCache.size > 24) memoryCache.delete(memoryCache.keys().next().value)
  }

  function cacheKey(text, cfg) {
    return crypto
      .createHash('sha256')
      .update([cfg.voice, cfg.rate, cfg.pitch, cfg.volume, text].join('\n'))
      .digest('hex')
  }

  async function readCache(key) {
    const hit = memoryCache.get(key)
    if (hit) return hit
    try {
      const buffer = await fs.promises.readFile(path.join(cacheDir, `${key}.mp3`))
      if (!buffer.length) return null
      remember(key, buffer)
      return buffer
    } catch {
      return null
    }
  }

  async function pruneCache(cfg) {
    if (!cfg.cacheMaxFiles) return
    if (Date.now() - lastPrune < 3600000) return
    lastPrune = Date.now()
    try {
      const names = await fs.promises.readdir(cacheDir)
      if (names.length <= cfg.cacheMaxFiles) return
      const files = await Promise.all(
        names.map(async (name) => {
          const file = path.join(cacheDir, name)
          try {
            const stat = await fs.promises.stat(file)
            return { file, mtime: stat.mtimeMs }
          } catch {
            return null
          }
        }),
      )
      const valid = files.filter(Boolean)
      const stale = valid
        .sort((a, b) => a.mtime - b.mtime)
        .slice(0, Math.max(0, valid.length - cfg.cacheMaxFiles))
      await Promise.all(stale.map(({ file }) => fs.promises.unlink(file).catch(() => {})))
    } catch (error) {
      logger.debug('清理语音缓存失败：%s', error.message)
    }
  }

  async function writeCache(key, buffer, cfg) {
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true })
      await fs.promises.writeFile(path.join(cacheDir, `${key}.mp3`), buffer)
      remember(key, buffer)
      pruneCache(cfg)
    } catch (error) {
      logger.debug('写入语音缓存失败：%s', error.message)
    }
  }

  async function synthesizeOnce(text, cfg) {
    const tts = new MsEdgeTTS()
    try {
      await tts.setMetadata(cfg.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
      const { audioStream } = await tts.toStream(text, {
        rate: cfg.rate,
        pitch: cfg.pitch,
        volume: cfg.volume,
      })
      const chunks = []
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Edge TTS 超时（${cfg.timeoutMs}ms）`))
        }, cfg.timeoutMs)
        audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        audioStream.on('end', () => {
          clearTimeout(timer)
          resolve()
        })
        audioStream.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      const buffer = Buffer.concat(chunks)
      if (!buffer.length) throw new Error('Edge TTS 返回空音频')
      return buffer
    } finally {
      try {
        tts.close()
      } catch {
        // ignore
      }
    }
  }

  function enqueue(task, cfg) {
    if (queueSize >= cfg.maxQueue) {
      return Promise.reject(new Error(`语音队列已满（${cfg.maxQueue}）`))
    }
    queueSize++
    const run = queueTail.then(async () => {
      const wait = Math.max(0, lastStart + cfg.minIntervalMs - Date.now())
      if (wait) await sleep(wait)
      lastStart = Date.now()
      return task()
    })
    queueTail = run.then(
      () => {},
      () => {},
    )
    return run.finally(() => {
      queueSize--
    })
  }

  function synthesizeQueued(text, cfg) {
    return enqueue(async () => {
      for (let attempt = 0; attempt <= cfg.retries; attempt++) {
        try {
          return await synthesizeOnce(text, cfg)
        } catch (error) {
          const message = String((error && error.message) || error)
          const rateLimited = /429|too many requests/i.test(message)
          if (!rateLimited || attempt >= cfg.retries) throw error
          const delay = cfg.retryDelayMs * (attempt + 1)
          logger.warn('Edge TTS 被限流，%d 秒后重试（%d/%d）', Math.round(delay / 1000), attempt + 1, cfg.retries)
          await sleep(delay)
          lastStart = Date.now()
        }
      }
      throw new Error('Edge TTS 重试耗尽')
    }, cfg)
  }

  async function getAudio(text, cfg) {
    const key = cacheKey(text, cfg)
    const cachedAudio = await readCache(key)
    if (cachedAudio) return cachedAudio
    const buffer = await synthesizeQueued(text, cfg)
    await writeCache(key, buffer, cfg)
    return buffer
  }

  function checkUserLimit(userId, cfg) {
    const id = String(userId || 'unknown')
    const now = Date.now()
    let usage = userUsage.get(id)
    if (!usage) {
      usage = { minuteAt: now, minuteCount: 0, dayAt: now, dayCount: 0 }
      userUsage.set(id, usage)
    }
    if (now - usage.minuteAt >= 60000) {
      usage.minuteAt = now
      usage.minuteCount = 0
    }
    if (now - usage.dayAt >= 86400000) {
      usage.dayAt = now
      usage.dayCount = 0
    }
    if (usage.minuteCount >= cfg.perUserPerMinute || usage.dayCount >= cfg.perUserPerDay) {
      return false
    }
    usage.minuteCount++
    usage.dayCount++
    if (userUsage.size > 500) {
      for (const [key, item] of userUsage) {
        if (now - item.dayAt > 86400000) userUsage.delete(key)
      }
    }
    return true
  }

  function markVoiceTurn(session) {
    const key = sessionKey(session)
    pendingVoice.set(key, Date.now() + 180000)
    if (pendingVoice.size > 200) {
      const now = Date.now()
      for (const [itemKey, expires] of pendingVoice) {
        if (expires < now) pendingVoice.delete(itemKey)
      }
    }
  }

  function consumeVoiceTurn(session) {
    const key = sessionKey(session)
    const expires = pendingVoice.get(key)
    if (!expires) return false
    pendingVoice.delete(key)
    return expires >= Date.now()
  }

  async function sendVoice(session, rawText, cfg, options = {}) {
    const fallback = options.fallback !== false
    const text = cleanForSpeech(rawText, options.auto ? cfg.autoMaxChars : cfg.maxChars)
    if (text.length < 2) {
      if (fallback) await session.send('没听清，再说一遍？')
      return false
    }
    let buffer
    try {
      buffer = await getAudio(text, cfg)
    } catch (error) {
      logger.warn('语音生成失败：%s', error.message)
      if (fallback) await session.send('哼，本小姐嗓子不舒服，晚点再说。')
      return false
    }
    try {
      await session.send(h.audio(buffer, 'audio/mpeg'))
      return true
    } catch (error) {
      logger.warn('语音发送失败：%s', error.message)
      if (fallback) await session.send('语音没发出去，等下再试。')
      return false
    }
  }

  ctx.middleware(async (session, next) => {
    if (!session.content) return next()
    if (session.userId && session.userId === session.selfId) return next()

    const cfg = loadConfig()
    if (!cfg.enabled) return next()
    if (session.guildId) {
      const mentioned =
        (session.stripped && session.stripped.atSelf) ||
        (session.selfId && String(session.content || '').includes(`<at id="${session.selfId}"`))
      if (!mentioned) return next()
      if (cfg.groupWhitelist.length && !cfg.groupWhitelist.includes(String(session.guildId))) return next()
    }

    const text = normalizeIncoming((session.stripped && session.stripped.content) || session.content)
    const intent = parseIntent(text)
    if (!intent) return next()
    if (intent.mode === 'read' && !cfg.readMode) return next()
    if (intent.mode === 'answer' && !cfg.answerMode) return next()

    if (intent.mode === 'answer' && !intent.text) {
      await session.send('想让本小姐说什么？')
      return
    }

    if (!checkUserLimit(session.userId, cfg)) {
      if (intent.mode === 'read') await session.send('哼，本小姐嗓子要冒烟了，等会儿再说。')
      return
    }

    if (intent.mode === 'read') {
      await sendVoice(session, intent.text, cfg, { fallback: true })
      return
    }

    markVoiceTurn(session)
    return next()
  }, true)

  ctx.on('chatluna/after-chat', async (conversationId, sourceMessage, responseMessage, promptVariables, chatInterface, session) => {
    const cfg = loadConfig()
    if (!cfg.enabled || !cfg.answerMode || !session) return
    if (!consumeVoiceTurn(session)) return
    const text = messageText(responseMessage && responseMessage.content)
    await sendVoice(session, text, cfg, { fallback: false, auto: true })
  })

  logger.info(
    'TTS 已加载：voice=%s rate=%s pitch=%s 间隔=%dms 缓存=%s',
    cfg0.voice,
    cfg0.rate,
    cfg0.pitch,
    cfg0.minIntervalMs,
    cacheDir,
  )
}

exports._test = { parseIntent, cleanForSpeech, normalizeConfig, normalizeIncoming, sessionKey, truncateAtSentence }
