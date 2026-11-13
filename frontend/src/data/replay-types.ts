/** 贴源层水位回放的类型定义：批次、分片、固定证据与命中结果。 */

export type FieldMapping = {
  source: string
  target: string
}

export type MappingVersion = {
  id: string
  odsCode: string
  version: number
  label: string
  createdAt: string
  /** 已发布的映射版本是不可变的，后续只允许追加新版本。 */
  frozen: true
  fields: FieldMapping[]
}

/** 创建批次时冻结的水位含义，后续不会随配置变化。 */
export type WatermarkSpec = {
  field: string
  start: string
  end: string
  includeStart: boolean
  includeEnd: boolean
  timezone: string
  partitionField: string
  partitionStart: string
  partitionEnd: string
}

export type MappingSnapshot = {
  versionId: string
  label: string
  version: number
  fields: FieldMapping[]
  frozenAt: string
  sourceTable: string
}

export type SourceRow = {
  id: number
  odsCode: string
  sourceTable: string
  businessKey: string
  partition: string
  updatedAt: string
  payload: Record<string, string>
}

export type ReplayTableConfig = {
  odsCode: string
  tableName: string
  sourceTable: string
  targetTable: string
  watermarkField: string
  partitionField: string
  businessKeyField: string
}

export type ShardStatus = '待执行' | '已确认' | '已失败'

export type Shard = {
  index: number
  partition: string
  status: ShardStatus
  rowCount: number
  confirmedAt?: string
}

export type RowDecision = '纳入' | '分区边界排除'

export type ReplayRowResult = {
  sourceRowId: number
  shardIndex: number
  businessKey: string
  partition: string
  updatedAt: string
  decision: RowDecision
  /** 同一业务键的最终保留结果：true 表示当前保留，false 表示被同键新版本覆盖。 */
  retained: boolean
  reason: string
  supersededBy?: number
  mappingValues: Record<string, string>
}

export type BatchStatus = '待执行' | '运行中' | '已失败' | '已确认' | '已终止'

export type ResumeRecord = {
  at: string
  fromShardIndex: number
  confirmedBefore: number
  message: string
}

export type ReplayBatch = {
  id: number
  batchNo: string
  odsCode: string
  tableName: string
  sourceTable: string
  targetTable: string
  operator: string
  createdAt: string
  status: BatchStatus
  watermark: WatermarkSpec
  mappingVersionId: string
  mappingSnapshot: MappingSnapshot
  shards: Shard[]
  /** 水位命中但被分区边界挡在外面的源行。 */
  excludedRows: ReplayRowResult[]
  /** 水位与分区命中、纳入本批次的全部源行（保留判定已算好）。 */
  candidates: ReplayRowResult[]
  /** 已确认分片的最大序号；失败续跑从它之后继续，不会从头叠加。 */
  lastConfirmedShardIndex: number
  failedShardIndex: number | null
  resumeCount: number
  resumeHistory: ResumeRecord[]
  completedAt?: string
  note: string
  evidenceCode: string
}

export type TableLock = {
  odsCode: string
  batchNo: string
  operator: string
  token: string
  claimedAt: string
}

export type ConflictRecord = {
  at: string
  odsCode: string
  attemptedBatchNo: string
  operator: string
  holderBatchNo: string
  holderOperator: string
  message: string
}

export type ReplayState = {
  revision: number
  mappingVersions: MappingVersion[]
  sourceRows: SourceRow[]
  batches: ReplayBatch[]
  locks: TableLock[]
  conflicts: ConflictRecord[]
  syncLinks: SyncLinkView[]
}

export type BatchStats = {
  included: number
  excluded: number
  covered: number
  retainedKeys: number
  confirmedShards: number
  totalShards: number
  candidateRows: number
}

export type KeyRetentionGroup = {
  businessKey: string
  retained: ReplayRowResult | null
  versions: ReplayRowResult[]
  duplicateCount: number
  retainedLabel: string
}

export type ReplayComparisonRow = {
  businessKey: string
  previousRowId: number | null
  currentRowId: number | null
  previousUpdatedAt: string
  currentUpdatedAt: string
  change: '一致' | '保留变更' | '仅上次' | '仅本次'
}

export type ReplayComparison = {
  previousBatchNo: string
  previousCompletedAt: string
  rows: ReplayComparisonRow[]
  summary: { same: number; changed: number; previousOnly: number; currentOnly: number }
}

export type BatchDetail = {
  batch: ReplayBatch
  table: ReplayTableConfig
  includedRows: ReplayRowResult[]
  excludedRows: ReplayRowResult[]
  keyGroups: KeyRetentionGroup[]
  stats: BatchStats
  latestMapping: MappingVersion | null
  mappingChanged: boolean
  previousComparison: ReplayComparison | null
}

export type OdsReplayObject = {
  odsCode: string
  tableName: string
  sourceTable: string
  targetTable: string
  watermarkField: string
  partitionField: string
  businessKeyField: string
  sourceRowCount: number
  minWatermark: string
  maxWatermark: string
  minPartition: string
  maxPartition: string
  batchCount: number
  confirmedCount: number
  latestBatch: ReplayBatch | null
  latestMapping: MappingVersion | null
  lock: TableLock | null
}

export type CreateBatchInput = {
  odsCode: string
  operator: string
  startWatermark: string
  endWatermark: string
  partitionStart: string
  partitionEnd: string
  includeStart: boolean
  includeEnd: boolean
  mappingVersionId: string
}

export type CreateBatchResult =
  | { ok: true; message: string; batch: ReplayBatch }
  | {
      ok: false
      message: string
      conflict?: {
        holderBatchNo: string
        holderOperator: string
        claimedAt: string
      }
    }

export type ActionResponse = {
  ok: boolean
  message: string
}

export type SyncOptionGroup = {
  odsCode: string
  tableName: string
  sourceTable: string
  targetTable: string
  batches: ReplayBatch[]
}

export type SyncLinkView = {
  linkNo: string
  batchNo: string
  odsCode: string
  tableName: string
  sourceTable: string
  targetTable: string
  watermarkText: string
  mappingVersionId: string
  included: number
  targetConnection: string
  status: string
  owner: string
}
