'use strict'

const {
  cleanText,
  truncate,
  parseJsonLoose,
  sha256,
  estimateTokens,
} = require('./text')
const { clampScore, profilePromptBlock, scoreAnalysis, timelinessScore } = require('./profile')

const PROMPT_VERSION = 'research-analysis-v1'
const ANALYSIS_SYSTEM_TEMPLATE = `你是严谨的计算机科学研究助理。你只根据提供的论文标题和摘要做初步判断，不能假装读过全文，不能编造实验结果，不能把作者主张当成已验证事实。

请把“论文原文/作者主张/实验证据/你的推断”分开：
- 摘要中明确写出的内容可以作为作者主张；
- 没有全文或实验细节时，创新性、证据质量和可复现性只能是初步判断；
- 不得因为摘要出现热门关键词就给高相关性；
- 必须联系研究者已有的项目、baseline、实验结果和当前研究问题；
- 降低方差、提高平均分、增强稳定性不是同一件事；
- 单纯扩大模型或增加 GPU 不算系统创新。

你将收到若干篇论文。只输出一个 json 对象，不要输出 Markdown，不要输出解释。格式必须为：
{
  "analyses": [
    {
      "id": "输入的 arxiv id，逐字返回",
      "direction": "music|mlsys|rl|multimodal|other",
      "directionTags": ["最多 3 个方向 id"],
      "summary": "80-180 字中文摘要",
      "coreContribution": "核心方法/机制，1-3 句",
      "differenceFromPrior": "相对已有工作的差异；若摘要不足以判断，明确写‘摘要未提供充分对比’",
      "evidenceBoundary": "哪些是作者主张，哪些只是摘要层面，缺少什么证据",
      "limitations": "具体局限，不要写套话",
      "relatedProjects": ["与研究者哪个项目/研究问题相关"],
      "recommendation": "为什么值得/不值得读，以及建议的下一步",
      "noveltyJudgment": "初步创新性判断及依据",
      "scores": {
        "relevance": 0,
        "novelty": 0,
        "evidence": 0,
        "reproducibility": 0
      }
    }
  ]
}

评分均为 0-100 整数：
- relevance：与研究者具体问题和已有工作的关系；仅关键词相似不得高分。
- novelty：新问题、新机制或明确缺陷修复；摘要证据不足时不得高于 60。
- evidence：基线、消融、真实负载、统计和复现细节；只有摘要时不得高于 65。
- reproducibility：代码/数据/实现细节/成本可复现性。

研究画像：
__RESEARCH_PROFILE__
`

function profileSystemBlock(profile) {
  return profilePromptBlock(profile)
}

function buildAnalysisSystem(profile) {
  return ANALYSIS_SYSTEM_TEMPLATE.replace('__RESEARCH_PROFILE__', profileSystemBlock(profile))
}

function buildAnalysisUser(papers, profile, now = new Date()) {
  const abstractChars = profile.scoring.abstractChars
  return JSON.stringify(
    {
      task: 'evaluate_papers_for_research_decisions',
      date: now.toISOString().slice(0, 10),
      output: 'json',
      papers: papers.map((paper) => ({
        id: paper.arxiv_id || paper.arxivId,
        title: cleanText(paper.title),
        published: paper.published_at || paper.published,
        categories: paper.categories,
        abstract: truncate(paper.abstract, abstractChars),
        deterministic_direction_hint: paper.primary_direction || null,
        deterministic_matches: paper.directionTags || [],
        code_signal: /(github\.com|gitlab\.com|code is available|open-source|we release)/i.test(
          paper.abstract || '',
        ),
      })),
    },
    null,
    0,
  )
}

const QUESTION_SYSTEM = `你是研究选题审计助手。你的任务不是编造“研究空白”，而是从给定的研究画像、论文证据和局限中提出可证伪的候选研究问题。

只输出 json，不要 Markdown。格式：
{
  "questions": [
    {
      "question": "一个具体、可证伪的问题",
      "whyItMatters": "为什么影响用户当前研究决策",
      "evidence": ["只能引用输入中出现的 arxiv id"],
      "counterexample": "什么结果会推翻这个判断",
      "experiment": "成本可控的最低验证实验",
      "uncertainty": "目前证据不足或可能失败的地方"
    }
  ]
}
要求：最多 4 个问题；每个问题至少引用一个输入论文 id；不得把“训练更稳定”“平均分更高”“方差更低”混为一谈；不得声称输入中没有的事实。`

