'use strict'

const { cleanText, nowIso, parseVersionNumber, parseDate } = require('./text')

const GITHUB_API = 'https://api.github.com'
const IMPORTANT_TERMS = [
  'breaking',
  'deprecat',
  'api',
  'checkpoint',
  'weights',
  'dataset',
  'data format',
  'migration',
  'performance',
  'throughput',
  'latency',
  'memory',
  'oom',
  'compile',
  'compiler',
  'kernel',
  'correctness',
  'regression',
  'grpo',
  'rl',
  'training',
  'inference',
  'bug',
]

function hasImportantTerm(value) {
  const text = String(value || '').toLowerCase()
  return IMPORTANT_TERMS.some((term) => text.includes(term))
}

function releaseImportance(release) {
  if (release.draft || release.prerelease) return 'low'
  const version = parseVersionNumber(release.tag_name || release.name)
  const body = `${release.name || ''} ${release.body || ''}`
  if (version && version[1] === 0 && version[2] === 0) return 'high'
  if (/\b(breaking|migration|deprecat|api change|checkpoint|weights|dataset|security)\b/i.test(body)) return 'high'
  if (version && version[2] === 0) return 'normal'
  return hasImportantTerm(body) ? 'normal' : 'low'
}

function releaseEvent(repo, release, { baseline = false } = {}) {
  const importance = releaseImportance(release)
  return {
    eventKey: `release:${release.id}`,
    eventType: 'release',
    title: `${repo.full_name} ${release.tag_name || release.name || 'release'}`,
    url: release.html_url,
    publishedAt: release.published_at || release.created_at,
    summary: cleanText(release.body || release.name || ''),
    importance,
    actionNeeded: importance === 'high' && /breaking|migration|deprecat|api change/i.test(release.body || ''),
    notifiedAt: baseline || importance === 'low' ? nowIso() : null,
    raw: {
      tag: release.tag_name,
      prerelease: release.prerelease,
      draft: release.draft,
    },
  }
}

function pullImportance(pull) {
  if (!pull.merged_at) return 'low'
  const labels = (pull.labels || []).map((label) => label.name).join(' ')
  const text = `${pull.title || ''} ${labels}`
  if (/performance|regression|kernel|compiler|compile|memory|throughput|correctness|grpo|rl/i.test(text)) {
    return 'high'
  }
  if (hasImportantTerm(text)) return 'normal'
  return 'low'
}

function pullEvent(repo, pull, { baseline = false } = {}) {
  const importance = pullImportance(pull)
  return {
    eventKey: `pull:${pull.id}:${pull.merged_at || pull.updated_at}`,
    eventType: 'pull_request',
    title: `${repo.full_name} PR #${pull.number}: ${cleanText(pull.title)}`,
    url: pull.html_url,
    publishedAt: pull.merged_at || pull.updated_at || pull.created_at,
    summary: cleanText(pull.body || ''),
    importance,
    actionNeeded: false,
    notifiedAt: baseline || importance === 'low' ? nowIso() : null,
    raw: {
      number: pull.number,
      merged: Boolean(pull.merged_at),
      labels: (pull.labels || []).map((label) => label.name),
    },
  }
}

function issueImportance(issue) {
  if (issue.state === 'closed') return 'low'
  const labels = (issue.labels || []).map((label) => label.name).join(' ')
  const text = `${issue.title || ''} ${labels}`
  const comments = Number(issue.comments || 0)
  if (/bug|regression|performance|correctness|oom|memory/i.test(text) && comments >= 2) return 'high'
  if (comments >= 8) return 'normal'
  if (comments >= 3 && hasImportantTerm(text)) return 'normal'
  return 'low'
}

function issueEvent(repo, issue, { baseline = false } = {}) {
  const importance = issueImportance(issue)
  return {
    eventKey: `issue:${issue.id}:${issue.updated_at}`,
    eventType: 'issue',
    title: `${repo.full_name} Issue #${issue.number}: ${cleanText(issue.title)}`,
    url: issue.html_url,
    publishedAt: issue.updated_at || issue.created_at,
    summary: cleanText(issue.body || ''),
    importance,
    actionNeeded: importance === 'high',
    notifiedAt: baseline || importance === 'low' ? nowIso() : null,
    raw: {
      number: issue.number,
      state: issue.state,
      comments: issue.comments,
      labels: (issue.labels || []).map((label) => label.name),
    },
  }
}

class GitHubMonitor {
  constructor({ profile, db, logger, fetchImpl, token }) {
    this.profile = profile
    this.db = db
    this.logger = logger || console
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.token = token || process.env.GITHUB_TOKEN || ''
    this.config = profile.github || {}
  }

