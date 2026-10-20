'use strict'

const fs = require('fs')
const path = require('path')
const { Schema, h } = require('koishi')

const PROJECT_ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '../../..')

exports.name = 'bot-services'

exports.Config = Schema.object({
  configFile: Schema.string()
    .default(path.join(PROJECT_ROOT, 'config', 'bot.json'))
    .description('运行时配置（白名单、默认城市、限额、开关、人设图目录）'),
})

const DEFAULTS = {
  groupWhitelist: [],
  defaultCity: 'London',
  features: {
    search: true,
    weather: true,
    translate: true,
    summarize: true,
    remind: true,
    threeKingdom: true,
  },
  searchCount: 5,
  searchCacheSeconds: 600,
  searchPerUserPerMinute: 3,
  searchPerUserPerDay: 30,
  weatherPerUserPerMinute: 6,
  translateModel: 'deepseek-flash',
  translatePerUserPerMinute: 5,
  translatePerUserPerDay: 100,
  summarizeModel: 'deepseek-flash',
  summarizeMaxChars: 12000,
  summarizeCacheSeconds: 1800,
  summarizePerUserPerMinute: 3,
  summarizePerUserPerDay: 30,
  reminderFile: path.join(PROJECT_ROOT, 'data', 'reminders.json'),
  reminderMaxPending: 10,
  reminderPerUserPerDay: 10,
  timezone: 'Asia/Shanghai',
  threeKingdomFile: path.join(PROJECT_ROOT, 'integrations', 'ThreeKingdomMeme', 'knowledge_base', 'xinsanguo_corpus.json'),
  persona: {
    name: '研究助理',
    addressUserAs: '你',
    imagesDir: path.join(PROJECT_ROOT, 'assets', 'persona'),
    maxImages: 3,
    intro: [],
  },
}

const WEATHER_TEXT = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '雷暴伴冰雹',
}

const TARGET_LANGS = {
  英文: 'English',
  英语: 'English',
  日文: 'Japanese',
  日语: 'Japanese',
  韩文: 'Korean',
  韩语: 'Korean',
  中文: 'Chinese',
  汉语: 'Chinese',
  法文: 'French',
  法语: 'French',
  德文: 'German',
  德语: 'German',
  俄文: 'Russian',
  俄语: 'Russian',
  西班牙文: 'Spanish',
  西班牙语: 'Spanish',
}

function clean(value, limit = 160) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function featureEnabled(cfg, name) {
  return !cfg.features || cfg.features[name] !== false
}

function deepseekErrorMessage(status) {
  if (status === 401 || status === 403) return 'DeepSeek 鉴权失败，检查 .env 里的 Key'
  if (status === 402) return 'DeepSeek 余额不足，去平台充值'
  if (status === 429) return 'DeepSeek 被限流了，稍后再试'
  if (status >= 500) return 'DeepSeek 服务暂时不可用，稍后再试'
  return `DeepSeek 请求失败（HTTP ${status}）`
}

function parseTranslateInput(input) {
  const text = String(input || '').trim()
  for (const [alias, target] of Object.entries(TARGET_LANGS)) {
    if (text.startsWith(alias + ' ')) {
      return { target, text: text.slice(alias.length).trim() }
    }
  }
  const hasCJK = /[一-鿿]/.test(text)
  return { target: hasCJK ? 'English' : 'Chinese', text }
}

function parseWhen(input) {
  const match = String(input || '').trim().match(/^(\d+)\s*(秒钟|分钟|小时|秒|分|时|天)后$/)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = match[2]
  const ms =
    unit === '秒钟' || unit === '秒'
      ? 1000
      : unit === '分钟' || unit === '分'
        ? 60000
        : unit === '小时' || unit === '时'
          ? 3600000
          : 86400000
  const due = n * ms
  if (due < 10000 || due > 7 * 86400000) return null
  return { due, label: `${n}${unit}` }
}

function formatTime(ts, timezone) {
  try {
    return new Date(ts).toLocaleString('zh-CN', {
      timeZone: timezone || 'Asia/Shanghai',
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return new Date(ts).toISOString()
  }
}

function validatePublicUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error('链接格式不对')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http/https 链接')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error('这个链接不允许抓取')
  }
  return url.toString()
}

