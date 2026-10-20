'use strict'

const path = require('path')
const ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '..')

// Local dry run: fetches arXiv, builds a small daily brief + detailed Markdown,
// and optionally a weekly brief + detailed Markdown, without sending to QQ.
// It writes only to /tmp.
//
// Usage:
//   set -a; . .env; set +a
//   node scripts/arxiv-dry-run.js --papers 3 --weekly

const {
  buildDailyReport,
  makeDailyBrief,
  makeWeeklyBrief,
  saveMarkdownReport,
} = require(path.join(ROOT, 'koishi/plugins/arxiv-digest/lib/report'))
const { buildWeeklyReport } = require(path.join(ROOT, 'koishi/plugins/arxiv-digest/lib/weekly'))

const args = process.argv.slice(2)
const getArg = (name, fallback) => {
  const prefix = `--${name}=`
  const found = args.find((item) => item.startsWith(prefix))
  if (found) return found.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1]
  return fallback
}
const papersArg = Number(getArg('papers', '3'))
const maxPapers = Number.isFinite(papersArg) && papersArg > 0 ? Math.floor(papersArg) : 3
const withWeekly = args.includes('--weekly')
const noLineage = args.includes('--no-lineage')

const arxivCfg = {
  ...require(path.join(ROOT, 'config/arxiv.json')),
  maxPapers,
  dataDir: '/tmp/arxiv-digest-dry-run',
  lineageEnabled: !noLineage,
}
const ccfCfg = require(path.join(ROOT, 'config/ccfddl.json'))
const weeklyCfg = {
  ...require(path.join(ROOT, 'config/weekly.json')),
  arxiv: { ...require(path.join(ROOT, 'config/weekly.json')).arxiv, liveFallback: false },
}

async function main() {
  console.log(`[dry-run] fetching arXiv, papers=${maxPapers}, lineage=${!noLineage}`)
  const state = { lastRunDate: null, summaries: {}, lineage: {} }
  const daily = await buildDailyReport(arxivCfg, {
    state,
    weeklyCfg,
    ccfCfg,
    now: new Date(),
  })
  const dailyPath = saveMarkdownReport(
    arxivCfg.dataDir,
    'daily',
    daily.result.date,
    daily.markdown,
  )
  console.log(`[dry-run] daily date=${daily.result.date}, papers=${daily.result.papers.length}`)
  console.log(`[dry-run] daily markdown: ${dailyPath}`)
  console.log('\n[dry-run] daily brief\n' + makeDailyBrief(daily, { reportPath: dailyPath }))
  console.log('\n[dry-run] daily detailed markdown\n' + daily.markdown)

  if (withWeekly) {
    const report = await buildWeeklyReport(weeklyCfg, {
      now: new Date(),
      dataDir: arxivCfg.dataDir,
      arxivCfg,
      arxivState: state,
      ccfCfg,
      botCount: 0,
    })
    const weeklyPath = saveMarkdownReport(
      arxivCfg.dataDir,
      'weekly',
      report.week.weekKey,
      report.markdown,
    )
    console.log(`\n[dry-run] weekly=${report.week.weekKey}, chunks=${report.chunks.length}`)
    console.log(`[dry-run] weekly markdown: ${weeklyPath}`)
    console.log('\n[dry-run] weekly brief\n' + makeWeeklyBrief(report, { reportPath: weeklyPath }))
    console.log('\n[dry-run] weekly detailed markdown\n' + report.markdown)
  }
}

main().catch((error) => {
  console.error('[dry-run] failed:', error.stack || error.message)
  process.exit(1)
})