function buildQuestionUser(direction, papers, profile) {
  return JSON.stringify(
    {
      task: 'propose_research_questions',
      direction: direction.id,
      directionLabel: direction.label,
      researchQuestions: (direction.projects || []).flatMap((project) => project.questions || []),
      knownWorks: direction.knownWorks || [],
      evidence: papers.map((paper) => ({
        id: paper.arxiv_id,
        title: paper.title,
        summary: paper.summary || '',
        coreContribution: paper.core_contribution || '',
        limitations: paper.limitations || '',
        evidenceBoundary: paper.evidence_boundary || '',
        scores: paper.scores || null,
      })),
    },
    null,
    0,
  )
}

function normalizeAnalysis(item, profile, paper, now = new Date()) {
  const scores = item && item.scores ? item.scores : {}
  const directionIds = new Set((profile.researchDirections || []).map((direction) => direction.id))
  const direction = directionIds.has(cleanText(item && item.direction)) ? cleanText(item.direction) : 'other'
  const tags = Array.isArray(item && item.directionTags)
    ? item.directionTags.map(cleanText).filter((tag) => directionIds.has(tag)).slice(0, 3)
    : direction !== 'other'
      ? [direction]
      : []
  const rawScores = {
    relevance: clampScore(scores.relevance, 0),
    novelty: clampScore(scores.novelty, 0),
    evidence: clampScore(scores.evidence, 0),
    reproducibility: clampScore(scores.reproducibility, 0),
    timeliness: timelinessScore(paper && (paper.published_at || paper.published), now),
  }
  const total = scoreAnalysis(rawScores, profile)
  return {
    direction,
    directionTags: tags,
    summary: truncate(item.summary, 800),
    coreContribution: truncate(item.coreContribution, 1200),
    differenceFromPrior: truncate(item.differenceFromPrior, 1200),
    evidenceBoundary:
      truncate(item.evidenceBoundary, 1200) ||
      '仅基于标题与摘要，未核验全文、实验设置和统计检验。',
    limitations: truncate(item.limitations, 1000),
    relatedProjects: (Array.isArray(item.relatedProjects) ? item.relatedProjects : [])
      .map((value) => truncate(value, 200))
      .filter(Boolean)
      .slice(0, 5),
    recommendation: truncate(item.recommendation, 1200),
    noveltyJudgment: truncate(item.noveltyJudgment, 1000),
    noveltyPreliminary: true,
    scores: total,
    totalScore: total.total,
    raw: item,
  }
}

function validateBatch(payload, papers, profile, now = new Date()) {
  const list = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.analyses) && payload.analyses) ||
      (payload && Array.isArray(payload.papers) && payload.papers) ||
      []
  const paperList = (papers || []).map((paper) =>
    typeof paper === 'string' ? { arxiv_id: paper } : paper,
  )
  const byId = new Map(paperList.map((paper) => [String(paper.arxiv_id), paper]))
  const wanted = new Set(byId.keys())
  const valid = []
  const invalid = []
  for (const item of list) {
    const id = cleanText(item && item.id)
    if (!wanted.has(id)) {
      invalid.push({ id, reason: 'unknown_or_missing_id' })
      continue
    }
    const normalized = normalizeAnalysis(item, profile, byId.get(id), now)
    if (!normalized.summary || !normalized.coreContribution) {
      invalid.push({ id, reason: 'missing_required_fields' })
      continue
    }
    valid.push({ id, analysis: normalized })
  }
  const found = new Set(valid.map((item) => item.id))
  for (const id of wanted) if (!found.has(id)) invalid.push({ id, reason: 'missing_from_response' })
  return { valid, invalid: invalid.slice(0, 20) }
}

function parsePricePeriod(profile, now = new Date()) {
  const pricing = profile.modelPrices || {}
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: profile.timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const holidays = new Set(pricing.holidays || [])
  const weekday = now.getUTCDay()
  const hour = now.getUTCHours()
  let peak = false
  if (!pricing.peakWeekdaysOnly || (weekday >= 1 && weekday <= 5)) {
    if (!holidays.has(localDate)) {
      peak = (pricing.peakHoursUtc || []).some(([start, end]) => hour >= start && hour < end)
    }
  }
  return peak ? 'peak' : 'offpeak'
}

