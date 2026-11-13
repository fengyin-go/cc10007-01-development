import type {
  KeyRetentionGroup,
  MappingVersion,
  ReplayBatch,
  ReplayComparison,
  ReplayComparisonRow,
  ReplayRowResult,
  Shard,
  SourceRow,
  WatermarkSpec,
} from './replay-types'

// 纯函数的水位回放引擎：选行、分区边界排除、同键保留、批次比对都在这里算。
// 不读写存储，便于页面与示例数据共用同一套解释。

export function nowStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function watermarkHits(row: SourceRow, spec: WatermarkSpec): boolean {
  const startHit = spec.includeStart ? row.updatedAt >= spec.start : row.updatedAt > spec.start
  const endHit = spec.includeEnd ? row.updatedAt <= spec.end : row.updatedAt < spec.end
  return startHit && endHit
}

export function partitionHits(row: SourceRow, spec: WatermarkSpec): boolean {
  return row.partition >= spec.partitionStart && row.partition <= spec.partitionEnd
}

function mapValues(row: SourceRow, mapping: MappingVersion): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of mapping.fields) {
    values[field.target] = row.payload[field.source] ?? ''
  }
  return values
}

/** 选出水位命中的行，再按分区边界拆成「纳入」与「分区边界排除」两组。 */
export function selectRows(
  sourceRows: SourceRow[],
  odsCode: string,
  spec: WatermarkSpec,
  mapping: MappingVersion,
): { candidates: ReplayRowResult[]; excluded: ReplayRowResult[] } {
  const candidates: ReplayRowResult[] = []
  const excluded: ReplayRowResult[] = []
  const ordered = sourceRows
    .filter((row) => row.odsCode === odsCode && watermarkHits(row, spec))
    .sort((a, b) => (a.updatedAt === b.updatedAt ? a.id - b.id : a.updatedAt < b.updatedAt ? -1 : 1))

  for (const row of ordered) {
    const partitionOk = partitionHits(row, spec)
    if (!partitionOk) {
      excluded.push({
        sourceRowId: row.id,
        shardIndex: -1,
        businessKey: row.businessKey,
        partition: row.partition,
        updatedAt: row.updatedAt,
        decision: '分区边界排除',
        retained: false,
        reason: `水位命中，但分区 ${row.partition} 不在冻结分区范围 ${spec.partitionStart} ~ ${spec.partitionEnd} 内`,
        mappingValues: {},
      })
      continue
    }
    candidates.push({
      sourceRowId: row.id,
      shardIndex: -1,
      businessKey: row.businessKey,
      partition: row.partition,
      updatedAt: row.updatedAt,
      decision: '纳入',
      retained: false,
      reason: '待同键保留判定',
      mappingValues: mapValues(row, mapping),
    })
  }
  return { candidates: resolveRetention(candidates), excluded }
}

/** 同一业务键按水位从旧到新排列，最后一个版本保留，其余标记被覆盖。 */
export function resolveRetention(rows: ReplayRowResult[]): ReplayRowResult[] {
  const grouped = new Map<string, ReplayRowResult[]>()
  for (const row of rows) {
    const list = grouped.get(row.businessKey) ?? []
    list.push(row)
    grouped.set(row.businessKey, list)
  }
  const resolved: ReplayRowResult[] = []
  for (const [key, list] of grouped) {
    const ordered = [...list].sort((a, b) => {
      if (a.updatedAt === b.updatedAt) {
        return a.sourceRowId - b.sourceRowId
      }
      return a.updatedAt < b.updatedAt ? -1 : 1
    })
    const winner = ordered[ordered.length - 1]
    ordered.forEach((row, index) => {
      if (row.sourceRowId === winner.sourceRowId) {
        resolved.push({
          ...row,
          retained: true,
          reason: ordered.length > 1 ? `同键水位最新（${key}），最终保留` : '同键仅此一个版本，直接保留',
        })
        return
      }
      const next = ordered[index + 1]
      resolved.push({
        ...row,
        retained: false,
        supersededBy: next.sourceRowId,
        reason: `同键新版本 ${next.sourceRowId}（${next.updatedAt}）覆盖本行`,
      })
    })
  }
  return resolved.sort((a, b) => {
    if (a.partition === b.partition) {
      return a.updatedAt === b.updatedAt ? a.sourceRowId - b.sourceRowId : a.updatedAt < b.updatedAt ? -1 : 1
    }
    return a.partition < b.partition ? -1 : 1
  })
}

