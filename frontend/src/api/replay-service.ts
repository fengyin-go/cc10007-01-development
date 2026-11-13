import { listRows, saveRows } from '@/data/local-store'
import { REPLAY_TABLES, REPLAY_SYNC_SEED, createReplaySeed } from '@/data/replay-seed'
import {
  batchStats,
  buildKeyGroups,
  buildShards,
  compareWithPrevious,
  materializedRows,
  nextPendingShard,
  nowStamp,
  resolveRetention,
  selectRows,
} from '@/data/replay-engine'
import type {
  ActionResponse,
  BatchDetail,
  ConflictRecord,
  CreateBatchInput,
  CreateBatchResult,
  MappingVersion,
  OdsReplayObject,
  ReplayBatch,
  ReplayRowResult,
  ReplayState,
  Shard,
  SourceRow,
  SyncLinkView,
  SyncOptionGroup,
} from '@/data/replay-types'

// 贴源层水位回放的本地服务：批次创建、分片执行、失败续跑、冲突登记、证据冻结与下游同步引用。
// 页面组件只负责渲染与调用这里的方法，不自行判断业务规则。

const STORAGE_KEY = 'data-layer-studio:replay'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function loadState(): ReplayState {
  const fallback = createReplaySeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as ReplayState
    return {
      revision: parsed.revision ?? 0,
      mappingVersions: parsed.mappingVersions ?? fallback.mappingVersions,
      sourceRows: parsed.sourceRows ?? fallback.sourceRows,
      batches: parsed.batches ?? [],
      locks: parsed.locks ?? [],
      conflicts: parsed.conflicts ?? [],
      syncLinks: parsed.syncLinks ?? REPLAY_SYNC_SEED.map((link) => ({ ...link })),
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function saveState(next: ReplayState): void {
  next.revision += 1
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

function tableConfig(odsCode: string) {
  const table = REPLAY_TABLES.find((item) => item.odsCode === odsCode)
  if (!table) {
    throw new Error(`没有登记编号为 ${odsCode} 的贴源表`)
  }
  return table
}

function nextBatchNo(state: ReplayState): string {
  const date = nowStamp().slice(0, 10).replace(/-/g, '')
  const sameDay = state.batches.filter((batch) => batch.batchNo.includes(date)).length
  return `RP-${date}-${String(sameDay + 1).padStart(3, '0')}`
}

function validateInput(state: ReplayState, input: CreateBatchInput): string | null {
  if (!input.startWatermark.trim() || !input.endWatermark.trim()) {
    return '必须同时指定起始水位与结束水位'
  }
  if (input.startWatermark > input.endWatermark) {
    return `起始水位 ${input.startWatermark} 晚于结束水位 ${input.endWatermark}`
  }
  if (!input.partitionStart.trim() || !input.partitionEnd.trim()) {
    return '必须同时指定分区起点与分区终点'
  }
  if (input.partitionStart > input.partitionEnd) {
    return `分区起点 ${input.partitionStart} 晚于分区终点 ${input.partitionEnd}`
  }
  const mapping = state.mappingVersions.find((item) => item.id === input.mappingVersionId)
  if (!mapping) {
    return `映射版本 ${input.mappingVersionId} 不存在，不能创建回放批次`
  }
  if (mapping.odsCode !== input.odsCode) {
    return `映射版本 ${mapping.id} 属于 ${mapping.odsCode}，不能用于 ${input.odsCode}`
  }
  return null
}

function upsertConflict(state: ReplayState, conflict: ConflictRecord): void {
  state.conflicts = [conflict, ...state.conflicts].slice(0, 30)
}

export function listReplayObjects(): OdsReplayObject[] {
  const state = loadState()
  return REPLAY_TABLES.map((table) => {
    const sourceRows = state.sourceRows
      .filter((row) => row.odsCode === table.odsCode)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    const batches = state.batches
      .filter((batch) => batch.odsCode === table.odsCode)
      .sort((a, b) => b.id - a.id)
    const latest = batches[0] ?? null
    return {
      ...table,
      sourceRowCount: sourceRows.length,
      minWatermark: sourceRows[0]?.updatedAt ?? '',
      maxWatermark: sourceRows[sourceRows.length - 1]?.updatedAt ?? '',
      minPartition: [...sourceRows].sort((a, b) => (a.partition < b.partition ? -1 : 1))[0]?.partition ?? '',
      maxPartition: [...sourceRows].sort((a, b) => (a.partition < b.partition ? -1 : 1))[sourceRows.length - 1]?.partition ?? '',
      batchCount: batches.length,
      confirmedCount: batches.filter((batch) => batch.status === '已确认').length,
      latestBatch: latest,
      latestMapping: latest?.mappingSnapshot
        ? {
            id: latest.mappingSnapshot.versionId,
            odsCode: latest.odsCode,
            version: latest.mappingSnapshot.version,
            label: latest.mappingSnapshot.label,
            createdAt: latest.mappingSnapshot.frozenAt,
            frozen: true,
            fields: latest.mappingSnapshot.fields,
          }
        : (state.mappingVersions.find((item) => item.odsCode === table.odsCode) ?? null),
      lock: state.locks.find((lock) => lock.odsCode === table.odsCode) ?? null,
    }
  })
}

export function listMappingVersions(odsCode?: string): MappingVersion[] {
  const state = loadState()
  return state.mappingVersions
    .filter((item) => (odsCode ? item.odsCode === odsCode : true))
    .sort((a, b) => (a.odsCode === b.odsCode ? b.version - a.version : a.odsCode < b.odsCode ? -1 : 1))
}

export function listBatches(odsCode?: string): ReplayBatch[] {
  const state = loadState()
  return state.batches
    .filter((batch) => (odsCode ? batch.odsCode === odsCode : true))
    .sort((a, b) => b.id - a.id)
}

export function listConflicts(): ConflictRecord[] {
  return loadState().conflicts
}

export function createBatch(input: CreateBatchInput): CreateBatchResult {
  const state = loadState()
  const problem = validateInput(state, input)
  if (problem) {
    return { ok: false, message: problem }
  }
  const table = tableConfig(input.odsCode)
  const mapping = state.mappingVersions.find((item) => item.id === input.mappingVersionId) as MappingVersion
  const batchNo = nextBatchNo(state)
  const held = state.locks.find((lock) => lock.odsCode === input.odsCode)
  if (held) {
    const message = `${table.tableName}正被批次 ${held.batchNo}（${held.operator}，${held.claimedAt} 占用），本批次 ${batchNo} 未创建`
    upsertConflict(state, {
      at: nowStamp(),
      odsCode: input.odsCode,
      attemptedBatchNo: batchNo,
      operator: input.operator,
      holderBatchNo: held.batchNo,
      holderOperator: held.operator,
      message,
    })
    saveState(state)
    return {
      ok: false,
      message,
      conflict: {
        holderBatchNo: held.batchNo,
        holderOperator: held.operator,
        claimedAt: held.claimedAt,
      },
    }
  }

  const spec = {
    field: table.watermarkField,
    start: input.startWatermark,
    end: input.endWatermark,
    includeStart: input.includeStart,
    includeEnd: input.includeEnd,
    timezone: 'Asia/Shanghai',
    partitionField: table.partitionField,
    partitionStart: input.partitionStart,
    partitionEnd: input.partitionEnd,
  }
  const { candidates, excluded } = selectRows(state.sourceRows, input.odsCode, spec, mapping)
  const mapped = buildShards(candidates)
  const id = Math.max(0, ...state.batches.map((batch) => batch.id)) + 1
  const createdAt = nowStamp()
  const batch: ReplayBatch = {
    id,
    batchNo,
    odsCode: table.odsCode,
    tableName: table.tableName,
    sourceTable: table.sourceTable,
    targetTable: table.targetTable,
    operator: input.operator,
    createdAt,
    status: '待执行',
    watermark: spec,
    mappingVersionId: mapping.id,
    mappingSnapshot: {
      versionId: mapping.id,
      label: mapping.label,
      version: mapping.version,
      fields: clone(mapping.fields),
      frozenAt: createdAt,
      sourceTable: table.sourceTable,
    },
    shards: mapped.shards,
    excludedRows: excluded,
    candidates: mapped.rows,
    lastConfirmedShardIndex: -1,
    failedShardIndex: null,
    resumeCount: 0,
    resumeHistory: [],
    note: '',
    evidenceCode: `EV-${batchNo.replace('RP-', '')}`,
  }
  if (mapped.shards.length === 0) {
    // 没有命中任何分片时批次直接完成，也不占用贴源表。
    batch.status = '已确认'
    batch.completedAt = createdAt
    batch.note = `水位与分区范围内没有命中行，证据冻结为 ${batch.evidenceCode}`
    state.batches = [batch, ...state.batches]
    saveState(state)
    return {
      ok: true,
      message: `批次 ${batchNo} 已创建；水位与分区范围内没有命中行，直接确认，未占用贴源表`,
      batch,
    }
  }
  state.batches = [batch, ...state.batches]
  state.locks = [
    ...state.locks,
    {
      odsCode: input.odsCode,
      batchNo,
      operator: input.operator,
      token: `${batchNo}-${state.revision + 1}`,
      claimedAt: createdAt,
    },
  ]
  saveState(state)
  return {
    ok: true,
    message: `批次 ${batchNo} 已创建并占用 ${table.tableName}，待执行 ${mapped.shards.length} 个分片`,
    batch,
  }
}

function refreshStatus(batch: ReplayBatch): void {
  if (batch.shards.every((shard) => shard.status === '已确认')) {
    batch.status = '已确认'
    batch.completedAt = nowStamp()
    batch.note = `全部 ${batch.shards.length} 个分片确认，证据冻结为 ${batch.evidenceCode}`
    return
  }
  if (batch.shards.some((shard) => shard.status === '已失败')) {
    batch.status = '已失败'
    return
  }
  if (batch.shards.some((shard) => shard.status === '已确认')) {
    batch.status = '运行中'
    return
  }
  batch.status = '待执行'
}

function releaseLock(state: ReplayState, batchNo: string): void {
  state.locks = state.locks.filter((lock) => lock.batchNo !== batchNo)
}

function findBatch(state: ReplayState, batchNo: string): { batch: ReplayBatch; index: number } | null {
  const index = state.batches.findIndex((batch) => batch.batchNo === batchNo)
  if (index < 0) {
    return null
  }
  return { batch: state.batches[index], index }
}

/** 确认当前可执行分片。fail 只在演示故障注入时使用；失败分片之前的分片保持已确认。 */
export function runShard(batchNo: string, fail = false): ActionResponse {
  const state = loadState()
  const found = findBatch(state, batchNo)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  const { batch } = found
  if (batch.status === '已确认' || batch.status === '已终止') {
    return { ok: false, message: `批次 ${batchNo} 已是「${batch.status}」，不能再执行分片` }
  }
  const lock = state.locks.find((item) => item.odsCode === batch.odsCode)
  if (lock && lock.batchNo !== batchNo) {
    return { ok: false, message: `贴源表 ${batch.tableName} 已被批次 ${lock.batchNo} 占用，本批次不能推进` }
  }
  if (!lock) {
    state.locks.push({
      odsCode: batch.odsCode,
      batchNo,
      operator: batch.operator,
      token: `${batchNo}-resume`,
      claimedAt: nowStamp(),
    })
  }
  const shard = nextPendingShard(batch)
  if (!shard) {
    return { ok: false, message: `批次 ${batchNo} 没有待执行分片` }
  }
  if (fail) {
    shard.status = '已失败'
    batch.failedShardIndex = shard.index
    batch.status = '已失败'
    saveState(state)
    return {
      ok: false,
      message: `分片 ${shard.index}（分区 ${shard.partition}）执行失败；已确认分片 ${batch.lastConfirmedShardIndex + 1} 个保持不变`,
    }
  }
  shard.status = '已确认'
  shard.confirmedAt = nowStamp()
  batch.lastConfirmedShardIndex = Math.max(batch.lastConfirmedShardIndex, shard.index)
  batch.failedShardIndex = null
  refreshStatus(batch)
  if (batch.shards.every((item) => item.status === '已确认')) {
    releaseLock(state, batchNo)
  }
  saveState(state)
  return {
    ok: true,
    message: `分片 ${shard.index}（分区 ${shard.partition}）已确认，${shard.rowCount} 行落库；批次状态「${batch.status}」`,
  }
}

/** 失败后从最后一个已确认分片之后继续，不重跑、不叠加。 */
export function resumeBatch(batchNo: string): ActionResponse {
  const state = loadState()
  const found = findBatch(state, batchNo)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  const { batch } = found
  if (batch.status === '已确认' || batch.status === '已终止') {
    return { ok: false, message: `批次 ${batchNo} 已是「${batch.status}」，无需续跑` }
  }
  if (batch.status !== '已失败') {
    return { ok: false, message: `批次 ${batchNo} 当前为「${batch.status}」，只有失败批次才需要续跑` }
  }
  const lock = state.locks.find((item) => item.odsCode === batch.odsCode)
  if (lock && lock.batchNo !== batchNo) {
    return { ok: false, message: `贴源表 ${batch.tableName} 已被批次 ${lock.batchNo} 占用，本批次不能续跑` }
  }
  const confirmedBefore = batch.shards.filter((shard) => shard.status === '已确认').length
  const fromShard = batch.lastConfirmedShardIndex + 1
  // 关键：已确认分片保留，失败与未执行分片重置为待执行，命中行不做任何追加。
  batch.shards = batch.shards.map((shard) =>
    shard.status === '已确认' ? shard : { ...shard, status: '待执行' },
  )
  batch.failedShardIndex = null
  batch.resumeCount += 1
  batch.resumeHistory.push({
    at: nowStamp(),
    fromShardIndex: fromShard,
    confirmedBefore,
    message: `从分片 ${fromShard} 续跑，已确认 ${confirmedBefore} 个分片保持不变`,
  })
  batch.status = '运行中'
  if (!lock) {
    state.locks.push({
      odsCode: batch.odsCode,
      batchNo,
      operator: batch.operator,
      token: `${batchNo}-resume-${batch.resumeCount}`,
      claimedAt: nowStamp(),
    })
  }
  saveState(state)
  return {
    ok: true,
    message: `批次 ${batchNo} 从分片 ${fromShard} 续跑（已确认 ${confirmedBefore} 个分片不重跑）`,
  }
}

export function terminateBatch(batchNo: string): ActionResponse {
  const state = loadState()
  const found = findBatch(state, batchNo)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  const { batch } = found
  if (batch.status === '已确认') {
    return { ok: false, message: `批次 ${batchNo} 已确认，不能终止；证据保持冻结` }
  }
  if (batch.status === '已终止') {
    return { ok: false, message: `批次 ${batchNo} 已经终止` }
  }
  batch.status = '已终止'
  batch.note = `操作员终止于分片 ${batch.lastConfirmedShardIndex + 1} 之前，已确认分片保留为证据`
  releaseLock(state, batchNo)
  saveState(state)
  return { ok: true, message: `批次 ${batchNo} 已终止，贴源表占用已释放` }
}

export function getBatchDetail(batchNo: string): BatchDetail | null {
  const state = loadState()
  const found = findBatch(state, batchNo)
  if (!found) {
    return null
  }
  const { batch } = found
  const table = tableConfig(batch.odsCode)
  const latest = state.mappingVersions
    .filter((mapping) => mapping.odsCode === batch.odsCode)
    .sort((a, b) => b.version - a.version)[0] ?? null
  const previous = state.batches
    .filter(
      (item) =>
        item.odsCode === batch.odsCode &&
        item.id < batch.id &&
        (item.status === '已确认' || item.status === '已终止' || item.status === '已失败'),
    )
    .sort((a, b) => b.id - a.id)[0]
  return {
    batch,
    table,
    includedRows: batch.candidates,
    excludedRows: batch.excludedRows,
    keyGroups: buildKeyGroups(batch),
    stats: batchStats(batch),
    latestMapping: latest,
    mappingChanged: latest !== null && latest.id !== batch.mappingSnapshot.versionId,
    previousComparison: previous ? compareWithPrevious(batch, previous) : null,
  }
}

/** 命中结果的独立视图分组：保留 / 被同键覆盖 / 分区边界排除。 */
export function groupHitRows(batch: ReplayBatch) {
  return [
    {
      key: 'retained',
      title: '同键最终保留',
      hint: '同一业务键在本批次水位区间内保留的最新版本',
      rows: batch.candidates.filter((row) => row.retained),
    },
    {
      key: 'superseded',
      title: '同键被新版本覆盖',
      hint: '水位命中但同一业务键已有更晚版本，不再落库',
      rows: batch.candidates.filter((row) => !row.retained),
    },
    {
      key: 'excluded',
      title: '分区边界排除',
      hint: '水位命中但落在冻结分区范围之外，不计入本批次',
      rows: batch.excludedRows,
    },
  ]
}

/** 数据同步页只读取已创建的批次来建立下游同步，不再给一个孤立的概览数字。 */
export function listSyncGroups(): SyncOptionGroup[] {
  return REPLAY_TABLES.map((table) => ({
    odsCode: table.odsCode,
    tableName: table.tableName,
    sourceTable: table.sourceTable,
    targetTable: table.targetTable,
    batches: listBatches(table.odsCode).filter((batch) => batch.status !== '已终止'),
  })).filter((group) => group.batches.length > 0)
}

export function listSyncLinks(): SyncLinkView[] {
  const state = loadState()
  const links = clone(state.syncLinks)
  for (const batch of state.batches) {
    for (const link of links) {
      if (link.batchNo === batch.batchNo) {
        link.included = materializedRows(batch).filter((row) => row.retained).length
      }
    }
  }
  return links
}

export function createSyncFromBatch(batchNo: string, targetConnection: string, operator: string): ActionResponse {
  const state = loadState()
  const found = findBatch(state, batchNo)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchNo}，不能建立下游同步` }
  }
  const { batch } = found
  if (batch.status !== '已确认' && batch.status !== '已失败') {
    return { ok: false, message: `批次 ${batchNo} 当前为「${batch.status}」，至少要有已确认分片才能建立下游同步` }
  }
  if (batch.status === '已失败' && batch.lastConfirmedShardIndex < 0) {
    return { ok: false, message: `批次 ${batchNo} 尚无已确认分片，不能建立下游同步` }
  }
  if (!targetConnection.trim()) {
    return { ok: false, message: '必须填写下游目标连接' }
  }
  const links = listSyncLinks()
  if (links.some((link) => link.batchNo === batchNo)) {
    return { ok: false, message: `批次 ${batchNo} 已建立过下游同步，避免重复登记` }
  }
  const retained = materializedRows(batch).filter((row) => row.retained).length
  const syncLinks = clone(state.syncLinks)
  syncLinks.push({
    linkNo: `SYNC-${String(syncLinks.length + 1).padStart(4, '0')}`,
    batchNo,
    odsCode: batch.odsCode,
    tableName: batch.tableName,
    sourceTable: batch.sourceTable,
    targetTable: batch.targetTable,
    watermarkText: `${batch.watermark.field} ${batch.watermark.start} ~ ${batch.watermark.end}`,
    mappingVersionId: batch.mappingSnapshot.versionId,
    included: retained,
    targetConnection: targetConnection.trim(),
    status: '待校验',
    owner: operator,
  })
  state.syncLinks = syncLinks
  saveState(state)
  return { ok: true, message: `已引用批次 ${batchNo} 建立同步链路 ${syncLinks[syncLinks.length - 1].linkNo}` }
}

/** 追加一个映射版本：旧批次证据保持不变，只有新批次会使用新版本。 */
export function appendMappingVersion(odsCode: string, operator: string): { ok: boolean; message: string } {
  const state = loadState()
  const existing = state.mappingVersions
    .filter((mapping) => mapping.odsCode === odsCode)
    .sort((a, b) => b.version - a.version)
  const latest = existing[0]
  if (!latest) {
    return { ok: false, message: `${odsCode} 还没有可继承的映射版本` }
  }
  const version = latest.version + 1
  const fields = latest.fields.map((field) => ({ ...field }))
  const targetIndex = fields.findIndex((field) => field.source !== 'updated_at')
  if (targetIndex >= 0) {
    fields[targetIndex] = {
      ...fields[targetIndex],
      target: `${fields[targetIndex].target}_v${version}`,
    }
  }
  const mapping: MappingVersion = {
    id: `MAP-${odsCode}-v${version}`,
    odsCode,
    version,
    label: `v${version} · ${operator} 调整字段映射`,
    createdAt: nowStamp(),
    frozen: true,
    fields,
  }
  state.mappingVersions = [...state.mappingVersions, mapping]
  saveState(state)
  // 台账上的「字段映射」只是当前配置引用，旧批次仍按自己的快照解释。
  const ledger = listRows('ods')
  const ledgerIndex = ledger.findIndex((row) => String(row['表编号'] ?? '') === odsCode)
  if (ledgerIndex >= 0) {
    const next = [...ledger]
    next[ledgerIndex] = { ...next[ledgerIndex], 字段映射: mapping.id }
    saveRows('ods', next)
  }
  return {
    ok: true,
    message: `已追加映射版本 ${mapping.id}；历史批次的映射快照不随之改变`,
  }
}

export function replayStorageKey(): string {
  return STORAGE_KEY
}