function calculateCost(usage, model, profile, period) {
  const pricing = profile.modelPrices || {}
  const modelPricing = pricing.models && pricing.models[model]
  if (!modelPricing || !modelPricing[period]) return null
  const rate = modelPricing[period]
  const input = Number(usage.prompt_tokens || 0)
  const hit = Number(usage.prompt_cache_hit_tokens || 0)
  const miss = Number.isFinite(Number(usage.prompt_cache_miss_tokens))
    ? Number(usage.prompt_cache_miss_tokens)
    : Math.max(0, input - hit)
  const output = Number(usage.completion_tokens || 0)
  const cost =
    (hit * Number(rate.cacheHit || 0) +
      miss * Number(rate.cacheMiss || 0) +
      output * Number(rate.output || 0)) /
    Number(pricing.unitTokens || 1000000)
  return Math.round(cost * 1e8) / 1e8
}

function startOfZonedDay(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type) => (parts.find((item) => item.type === type) || {}).value
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai',
    timeZoneName: 'longOffset',
  }).formatToParts(now)
  const offsetText = (offsetParts.find((item) => item.type === 'timeZoneName') || {}).value || 'GMT+00:00'
  const offset = offsetText.replace('GMT', '') || '+00:00'
  return new Date(`${date}T00:00:00${offset}`)
}

function startOfZonedWeek(now, timezone) {
  const dayStart = startOfZonedDay(now, timezone)
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai',
    weekday: 'short',
  }).format(now)
  const daysSinceMonday = (weekdayMap[label] + 6) % 7
  return new Date(dayStart.getTime() - daysSinceMonday * 86400000)
}

class BudgetError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'BudgetError'
    this.category = 'budget'
    this.details = details
  }
}

class LlmError extends Error {
  constructor(message, category, details) {
    super(message)
    this.name = 'LlmError'
    this.category = category || 'llm'
    this.details = details || {}
  }
}

class DeepSeekResearchClient {
  constructor({ profile, db, logger, fetchImpl, apiKey, baseUrl, sessionId }) {
    this.profile = profile
    this.db = db
    this.logger = logger || console
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.apiKey = apiKey || process.env.OPENCODE_API_KEY || ''
    this.baseUrl = (
      baseUrl ||
      process.env.OPENCODE_BASE_URL ||
      'https://opencode.ai/inference/go/v1'
    ).replace(/\/+$/, '')
    this.sessionId = sessionId || process.env.OPENCODE_SESSION || 'qq-bot'
  }

  model() {
    return this.profile.model || 'deepseek-flash'
  }

  budgetStatus(now = new Date()) {
    const dailyStart = startOfZonedDay(now, this.profile.timezone)
    const weeklyStart = startOfZonedWeek(now, this.profile.timezone)
    const daily = this.db.usageCostSince(dailyStart.toISOString())
    const weekly = this.db.usageCostSince(weeklyStart.toISOString())
    return {
      daily: {
        spent: daily.cost,
        requests: daily.requests,
        limit: this.profile.budget.dailyUsd,
        remaining: Math.max(0, this.profile.budget.dailyUsd - daily.cost),
      },
      weekly: {
        spent: weekly.cost,
        requests: weekly.requests,
        limit: this.profile.budget.weeklyUsd,
        remaining: Math.max(0, this.profile.budget.weeklyUsd - weekly.cost),
      },
    }
  }

  assertBudget(system, user, maxTokens) {
    const budget = this.budgetStatus()
    const period = parsePricePeriod(this.profile)
    const pricing = this.profile.modelPrices || {}
    const rate = pricing.models && pricing.models[this.model()] && pricing.models[this.model()][period]
    if (!rate) return
    const inputEstimate = estimateTokens(`${system}\n${user}`)
    const maxEstimate =
      (inputEstimate * Number(rate.cacheMiss || 0) + Number(maxTokens) * Number(rate.output || 0)) /
      Number(pricing.unitTokens || 1000000)
    if (this.profile.budget.dailyUsd > 0 && budget.daily.spent + maxEstimate > this.profile.budget.dailyUsd) {
      throw new BudgetError('今日研究 API 预算不足，已停止新的模型调用', {
        ...budget.daily,
        estimatedMaxCost: maxEstimate,
      })
    }
    if (this.profile.budget.weeklyUsd > 0 && budget.weekly.spent + maxEstimate > this.profile.budget.weeklyUsd) {
      throw new BudgetError('本周研究 API 预算不足，已停止新的模型调用', {
        ...budget.weekly,
        estimatedMaxCost: maxEstimate,
      })
    }
  }

