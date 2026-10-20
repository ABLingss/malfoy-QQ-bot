'use strict'

// End-to-end Research Agent dry-run with real arXiv fetch and a mock LLM.
// It never calls DeepSeek and never sends QQ messages. All output goes to /tmp.
//
// Usage:
//   node scripts/research-dry-run.js [--papers 5]

const fs = require('fs')
const os = require('os')
const path = require('path')
const { ResearchService } = require('../koishi/plugins/arxiv-digest/lib/research/service')
const render = require('../koishi/plugins/arxiv-digest/lib/research/render')

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const maxPapers = Math.max(1, Math.min(20, Number(arg('papers', '5')) || 5))
const PROFILE_FILE = fs.existsSync(path.join(__dirname, '..', 'config', 'research-profile.json'))
  ? path.join(__dirname, '..', 'config', 'research-profile.json')
  : path.join(__dirname, '..', 'config', 'research-profile.example.json')
const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))

class MockLlm {
  constructor() {
    this.calls = 0
  }

  budgetStatus() {
    return {
      daily: { spent: 0, requests: 0, limit: 1, remaining: 1 },
      weekly: { spent: 0, requests: 0, limit: 5, remaining: 5 },
    }
  }

  async analyzeBatch(papers) {
    this.calls += 1
    return {
      valid: papers.map((paper) => ({
        id: paper.arxiv_id,
        analysis: {
          direction: paper.primary_direction || 'other',
          directionTags: paper.direction_tags_json ? JSON.parse(paper.direction_tags_json) : [],
          summary: `[mock] ${String(paper.title).slice(0, 80)}。这是 dry-run 生成的占位摘要，用于验证缓存、排序和报告流程；真实运行会调用 DeepSeek。`,
          coreContribution: 'Mock 分析：未调用模型。',
          differenceFromPrior: 'Mock 分析：未调用模型，不能作为研究判断。',
          evidenceBoundary: 'dry-run 占位，未核验摘要或全文。',
          limitations: '不是真实论文分析。',
          relatedProjects: [],
          recommendation: '仅为流程验证。',
          noveltyJudgment: '未评估。',
          noveltyPreliminary: true,
          scores: {
            relevance: 80,
            novelty: 60,
            evidence: 55,
            reproducibility: 50,
            timeliness: 100,
            total: 70,
          },
          totalScore: 70,
        },
      })),
      invalid: [],
      api: { latencyMs: 0, cost: 0, requestId: 'mock' },
    }
  }

  async repairAnalysis(paper) {
    return this.analyzeBatch([paper])
  }

  async synthesizeQuestions() {
    return { questions: [], api: { latencyMs: 0, cost: 0 } }
  }
}

const fakeGithub = {
  async syncAll() {
    return { enabled: false, repositories: [], events: [] }
  },
  formatEvents() {
    return ''
  },
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-agent-dry-run-'))
  const dataDir = path.join(dir, 'data')
  const knowledgeRoot = path.join(dir, 'knowledge')
  const llm = new MockLlm()
  const service = new ResearchService({
    root: dir,
    profileFile: PROFILE_FILE,
    dataDir,
    dbFile: path.join(dir, 'research.db'),
    knowledgeRoot,
    llm,
    github: fakeGithub,
  })
  const arxivCfg = {
    ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'arxiv.json'), 'utf8')),
    maxPapers,
    dataDir,
  }
  const report = await service.buildDailyReport(arxivCfg, {
    now: new Date(),
    weeklyCfg: { weather: { enabled: false } },
    ccfCfg: { enabled: false },
  })
  const reportPath = path.join(dataDir, 'reports', 'daily', `${report.result.date}.md`)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(reportPath, report.markdown, { mode: 0o600 })
  console.log(`[dry-run] workspace=${dir}`)
  console.log(`[dry-run] papers=${report.result.papers.length}, top3=${report.top3.length}, mock_llm_calls=${llm.calls}`)
  console.log(`[dry-run] markdown=${report.markdown}`)
  console.log('\n[dry-run] top3\n' + report.top3.map((item, index) => render.renderTop3Item(item, index)).join('\n\n'))
  service.close()
}

main().catch((error) => {
  console.error('[dry-run] failed:', error.stack || error.message)
  process.exit(1)
})
