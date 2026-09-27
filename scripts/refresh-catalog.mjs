#!/usr/bin/env node
/**
 * 目录收录机器人（21 §2.5 路径 A 的定时刷新侧；27 号批三族化）：
 * ① 下架失联：仓库 404 / 锚 meta 404 → 摘整条；某变体 meta 404 或其 Release 404 → 摘该语言
 *    （languages 摘空 → 摘条）。单次 404 即出下架动作（机器人跑在 GitHub 侧无网络墙，404 可信度高）；
 *    网络/限额(403)/5xx 一律保守跳过不动，防误下架。
 * ② 版本刷新：逐语言拉各自 metaUrl，storyVersion 高于该语言项 → 下载新包复核 sha256/sizeBytes
 *    后只更新对应 languages[] 项（27 §5.4：每语言独立版本线）；新公钥头部追加进族级 keys[]。
 * ③ 新收录：扫 topic `daydream-story` → 列仓库根目录（contents API）发现锚 story.meta.json +
 *    变体 story.meta.<bcp47>.json 全族 → 族约束四条（同 signing / 变体 origin 指锚 / 语言不重 /
 *    storyId 不重）+ 包体复核 → 聚合单条目多语言；族内任一 storyId 与现有条目冲突不自动收。
 * 变更直推（refresh.workflow.yml 内 git commit + push——21 §2.5 v0.9 口径）；动作摘要写
 * refresh-summary.md 供运行日志查阅，不提交入库。
 * 客户端零配合：已装用户不受影响，下架后更新入口由 not_in_catalog 提示（21 §3.6）。
 * 用法：node refresh-catalog.mjs [--dry-run] [--index <index.json>]
 *   部署态默认读 ../index.json（本脚本在目录仓库 scripts/ 下）；GITHUB_TOKEN env 提升 API 限额
 *   并启用扫 topic（未配置时仅健康检查与版本刷新，跳过新收录）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const idxArgAt = args.indexOf('--index')
const indexFile = (idxArgAt >= 0 ? args[idxArgAt + 1] : undefined)
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'index.json')
const TOKEN = process.env.GITHUB_TOKEN
const API_H = { 'User-Agent': 'daydream-catalog-bot', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }
const PUB_H = { 'User-Agent': 'daydream-catalog-bot' }

/** API JSON：404 → null；403/5xx/网络错 → throw（调用方保守跳过） */
async function getJson(url, headers = API_H) {
  const res = await fetch(url, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
/** 下载源可达性：404 → false；2xx/3xx → true；其他/网络错 → null（未知，保守不动） */
async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: PUB_H })
    if (res.status === 404) return false
    return res.ok
  } catch { return null }
}
async function fetchBuf(url) {
  const res = await fetch(url, { headers: PUB_H })
  return res.ok ? Buffer.from(await res.arrayBuffer()) : null
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const fpOf = (pubkeyB64) => sha256(Buffer.from(pubkeyB64, 'base64')).slice(0, 16)
const semverCmp = (a, b) => {
  const [x, y] = [a, b].map((s) => s.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}

/** story.meta.json 基础形状（机器人侧常识校验，完整 zod 在闸门与客户端复验；27 §5.2 含 releaseTag） */
function metaBasicOk(meta) {
  return meta?.kind === 'story_meta'
    && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(meta.storyId ?? '')
    && /^\d+\.\d+\.\d+$/.test(meta.storyVersion ?? '')
    && /^(v|[a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*-v)\d+\.\d+\.\d+$/.test(meta.releaseTag ?? '')
    && /^[0-9a-f]{64}$/.test(meta.sha256 ?? '')
    && Number.isInteger(meta.sizeBytes) && meta.sizeBytes > 0
    && Boolean(meta.license?.rights)
}

/** 签名身份自洽（收录/刷新的动作闸：旧物料无 signing 字段 → 不自动处理，走人工提报） */
function signingOk(meta) {
  return typeof meta.signing?.pubkey === 'string' && meta.signing.pubkey.length > 0
    && /^[0-9a-f]{16}$/.test(meta.signing?.fingerprint ?? '')
    && fpOf(meta.signing.pubkey) === meta.signing.fingerprint
}

/** 变体文件名 → 语言标签（story.meta.en-US.json → en-US）；锚/README 等其他文件不匹配 */
const VARIANT_RE = /^story\.meta\.([a-zA-Z]{2,3}(-[a-zA-Z0-9]+)*)\.json$/

/** meta → 语言项（27 §5.3 indexLanguageSchema 字段映射；covers 相对路径转 raw 直链；下载只记 GitHub 主源；
 *  fileName = 该 meta 在仓库里的文件名——锚 story.meta.json / 变体 story.meta.<lang>.json） */
function metaToLang(meta, owner, name, fileName) {
  const raw = (p) => (/^https?:/.test(p) ? p : `https://raw.githubusercontent.com/${owner}/${name}/main/${p}`)
  return {
    storyId: meta.storyId, contentLanguage: meta.contentLanguage,
    version: meta.storyVersion, releaseTag: meta.releaseTag,
    sha256: meta.sha256, sizeBytes: meta.sizeBytes, packageName: meta.packageName,
    download: [{ url: `https://github.com/${owner}/${name}/releases/download/${meta.releaseTag}/${meta.packageName}` }],
    metaUrl: raw(fileName),
    stats: meta.stats, requires: meta.requires,
    permissions: { rights: meta.license.rights, ...(meta.license.origin != null ? { origin: meta.license.origin } : {}) },
    releasedAt: meta.releasedAt, updatedAt: meta.updatedAt,
  }
}

/** 锚 + 变体全族 meta → 单条目（languages[0] = 锚语言；族约束四条在收编前校验） */
function familyToEntry(anchor, variants, owner, name, keys, stars) {
  const raw = (p) => (/^https?:/.test(p) ? p : `https://raw.githubusercontent.com/${owner}/${name}/main/${p}`)
  return {
    storyId: anchor.storyId, title: anchor.title, synopsis: anchor.synopsis, tags: anchor.tags,
    rating: anchor.rating, contentLanguage: anchor.contentLanguage, type: 'story',
    author: { id: anchor.author.id, name: anchor.author.name },
    platform: { host: 'github', owner }, repo: `github.com/${owner}/${name}`,
    updatedAt: anchor.updatedAt, releasedAt: anchor.releasedAt,
    ...(stars != null ? { stars } : {}),
    languages: [metaToLang(anchor, owner, name, 'story.meta.json'), ...variants.map((m) => metaToLang(m, owner, name, `story.meta.${m.contentLanguage}.json`))],
    cover: raw(anchor.covers.cover), screenshots: anchor.covers.screenshots.map(raw),
    keys,
  }
}

/**
 * 族约束四条（27 §5.1，收录与刷新共用的动作闸；违反返回原因串）：
 * 同 signing / 变体 license.origin.storyId 指锚 / contentLanguage 互不重复 / storyId 互不重复。
 */
function familyViolation(anchor, variants) {
  for (const m of variants) {
    if (m.signing?.pubkey !== anchor.signing?.pubkey) return '变体 signing 与锚不一致'
    if (m.license?.origin?.storyId !== anchor.storyId) return '变体 license.origin 未指向锚 storyId'
  }
  const langs = [anchor, ...variants].map((m) => m.contentLanguage)
  if (new Set(langs).size !== langs.length) return '语言标签重复'
  const ids = [anchor, ...variants].map((m) => m.storyId)
  if (new Set(ids).size !== ids.length) return '族内 storyId 重复'
  return null
}

/** 下载 meta 声明的包体并复核哈希/大小（releaseTag 定位；不符 = 拒收该次变更，防 meta 与 Release 脱节或被篡改） */
async function verifyPackage(meta, owner, name) {
  const url = `https://github.com/${owner}/${name}/releases/download/${meta.releaseTag}/${meta.packageName}`
  const buf = await fetchBuf(url)
  if (buf == null) return { err: '新版本包体不可达（Release 未就绪？）' }
  if (sha256(buf) !== meta.sha256 || buf.length !== meta.sizeBytes) return { err: '包体 sha256/sizeBytes 与 meta 声明不符，拒收' }
  return { buf }
}

/** 列仓库根目录文件清单（contents API；失败 throw 由调用方保守跳过） */
async function listRootFiles(owner, name) {
  const list = await getJson(`https://api.github.com/repos/${owner}/${name}/contents`)
  if (!Array.isArray(list)) throw new Error('根目录清单不可读')
  return list.filter((x) => x.type === 'file').map((x) => x.name)
}

/**
 * 拉取仓库全族 meta（锚 + 变体）：锚 404 → { anchor: null }（触发摘条）；
 * 变体 404/形状不过 → 跳过该变体（不进族，refreshed 侧自然摘语言）。返回 { anchor, variants }。
 */
async function fetchFamily(owner, name) {
  let anchor
  try { anchor = await getJson(`https://raw.githubusercontent.com/${owner}/${name}/main/story.meta.json`, PUB_H) } catch { return { anchor: null, variants: [] } }
  if (anchor == null) return { anchor: null, variants: [] }
  const variants = []
  try {
    const files = await listRootFiles(owner, name)
    for (const f of files) {
      const lang = VARIANT_RE.exec(f)?.[1]
      if (lang == null) continue
      const m = await getJson(`https://raw.githubusercontent.com/${owner}/${name}/main/${f}`, PUB_H)
      if (m != null && metaBasicOk(m) && m.contentLanguage === lang) variants.push(m)
    }
  } catch { /* 根目录清单失败：只按锚处理（变体不动） */ }
  return { anchor, variants }
}

const index = JSON.parse(readFileSync(indexFile, 'utf8'))
index.version = '2.0'

/** 一次性迁移：v1.0 单值条目 → v2.0 languages[0]（部署新机器人时的存量转换，此后全走 v2 结构） */
function toV2(entry) {
  if (Array.isArray(entry.languages) && entry.languages.length > 0) return entry
  const { version, sha256, sizeBytes, stats, requires, metaUrl, download, permissions, ...rest } = entry
  return {
    ...rest,
    languages: [{
      storyId: entry.storyId, contentLanguage: entry.contentLanguage,
      version, releaseTag: `v${version}`, sha256, sizeBytes,
      packageName: download?.[0]?.url?.split('/').pop() ?? '',
      download: download ?? [], metaUrl: metaUrl ?? '',
      stats: stats ?? { chapters: 0, scenes: 0, words: 0, estMinutes: 10 },
      requires: requires ?? { containerVersion: '1.2', minAppVersion: '0.1.0', requiredFeatures: [] },
      permissions: permissions ?? { rights: { allowEdit: true, allowDerivative: true, allowRedistribute: true, allowRelist: true, requireAttribution: true } },
      releasedAt: entry.releasedAt, updatedAt: entry.updatedAt,
    }],
  }
}
index.entries = (index.entries ?? []).map(toV2)

const actions = { removed: [], updated: [], added: [], warned: [] }
const kept = []

for (const entry of index.entries) {
  const tag = `${entry.title}（${entry.storyId}）`
  // Gitee/其他 host 条目暂不探测（GitHub 市集先行，21 §7.14），原样保留
  if (entry.platform?.host !== 'github' || !/^github\.com\/[\w.-]+\/[\w.-]+$/.test(entry.repo ?? '')) {
    kept.push(entry)
    continue
  }
  const [, owner, name] = entry.repo.split('/')
  try {
    const repo = await getJson(`https://api.github.com/repos/${owner}/${name}`)
    if (repo == null) { actions.removed.push(`${tag}：仓库不存在或已转私有`); continue }
    // 拉全族 meta：锚失联 → 摘整条（元数据失联仅提示的旧口径废止——锚是族存在依据）
    const { anchor, variants } = await fetchFamily(owner, name)
    if (anchor == null) { actions.removed.push(`${tag}：锚 story.meta.json 不可达（撤回发布？）`); continue }
    if (!metaBasicOk(anchor)) { actions.warned.push(`${tag}：story.meta.json 形状校验不过，跳过刷新`); kept.push(entry); continue }
    // 变体集过滤：只保留形状过关且族约束成立的（违例变体不进族 = 摘该语言并警示）
    const goodVariants = []
    for (const m of variants) {
      const v = familyViolation(anchor, [m])
      if (v == null) goodVariants.push(m)
      else actions.warned.push(`${tag}：变体 ${m.contentLanguage} 族约束违例（${v}），摘除`)
    }
    // 逐语言处理：Release 可达性（404 = 摘该语言）+ 版本刷新（meta 高于语言项 → 复核后更新该项）；
    // processed 与 langs 一一对应（顶层展示值取 langs[0] 对应 meta）
    const langs = []
    const processed = []
    const all = [anchor, ...goodVariants]
    for (const m of all) {
      const ok = await headOk(`https://github.com/${owner}/${name}/releases/download/${m.releaseTag}/${m.packageName}`)
      if (ok === false) {
        if (m === anchor) actions.removed.push(`${tag}：主语言 Release 附件不可达（作者撤回发布？）`)
        else actions.warned.push(`${tag}：变体 ${m.contentLanguage} Release 附件不可达，摘除该语言`)
        continue
      }
      if (ok == null) actions.warned.push(`${tag}：${m.contentLanguage} 包体探测网络异常，本次跳过检查`)
      const fileName = m === anchor ? 'story.meta.json' : `story.meta.${m.contentLanguage}.json`
      const existing = entry.languages.find((l) => l.contentLanguage === m.contentLanguage)
      if (existing != null && semverCmp(m.storyVersion, existing.version) <= 0) { langs.push(existing); processed.push(m); continue }
      if (!signingOk(m)) {
        actions.warned.push(`${tag}：${m.contentLanguage} v${m.storyVersion} meta 缺签名身份（旧物料？），走人工提报更新`)
        if (existing != null) { langs.push(existing); processed.push(m) }
        continue
      }
      const v = await verifyPackage(m, owner, name)
      if (v.err != null) {
        actions.warned.push(`${tag}：${m.contentLanguage} v${m.storyVersion} ${v.err}`)
        if (existing != null) { langs.push(existing); processed.push(m) }
        continue
      }
      langs.push(metaToLang(m, owner, name, fileName))
      processed.push(m)
      actions.updated.push(`${tag}：${m.contentLanguage} ${existing ? `v${existing.version} → ` : '新变体 '}v${m.storyVersion}`)
    }
    if (langs.length === 0) { actions.removed.push(`${tag}：全部语言不可用，摘除条目`); continue }
    // 重组条目：顶层展示值跟随 langs[0] 对应 meta（锚语言被摘时降级首个存活语言）；
    // 族级 keys 合并——新公钥头部（当前信任锚），旧键保留供轮换过渡验旧签
    const top = processed[0]
    const rawOf = (p) => (/^https?:/.test(p) ? p : `https://raw.githubusercontent.com/${owner}/${name}/main/${p}`)
    const keys = [
      { pubkey: anchor.signing.pubkey, fingerprint: anchor.signing.fingerprint, validFrom: anchor.releasedAt },
      ...entry.keys.filter((k) => k.fingerprint !== anchor.signing.fingerprint),
    ]
    kept.push({
      storyId: langs[0].storyId, title: top.title, synopsis: top.synopsis, tags: top.tags,
      rating: top.rating, contentLanguage: langs[0].contentLanguage, type: 'story',
      author: { id: top.author.id, name: top.author.name },
      platform: { host: 'github', owner }, repo: `github.com/${owner}/${name}`,
      updatedAt: top.updatedAt, releasedAt: top.releasedAt,
      ...(entry.stars != null ? { stars: entry.stars } : {}),
      languages: langs,
      cover: rawOf(top.covers.cover), screenshots: top.covers.screenshots.map(rawOf),
      keys,
    })
  } catch (e) {
    // API 限额/网络故障：保守保留，本次不动
    actions.warned.push(`${tag}：检查异常（${e.message}），本次跳过`)
    kept.push(entry)
  }
}

// 新收录（扫 topic；无 token 不扫——匿名 search 限额过低易误跳）
if (TOKEN != null && TOKEN !== '') {
  try {
    const res = await getJson('https://api.github.com/search/repositories?q=topic%3Adaydream-story&sort=updated&per_page=100')
    for (const r of res?.items ?? []) {
      const [owner, name] = r.full_name.split('/')
      if (kept.some((e) => e.repo === `github.com/${r.full_name}`)) continue
      try {
        const { anchor, variants } = await fetchFamily(owner, name)
        if (anchor == null) continue
        const tag = `${anchor.title ?? '?'}（${anchor.storyId ?? '?'} · ${r.full_name}）`
        if (!metaBasicOk(anchor) || !signingOk(anchor)) { actions.warned.push(`新仓库 ${r.full_name}：锚 meta 校验不过（形状/签名身份/指纹自洽），不自动收录`); continue }
        // 族约束四条（变体不全合格时降级只收合格子集？收录口径从严：全族合格才收，防半族上架）
        const violation = familyViolation(anchor, variants.filter((m) => metaBasicOk(m) && signingOk(m)))
        if (violation != null) { actions.warned.push(`新仓库 ${r.full_name}：族约束违例（${violation}），不自动收录`); continue }
        // 包体复核（全族逐语言）
        let pkgErr = null
        for (const m of [anchor, ...variants]) {
          const v = await verifyPackage(m, owner, name)
          if (v.err != null) { pkgErr = `${m.contentLanguage}：${v.err}`; break }
        }
        if (pkgErr != null) { actions.warned.push(`新仓库 ${r.full_name}：${pkgErr}`); continue }
        // storyId 冲突（族内任一 vs 现有条目任意语言）不自动收（防冒名转发，人工裁决）
        const ids = [anchor, ...variants].map((m) => m.storyId)
        if (kept.some((e) => e.languages.some((l) => ids.includes(l.storyId)))) {
          actions.warned.push(`新仓库 ${r.full_name}：storyId 与现有条目冲突（转发/冒名？），人工裁决`)
          continue
        }
        kept.push(familyToEntry(anchor, variants, owner, name,
          [{ pubkey: anchor.signing.pubkey, fingerprint: anchor.signing.fingerprint, validFrom: anchor.releasedAt }],
          r.stargazers_count))
        actions.added.push(`${tag}：${[anchor, ...variants].map((m) => `${m.contentLanguage} v${m.storyVersion}`).join(' / ')}（自动收录，合并前闸门验签）`)
      } catch (e) {
        actions.warned.push(`新仓库 ${r.full_name}：收录检查异常（${e.message}），本次跳过`)
      }
    }
  } catch (e) {
    actions.warned.push(`扫 topic 新收录失败（${e.message}），本次跳过`)
  }
} else if (!dryRun) {
  console.log('（未配置 GITHUB_TOKEN：跳过扫 topic 新收录，仅健康检查与版本刷新）')
}

const changed = actions.removed.length + actions.updated.length + actions.added.length > 0
const lines = [
  `## 目录机器人动作摘要（${new Date().toISOString()}）`,
  '', `下架 ${actions.removed.length} · 更新 ${actions.updated.length} · 新收录 ${actions.added.length} · 警示 ${actions.warned.length}`, '',
  ...actions.removed.map((x) => `- 🗑 下架：${x}`),
  ...actions.updated.map((x) => `- ⬆ 更新：${x}`),
  ...actions.added.map((x) => `- ✚ 收录：${x}`),
  ...actions.warned.map((x) => `- ⚠ ${x}`),
]
console.log(lines.slice(2).join('\n'))

if (!dryRun) {
  // summary 无条件落盘供日志查阅（不提交入库；保留以兼容未来恢复 PR 模式）
  writeFileSync(join(dirname(indexFile), 'refresh-summary.md'), lines.join('\n') + '\n')
}
if (!dryRun && changed) {
  index.entries = kept
  index.updatedAt = new Date().toISOString()
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n')
  console.log(`\n已写回 ${indexFile}（${kept.length} 条目）+ refresh-summary.md`)
} else {
  console.log(dryRun ? '\n[dry-run] 未写任何文件' : '\n无内容变更，未写回（stars 同步见 sync-stars 机器人）')
}
