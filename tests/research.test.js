'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { ResearchDatabase } = require('../koishi/plugins/arxiv-digest/lib/research/db')
const {
  validateProfile,
  matchDirections,
  preliminaryScores,
  scoreAnalysis,
} = require('../koishi/plugins/arxiv-digest/lib/research/profile')
const {
  classifySummary,
} = require('../koishi/plugins/arxiv-digest/lib/research/migrate')
const {
  writePaperNote,
  updateManagedBlock,
  MANAGED_START,
} = require('../koishi/plugins/arxiv-digest/lib/research/knowledge')
const {
  DeepSeekResearchClient,
  BudgetError,
  buildAnalysisSystem,
  parsePricePeriod,
  calculateCost,
} = require('../koishi/plugins/arxiv-digest/lib/research/llm')
const { ResearchService } = require('../koishi/plugins/arxiv-digest/lib/research/service')
const { abstractHash } = require('../koishi/plugins/arxiv-digest/lib/research/text')

const ROOT = path.resolve(__dirname, '..')
const PROFILE_FILE = fs.existsSync(path.join(ROOT, 'config', 'research-profile.json'))
  ? path.join(ROOT, 'config', 'research-profile.json')
  : path.join(ROOT, 'config', 'research-profile.example.json')
const PROFILE = validateProfile(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')))

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-agent-test-'))
}

function fixture(id, title, abstract) {
  return {
    id,
    title,
    summary: abstract,
    authors: ['Test Author'],
    categories: ['cs.LG'],
    primaryCategory: 'cs.LG',
    published: new Date(),
    updated: new Date(),
    url: `https://arxiv.org/abs/${id}`,
  }
}

class FakeLlm {
  constructor(profile) {
    this.profile = profile
    this.calls = 0
    this.papers = []
  }

  budgetStatus() {
    return {
      daily: { spent: 0, requests: 0, limit: 1, remaining: 1 },
      weekly: { spent: 0, requests: 0, limit: 5, remaining: 5 },
    }
  }

  async analyzeBatch(papers) {
    this.calls += 1
    this.papers.push(...papers.map((paper) => paper.arxiv_id))
    return {
      valid: papers.map((paper) => ({
        id: paper.arxiv_id,
        analysis: {
          direction: paper.primary_direction || 'mlsys',
          directionTags: [paper.primary_direction || 'mlsys'],
          summary: `测试摘要：${paper.title}`,
          coreContribution: '提出一个可测试的系统机制。',
          differenceFromPrior: '摘要声称与旧方法不同，仍需全文核验。',
          evidenceBoundary: '仅基于摘要，未核验全文实验。',
          limitations: '摘要没有给出完整消融。',
          relatedProjects: ['训练与推理系统效率'],
          recommendation: '先读方法部分，再核对端到端收益。',
          noveltyJudgment: '初步判断：问题明确，但证据有限。',
          noveltyPreliminary: true,
          scores: { relevance: 88, novelty: 75, evidence: 70, reproducibility: 65, timeliness: 100, total: 80.5 },
          totalScore: 80.5,
        },
      })),
      invalid: [],
      api: { latencyMs: 5, cost: 0.000001, requestId: 'fake', usage: {} },
    }
  }

  async repairAnalysis(paper) {
    return this.analyzeBatch([paper])
  }

  async synthesizeQuestions() {
    return {
      questions: [],
      api: { latencyMs: 1, cost: 0 },
    }
  }
}

const fakeGithub = {
  config: { enabled: false, repositories: [] },
  async syncAll() {
    return { enabled: false, repositories: [], events: [] }
  },
  formatEvents() {
    return ''
  },
}

test('profile scoring and direction matching are deterministic', () => {
  const paper = {
    title: 'GRPO Training Order Sensitivity and Rollout Variance',
    abstract:
      'We audit how prompt order and random seeds affect GRPO training endpoints under verifiable rewards. We release code and provide a training stability benchmark with multiple baselines.',
    categories: ['cs.LG'],
    publishedAt: new Date().toISOString(),
  }
  const matches = matchDirections(paper, PROFILE)
  assert.equal(matches[0].id, 'rl')
  const prelim = preliminaryScores(paper, PROFILE)
  assert.equal(prelim.direction, 'rl')
  assert.ok(prelim.relevance > 30)
  const final = scoreAnalysis({ relevance: 90, novelty: 60, evidence: 50, reproducibility: 40, timeliness: 100 }, PROFILE)
  assert.equal(final.total, 72.5)
})