  async callJson({ system, user, requestType, taskId, maxTokens, temperature = 0.1 }) {
    if (!this.apiKey) throw new LlmError('OPENCODE_API_KEY 未配置', 'auth')
    const inputChars = system.length + user.length
    if (inputChars > this.profile.budget.maxRequestInputChars) {
      throw new LlmError(`单次请求输入过长（${inputChars} 字符），请缩小批次`, 'input_too_large')
    }
    this.assertBudget(system, user, maxTokens)
    const requestId = `req_${sha256(`${Date.now()}:${Math.random()}`).slice(0, 24)}`
    const started = Date.now()
    const period = parsePricePeriod(this.profile)
    const model = this.model()
    let lastError = null
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.profile.budget.timeoutMs || 90000)
      try {
        const session = [
          this.sessionId,
          requestType || 'research',
          taskId || 'batch',
        ]
          .map((part) => String(part).slice(0, 80))
          .join(':')
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'x-opencode-session': session,
            'User-Agent': 'qq-bot/1.0',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            thinking: {
              type: this.profile.budget.thinkingMode === 'enabled' ? 'enabled' : 'disabled',
            },
            max_tokens: Math.min(
              Number(maxTokens) || 2000,
              Number(this.profile.budget.maxOutputTokens) || 5000,
            ),
            temperature,
            stream: false,
          }),
          signal: controller.signal,
        })
        clearTimeout(timer)
        const text = await response.text()
        if (!response.ok) {
          let message = `HTTP ${response.status}`
          try {
            const body = JSON.parse(text)
            message = (body.error && (body.error.message || body.error.type)) || message
          } catch (error) {
            if (text) message = `${message} ${text.slice(0, 300)}`
          }
          const category =
            response.status === 401 || response.status === 403
              ? 'auth'
              : response.status === 402
                ? 'balance'
                : response.status === 429
                  ? 'rate_limit'
                  : response.status >= 500
                    ? 'server'
                    : 'http'
          const error = new LlmError(message, category, { status: response.status })
          if ((response.status === 429 || response.status >= 500) && attempt === 0) {
            const retryAfter = Number(response.headers.get('retry-after'))
            await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 2500))
            lastError = error
            continue
          }
          this.recordFailure({ requestId, requestType, taskId, model, started, error, period })
          throw error
        }
        let data
        try {
          data = JSON.parse(text)
        } catch (error) {
          throw new LlmError('API 返回的不是 JSON', 'invalid_response')
        }
        const message = data.choices && data.choices[0] && data.choices[0].message
        const content = message && (message.content || message.reasoning_content)
        const usage = data.usage || {}
        if (!content) {
          try {
            this.db.recordUsage({
              requestId,
              taskId,
              requestType,
              model,
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
              cacheHitTokens: usage.prompt_cache_hit_tokens,
              cacheMissTokens: usage.prompt_cache_miss_tokens,
              latencyMs: Date.now() - started,
              estimatedCostUsd: calculateCost(usage, model, this.profile, period),
              pricingPeriod: period,
              status: 'error',
              errorCategory: 'empty_response',
              errorMessage: '模型没有返回内容',
              rawUsage: usage,
            })
          } catch (recordError) {
            this.logger.warn && this.logger.warn('记录空响应用量失败: %s', recordError.message)
          }
          lastError = new LlmError('模型没有返回内容', 'empty_response')
          if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1500))
            continue
          }
          throw lastError
        }
        const latencyMs = Date.now() - started
        const cost = calculateCost(usage, model, this.profile, period)
        try {
          this.db.recordUsage({
            requestId,
            taskId,
            requestType,
            model,
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            cacheHitTokens: usage.prompt_cache_hit_tokens,
            cacheMissTokens: usage.prompt_cache_miss_tokens,
            latencyMs,
            estimatedCostUsd: cost,
            pricingPeriod: period,
            status: 'ok',
            rawUsage: usage,
          })
        } catch (recordError) {
          this.logger.warn && this.logger.warn('记录 API 用量失败: %s', recordError.message)
        }
        return {
          content: String(content).trim(),
          usage,
          latencyMs,
          cost,
          period,
          requestId,
          cacheHit: Number(usage.prompt_cache_hit_tokens || 0),
          cacheMiss: Number(usage.prompt_cache_miss_tokens || 0),
        }
      } catch (error) {
        clearTimeout(timer)
        if (error instanceof LlmError || error instanceof BudgetError) {
          if (error instanceof BudgetError) throw error
          if (error.category === 'invalid_response' && attempt === 0) {
            lastError = error
            continue
          }
          throw error
        }
        const category =
          error.name === 'AbortError'
            ? 'timeout'
            : /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(error.message)
              ? 'network'
              : 'network'
        const wrapped = new LlmError(error.name === 'AbortError' ? 'DeepSeek 请求超时' : error.message, category)
        if (attempt === 0) {
          lastError = wrapped
          await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        this.recordFailure({ requestId, requestType, taskId, model, started, error: wrapped, period })
        throw wrapped
      }
    }
    throw lastError || new LlmError('DeepSeek 请求失败', 'unknown')
  }

  recordFailure({ requestId, requestType, taskId, model, started, error, period }) {
    try {
      this.db.recordUsage({
        requestId,
        taskId,
        requestType,
        model,
        latencyMs: Date.now() - started,
        status: 'error',
        errorCategory: error.category || 'unknown',
        errorMessage: error.message,
        pricingPeriod: period,
      })
    } catch (recordError) {
      this.logger.warn && this.logger.warn('记录 API 用量失败: %s', recordError.message)
    }
  }

  async analyzeBatch(papers, { taskId, now = new Date() } = {}) {
    const system = buildAnalysisSystem(this.profile)
    const user = buildAnalysisUser(papers, this.profile, now)
    const maxTokens = Math.min(
      Number(this.profile.budget.maxOutputTokens) || 5000,
      Math.max(1800, papers.length * 900),
    )
    const result = await this.callJson({
      system,
      user,
      requestType: 'paper_analysis',
      taskId,
      maxTokens,
      temperature: 0.1,
    })
    let payload
    try {
      payload = parseJsonLoose(result.content)
    } catch (error) {
      const wrapped = new LlmError(
        `论文分析结果无法解析为 JSON（${result.content.length} 字符: ${result.content.slice(0, 160)}）`,
        'invalid_json',
        { contentLength: result.content.length, usage: result.usage },
      )
      throw wrapped
    }
    return {
      ...validateBatch(payload, papers, this.profile, now),
      api: result,
    }
  }

  async repairAnalysis(paper, { taskId, now = new Date() } = {}) {
    return this.analyzeBatch([paper], { taskId, now })
  }

  async synthesizeQuestions(direction, papers, { taskId } = {}) {
    const result = await this.callJson({
      system: QUESTION_SYSTEM,
      user: buildQuestionUser(direction, papers, this.profile),
      requestType: 'research_questions',
      taskId,
      maxTokens: 2600,
      temperature: 0.2,
    })
    let payload
    try {
      payload = parseJsonLoose(result.content)
    } catch (error) {
      throw new LlmError('研究问题结果无法解析为 JSON', 'invalid_json')
    }
    const evidenceIds = new Set(papers.map((paper) => paper.arxiv_id).filter(Boolean))
    const questions = (payload.questions || [])
      .filter((item) => item && cleanText(item.question))
      .slice(0, 4)
      .map((item) => ({
        question: truncate(item.question, 300),
        whyItMatters: truncate(item.whyItMatters, 500),
        evidence: (Array.isArray(item.evidence) ? item.evidence : [])
          .map(cleanText)
          .filter((id) => evidenceIds.has(id)),
        counterexample: truncate(item.counterexample, 500),
        experiment: truncate(item.experiment, 500),
        uncertainty: truncate(item.uncertainty, 500),
      }))
      .filter((item) => item.evidence.length > 0)
    return { questions, api: result }
  }
}

module.exports = {
  PROMPT_VERSION,
  DeepSeekResearchClient,
  LlmError,
  BudgetError,
  buildAnalysisSystem,
  buildAnalysisUser,
  parsePricePeriod,
  calculateCost,
  startOfZonedDay,
  startOfZonedWeek,
  validateBatch,
  normalizeAnalysis,
  QUESTION_SYSTEM,
}
