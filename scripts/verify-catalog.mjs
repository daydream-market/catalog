#!/usr/bin/env node
/**
 * 目录 index.json 结构常识校验（27§4.4 verify 自检；完整 C-1~C-8 校验在 verify-bundle.mjs——
 * 本脚本只拦明显坏条目：头字段/必填字段/language 四语枚举（P5 铁律）/semver/sha256/cover 域白名单）。
 * 用法：node verify-catalog.mjs <index.json>——exit 0 = OK，1 = 有问题。
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file == null) { console.error('用法：node verify-catalog.mjs <index.json>'); process.exit(1); }

const problems = [];
let idx;
try { idx = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error(`index.json 不是合法 JSON：${e.message}`); process.exit(1); }

if (idx.format !== 'jubensha' || idx.kind !== 'market_index' || idx.version !== '1.0') problems.push('头字段 format/kind/version 不符（期望 jubensha/market_index/1.0）');
if (!Array.isArray(idx.entries)) problems.push('entries 不是数组');
if (typeof idx.updated_at !== 'string') problems.push('缺 updated_at');

const HEX64 = /^[0-9a-f]{64}$/
const SEMVER = /^\d+\.\d+\.\d+$/
const LOCALES = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']
const COVER_HOSTS = ['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'github.com']
const REQUIRED = ['id', 'title', 'author', 'synopsis', 'genres', 'player_range', 'language', 'rating', 'repo', 'released_at', 'updated_at', 'version', 'package']

for (const [i, e] of (idx.entries ?? []).entries()) {
  const at = `entries[${i}](${e?.id ?? '?'})`
  for (const k of REQUIRED) if (e?.[k] == null) problems.push(`${at}: 缺字段 ${k}`)
  if (e?.id != null && !/^script_[a-z0-9_]+$/.test(e.id)) problems.push(`${at}: id 非 script_ 前缀 slug`)
  if (e?.language != null && !LOCALES.includes(e.language)) problems.push(`${at}: language "${e.language}" 不在四语枚举（zh-CN/en-US/ja-JP/ko-KR）`)
  if (e?.version != null && !SEMVER.test(e.version)) problems.push(`${at}: version 非 semver`)
  if (e?.rating != null && !['all_ages'].includes(e.rating)) problems.push(`${at}: rating 越界（v1 固定 all_ages）`)
  if (e?.repo != null && !/^github\.com\/[\w.-]+\/[\w.-]+$/.test(e.repo)) problems.push(`${at}: repo 非 github.com/<owner>/<name> 形态`)
  if (!Array.isArray(e?.genres) || e.genres.length === 0) problems.push(`${at}: genres 空集`)
  if (!Array.isArray(e?.player_range) || e.player_range.length !== 2) problems.push(`${at}: player_range 非 [min,max]`)
  const p = e?.package
  if (p == null || typeof p?.url !== 'string' || p.url.length === 0) problems.push(`${at}: package.url 缺失`)
  else if (!/^https:\/\/github\.com\//.test(p.url)) problems.push(`${at}: package.url 非 GitHub Release 直链（27§二：包体走 Release 直链）`)
  if (p?.sha256 != null && !HEX64.test(p.sha256)) problems.push(`${at}: package.sha256 非 64 位小写 hex`)
  if (p?.size_bytes != null && !(Number.isInteger(p.size_bytes) && p.size_bytes > 0)) problems.push(`${at}: package.size_bytes 非正整数`)
  if (e?.cover != null) {
    try {
      const host = new URL(e.cover).host
      if (!COVER_HOSTS.includes(host)) problems.push(`${at}: cover 域 ${host} 不在白名单（${COVER_HOSTS.join('/')}）`)
    } catch { problems.push(`${at}: cover 非法 URL`) }
  }
}

if (problems.length > 0) {
  console.error(`index.json 有 ${problems.length} 处问题：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`index.json OK：${idx.entries.length} 条目`)
