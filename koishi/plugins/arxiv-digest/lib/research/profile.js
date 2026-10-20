'use strict'

const fs = require('fs')
const path = require('path')
const {
  cleanText,
  termMatches,
  sha256,
  parseDate,
} = require('./text')

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => !key.startsWith('__'))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const DEFAULT_WEIGHTS = {
  relevance: 0.4,
  novelty: 0.25,
  evidence: 0.15,
  reproducibility: 0.1,
  timeliness: 0.1,
}

function clampScore(value, fallback = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(100, Math.round(number)))
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('研究画像不是对象')
  if (!Array.isArray(profile.researchDirections) || !profile.researchDirections.length) {
    throw new Error('研究画像缺少 researchDirections')
  }
  const ids = new Set()
  for (const direction of profile.researchDirections) {
    if (!direction.id || ids.has(direction.id)) throw new Error(`研究方向 id 无效或重复: ${direction.id}`)
    ids.add(direction.id)
    direction.weight = Number(direction.weight) || 0
    direction.keywords = Array.isArray(direction.keywords) ? direction.keywords : []
    direction.projects = Array.isArray(direction.projects) ? direction.projects : []
  }
  profile.scoring = profile.scoring || {}
  profile.scoring.weights = { ...DEFAULT_WEIGHTS, ...(profile.scoring.weights || {}) }
  const total = Object.values(profile.scoring.weights).reduce((sum, item) => sum + Number(item || 0), 0)
  if (total <= 0) throw new Error('评分权重之和必须大于 0')
  profile.scoring.topN = Math.max(1, Math.min(5, Number(profile.scoring.topN) || 3))
  profile.scoring.minTopScore = clampScore(profile.scoring.minTopScore, 60)
  profile.scoring.analysisBatchSize = Math.max(1, Math.min(20, Number(profile.scoring.analysisBatchSize) || 8))
  profile.scoring.dailyAnalysisLimit = Math.max(1, Math.min(30, Number(profile.scoring.dailyAnalysisLimit) || 10))
  profile.scoring.abstractChars = Math.max(600, Math.min(5000, Number(profile.scoring.abstractChars) || 1800))
  profile.budget = profile.budget || {}
  profile.budget.dailyUsd = Math.max(0, Number(profile.budget.dailyUsd) || 0)
  profile.budget.weeklyUsd = Math.max(0, Number(profile.budget.weeklyUsd) || 0)
  profile.budget.maxOutputTokens = Math.max(512, Math.min(16000, Number(profile.budget.maxOutputTokens) || 5000))
  return profile
}

function createProfileLoader(file) {
  let cached = null
  let mtime = 0
  return function load() {
    const stat = fs.statSync(file)
    if (cached && stat.mtimeMs === mtime) return cached
    const profile = validateProfile(JSON.parse(fs.readFileSync(file, 'utf8')))
    profile.__file = file
    profile.__hash = sha256(stableStringify(profile))
    cached = profile
    mtime = stat.mtimeMs
    return profile
  }
}

function directionById(profile, id) {
  return (profile.researchDirections || []).find((direction) => direction.id === id) || null
}

function matchDirections(paper, profile) {
  const title = cleanText(paper.title).toLowerCase()
  const abstract = cleanText(paper.abstract || paper.summary || '').toLowerCase()
  const categories = new Set(
    [paper.primaryCategory].concat(paper.categories || []).filter(Boolean).map((item) => String(item)),
  )
  const matches = []
  for (const direction of profile.researchDirections || []) {
    let score = 0
    let titleHits = 0
    let abstractHits = 0
    const matchedTerms = []
    if ((direction.arxivCategories || []).some((category) => categories.has(category))) score += 6
    for (const term of direction.keywords || []) {
      let hit = false
      if (termMatches(title, term)) {
        score += 5
        titleHits += 1
        hit = true
      } else if (termMatches(abstract, term)) {
        score += 2
        abstractHits += 1
        hit = true
      }
      if (hit) matchedTerms.push(term)
    }
    if (!score) continue
    matches.push({
      id: direction.id,
      label: direction.label,
      priority: Number(direction.priority) || 99,
      weight: Number(direction.weight) || 0,
      score,
      titleHits,
      abstractHits,
      matchedTerms: matchedTerms.slice(0, 8),
    })
  }
  matches.sort((left, right) => right.score - left.score || left.priority - right.priority)
  return matches
}