/** 按分区生成分片，纳入行按分区顺序绑到分片号上。 */
export function buildShards(candidates: ReplayRowResult[]): { shards: Shard[]; rows: ReplayRowResult[] } {
  const partitions = [...new Set(candidates.map((row) => row.partition))].sort()
  const shards: Shard[] = partitions.map((partition, index) => ({
    index,
    partition,
    status: '待执行',
    rowCount: candidates.filter((row) => row.partition === partition).length,
  }))
  const indexOf = new Map(partitions.map((partition, index) => [partition, index]))
  return {
    shards,
    rows: candidates.map((row) => ({ ...row, shardIndex: indexOf.get(row.partition) ?? -1 })),
  }
}

/** 分片执行成功后写入该分片的命中行；再次执行同一分片会覆盖，不会叠加。 */
export function materializedRows(batch: ReplayBatch): ReplayRowResult[] {
  const confirmed = new Set(batch.shards.filter((shard) => shard.status === '已确认').map((shard) => shard.index))
  return batch.candidates.filter((row) => confirmed.has(row.shardIndex))
}

export function buildKeyGroups(batch: ReplayBatch): KeyRetentionGroup[] {
  const groups = new Map<string, ReplayRowResult[]>()
  for (const row of batch.candidates) {
    const list = groups.get(row.businessKey) ?? []
    list.push(row)
    groups.set(row.businessKey, list)
  }
  return [...groups.entries()]
    .map(([businessKey, rows]) => {
      const versions = [...rows].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
      const retained = versions.find((row) => row.retained) ?? null
      const confirmed = new Set(batch.shards.filter((shard) => shard.status === '已确认').map((shard) => shard.index))
      const retainedConfirmed = retained !== null && confirmed.has(retained.shardIndex)
      return {
        businessKey,
        retained,
        versions,
        duplicateCount: versions.length,
        retainedLabel: retained
          ? retainedConfirmed
            ? '本批保留（已落库）'
            : '本批保留（所在分片待执行）'
          : '无保留行',
      }
    })
    .sort((a, b) => (a.businessKey < b.businessKey ? -1 : 1))
}

export function compareWithPrevious(batch: ReplayBatch, previous: ReplayBatch): ReplayComparison {
  const winnerOf = (target: ReplayBatch) => {
    const map = new Map<string, ReplayRowResult>()
    for (const row of target.candidates) {
      if (row.retained) {
        map.set(row.businessKey, row)
      }
    }
    return map
  }
  const current = winnerOf(batch)
  const before = winnerOf(previous)
  const keys = [...new Set([...current.keys(), ...before.keys()])].sort()
  const rows: ReplayComparisonRow[] = keys.map((key) => {
    const now = current.get(key) ?? null
    const old = before.get(key) ?? null
    let change: ReplayComparisonRow['change'] = '一致'
    if (now && old) {
      change = now.sourceRowId === old.sourceRowId && now.updatedAt === old.updatedAt ? '一致' : '保留变更'
    } else if (now) {
      change = '仅本次'
    } else {
      change = '仅上次'
    }
    return {
      businessKey: key,
      previousRowId: old?.sourceRowId ?? null,
      currentRowId: now?.sourceRowId ?? null,
      previousUpdatedAt: old?.updatedAt ?? '—',
      currentUpdatedAt: now?.updatedAt ?? '—',
      change,
    }
  })
  return {
    previousBatchNo: previous.batchNo,
    previousCompletedAt: previous.completedAt ?? previous.createdAt,
    rows,
    summary: {
      same: rows.filter((row) => row.change === '一致').length,
      changed: rows.filter((row) => row.change === '保留变更').length,
      previousOnly: rows.filter((row) => row.change === '仅上次').length,
      currentOnly: rows.filter((row) => row.change === '仅本次').length,
    },
  }
}

export function batchStats(batch: ReplayBatch) {
  const confirmed = batch.shards.filter((shard) => shard.status === '已确认')
  const retainedKeys = new Set(batch.candidates.filter((row) => row.retained).map((row) => row.businessKey))
  return {
    included: batch.candidates.length,
    excluded: batch.excludedRows.length,
    covered: materializedRows(batch).length,
    retainedKeys: retainedKeys.size,
    confirmedShards: confirmed.length,
    totalShards: batch.shards.length,
    candidateRows: batch.candidates.length,
  }
}

export function nextPendingShard(batch: ReplayBatch): Shard | null {
  return batch.shards.find((shard) => shard.status === '待执行') ?? null
}
