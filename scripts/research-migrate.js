'use strict'

// Idempotent migration of legacy arXiv digest state into the Research Agent SQLite DB.
// Usage:
//   node scripts/research-migrate.js [--dry-run] [--db /path/research.db] [--no-backup]
//
// The legacy state.json, digest JSON and report Markdown are copied to backup/
// before the first run. No secret is read or written.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { ResearchDatabase } = require('../koishi/plugins/arxiv-digest/lib/research/db')
const {
  validateProfile,
} = require('../koishi/plugins/arxiv-digest/lib/research/profile')
const {
  migrateLegacyData,
} = require('../koishi/plugins/arxiv-digest/lib/research/migrate')
const { writePaperNote } = require('../koishi/plugins/arxiv-digest/lib/research/knowledge')

const ROOT = process.env.QQ_BOT_ROOT || path.resolve(__dirname, '..')
const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const noBackup = args.includes('--no-backup')
const dbFile = path.resolve(arg('db', path.join(ROOT, 'data', 'research-agent', 'research.db')))
const defaultProfile = fs.existsSync(path.join(ROOT, 'config', 'research-profile.json'))
  ? path.join(ROOT, 'config', 'research-profile.json')
  : path.join(ROOT, 'config', 'research-profile.example.json')
const profileFile = path.resolve(arg('profile', defaultProfile))
const dataDir = path.join(ROOT, 'data', 'arxiv-digest')
const stateFile = path.join(dataDir, 'state.json')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) return false
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true })
  return true
}

function backupLegacy() {
  if (noBackup) return null
  const dir = path.join(ROOT, 'backup', `research-migration-${stamp}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const copies = []
  if (copyIfExists(stateFile, path.join(dir, 'state.json'))) copies.push('state.json')
  if (copyIfExists(path.join(dataDir, 'weekly-state.json'), path.join(dir, 'weekly-state.json'))) {
    copies.push('weekly-state.json')
  }
  if (copyIfExists(path.join(dataDir, 'digests'), path.join(dir, 'digests'))) copies.push('digests/')
  if (copyIfExists(path.join(dataDir, 'reports'), path.join(dir, 'reports'))) copies.push('reports/')
  if (copyIfExists(path.join(ROOT, 'config', 'research-profile.json'), path.join(dir, 'research-profile.json'))) {
    copies.push('research-profile.json')
  }
  if (fs.existsSync(dbFile)) {
    copyIfExists(dbFile, path.join(dir, path.basename(dbFile)))
    copies.push(path.basename(dbFile))
    if (fs.existsSync(`${dbFile}-wal`)) {
      copyIfExists(`${dbFile}-wal`, path.join(dir, `${path.basename(dbFile)}-wal`))
      copies.push(`${path.basename(dbFile)}-wal`)
    }
  }
  fs.chmodSync(dir, 0o700)
  fs.writeFileSync(path.join(dir, 'README.txt'), `Research Agent migration backup\nCreated: ${new Date().toISOString()}\nContents: ${copies.join(', ')}\n`, {
    mode: 0o600,
  })
  return dir
}

function main() {
  const profile = validateProfile(JSON.parse(fs.readFileSync(profileFile, 'utf8')))
  const backupDir = dryRun ? null : backupLegacy()
  let targetFile = dbFile
  let tempDir = null
  if (dryRun) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-migrate-'))
    targetFile = path.join(tempDir, 'research.db')
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 })
  const db = new ResearchDatabase(targetFile)
  const report = migrateLegacyData({
    db,
    profile,
    dataDir,
    stateFile,
    logger: {
      warn: (...parts) => console.warn(...parts),
      debug: () => {},
    },
  })
  report.dryRun = dryRun
  report.backupDir = backupDir
  report.dbFile = targetFile
  const verification = {
    papers: db.stats().papers,
    duplicateArxiv: db.db
      .prepare(
        `SELECT COUNT(*) AS count FROM (
          SELECT arxiv_id FROM papers WHERE arxiv_id IS NOT NULL GROUP BY arxiv_id HAVING COUNT(*) > 1
        )`,
      )
      .get().count,
    analyses: db.db.prepare('SELECT COUNT(*) AS count FROM paper_analyses').get().count,
    versions: db.db.prepare('SELECT COUNT(*) AS count FROM paper_versions').get().count,
    integrity: db.db.prepare('PRAGMA integrity_check').get(),
  }
  const knowledgeRoot = dryRun ? path.join(tempDir, 'knowledge') : path.join(ROOT, 'knowledge')
  const knowledge = { written: 0, unchanged: 0, userOwned: 0, errors: [] }
  for (const paper of db.listAllPapers(5000)) {
    try {
      const result = writePaperNote({
        root: knowledgeRoot,
        paper,
        analysis: db.getLatestAnalysis(paper.id),
        logger: { warn: (...parts) => console.warn(...parts), debug: () => {} },
      })
      if (result.changed) knowledge.written += 1
      else if (result.reason === 'user-owned' || result.reason === 'broken-managed-block') knowledge.userOwned += 1
      else knowledge.unchanged += 1
    } catch (error) {
      knowledge.errors.push(`${paper.arxiv_id || paper.id}: ${error.message}`)
    }
  }
  report.verification = verification
  report.knowledge = knowledge
  if (!dryRun) {
    const reportFile = path.join(ROOT, 'data', 'research-agent', 'migration-report.json')
    fs.mkdirSync(path.dirname(reportFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
    report.reportFile = reportFile
  }
  db.close()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
  if (report.errors.length) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error('migration failed:', error.stack || error.message)
  process.exit(1)
}