function flattenThreeKingdom(corpus, templates) {
  const quotes = []
  for (const category of (corpus && corpus.categories) || []) {
    for (const item of category.items || []) {
      const tags = Array.isArray(item.meme_tags) ? item.meme_tags : []
      quotes.push({
        kind: 'quote',
        category: category.name || '',
        categoryDescription: category.description || '',
        text: item.text || '',
        character: item.character || '',
        tags,
        value: item.template_value || '',
        search: [item.text, item.character, category.name, category.description, ...tags]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      })
    }
  }
  const characters = ((corpus && corpus.character_styles) || []).map((item) => {
    const catchphrases = Array.isArray(item.catchphrases) ? item.catchphrases : []
    const bestFor = Array.isArray(item.best_for) ? item.best_for : []
    const recommendedUsage = Array.isArray(item.recommended_usage) ? item.recommended_usage : []
    return {
      kind: 'character',
      character: item.character || '',
      tone: item.tone || '',
      instruction: item.voice_instruction || '',
      catchphrases,
      bestFor,
      recommendedUsage,
      search: [
        item.character,
        item.tone,
        item.voice_instruction,
        ...catchphrases,
        ...bestFor,
        ...recommendedUsage,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
    }
  })
  const templateList = ((templates && templates.templates) || []).map((item) => ({
    kind: 'template',
    style: item.style || '',
    template: item.template || '',
    useCase: item.use_case || '',
    example: item.example_filled || '',
    search: [item.style, item.template, item.use_case, item.example_filled]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  }))
  return { quotes, characters, templates: templateList }
}

function searchThreeKingdom(data, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) {
    const quote = data.quotes[Math.floor(Math.random() * data.quotes.length)] || null
    const template = data.templates[Math.floor(Math.random() * data.templates.length)] || null
    return { mode: 'random', quote, template }
  }
  const character = data.characters.find(
    (item) =>
      item.character.toLowerCase() === q ||
      (q.length >= 2 &&
        (q.includes(item.character.toLowerCase()) || item.character.toLowerCase().includes(q))),
  )
  if (character) {
    return {
      mode: 'character',
      character,
      quotes: data.quotes.filter((item) => item.character === character.character).slice(0, 2),
    }
  }
  const tokens = q.split(/\s+/).filter(Boolean)
  const score = (entry) => {
    let value = 0
    if (entry.search.includes(q)) value += 6
    for (const token of tokens) if (entry.search.includes(token)) value += 2
    if (entry.kind === 'quote' && entry.text.toLowerCase().includes(q)) value += 4
    if (entry.kind === 'template' && entry.template.toLowerCase().includes(q)) value += 3
    return value
  }
  const entries = [...data.quotes, ...data.templates]
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.entry)
  if (entries.length) return { mode: 'search', query: q, entries }

  // 中文长句没有空格，退回二字组模糊匹配，例如“老板改需求”可命中“需求”。
  const compact = q.replace(/\s+/g, '')
  if (compact.length >= 2) {
    const grams = new Set()
    for (let i = 0; i < compact.length - 1; i += 1) grams.add(compact.slice(i, i + 2))
    const fuzzy = [...data.quotes, ...data.templates]
      .map((entry) => {
        let value = 0
        for (const gram of grams) if (entry.search.includes(gram)) value += 1
        return { entry, score: value }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.entry)
    if (fuzzy.length) return { mode: 'search', query: q, entries: fuzzy }
  }
  return { mode: 'none', query: q }
}

function formatThreeKingdom(result, query) {
  if (result.mode === 'none') {
    return `没找到「${clean(query, 40)}」相关的梗，试试：曹操、诸葛亮、摆烂、叉出去、不可能。`
  }
  const lines = ['【新三国梗】']
  if (result.mode === 'random') {
    if (result.quote) {
      lines.push(`【${result.quote.character}】「${clean(result.quote.text, 100)}」`)
      if (result.quote.tags.length) lines.push(`标签：${result.quote.tags.slice(0, 6).join(' / ')}`)
    }
    if (result.template) {
      lines.push(`句式：「${clean(result.template.template, 100)}」`)
      if (result.template.useCase) lines.push(`用法：${clean(result.template.useCase, 100)}`)
    }
  } else if (result.mode === 'character') {
    const c = result.character
    lines.push(`【${c.character}】${clean(c.tone, 120)}`)
    if (c.catchphrases.length) {
      lines.push(`口头禅：${c.catchphrases.slice(0, 6).map((x) => clean(x, 40)).join(' / ')}`)
    }
    if (c.bestFor.length) {
      lines.push(`适合：${c.bestFor.slice(0, 3).map((x) => clean(x, 60)).join('；')}`)
    }
    for (const quote of result.quotes) {
      lines.push(`「${clean(quote.text, 100)}」`)
      if (quote.tags.length) lines.push(`标签：${quote.tags.slice(0, 6).join(' / ')}`)
    }
  } else {
    for (const entry of result.entries) {
      if (entry.kind === 'quote') {
        lines.push(`【${entry.character}】「${clean(entry.text, 100)}」`)
        if (entry.tags.length) lines.push(`标签：${entry.tags.slice(0, 6).join(' / ')}`)
        if (entry.category) lines.push(`分类：${clean(entry.category, 60)}`)
      } else if (entry.kind === 'template') {
        lines.push(`句式：「${clean(entry.template, 100)}」`)
        if (entry.useCase) lines.push(`用法：${clean(entry.useCase, 100)}`)
        if (entry.example) lines.push(`示例：${clean(entry.example, 100)}`)
      }
    }
  }
  lines.push('想再找就发：三国梗 <关键词>')
  return lines.join('\n')
}

