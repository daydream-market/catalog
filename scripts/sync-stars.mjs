#!/usr/bin/env node
// 每日聚合各条目作者仓库的 stargazers_count 回写 index.json 的 stars 字段
// （客户端点赞排序/展示的数据源）。单条目失败保留原值不阻断。
import { readFileSync, writeFileSync } from 'node:fs'

const index = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
const headers = { 'User-Agent': 'daydream-catalog', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) }
let changed = 0
for (const e of index.entries ?? []) {
  const slug = String(e.repo ?? '').replace(/^[^/]+\//, '') // 'github.com/owner/repo' -> 'owner/repo'
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) { console.warn('跳过（repo 非法）：' + e.repo); continue }
  try {
    const res = await fetch('https://api.github.com/repos/' + slug, { headers })
    if (!res.ok) { console.warn(slug + '：HTTP ' + res.status); continue }
    const stars = (await res.json()).stargazers_count ?? 0
    if (e.stars !== stars) { e.stars = stars; changed++ }
  } catch (err) { console.warn(slug + '：' + err) }
}
if (changed > 0) writeFileSync(new URL('../index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n')
console.log('完成：' + changed + ' 条更新，共 ' + (index.entries?.length ?? 0) + ' 条')
