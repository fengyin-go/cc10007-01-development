import { buildShards, selectRows } from './replay-engine'
import type {
  MappingVersion,
  ReplayBatch,
  ReplayState,
  SourceRow,
  SyncLinkView,
} from './replay-types'

// 回放证据的示例数据：贴源表、固定映射版本、源行与演示用的历史批次。
// 只用于首次播种，之后浏览器 localStorage 里的内容优先。

export const REPLAY_TABLES = [
  {
    odsCode: 'ODS-0003',
    tableName: '订单增量贴源表',
    sourceTable: 'src_trade_order',
    targetTable: 'ods_trade_order_inc',
    watermarkField: 'updated_at',
    partitionField: 'dt',
    businessKeyField: 'order_id',
  },
  {
    odsCode: 'ODS-0002',
    tableName: '支付流水贴源表',
    sourceTable: 'src_pay_flow',
    targetTable: 'ods_pay_flow_inc',
    watermarkField: 'updated_at',
    partitionField: 'dt',
    businessKeyField: 'pay_no',
  },
  {
    odsCode: 'ODS-0001',
    tableName: '商品快照贴源表',
    sourceTable: 'src_product_snap',
    targetTable: 'ods_product_snap',
    watermarkField: 'updated_at',
    partitionField: 'dt',
    businessKeyField: 'product_id',
  },
]

export const REPLAY_MAPPING_SEED: MappingVersion[] = [
  {
    id: 'MAP-ODS-0003-v1',
    odsCode: 'ODS-0003',
    version: 1,
    label: 'v1 · 订单主字段',
    createdAt: '2026-06-01 09:00',
    frozen: true,
    fields: [
      { source: 'order_id', target: 'order_id' },
      { source: 'buyer_id', target: 'buyer_id' },
      { source: 'order_status', target: 'order_status' },
      { source: 'pay_amount', target: 'pay_amt' },
      { source: 'updated_at', target: 'updated_at' },
    ],
  },
  {
    id: 'MAP-ODS-0003-v2',
    odsCode: 'ODS-0003',
    version: 2,
    label: 'v2 · 支付金额拆分后',
    createdAt: '2026-09-15 14:20',
    frozen: true,
    fields: [
      { source: 'order_id', target: 'order_id' },
      { source: 'buyer_id', target: 'buyer_id' },
      { source: 'order_status', target: 'order_status' },
      { source: 'pay_amount', target: 'pay_amount_cny' },
      { source: 'currency', target: 'currency_code' },
      { source: 'updated_at', target: 'updated_at' },
    ],
  },
  {
    id: 'MAP-ODS-0002-v1',
    odsCode: 'ODS-0002',
    version: 1,
    label: 'v1 · 支付流水',
    createdAt: '2026-05-20 10:00',
    frozen: true,
    fields: [
      { source: 'pay_no', target: 'pay_no' },
      { source: 'order_id', target: 'order_id' },
      { source: 'pay_channel', target: 'channel' },
      { source: 'pay_amount', target: 'pay_amount' },
      { source: 'updated_at', target: 'updated_at' },
    ],
  },
  {
    id: 'MAP-ODS-0002-v2',
    odsCode: 'ODS-0002',
    version: 2,
    label: 'v2 · 渠道编码统一',
    createdAt: '2026-10-08 11:30',
    frozen: true,
    fields: [
      { source: 'pay_no', target: 'pay_no' },
      { source: 'order_id', target: 'order_id' },
      { source: 'pay_channel', target: 'pay_channel_code' },
      { source: 'pay_amount', target: 'pay_amount' },
      { source: 'updated_at', target: 'updated_at' },
    ],
  },
  {
    id: 'MAP-ODS-0001-v1',
    odsCode: 'ODS-0001',
    version: 1,
    label: 'v1 · 商品快照',
    createdAt: '2026-04-11 16:00',
    frozen: true,
    fields: [
      { source: 'product_id', target: 'product_id' },
      { source: 'product_name', target: 'product_name' },
      { source: 'category', target: 'category_name' },
      { source: 'price', target: 'price' },
      { source: 'updated_at', target: 'updated_at' },
    ],
  },
]

function rowsFor(
  odsCode: string,
  sourceTable: string,
  partition: string,
  hourSeed: number,
  payloadLines: string[],
): SourceRow[] {
  // 每张表两条业务键、各两个版本，保证能看到同键覆盖与分区排除。
  const rows: SourceRow[] = []
  payloadLines.forEach((line, index) => {
    const [key, updatedAt, ...pairs] = line.split('|')
    const payload: Record<string, string> = {}
    for (const pair of pairs) {
      const [name, value] = pair.split('=')
      payload[name] = value
    }
    rows.push({
      id: hourSeed * 100 + index,
      odsCode,
      sourceTable,
      businessKey: key,
      partition,
      updatedAt,
      payload,
    })
  })
  return rows
}