function timelinessScore(publishedAt, now = new Date()) {
  const published = parseDate(publishedAt)
  if (!published) return 50
  const ageDays = Math.max(0, (now.getTime() - published.getTime()) / 86400000)
  if (ageDays <= 2) return 100
  if (ageDays <= 7) return 90
  if (ageDays <= 30) return 75
  if (ageDays <= 180) return 55
  return 35
}

function hasCodeSignal(paper) {
  const abstract = String(paper.abstract || paper.summary || '')
  return /(github\.com|gitlab\.com|code is available|code and data|open-source|open source|we release|released at)/i.test(abstract)
}

function hasExperimentSignal(paper) {
  const abstract = String(paper.abstract || paper.summary || '')
  return /(experiment|benchmark|dataset|ablation|evaluation|baseline|improv|outperform|accuracy|throughput|latency)/i.test(abstract)
}

function preliminaryScores(paper, profile, now = new Date()) {
  const matches = matchDirections(paper, profile)
  const best = matches[0]
  const relevance = best
    ? Math.min(58, 18 + Math.min(18, best.score) + (best.titleHits ? 8 : 0))
    : 12
  const evidence = hasExperimentSignal(paper) ? 46 : 34
  const reproducibility = 30 + (hasCodeSignal(paper) ? 22 : 0) + (hasExperimentSignal(paper) ? 8 : 0)
  const timeliness = timelinessScore(paper.publishedAt || paper.published, now)
  const defaults = {
    relevance,
    novelty: 30,
    evidence,
    reproducibility: Math.min(60, reproducibility),
    timeliness,
  }
  const weights = profile.scoring.weights
  const total =
    defaults.relevance * weights.relevance +
    defaults.novelty * weights.novelty +
    defaults.evidence * weights.evidence +
    defaults.reproducibility * weights.reproducibility +
    defaults.timeliness * weights.timeliness
  return {
    ...defaults,
    total: Math.round(total * 10) / 10,
    preliminary: true,
    direction: best ? best.id : null,
    directionLabel: best ? best.label : '未分类',
    directionMatches: matches,
  }
}

function scoreAnalysis(scores, profile) {
  const weights = profile.scoring.weights
  const normalized = {
    relevance: clampScore(scores && scores.relevance, 0),
    novelty: clampScore(scores && scores.novelty, 0),
    evidence: clampScore(scores && scores.evidence, 0),
    reproducibility: clampScore(scores && scores.reproducibility, 0),
    timeliness: clampScore(scores && scores.timeliness, 0),
  }
  const total =
    normalized.relevance * weights.relevance +
    normalized.novelty * weights.novelty +
    normalized.evidence * weights.evidence +
    normalized.reproducibility * weights.reproducibility +
    normalized.timeliness * weights.timeliness
  return { ...normalized, total: Math.round(total * 10) / 10, preliminary: false }
}

function scoreBand(score) {
  if (score >= 80) return '强烈推荐'
  if (score >= 70) return '值得优先阅读'
  if (score >= 60) return '值得浏览'
  if (score >= 45) return '可留作背景'
  return '相关性较低'
}

function profilePromptBlock(profile) {
  const lines = []
  lines.push('研究者的长期优先级（仅用于判断论文与用户研究问题的关系）：')
  for (const direction of [...(profile.researchDirections || [])].sort(
    (left, right) => Number(left.priority) - Number(right.priority),
  )) {
    lines.push(`- [${direction.id}] ${direction.label}（权重 ${direction.weight}）`)
    for (const project of (direction.projects || []).slice(0, 4)) {
      lines.push(`  · 项目/主题：${project.name}`)
      for (const question of (project.questions || []).slice(0, 4)) {
        lines.push(`    问题：${question}`)
      }
    }
  }
  lines.push('已知相关工作与实验条件（避免把用户已做过的工作当作新颖发现）：')
  for (const direction of profile.researchDirections || []) {
    const works = (direction.knownWorks || []).join('；')
    if (works) lines.push(`- ${direction.label}：${works}`)
  }
  return lines.join('\n')
}

function publicProfilePath(profile) {
  return profile && profile.__file ? path.basename(profile.__file) : 'research-profile.json'
}

module.exports = {
  DEFAULT_WEIGHTS,
  scoreBand,
  clampScore,
  validateProfile,
  createProfileLoader,
  directionById,
  matchDirections,
  preliminaryScores,
  scoreAnalysis,
  timelinessScore,
  profilePromptBlock,
  publicProfilePath,
  stableStringify,
}