test('legacy summary classification separates generated, fallback and unverified', () => {
  assert.equal(
    classifySummary('本文提出一种新的训练顺序审计方法，并在多个模型上验证端点差异。', 'We propose a new method.'),
    'generated',
  )
  const abstract = 'We propose a method for auditing GRPO prompt order sensitivity with many experiments and baselines.'
  assert.equal(classifySummary(`${abstract.slice(0, 80)}…`, abstract), 'fallback')
  assert.equal(classifySummary('A short English note.', ''), 'unverified')
})

test('SQLite upsert and legacy migration are idempotent', () => {
  const dir = tempDir()
  const db = new ResearchDatabase(path.join(dir, 'test.db'))
  const paper = {
    canonicalKey: 'arxiv:2610.00001',
    arxivId: '2610.00001',
    title: 'A GRPO paper',
    abstract: 'GRPO training order sensitivity. '.repeat(10),
    authors: ['A'],
    publishedAt: '2026-10-19T00:00:00.000Z',
  }
  const first = db.upsertPaper(paper)
  assert.equal(first.isNew, true)
  const second = db.upsertPaper(paper)
  assert.equal(second.isNew, false)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM papers').get().c, 1)
  const changed = db.upsertPaper({ ...paper, abstract: `${paper.abstract} New results.` })
  assert.equal(changed.abstractChanged, true)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM paper_versions').get().c, 2)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('knowledge note updates managed block but preserves user-owned text', () => {
  const dir = tempDir()
  const paper = {
    id: 1,
    canonical_key: 'arxiv:2610.00002',
    arxiv_id: '2610.00002',
    title: 'Test paper',
    authors_json: '[]',
    authors: [],
    direction_tags_json: '[]',
    directionTags: ['rl'],
    read_status: 'unread',
    abstract: 'An abstract. '.repeat(20),
    published_at: '2026-10-19',
    analysis_status: 'none',
  }
  const analysis = {
    summary: '第一版摘要',
    core_contribution: '贡献 A',
    difference_from_prior: '',
    evidence_boundary: '仅摘要',
    limitations: '',
    related_projects: [],
    recommendation: '',
    novelty_judgment: '',
    novelty_preliminary: true,
  }
  const first = writePaperNote({ root: dir, paper, analysis })
  assert.equal(first.changed, true)
  let content = fs.readFileSync(first.file, 'utf8')
  content = content.replace('## 我的笔记\n', '## 我的笔记\n\n这是用户手工写的，不应被覆盖。\n')
  fs.writeFileSync(first.file, content)
  const second = writePaperNote({
    root: dir,
    paper: { ...paper, score_total: 80, scores: { relevance: 80 } },
    analysis: { ...analysis, summary: '第二版摘要' },
  })
  assert.equal(second.changed, true)
  const updated = fs.readFileSync(first.file, 'utf8')
  assert.match(updated, /这是用户手工写的/)
  assert.match(updated, /第二版摘要/)
  assert.ok(updated.includes(MANAGED_START))
  const noMarker = path.join(dir, 'papers', 'manual.md')
  fs.writeFileSync(noMarker, '# 手工文件\n')
  assert.equal(updateManagedBlock('# 手工文件\n', paper, analysis), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('daily pipeline reuses completed analysis with no extra LLM call', async () => {
  const dir = tempDir()
  const dataDir = path.join(dir, 'data')
  const papers = [
    fixture(
      '2610.10001',
      'A GPU Inference System with Kernel-Level Scheduling',
      'We present a machine learning systems mechanism for GPU inference serving. It improves throughput and latency with a new kernel runtime, and we evaluate on real workloads with baselines and ablations. Code is available.',
    ),
    fixture(
      '2610.10002',
      'Prompt-Order Sensitivity in GRPO Training',
      'We study GRPO prompt order sensitivity and endpoint variance with verifiable rewards. Experiments compare forward, reverse and shuffled orders across models and seeds, with code and a benchmark.',
    ),
  ]
  const fakeLlm = new FakeLlm(PROFILE)
  const service = new ResearchService({
    root: dir,
    profileFile: PROFILE_FILE,
    dataDir,
    dbFile: path.join(dir, 'research.db'),
    knowledgeRoot: path.join(dir, 'knowledge'),
    arxivFetch: async () => papers,
    llm: fakeLlm,
    github: fakeGithub,
  })
  const cfg = {
    timezone: 'Asia/Shanghai',
    dataDir,
    maxPapers: 5,
    categories: ['cs.LG'],
  }
  const first = await service.buildDailyReport(cfg, {
    now: new Date(),
    weeklyCfg: { weather: { enabled: false } },
    ccfCfg: { enabled: false },
  })
  assert.equal(fakeLlm.calls, 1)
  assert.equal(first.result.papers.length, 2)
  assert.ok(first.top3.length >= 1)
  const second = await service.buildDailyReport(cfg, {
    now: new Date(),
    weeklyCfg: { weather: { enabled: false } },
    ccfCfg: { enabled: false },
  })
  assert.equal(fakeLlm.calls, 1, 'second run must reuse SQLite analysis cache')
  assert.equal(second.analysisStats.newCalls, 0)
  service.commitDailyReport(first, { messageOk: true, fileOk: true })
  assert.equal(service.db.stats().papers.pushed, 2)
  service.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('abstract changes invalidate only the changed paper analysis', async () => {
  const dir = tempDir()
  const dataDir = path.join(dir, 'data')
  const original = fixture(
    '2610.10003',
    'A Compiler for Machine Learning Graphs',
    'We present a compiler optimization for machine learning graphs. The system fuses operators and schedules kernels on heterogeneous hardware, with measured end-to-end latency and ablation baselines. Code is available.',
  )
  const fakeLlm = new FakeLlm(PROFILE)
  const service = new ResearchService({
    root: dir,
    profileFile: PROFILE_FILE,
    dataDir,
    dbFile: path.join(dir, 'research.db'),
    knowledgeRoot: path.join(dir, 'knowledge'),
    arxivFetch: async () => [original],
    llm: fakeLlm,
    github: fakeGithub,
  })
  const cfg = { timezone: 'Asia/Shanghai', dataDir, maxPapers: 5, categories: ['cs.LG'] }
  await service.buildDailyReport(cfg, { now: new Date(), weeklyCfg: {}, ccfCfg: { enabled: false } })
  assert.equal(fakeLlm.calls, 1)
  const changed = {
    ...original,
    summary: `${original.summary} The revision adds a new evaluation on a second compiler backend and reports an additional ablation.`,
  }
  service.arxivFetch = async () => [changed]
  await service.buildDailyReport(cfg, { now: new Date(), weeklyCfg: {}, ccfCfg: { enabled: false } })
  assert.equal(fakeLlm.calls, 2, 'changed abstract must trigger one new analysis')
  service.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function response({ status = 200, body = '', headers = {}, json = null }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || headers[name] || null
      },
    },
    async text() {
      return json == null ? body : JSON.stringify(json)
    },
    async json() {
      return json
    },
  }
}

test('DeepSeek client records cache-aware usage and estimated cost', async () => {
  const dir = tempDir()
  const db = new ResearchDatabase(path.join(dir, 'usage.db'))
  let calls = 0
  const client = new DeepSeekResearchClient({
    profile: { ...PROFILE, model: 'deepseek-flash' },
    db,
    logger: { warn() {}, debug() {} },
    apiKey: 'test-key',
    fetchImpl: async () => {
      calls += 1
      return response({
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  analyses: [
                    {
                      id: '2610.10004',
                      direction: 'mlsys',
                      summary: '摘要',
                      coreContribution: '贡献',
                      differenceFromPrior: '差异',
                      evidenceBoundary: '摘要',
                      limitations: '局限',
                      relatedProjects: [],
                      recommendation: '建议',
                      noveltyJudgment: '初步',
                      scores: { relevance: 80, novelty: 55, evidence: 50, reproducibility: 40 },
                    },
                  ],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            prompt_cache_hit_tokens: 600,
            prompt_cache_miss_tokens: 400,
          },
        },
      })
    },
  })
  const result = await client.analyzeBatch([
    {
      arxiv_id: '2610.10004',
      title: 'Test',
      abstract: 'A sufficiently long abstract about GPU inference and compiler kernels.',
      categories: ['cs.LG'],
    },
  ])
  assert.equal(calls, 1)
  assert.equal(result.valid.length, 1)
  const usage = db.db.prepare('SELECT * FROM api_usage').get()
  assert.equal(usage.cache_hit_tokens, 600)
  assert.equal(usage.cache_miss_tokens, 400)
  assert.ok(usage.estimated_cost_usd > 0)
  assert.equal(usage.input_tokens, 1000)
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('budget guard blocks calls before they exceed the daily limit', async () => {
  const dir = tempDir()
  const db = new ResearchDatabase(path.join(dir, 'budget.db'))
  const profile = JSON.parse(JSON.stringify(PROFILE))
  profile.budget.dailyUsd = 0.000000001
  const client = new DeepSeekResearchClient({
    profile,
    db,
    logger: { warn() {}, debug() {} },
    apiKey: 'test-key',
    fetchImpl: async () => {
      throw new Error('must not be called')
    },
  })
  await assert.rejects(
    () =>
      client.callJson({
        system: buildAnalysisSystem(profile),
        user: JSON.stringify({ papers: [{ abstract: 'x'.repeat(500) }] }),
        requestType: 'test',
        maxTokens: 1000,
      }),
    (error) => error instanceof BudgetError,
  )
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('price period and cost calculation use cache hit/miss separately', () => {
  const profile = JSON.parse(JSON.stringify(PROFILE))
  const cost = calculateCost(
    { prompt_tokens: 1000, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens: 100 },
    'deepseek-flash',
    profile,
    'offpeak',
  )
  assert.ok(Math.abs(cost - (600 * 0.003 + 400 * 0.15 + 100 * 0.6) / 1000000) < 1e-12)
  const period = parsePricePeriod(profile, new Date('2026-10-20T02:00:00Z'))
  assert.equal(period, 'peak')
})

test('task queue deduplicates active tasks and recovers processing tasks', () => {
  const dir = tempDir()
  const db = new ResearchDatabase(path.join(dir, 'tasks.db'))
  const first = db.createTask({ type: 'analyze_paper', payload: { paperId: 1 }, dedupeKey: 'a' })
  const second = db.createTask({ type: 'analyze_paper', payload: { paperId: 1 }, dedupeKey: 'a' })
  assert.equal(first.existing, false)
  assert.equal(second.existing, true)
  const claimed = db.claimNextTask()
  assert.equal(claimed.status, 'processing')
  assert.equal(db.recoverTasks(), 1)
  assert.equal(db.getTask(first.task.id).status, 'pending')
  db.completeTask(first.task.id, { ok: true })
  assert.equal(db.getTask(first.task.id).status, 'completed')
  const third = db.createTask({ type: 'analyze_paper', payload: { paperId: 1 }, dedupeKey: 'a' })
  assert.equal(third.existing, false, 'completed task must not block a new explicit request')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('GitHub monitor baselines first sync and deduplicates later events', async () => {
  const dir = tempDir()
  const db = new ResearchDatabase(path.join(dir, 'github.db'))
  const recent = new Date().toISOString()
  let releaseVersion = 1
  const fetchImpl = async (url) => {
    if (url.includes('/releases')) {
      const releases = [
        {
          id: 1,
          tag_name: 'v1.1.0',
          name: 'v1.1.0',
          body: 'performance improvements',
          draft: false,
          prerelease: false,
          published_at: recent,
          html_url: 'https://example.test/release/1',
        },
      ]
      if (releaseVersion > 1) {
        releases.unshift({
          id: 2,
          tag_name: 'v1.2.0',
          name: 'v1.2.0',
          body: 'breaking API change',
          draft: false,
          prerelease: false,
          published_at: recent,
          html_url: 'https://example.test/release/2',
        })
      }
      return response({ json: releases, headers: { etag: 'release-etag' } })
    }
    if (url.includes('/pulls')) {
      const pulls = [
        {
          id: releaseVersion > 1 ? 11 : 10,
          number: 10,
          title: 'Improve kernel performance',
          body: 'Faster kernel.',
          state: 'closed',
          merged_at: recent,
          updated_at: recent,
          created_at: recent,
          html_url: 'https://example.test/pull/10',
          labels: [{ name: 'performance' }],
        },
      ]
      return response({ json: pulls, headers: { etag: 'pull-etag' } })
    }
    if (url.includes('/issues')) {
      return response({
        json: [
          {
            id: 20,
            number: 20,
            title: 'Regression in training throughput',
            body: 'Performance regression.',
            state: 'open',
            comments: 8,
            updated_at: recent,
            created_at: recent,
            html_url: 'https://example.test/issue/20',
            labels: [{ name: 'bug' }],
          },
        ],
        headers: { etag: 'issue-etag' },
      })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  const { GitHubMonitor } = require('../koishi/plugins/arxiv-digest/lib/research/github')
  const monitor = new GitHubMonitor({
    profile: {
      ...PROFILE,
      github: { enabled: true, lookbackDays: 7, repositories: [{ fullName: 'example/repo' }] },
    },
    db,
    logger: { warn() {}, debug() {} },
    fetchImpl,
  })
  await monitor.syncRepository({ fullName: 'example/repo', purpose: 'test' })
  assert.equal(db.unnotifiedRepositoryEvents(10).length, 0)
  releaseVersion = 2
  await monitor.syncRepository({ fullName: 'example/repo', purpose: 'test' })
  const events = db.unnotifiedRepositoryEvents(10)
  assert.ok(events.some((event) => event.event_key === 'release:2'))
  assert.ok(events.some((event) => event.event_key.startsWith('pull:11')))
  await monitor.syncRepository({ fullName: 'example/repo', purpose: 'test' })
  assert.equal(db.unnotifiedRepositoryEvents(10).length, 2, 'events must not duplicate')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persistent analysis task completes and notifies the QQ channel', async () => {
  const dir = tempDir()
  const service = new ResearchService({
    root: dir,
    profileFile: PROFILE_FILE,
    dataDir: path.join(dir, 'data'),
    dbFile: path.join(dir, 'tasks-service.db'),
    knowledgeRoot: path.join(dir, 'knowledge'),
    llm: new FakeLlm(PROFILE),
    github: fakeGithub,
    arxivFetch: async () => [],
  })
  const paper = service.db.upsertPaper({
    canonicalKey: 'arxiv:2610.10009',
    arxivId: '2610.10009',
    title: 'Task queue paper',
    abstract:
      'A long abstract about a compiler runtime for GPU inference. It reports throughput, latency and ablation results with code. '.repeat(3),
    authors: ['A'],
    publishedAt: new Date().toISOString(),
  })
  const notifications = []
  service.setNotifier(async (channel, message) => {
    notifications.push({ channel, message })
  })
  const created = service.enqueueTask('analyze_paper', { paperId: paper.id }, {
    dedupeKey: 'task-test',
    notifyChannel: 'private:123',
  })
  service.started = true
  await service.tick()
  const task = service.db.getTask(created.task.id)
  assert.equal(task.status, 'completed')
  assert.equal(task.notify_status, 'sent')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].channel, 'private:123')
  assert.equal(service.db.getPaperById(paper.id).analysis_status, 'completed')
  service.started = false
  service.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('summary command reads cache without scheduling API work unless deep is explicit', async () => {
  const dir = tempDir()
  const service = new ResearchService({
    root: dir,
    profileFile: PROFILE_FILE,
    dataDir: path.join(dir, 'data'),
    dbFile: path.join(dir, 'summary.db'),
    knowledgeRoot: path.join(dir, 'knowledge'),
    llm: new FakeLlm(PROFILE),
    github: fakeGithub,
    arxivFetch: async () => [],
  })
  const paper = service.db.upsertPaper({
    canonicalKey: 'arxiv:2610.10011',
    arxivId: '2610.10011',
    title: 'Summary cache paper',
    abstract: 'A long abstract about compiler scheduling and GPU kernels for machine learning systems. '.repeat(3),
    authors: ['A'],
    publishedAt: new Date().toISOString(),
  })
  const plain = await service.summaryCommand('2610.10011')
  assert.equal(plain.type, 'text')
  assert.match(plain.text, /尚未深度分析/)
  assert.equal(service.db.listTasks(10).length, 0)
  const deep = await service.summaryCommand('2610.10011', {
    deep: true,
    notifyChannel: 'private:1',
  })
  assert.equal(deep.type, 'task')
  assert.equal(service.db.listTasks(10).length, 1)
  assert.equal(deep.task.type, 'analyze_paper')
  service.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('profile makes music the top priority, removes neural operators and includes ViT', () => {
  const music = PROFILE.researchDirections.find((direction) => direction.id === 'music')
  const others = PROFILE.researchDirections.filter((direction) => direction.id !== 'music')
  assert.ok(music)
  assert.ok(others.every((direction) => direction.weight < music.weight))
  assert.ok(!PROFILE.researchDirections.some((direction) => direction.id === 'ai4science'))
  const multimodal = PROFILE.researchDirections.find((direction) => direction.id === 'multimodal')
  assert.ok(multimodal.keywords.includes('vit'))
  assert.ok(multimodal.projects.some((project) => project.name.includes('ViT')))

  const service = Object.create(ResearchService.prototype)
  service.profile = PROFILE
  service.directionMap = () => new Map(PROFILE.researchDirections.map((direction) => [direction.id, direction]))
  const musicPaper = { score_total: 68, primary_direction: 'music', published_at: '2026-10-20' }
  const systemPaper = { score_total: 70, primary_direction: 'mlsys', published_at: '2026-10-20' }
  assert.ok(service.userRankScore(musicPaper) > service.userRankScore(systemPaper))
  assert.equal(service.sortForUser([systemPaper, musicPaper])[0], musicPaper)
})