export const REPLAY_SOURCE_SEED: SourceRow[] = [
  // ODS-0003：2026-10-01 至 10-03，覆盖 10-01 全量 + 10-02 增量
  ...rowsFor('ODS-0003', 'src_trade_order', '2026-10-01', 1, [
    'T20261001-001|2026-10-01 09:12:00|order_id=T20261001-001|buyer_id=U-1001|order_status=PAID|pay_amount=328.00|currency=CNY|updated_at=2026-10-01 09:12:00',
    'T20261001-002|2026-10-01 10:05:00|order_id=T20261001-002|buyer_id=U-1002|order_status=PAID|pay_amount=59.90|currency=CNY|updated_at=2026-10-01 10:05:00',
    'T20261001-003|2026-10-01 11:40:00|order_id=T20261001-003|buyer_id=U-1003|order_status=CREATED|pay_amount=0.00|currency=CNY|updated_at=2026-10-01 11:40:00',
    'T20261001-004|2026-10-01 15:22:00|order_id=T20261001-004|buyer_id=U-1004|order_status=PAID|pay_amount=188.00|currency=CNY|updated_at=2026-10-01 15:22:00',
  ]),
  ...rowsFor('ODS-0003', 'src_trade_order', '2026-10-02', 2, [
    'T20261001-001|2026-10-02 08:30:00|order_id=T20261001-001|buyer_id=U-1001|order_status=SHIPPED|pay_amount=328.00|currency=CNY|updated_at=2026-10-02 08:30:00',
    'T20261001-003|2026-10-02 09:10:00|order_id=T20261001-003|buyer_id=U-1003|order_status=PAID|pay_amount=99.00|currency=CNY|updated_at=2026-10-02 09:10:00',
    'T20261001-005|2026-10-02 13:45:00|order_id=T20261001-005|buyer_id=U-1005|order_status=PAID|pay_amount=45.50|currency=CNY|updated_at=2026-10-02 13:45:00',
  ]),
  ...rowsFor('ODS-0003', 'src_trade_order', '2026-10-03', 3, [
    'T20261001-002|2026-10-03 07:20:00|order_id=T20261001-002|buyer_id=U-1002|order_status=REFUNDED|pay_amount=59.90|currency=CNY|updated_at=2026-10-03 07:20:00',
  ]),
  // ODS-0002：2026-10-04 至 10-06
  ...rowsFor('ODS-0002', 'src_pay_flow', '2026-10-04', 4, [
    'P20261004-001|2026-10-04 09:00:00|pay_no=P20261004-001|order_id=T20261001-001|pay_channel=ALIPAY|pay_amount=328.00|updated_at=2026-10-04 09:00:00',
    'P20261004-002|2026-10-04 10:20:00|pay_no=P20261004-002|order_id=T20261001-002|pay_channel=WECHAT|pay_amount=59.90|updated_at=2026-10-04 10:20:00',
    'P20261004-003|2026-10-04 18:02:00|pay_no=P20261004-003|order_id=T20261001-004|pay_channel=ALIPAY|pay_amount=188.00|updated_at=2026-10-04 18:02:00',
    'P20261004-004|2026-10-04 19:30:00|pay_no=P20261004-004|order_id=T20261001-005|pay_channel=UNIONPAY|pay_amount=45.50|updated_at=2026-10-04 19:30:00',
  ]),
  ...rowsFor('ODS-0002', 'src_pay_flow', '2026-10-05', 5, [
    'P20261004-002|2026-10-05 08:44:00|pay_no=P20261004-002|order_id=T20261001-002|pay_channel=WECHAT|pay_amount=59.90|updated_at=2026-10-05 08:44:00',
    'P20261005-001|2026-10-05 14:10:00|pay_no=P20261005-001|order_id=T20261002-001|pay_channel=ALIPAY|pay_amount=702.00|updated_at=2026-10-05 14:10:00',
  ]),
  ...rowsFor('ODS-0002', 'src_pay_flow', '2026-10-06', 6, [
    'P20261004-001|2026-10-06 09:05:00|pay_no=P20261004-001|order_id=T20261001-001|pay_channel=ALIPAY|pay_amount=328.00|updated_at=2026-10-06 09:05:00',
  ]),
  // ODS-0001：2026-10-07 至 10-09
  ...rowsFor('ODS-0001', 'src_product_snap', '2026-10-07', 7, [
    'SKU-2001|2026-10-07 08:00:00|product_id=SKU-2001|product_name=轻薄羽绒服|category=服饰/外套|price=499.00|updated_at=2026-10-07 08:00:00',
    'SKU-2002|2026-10-07 09:30:00|product_id=SKU-2002|product_name=通勤双肩包|category=箱包/背包|price=239.00|updated_at=2026-10-07 09:30:00',
    'SKU-2003|2026-10-07 11:15:00|product_id=SKU-2003|product_name=保温杯 500ml|category=家居/杯具|price=89.00|updated_at=2026-10-07 11:15:00',
  ]),
  ...rowsFor('ODS-0001', 'src_product_snap', '2026-10-08', 8, [
    'SKU-2001|2026-10-08 10:00:00|product_id=SKU-2001|product_name=轻薄羽绒服|category=服饰/外套|price=459.00|updated_at=2026-10-08 10:00:00',
    'SKU-2004|2026-10-08 12:40:00|product_id=SKU-2004|product_name=羊毛围巾|category=服饰/配件|price=159.00|updated_at=2026-10-08 12:40:00',
  ]),
  ...rowsFor('ODS-0001', 'src_product_snap', '2026-10-09', 9, [
    'SKU-2002|2026-10-09 08:20:00|product_id=SKU-2002|product_name=通勤双肩包|category=箱包/背包|price=219.00|updated_at=2026-10-09 08:20:00',
  ]),
]

