#!/usr/bin/env node
/**
 * 目录收录机器人（21 §2.5 路径 A 的定时刷新侧）：让 index.json 跟随作者仓库的增删改自动维护——
 * ① 下架失联条目：GitHub 仓库 API 404（删库/转私有）或 Release 附件 404（作者撤回）；
 *    单次 404 即出下架动作、合并前人工把关（机器人跑在 GitHub 侧无网络墙，404 可信度高）；
 *    网络/限额(403)/5xx 一律保守跳过不动条目，防误下架。
 * ② 版本刷新：story.meta.json 的 storyVersion 高于条目版本 → 下载新包复核 sha256/sizeBytes
 *    后全量刷新条目；新公钥追加进 keys[]（保留旧键，轮换过渡期验旧签，21 §2.5）。
 * ③ 新收录：扫 topic `daydream-story` → story.meta.json 带签名身份（signing，公钥/指纹自洽）
 *    且包体复核通过 → 生成条目；storyId 与现有条目冲突不自动收（防冒名转发，人工裁决）。
 * 变更一律走 PR 人工合并（refresh.workflow.yml，机器人不直接 push——内容变更与纯数字回写的
 * sync-stars 不同，须人审把关）；动作摘要写 refresh-summary.md 供 PR 描述引用。
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

/** story.meta.json 基础形状（机器人侧常识校验，完整 zod 在闸门与客户端复验） */
function metaBasicOk(meta) {
  return meta?.kind === 'story_meta'
    && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(meta.storyId ?? '')
    && /^\d+\.\d+\.\d+$/.test(meta.storyVersion ?? '')
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

/** meta → index 条目（字段映射对齐 21 §5.3；covers 相对路径转 raw 直链；下载只记 GitHub 主源） */
function metaToEntry(meta, owner, name, keys, stars) {
  const raw = (p) => (/^https?:/.test(p) ? p : `https://raw.githubusercontent.com/${owner}/${name}/main/${p}`)
  return {
    storyId: meta.storyId, title: meta.title, synopsis: meta.synopsis, tags: meta.tags,
    rating: meta.rating, contentLanguage: meta.contentLanguage, type: 'story',
    author: { id: meta.author.id, name: meta.author.name },
    platform: { host: 'github', owner }, repo: `github.com/${owner}/${name}`,
    version: meta.storyVersion, updatedAt: meta.updatedAt, releasedAt: meta.releasedAt,
    sha256: meta.sha256, sizeBytes: meta.sizeBytes, stats: meta.stats,
    ...(stars != null ? { stars } : {}),
    cover: raw(meta.covers.cover), screenshots: meta.covers.screenshots.map(raw),
    requires: meta.requires, metaUrl: raw('story.meta.json'),
    download: [{ url: `https://github.com/${owner}/${name}/releases/download/v${meta.storyVersion}/${meta.packageName}` }],
    keys,
    permissions: { rights: meta.license.rights, ...(meta.license.origin != null ? { origin: meta.license.origin } : {}) },
  }
}

/** 下载 meta 声明的包体并复核哈希/大小（不符 = 拒收该次变更，防 meta 与 Release 脱节或被篡改） */
async function verifyPackage(meta, owner, name) {
  const url = `https://github.com/${owner}/${name}/releases/download/v${meta.storyVersion}/${meta.packageName}`
  const buf = await fetchBuf(url)
  if (buf == null) return { err: '新版本包体不可达（Release 未就绪？）' }
  if (sha256(buf) !== meta.sha256 || buf.length !== meta.sizeBytes) return { err: '包体 sha256/sizeBytes 与 meta 声明不符，拒收' }
  return { buf }
}

const index = JSON.parse(readFileSync(indexFile, 'utf8'))
const actions = { removed: [], updated: [], added: [], warned: [] }
const kept = []

for (const entry of index.entries ?? []) {
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
    // Release 附件可达性（仅 GitHub 域源；纯镜像条目只看仓库存活）
    const pkgUrl = entry.download.find((d) => d.url.startsWith('https://github.com/'))?.url
    const ok = pkgUrl != null ? await headOk(pkgUrl) : true
    if (ok === false) { actions.removed.push(`${tag}：Release 附件不可达（作者撤回发布？）`); continue }
    if (ok == null) actions.warned.push(`${tag}：包体探测网络异常，本次跳过检查`)
    // 版本刷新（meta 拉 404 = 元数据失联：不动条目，仅提示；版本未变不产生任何动作）
    const meta = await getJson(entry.metaUrl, PUB_H)
    if (meta == null) actions.warned.push(`${tag}：story.meta.json 不可达，跳过刷新`)
    else if (!metaBasicOk(meta)) actions.warned.push(`${tag}：story.meta.json 形状校验不过，跳过刷新`)
    else if (semverCmp(meta.storyVersion, entry.version) > 0) {
      if (!signingOk(meta)) actions.warned.push(`${tag}：v${meta.storyVersion} meta 缺签名身份（旧物料？），走人工提报更新`)
      else {
        const v = await verifyPackage(meta, owner, name)
        if (v.err != null) actions.warned.push(`${tag}：v${meta.storyVersion} ${v.err}`)
        else {
          // keys 合并：新公钥在头部（当前信任锚），旧键保留供过渡期验旧签
          const keys = [
            { pubkey: meta.signing.pubkey, fingerprint: meta.signing.fingerprint, validFrom: meta.releasedAt },
            ...entry.keys.filter((k) => k.fingerprint !== meta.signing.fingerprint),
          ]
          kept.push(metaToEntry(meta, owner, name, keys, entry.stars))
          actions.updated.push(`${tag}：v${entry.version} → v${meta.storyVersion}`)
          continue
        }
      }
    }
    kept.push(entry)
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
      let meta
      try { meta = await getJson(`https://raw.githubusercontent.com/${r.full_name}/main/story.meta.json`, PUB_H) } catch { continue }
      if (meta == null) continue
      const tag = `${meta.title ?? '?'}（${meta.storyId ?? '?'} · ${r.full_name}）`
      if (!metaBasicOk(meta) || !signingOk(meta)) { actions.warned.push(`新仓库 ${r.full_name}：meta 校验不过（形状/签名身份/指纹自洽），不自动收录`); continue }
      if (kept.some((e) => e.storyId === meta.storyId)) { actions.warned.push(`新仓库 ${r.full_name}：storyId 与现有条目冲突（转发/冒名？），人工裁决`); continue }
      const v = await verifyPackage(meta, owner, name)
      if (v.err != null) { actions.warned.push(`新仓库 ${r.full_name}：${v.err}`); continue }
      kept.push(metaToEntry(meta, owner, name,
        [{ pubkey: meta.signing.pubkey, fingerprint: meta.signing.fingerprint, validFrom: meta.releasedAt }],
        r.stargazers_count))
      actions.added.push(`${tag}：v${meta.storyVersion}（自动收录，合并前闸门验签）`)
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

if (!dryRun && changed) {
  index.entries = kept
  index.updatedAt = new Date().toISOString()
  writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n')
  writeFileSync(join(dirname(indexFile), 'refresh-summary.md'), lines.join('\n') + '\n')
  console.log(`\n已写回 ${indexFile}（${kept.length} 条目）+ refresh-summary.md`)
} else {
  console.log(dryRun ? '\n[dry-run] 未写任何文件' : '\n无内容变更，未写回（stars 同步见 sync-stars 机器人）')
}