function fillThreeKingdomTopic(text, topic) {
  const value = topic || '你'
  return String(text || '')
    .replace(/\{X\}/g, value)
    .replace(/\{Y\}/g, value)
    .replace(/\{Z\}/g, value)
    .replace(/\bX\b/g, value)
    .replace(/\bY\b/g, value)
    .replace(/\bZ\b/g, value)
}

exports._test = {
  parseWhen,
  parseTranslateInput,
  validatePublicUrl,
  flattenThreeKingdom,
  searchThreeKingdom,
  formatThreeKingdom,
  fillThreeKingdomTopic,
}

exports.apply = function apply(ctx, config) {
  const logger = ctx.logger('bot-services')
  const configFile = config.configFile || path.join(PROJECT_ROOT, 'config', 'bot.json')
  let cached = null
  let cachedMtime = -1
  let warnedMissing = false

  function loadConfig() {
    try {
      const stat = fs.statSync(configFile)
      if (cached && stat.mtimeMs === cachedMtime) return cached
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      const whitelist = Array.isArray(raw.groupWhitelist)
        ? raw.groupWhitelist.map(String)
        : String(raw.groupWhitelist || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
      cached = {
        ...DEFAULTS,
        ...raw,
        groupWhitelist: whitelist,
        features: { ...DEFAULTS.features, ...(raw.features || {}) },
        searchCount: clampInt(raw.searchCount, 1, 50, DEFAULTS.searchCount),
        searchCacheSeconds: clampInt(raw.searchCacheSeconds, 0, 86400, DEFAULTS.searchCacheSeconds),
        searchPerUserPerMinute: clampInt(raw.searchPerUserPerMinute, 1, 100, DEFAULTS.searchPerUserPerMinute),
        searchPerUserPerDay: clampInt(raw.searchPerUserPerDay, 1, 1000, DEFAULTS.searchPerUserPerDay),
        weatherPerUserPerMinute: clampInt(raw.weatherPerUserPerMinute, 1, 100, DEFAULTS.weatherPerUserPerMinute),
        translatePerUserPerMinute: clampInt(raw.translatePerUserPerMinute, 1, 100, DEFAULTS.translatePerUserPerMinute),
        translatePerUserPerDay: clampInt(raw.translatePerUserPerDay, 1, 1000, DEFAULTS.translatePerUserPerDay),
        summarizeMaxChars: clampInt(raw.summarizeMaxChars, 1000, 50000, DEFAULTS.summarizeMaxChars),
        summarizeCacheSeconds: clampInt(raw.summarizeCacheSeconds, 0, 86400, DEFAULTS.summarizeCacheSeconds),
        summarizePerUserPerMinute: clampInt(raw.summarizePerUserPerMinute, 1, 100, DEFAULTS.summarizePerUserPerMinute),
        summarizePerUserPerDay: clampInt(raw.summarizePerUserPerDay, 1, 1000, DEFAULTS.summarizePerUserPerDay),
        reminderMaxPending: clampInt(raw.reminderMaxPending, 1, 100, DEFAULTS.reminderMaxPending),
        reminderPerUserPerDay: clampInt(raw.reminderPerUserPerDay, 1, 1000, DEFAULTS.reminderPerUserPerDay),
        reminderFile:
          typeof raw.reminderFile === 'string' && raw.reminderFile ? raw.reminderFile : DEFAULTS.reminderFile,
        timezone: typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : DEFAULTS.timezone,
        threeKingdomFile:
          typeof raw.threeKingdomFile === 'string' && raw.threeKingdomFile
            ? raw.threeKingdomFile
            : DEFAULTS.threeKingdomFile,
        persona: { ...DEFAULTS.persona, ...(raw.persona || {}) },
      }
      cachedMtime = stat.mtimeMs
      warnedMissing = false
      return cached
    } catch (error) {
      if (!cached) {
        cached = { ...DEFAULTS, features: { ...DEFAULTS.features }, persona: { ...DEFAULTS.persona } }
      }
      if (!warnedMissing) {
        logger.warn('cannot load %s, using defaults: %s', configFile, error.message)
        warnedMissing = true
      }
      return cached
    }
  }

  function isMentioned(session) {
    const selfId = String(session.selfId || '')
    if (!selfId) return false
    const elements = Array.isArray(session.elements) ? session.elements : []
    if (elements.some((el) => el.type === 'at' && String(el.attrs && el.attrs.id) === selfId)) {
      return true
    }
    const content = String(session.content || '')
    return content.includes(`<at id="${selfId}"`) || content.includes(`@${selfId}`)
  }

  function isIdentityQuestion(text) {
    return /(你是谁|你叫什么|你叫啥|介绍一下(你|自己)|介绍下(你|自己)|你是哪位|什么身份|人设图|看看你|长什么样|发.{0,4}(图|照片)|(你|马尔福|德拉科|大小姐|哈姆子).{0,8}(是谁|叫什么|哪位|介绍|什么身份))/.test(
      String(text || ''),
    )
  }

  function loadPersonaImages(cfg) {
    const dir = cfg.persona.imagesDir
    const max = clampInt(cfg.persona.maxImages, 1, 9, 3)
    const allowed = new Map([
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.webp', 'image/webp'],
    ])
    try {
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => allowed.has(path.extname(name).toLowerCase()))
      for (let i = files.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[files[i], files[j]] = [files[j], files[i]]
      }
      return files.slice(0, max).flatMap((name) => {
        try {
          const file = path.join(dir, name)
          const stat = fs.statSync(file)
          if (stat.size > 8 * 1024 * 1024) {
            logger.warn('persona image too large, skipped: %s', name)
            return []
          }
          const mime = allowed.get(path.extname(name).toLowerCase())
          const data = fs.readFileSync(file).toString('base64')
          return [h.image(`data:${mime};base64,${data}`)]
        } catch (error) {
          logger.warn('cannot read persona image %s: %s', name, error.message)
          return []
        }
      })
    } catch (error) {
      logger.warn('cannot read persona dir %s: %s', dir, error.message)
      return []
    }
  }

  async function sendPersona(session, cfg) {
    const name = clean(cfg.persona.name, 40) || DEFAULTS.persona.name
    const address = clean(cfg.persona.addressUserAs, 20) || DEFAULTS.persona.addressUserAs
    const images = loadPersonaImages(cfg)
    const configuredIntro = cfg.persona && cfg.persona.intro
    const intro = Array.isArray(configuredIntro) && configuredIntro.length
      ? configuredIntro.map((line) => clean(line, 300)).filter(Boolean).join('\n')
      : `我是${name}。直接问我就好，${address}。`
    if (images.length) {
      await session.send([h.text(intro), ...images])
    } else {
      await session.send(intro)
    }
  }

  const rateBuckets = new Map()
  function allowRate(key, limit, windowMs) {
    const now = Date.now()
    const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs)
    if (arr.length >= limit) {
      rateBuckets.set(key, arr)
      return false
    }
    arr.push(now)
    rateBuckets.set(key, arr)
    if (rateBuckets.size > 1000) {
      for (const [k, v] of rateBuckets) {
        if (!v.some((t) => now - t < 86400000)) rateBuckets.delete(k)
      }
    }
    return true
  }

  const searchCache = new Map()
  function cacheGet(cache, key) {
    const item = cache.get(key)
    if (!item) return null
    if (item.expires <= Date.now()) {
      cache.delete(key)
      return null
    }
    return item.text
  }
  function cacheSet(cache, key, text, seconds) {
    if (seconds <= 0) return
    if (cache.size > 100) cache.delete(cache.keys().next().value)
    cache.set(key, { text, expires: Date.now() + seconds * 1000 })
  }

  async function deepseekSearch(query, cfg) {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) throw new Error('DEEPSEEK_API_KEY 未配置')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await fetch('https://api.deepseek.com/v1/tools/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          count: cfg.searchCount,
          need_content: false,
        }),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(deepseekErrorMessage(response.status))
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error('DeepSeek 搜索返回格式异常')
      }
      return Array.isArray(data.results) ? data.results : []
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('搜索请求超时，检查服务器网络')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function formatSearch(query, results, cfg) {
    if (!results.length) return `什么都没查到，${cfg.persona.addressUserAs || '波特'}，关键词再想想。`
    const lines = [`${cfg.persona.addressUserAs || '波特'}，本小姐查到的「${query}」：`]
    results.forEach((r, index) => {
      const title = clean(r.title, 120) || '（无标题）'
      const url = clean(r.url, 300)
      const snippet = clean(r.snippet || r.summary, 140)
      const date = clean(r.date, 10)
      const score = typeof r.rerank_score === 'number' ? r.rerank_score.toFixed(1) : ''
      const meta = [clean(r.site_name, 40), date, score ? `相关度 ${score}` : '']
        .filter(Boolean)
        .join(' · ')
      lines.push(`${index + 1}. ${title}`)
      lines.push(`   ${url}`)
      if (snippet) lines.push(`   ${snippet}`)
      if (meta) lines.push(`   ${meta}`)
    })
    lines.push('哼，来源都给你了，自己判断。')
    return lines.join('\n')
  }

  async function runSearch(session, query, cfg) {
    if (!featureEnabled(cfg, 'search')) return '搜索功能暂时关了，波特。'
    const address = cfg.persona.addressUserAs || '波特'
    const normalized = query.trim()
    if (!normalized) return '波特，搜索什么？把关键词写出来。'
    if ([...normalized].length > 128) return '关键词太长了，波特。压缩到 128 个字以内。'

    const cacheKey = `${cfg.searchCount}:${normalized.toLowerCase()}`
    const cached = cacheGet(searchCache, cacheKey)
    if (cached) return `（缓存）\n${cached}`

    const uid = String(session.userId || session.channelId || 'unknown')
    if (!allowRate(`search:min:${uid}`, cfg.searchPerUserPerMinute, 60000)) {
      return `${address}，你问得太急了。等一分钟再来。`
    }
    if (!allowRate(`search:day:${uid}`, cfg.searchPerUserPerDay, 86400000)) {
      return `${address}，今天的搜索次数用完了。明天再来，或让管理员调高限额。`
    }

    const results = await deepseekSearch(normalized, cfg)
    const text = formatSearch(normalized, results, cfg)
    cacheSet(searchCache, cacheKey, text, cfg.searchCacheSeconds)
    logger.info('search ok results=%d query_len=%d', results.length, normalized.length)
    return text
  }

  async function deepseekChat(messages, cfg, options = {}) {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) throw new Error('DEEPSEEK_API_KEY 未配置')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model || cfg.translateModel || 'deepseek-flash',
          messages,
          max_tokens: options.maxTokens || 1000,
          temperature: options.temperature == null ? 0.3 : options.temperature,
        }),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(deepseekErrorMessage(response.status))
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error('DeepSeek 返回格式异常')
      }
      const message = data.choices && data.choices[0] && data.choices[0].message
      const content = message && (message.content || message.reasoning_content)
      if (!content) throw new Error('模型没有返回内容')
      return String(content).trim()
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('DeepSeek 请求超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function runTranslate(session, input, cfg) {
    if (!featureEnabled(cfg, 'translate')) return '翻译功能暂时关了，波特。'
    const { target, text } = parseTranslateInput(input)
    if (!text) return '要翻译什么，波特？'
    if ([...text].length > 4000) return '太长了，波特。分几段发。'
    const uid = String(session.userId || session.channelId || 'unknown')
    if (!allowRate(`translate:min:${uid}`, cfg.translatePerUserPerMinute, 60000)) {
      return '等一分钟再翻译，波特。'
    }
    if (!allowRate(`translate:day:${uid}`, cfg.translatePerUserPerDay, 86400000)) {
      return '今天的翻译次数用完了，波特。'
    }
    const translation = await deepseekChat(
      [
        {
          role: 'system',
          content:
            '你是一名专业翻译。只输出译文，不要解释、不要加引号、不要加前缀。保留原文语气、专有名词和格式。',
        },
        { role: 'user', content: `目标语言：${target}\n原文：\n${text}` },
      ],
      cfg,
      {
        model: cfg.translateModel,
        maxTokens: Math.min(2000, Math.max(256, [...text].length * 2)),
        temperature: 0.2,
      },
    )
    logger.info('translate ok chars=%d target=%s', [...text].length, target)
    return `波特，译文：\n${translation}`
  }

  async function deepseekFetch(url) {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) throw new Error('DEEPSEEK_API_KEY 未配置')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60000)
    try {
      const response = await fetch('https://api.deepseek.com/v1/tools/fetch', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) throw new Error(deepseekErrorMessage(response.status))
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error('网页抓取返回格式异常')
      }
      return { title: String(data.title || ''), content: String(data.content || '') }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('网页抓取请求超时')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  const summaryCache = new Map()

  async function runSummarize(session, rawUrl, cfg) {
    if (!featureEnabled(cfg, 'summarize')) return '总结功能暂时关了，波特。'
    let url
    try {
      url = validatePublicUrl(rawUrl)
    } catch (error) {
      return error.message
    }
    const cached = cacheGet(summaryCache, url)
    if (cached) return `（缓存）\n${cached}`
    const uid = String(session.userId || session.channelId || 'unknown')
    if (!allowRate(`summarize:min:${uid}`, cfg.summarizePerUserPerMinute, 60000)) {
      return '等一分钟再总结，波特。'
    }
    if (!allowRate(`summarize:day:${uid}`, cfg.summarizePerUserPerDay, 86400000)) {
      return '今天的总结次数用完了，波特。'
    }

    const page = await deepseekFetch(url)
    if (!page.content.trim()) throw new Error('没有抓到正文，可能被网站拦截了')
    const content = page.content.slice(0, cfg.summarizeMaxChars)
    const summary = await deepseekChat(
      [
        {
          role: 'system',
          content:
            '你是一名严谨的摘要助手。用中文输出 3-6 条要点，保留关键事实、数字、结论和争议点；不要编造，不要输出与正文无关的内容。',
        },
        { role: 'user', content: `标题：${page.title || '未知'}\n链接：${url}\n正文：\n${content}` },
      ],
      cfg,
      { model: cfg.summarizeModel, maxTokens: 900, temperature: 0.2 },
    )
    const text = `波特，本小姐替你看了《${clean(page.title, 80) || '这篇文章'}》：\n${summary}\n来源：${url}`
    cacheSet(summaryCache, url, text, cfg.summarizeCacheSeconds)
    logger.info('summarize ok url_len=%d content_len=%d', url.length, content.length)
    return text
  }

  let threeKingdomCache = null

  function loadThreeKingdom(cfg) {
    try {
      const corpusFile = cfg.threeKingdomFile
      const templatesFile = path.join(path.dirname(corpusFile), 'xinsanguo_caption_templates.json')
      const corpusStat = fs.statSync(corpusFile)
      let templatesStat = null
      try {
        templatesStat = fs.statSync(templatesFile)
      } catch {}
      const stamp = `${corpusStat.mtimeMs}:${templatesStat ? templatesStat.mtimeMs : 0}`
      if (threeKingdomCache && threeKingdomCache.stamp === stamp) return threeKingdomCache.data
      const corpus = JSON.parse(fs.readFileSync(corpusFile, 'utf8'))
      const templates = templatesStat ? JSON.parse(fs.readFileSync(templatesFile, 'utf8')) : {}
      const data = flattenThreeKingdom(corpus, templates)
      threeKingdomCache = { stamp, data }
      logger.info(
        'three kingdom corpus loaded: quotes=%d characters=%d templates=%d',
        data.quotes.length,
        data.characters.length,
        data.templates.length,
      )
      return data
    } catch (error) {
      logger.warn('cannot load ThreeKingdom corpus: %s', error.message)
      return null
    }
  }

  function runThreeKingdom(query, cfg) {
    if (!featureEnabled(cfg, 'threeKingdom')) return '三国梗功能暂时关了，波特。'
    const data = loadThreeKingdom(cfg)
    if (!data || !data.quotes.length) return '新三国语料还没装好，波特。'
    return formatThreeKingdom(searchThreeKingdom(data, query), query)
  }

  function buildThreeKingdomRoast(text, cfg) {
    const data = loadThreeKingdom(cfg)
    if (!data || !data.quotes.length) return '新三国语料还没装好，波特。'
    const topic = String(text || '')
      .replace(/<at[^>]*>/g, ' ')
      .replace(/新三国|三国梗|三国嘴替/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[，,。.!！?？、\s]+|[，,。.!！?？、\s]+$/g, '')
    const result = searchThreeKingdom(data, topic)
    const address = cfg.persona.addressUserAs || '波特'
    const shortTopic = clean(topic, 40)
    if (result.mode === 'character') {
      const character = result.character
      const catchphrase =
        character.catchphrases[Math.floor(Math.random() * character.catchphrases.length)] ||
        '不可能，绝对不可能'
      return `「${clean(catchphrase, 60)}」——${address}，${character.character}要是听见你这么说，怕是要把你叉出去。`
    }
    if (result.mode === 'search' || result.mode === 'random') {
      const quote =
        result.mode === 'search'
          ? result.entries.find((entry) => entry.kind === 'quote')
          : result.quote
      const template =
        result.mode === 'search'
          ? result.entries.find((entry) => entry.kind === 'template')
          : result.template
      if (quote) {
        return `「${clean(fillThreeKingdomTopic(quote.text, shortTopic), 80)}」——${address}，${
          shortTopic ? `就你这「${shortTopic}」也配叫新三国？` : '你连新三国都敢提？'
        }本小姐劝你叉出去。`
      }
      if (template) {
        const filled = fillThreeKingdomTopic(template.template, shortTopic)
        return `「${clean(filled, 100)}」——${address}，本小姐说的，不服？叉出去。`
      }
    }
    return `「不可能，绝对不可能！」——${address}，就你这点事也配叫新三国？叉出去。`
  }

  function ensureParent(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  }

  function loadReminders(file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data) ? data : []
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('load reminders failed: %s', error.message)
      return []
    }
  }

  function saveReminders(file, list) {
    try {
      ensureParent(file)
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, file)
    } catch (error) {
      logger.warn('save reminders failed: %s', error.message)
    }
  }

  let reminders = loadReminders(loadConfig().reminderFile)
  let checkingReminders = false

  async function sendReminder(reminder) {
    const bot = ctx.bots.find(
      (item) => item.platform === reminder.platform && String(item.selfId) === String(reminder.selfId),
    )
    if (!bot) throw new Error('bot not found')
    const elements = []
    if (reminder.guildId) elements.push(h.at(String(reminder.userId)), h.text(' '))
    elements.push(h.text(`时间到了，波特。${reminder.content}`))
    await bot.sendMessage(reminder.channelId, elements)
  }

  async function checkReminders() {
    if (checkingReminders) return
    checkingReminders = true
    try {
      const cfg = loadConfig()
      const now = Date.now()
      const due = reminders.filter((r) => Number(r.due) <= now)
      if (!due.length) return
      reminders = reminders.filter((r) => Number(r.due) > now)
      for (const reminder of due) {
        try {
          await sendReminder(reminder)
        } catch (error) {
          logger.warn('reminder send failed id=%s: %s', reminder.id, error.message)
          if ((reminder.attempts || 0) < 2) {
            reminders.push({
              ...reminder,
              due: Date.now() + 300000,
              attempts: (reminder.attempts || 0) + 1,
            })
          }
        }
      }
      saveReminders(cfg.reminderFile, reminders)
    } finally {
      checkingReminders = false
    }
  }

  const reminderTimer = setInterval(() => {
    checkReminders().catch((error) => logger.warn('reminder check error: %s', error.message))
  }, 15000)
  ctx.on('dispose', () => clearInterval(reminderTimer))

  async function runRemind(session, when, contentInput, cfg) {
    if (!featureEnabled(cfg, 'remind')) return '提醒功能暂时关了，波特。'
    const parsed = parseWhen(when)
    if (!parsed) return '时间格式没看懂。用“10分钟后”“1小时后”这种写法。'
    let content = String(contentInput || '').trim().replace(/^提醒我?[，,：:\s]*/, '')
    if (!content) return '提醒你做什么？'
    if ([...content].length > 200) return '内容太长了，波特。'
    const uid = String(session.userId || session.channelId || 'unknown')
    const pending = reminders.filter(
      (r) => String(r.userId) === uid && String(r.platform) === String(session.platform),
    )
    if (pending.length >= cfg.reminderMaxPending) {
      return `你已经存了 ${pending.length} 个提醒，先处理掉一些，波特。`
    }
    if (!allowRate(`remind:day:${uid}`, cfg.reminderPerUserPerDay, 86400000)) {
      return '今天的提醒次数用完了，波特。'
    }
    const id = reminders.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1
    reminders.push({
      id,
      due: Date.now() + parsed.due,
      userId: String(session.userId || ''),
      channelId: session.channelId,
      guildId: session.guildId || null,
      platform: session.platform,
      selfId: String(session.selfId || ''),
      content,
      createdAt: Date.now(),
      attempts: 0,
    })
    saveReminders(cfg.reminderFile, reminders)
    return `行，波特。${parsed.label}后本小姐提醒你：${content}。编号 ${id}。`
  }

  function runReminderList(session, cfg) {
    const uid = String(session.userId || '')
    const mine = reminders
      .filter((r) => String(r.userId) === uid)
      .sort((a, b) => Number(a.due) - Number(b.due))
    if (!mine.length) return '没有待办提醒，波特。'
    const lines = ['波特的待办提醒：']
    for (const reminder of mine) {
      lines.push(`#${reminder.id} ${formatTime(reminder.due, cfg.timezone)} — ${clean(reminder.content, 80)}`)
    }
    return lines.join('\n')
  }

  function runCancelReminder(session, input, cfg) {
    const id = Number(input)
    if (!Number.isFinite(id)) return '编号不对，波特。'
    const uid = String(session.userId || '')
    const index = reminders.findIndex((r) => Number(r.id) === id && String(r.userId) === uid)
    if (index < 0) return '没找到这个编号，波特。'
    const [reminder] = reminders.splice(index, 1)
    saveReminders(cfg.reminderFile, reminders)
    return `取消了 #${id}：${clean(reminder.content, 60)}`
  }

  async function geocode(city) {
    const url =
      'https://geocoding-api.open-meteo.com/v1/search?name=' +
      encodeURIComponent(city) +
      '&count=1&language=zh&format=json'
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`天气地理编码失败（HTTP ${response.status}）`)
    const data = await response.json()
    return data.results && data.results[0]
  }

  async function fetchWeather(city) {
    const location = await geocode(city)
    if (!location) throw new Error(`没找到城市「${city}」`)
    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '3',
    })
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`天气服务失败（HTTP ${response.status}）`)
    return { location, data: await response.json() }
  }

  function formatWeather(location, data, cfg) {
    const address = cfg.persona.addressUserAs || '波特'
    const current = data.current || {}
    const daily = data.daily || {}
    const desc = WEATHER_TEXT[current.weather_code] || '未知天气'
    const temp = Math.round(current.temperature_2m)
    const apparent = Math.round(current.apparent_temperature)
    const humidity = Math.round(current.relative_humidity_2m)
    const wind = Math.round(current.wind_speed_10m)
    const lines = [
      `${address}，${location.name}现在 ${temp}°C，${desc}，体感 ${apparent}°C，湿度 ${humidity}%，风速 ${wind} km/h。`,
    ]
    for (let i = 0; i < 3; i += 1) {
      if (!daily.time || !daily.time[i]) continue
      const min = Math.round(daily.temperature_2m_min[i])
      const max = Math.round(daily.temperature_2m_max[i])
      const code = WEATHER_TEXT[daily.weather_code[i]] || '未知'
      const prob = daily.precipitation_probability_max[i]
      lines.push(
        `${daily.time[i].slice(5)}：${min}~${max}°C，${code}，降雨概率 ${prob == null ? '--' : prob}%`,
      )
    }
    lines.push('哼，别指望本小姐替你带伞。')
    return lines.join('\n')
  }

  async function runWeather(session, city, cfg) {
    if (!featureEnabled(cfg, 'weather')) return '天气功能暂时关了，波特。'
    const address = cfg.persona.addressUserAs || '波特'
    const uid = String(session.userId || session.channelId || 'unknown')
    if (!allowRate(`weather:min:${uid}`, cfg.weatherPerUserPerMinute, 60000)) {
      return `${address}，天气问这么勤做什么？等一分钟。`
    }
    const queryCity = (city || cfg.defaultCity || 'London').trim()
    try {
      const { location, data } = await fetchWeather(queryCity)
      return formatWeather(location, data, cfg)
    } catch (error) {
      if (error.name === 'TimeoutError') return '天气服务请求超时，稍后再试。'
      return `天气查询失败：${error.message}`
    }
  }

  function buildMenu(cfg) {
    const lines = ['波特，听好了，本小姐能做的事：']
    if (featureEnabled(cfg, 'search')) lines.push('· @我 搜索 <关键词> —— 查最新网页，带来源')
    if (featureEnabled(cfg, 'weather')) lines.push(`· @我 天气 [城市] —— 默认${cfg.defaultCity}`)
    lines.push('· @我 wordle —— 猜单词/成语')
    if (featureEnabled(cfg, 'threeKingdom')) lines.push('· 提到“新三国” —— 本小姐会毒舌点评')
    if (featureEnabled(cfg, 'translate')) lines.push('· @我 翻译 <文本> —— 中英互译')
    if (featureEnabled(cfg, 'summarize')) lines.push('· @我 总结 <链接> —— 抓网页并总结')
    if (featureEnabled(cfg, 'remind')) {
      lines.push('· @我 提醒 <10分钟后> <内容> —— 到点提醒')
      lines.push('· @我 提醒列表 / 取消提醒 <编号>')
    }
    lines.push('· @我 直接说话 —— 聊天；群里必须 @')
    lines.push('· 私聊不需要 @')
    return lines.join('\n')
  }

  ctx.middleware(async (session, next) => {
    if (session.userId && session.userId === session.selfId) return
    const cfg = loadConfig()
    if (session.guildId) {
      const guildId = String(session.guildId)
      if (!cfg.groupWhitelist.includes(guildId)) return
      if (!isMentioned(session)) return
    }
    if (isIdentityQuestion(session.content)) {
      try {
        await sendPersona(session, cfg)
      } catch (error) {
        logger.warn('sendPersona failed: %s', error.message)
        await session.send('哼，本小姐现在不想说话。')
      }
      return
    }
    if (
      featureEnabled(cfg, 'threeKingdom') &&
      /新三国|三国梗|三国嘴替/.test(String(session.content || ''))
    ) {
      try {
        await session.send(buildThreeKingdomRoast(session.content, cfg))
      } catch (error) {
        logger.warn('three kingdom roast failed: %s', error.message)
      }
      return
    }
    return next()
  }, true)

  ctx
    .command('搜索 <query:text>', '用 DeepSeek 搜索网页')
    .alias('search')
    .action(async ({ session }, query) => {
      const cfg = loadConfig()
      try {
        return await runSearch(session, query || '', cfg)
      } catch (error) {
        logger.warn('search failed: %s', error.message)
        return `搜索失败：${error.message}`
      }
    })

  ctx
    .command('天气 [city:text]', '查询天气，默认伦敦')
    .alias('weather')
    .action(async ({ session }, city) => {
      const cfg = loadConfig()
      return runWeather(session, city, cfg)
    })

  ctx
    .command('翻译 <text:text>', '翻译文本')
    .alias('translate')
    .action(async ({ session }, text) => {
      const cfg = loadConfig()
      try {
        return await runTranslate(session, text || '', cfg)
      } catch (error) {
        logger.warn('translate failed: %s', error.message)
        return `翻译失败：${error.message}`
      }
    })

  ctx
    .command('总结 <url:text>', '抓取网页并总结')
    .alias('summarize')
    .action(async ({ session }, url) => {
      const cfg = loadConfig()
      try {
        return await runSummarize(session, url || '', cfg)
      } catch (error) {
        logger.warn('summarize failed: %s', error.message)
        return `总结失败：${error.message}`
      }
    })

  ctx
    .command('提醒 <when:string> <content:text>', '到点提醒你')
    .action(async ({ session }, when, content) => {
      const cfg = loadConfig()
      try {
        return await runRemind(session, when || '', content || '', cfg)
      } catch (error) {
        logger.warn('remind failed: %s', error.message)
        return `提醒失败：${error.message}`
      }
    })

  ctx.command('提醒列表', '查看待办提醒').action(async ({ session }) => {
    const cfg = loadConfig()
    if (!featureEnabled(cfg, 'remind')) return '提醒功能暂时关了，波特。'
    return runReminderList(session, cfg)
  })

  ctx.command('取消提醒 <id:number>', '取消提醒').action(async ({ session }, id) => {
    const cfg = loadConfig()
    if (!featureEnabled(cfg, 'remind')) return '提醒功能暂时关了，波特。'
    return runCancelReminder(session, id, cfg)
  })

  ctx.command('菜单', '查看可用功能').action(async () => {
    const cfg = loadConfig()
    return buildMenu(cfg)
  })
}