function tableOf(odsCode: string) {
  const table = REPLAY_TABLES.find((item) => item.odsCode === odsCode)
  if (!table) {
    throw new Error(`示例贴源表 ${odsCode} 未登记`)
  }
  return table
}

function mappingOf(id: string): MappingVersion {
  const mapping = REPLAY_MAPPING_SEED.find((item) => item.id === id)
  if (!mapping) {
    throw new Error(`示例映射版本 ${id} 未登记`)
  }
  return mapping
}

function buildDemoBatch(): ReplayBatch {
  const table = tableOf('ODS-0002')
  const mapping = mappingOf('MAP-ODS-0002-v1')
  const watermark = {
    field: table.watermarkField,
    start: '2026-10-04 00:00:00',
    end: '2026-10-06 23:59:59',
    includeStart: true,
    includeEnd: true,
    timezone: 'Asia/Shanghai',
    partitionField: 'dt',
    partitionStart: '2026-10-04',
    partitionEnd: '2026-10-05',
  }
  // 示例批次与运行时走同一个引擎：命中行、分区排除与同键保留结果保持一致。
  const { candidates, excluded } = selectRows(REPLAY_SOURCE_SEED, table.odsCode, watermark, mapping)
  const mapped = buildShards(candidates)
  const shards = mapped.shards.map((shard) => ({
    ...shard,
    status: '已确认' as const,
    confirmedAt: shard.index === 0 ? '2026-11-07 21:11' : '2026-11-07 21:12',
  }))
  return {
    id: 1,
    batchNo: 'RP-20261107-001',
    odsCode: table.odsCode,
    tableName: table.tableName,
    sourceTable: table.sourceTable,
    targetTable: table.targetTable,
    operator: '值班管理员',
    createdAt: '2026-11-07 21:10',
    status: '已确认',
    watermark,
    mappingVersionId: mapping.id,
    mappingSnapshot: {
      versionId: mapping.id,
      label: mapping.label,
      version: mapping.version,
      fields: mapping.fields.map((field) => ({ ...field })),
      frozenAt: '2026-11-07 21:10',
      sourceTable: table.sourceTable,
    },
    shards,
    excludedRows: excluded,
    candidates: mapped.rows,
    lastConfirmedShardIndex: shards.length - 1,
    failedShardIndex: null,
    resumeCount: 0,
    resumeHistory: [
      {
        at: '2026-11-07 21:12',
        fromShardIndex: shards.length - 1,
        confirmedBefore: 0,
        message: `本批次一次跑完，${shards.length} 个分片均确认`,
      },
    ],
    completedAt: '2026-11-07 21:12',
    note: '示例批次：固定 v1 映射与冻结分区边界，后续改动映射不影响本批次解释',
    evidenceCode: 'EV-20261107-001',
  }
}

export const REPLAY_SYNC_SEED: SyncLinkView[] = [
  {
    linkNo: 'SYNC-0001',
    batchNo: 'RP-20261107-001',
    odsCode: 'ODS-0002',
    tableName: '支付流水贴源表',
    sourceTable: 'src_pay_flow',
    targetTable: 'ods_pay_flow_inc',
    watermarkText: 'updated_at 2026-10-04 00:00:00 ~ 2026-10-06 23:59:59',
    mappingVersionId: 'MAP-ODS-0002-v1',
    included: 5,
    targetConnection: 'dwd_pay_flow_daily',
    status: '运行中',
    owner: '值班管理员',
  },
]

export function createReplaySeed(): ReplayState {
  const batch = buildDemoBatch()
  return {
    revision: 3,
    mappingVersions: REPLAY_MAPPING_SEED.map((item) => ({
      ...item,
      fields: item.fields.map((field) => ({ ...field })),
    })),
    sourceRows: REPLAY_SOURCE_SEED.map((row) => ({
      ...row,
      payload: { ...row.payload },
    })),
    batches: [batch],
    locks: [],
    conflicts: [],
    syncLinks: REPLAY_SYNC_SEED.map((link) => ({ ...link })),
  }
}