  headers(extra = {}) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'research-agent-qq/1.0',
      ...extra,
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    return headers
  }

  async request(url, { etag } = {}) {
    const headers = this.headers(etag ? { 'If-None-Match': etag } : {})
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await this.fetchImpl(url, { headers, signal: controller.signal })
      clearTimeout(timer)
      if (response.status === 304) return { notModified: true, etag }
      if (response.status === 403 || response.status === 429) {
        const remaining = response.headers.get('x-ratelimit-remaining')
        if (remaining === '0') {
          const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
          const error = new Error(`GitHub API 速率限制，重置时间 ${new Date(reset).toISOString()}`)
          error.category = 'rate_limit'
          error.retryAt = reset
          throw error
        }
      }
      if (!response.ok) {
        const text = await response.text()
        const error = new Error(`GitHub API HTTP ${response.status}: ${text.slice(0, 200)}`)
        error.category = response.status === 404 ? 'not_found' : 'http'
        error.status = response.status
        throw error
      }
      return {
        data: await response.json(),
        etag: response.headers.get('etag') || etag,
        notModified: false,
      }
    } catch (error) {
      clearTimeout(timer)
      if (error.name === 'AbortError') {
        const wrapped = new Error('GitHub 请求超时')
        wrapped.category = 'timeout'
        throw wrapped
      }
      throw error
    }
  }

  async syncRepository(repoConfig) {
    const repo = this.db.upsertRepository(repoConfig)
    const baseline = !repo.last_success_at
    const now = nowIso()
    const events = []
    let releasesEtag = repo.releases_etag
    let pullsEtag = repo.pulls_etag
    let issuesEtag = repo.issues_etag
    let failures = 0
    try {
      const releases = await this.request(
        `${GITHUB_API}/repos/${repo.full_name}/releases?per_page=8`,
        { etag: repo.releases_etag },
      )
      if (!releases.notModified && Array.isArray(releases.data)) {
        releasesEtag = releases.etag
        for (const release of releases.data) events.push(releaseEvent(repo, release, { baseline }))
      }
    } catch (error) {
      failures += 1
      this.logger.warn && this.logger.warn('GitHub releases 同步失败 %s: %s', repo.full_name, error.message)
      if (error.category === 'rate_limit') throw error
    }
    try {
      const since = new Date(Date.now() - (this.config.lookbackDays || 7) * 86400000).toISOString()
      const pulls = await this.request(
        `${GITHUB_API}/repos/${repo.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=20`,
        { etag: repo.pulls_etag },
      )
      if (!pulls.notModified && Array.isArray(pulls.data)) {
        pullsEtag = pulls.etag
        for (const pull of pulls.data) {
          if (!pull.merged_at || Date.parse(pull.merged_at) < Date.parse(since)) continue
          events.push(pullEvent(repo, pull, { baseline }))
        }
      }
    } catch (error) {
      failures += 1
      this.logger.warn && this.logger.warn('GitHub PR 同步失败 %s: %s', repo.full_name, error.message)
      if (error.category === 'rate_limit') throw error
    }
    try {
      const since = new Date(Date.now() - (this.config.lookbackDays || 7) * 86400000).toISOString()
      const issues = await this.request(
        `${GITHUB_API}/repos/${repo.full_name}/issues?state=open&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=20`,
        { etag: repo.issues_etag },
      )
      if (!issues.notModified && Array.isArray(issues.data)) {
        issuesEtag = issues.etag
        for (const issue of issues.data) {
          if (issue.pull_request) continue
          events.push(issueEvent(repo, issue, { baseline }))
        }
      }
    } catch (error) {
      failures += 1
      this.logger.warn && this.logger.warn('GitHub issue 同步失败 %s: %s', repo.full_name, error.message)
      if (error.category === 'rate_limit') throw error
    }

    let inserted = 0
    for (const event of events) {
      if (this.db.insertRepositoryEvent(repo.id, event)) inserted += 1
    }
    if (failures < 3) {
      this.db.updateRepository(repo.id, {
        last_checked_at: now,
        last_success_at: now,
        releases_etag: releasesEtag || null,
        pulls_etag: pullsEtag || null,
        issues_etag: issuesEtag || null,
        last_error: failures ? `${failures} 个 GitHub 子请求失败` : null,
      })
    } else {
      this.db.updateRepository(repo.id, {
        last_checked_at: now,
        last_error: '全部 GitHub 子请求失败',
      })
    }
    return {
      repo: repo.full_name,
      baseline,
      events: events.length,
      inserted,
      important: events.filter((event) => event.importance !== 'low' && !event.notifiedAt).length,
    }
  }

  async syncAll() {
    if (!this.config.enabled) return { enabled: false, repositories: [], events: [] }
    const results = []
    let rateError = null
    for (const repo of this.config.repositories || []) {
      try {
        results.push(await this.syncRepository(repo))
      } catch (error) {
        results.push({ repo: repo.fullName, error: error.message, category: error.category })
        if (error.category === 'rate_limit') {
          rateError = error
          break
        }
      }
    }
    const events = this.db.unnotifiedRepositoryEvents(this.config.maxEventsPerRun || 20)
    return {
      enabled: true,
      repositories: results,
      events,
      rateError: rateError ? rateError.message : null,
    }
  }

  formatEvents(events, limit = 3) {
    const rows = (events || []).slice(0, limit)
    if (!rows.length) return ''
    const lines = ['🛠 GitHub 科研工具更新']
    for (const event of rows) {
      const tag =
        event.importance === 'high' ? '重要' : event.event_type === 'release' ? 'Release' : event.event_type
      lines.push(`· [${tag}] ${cleanText(event.title)}`)
      if (event.summary) lines.push(`  ${cleanText(event.summary)}`)
      if (event.action_needed) lines.push('  可能需要检查接口/权重/数据格式兼容性')
      if (event.url) lines.push(`  ${event.url}`)
    }
    return lines.join('\n')
  }
}

module.exports = {
  GitHubMonitor,
  releaseImportance,
  pullImportance,
  issueImportance,
  releaseEvent,
  pullEvent,
  issueEvent,
  hasImportantTerm,
}
