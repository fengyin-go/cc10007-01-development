<template>
  <section class="page" data-module="datasync">
    <header class="page-head">
      <div>
        <h2>数据同步管理</h2>
        <p class="page-desc">
          下游同步不引用概览数字，而是引用一次具体的贴源层回放批次：沿用批次冻结的水位含义与映射版本，
          按该批次已确认分片的保留行建立同步链路。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出数据同步清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="object-layout">
      <aside class="section-block" style="margin-top: 0">
        <div class="section-head">
          <div>
            <h3>可引用回放批次</h3>
            <p>按贴源表分组，只有存在回放批次的贴源表会出现在这里。</p>
          </div>
        </div>
        <div v-for="group in syncGroups" :key="group.odsCode" class="object-list" style="margin-bottom: 14px">
          <div class="section-head" style="margin-bottom: 4px">
            <div>
              <h4 style="margin: 0; font-size: 13px">{{ group.odsCode }} · {{ group.tableName }}</h4>
              <p class="mono">{{ group.sourceTable }} → {{ group.targetTable }}</p>
            </div>
          </div>
          <button
            v-for="batch in group.batches"
            :key="batch.batchNo"
            class="object-card"
            :class="{ active: batch.batchNo === selectedBatchNo }"
            type="button"
            @click="selectedBatchNo = batch.batchNo"
          >
            <div class="object-title">
              <span class="object-code">{{ batch.batchNo }}</span>
              <span class="chip" :class="batch.status === '已确认' ? 'ok' : batch.status === '已失败' ? 'bad' : 'warn'">
                {{ batch.status }}
              </span>
            </div>
            <div class="object-meta">
              <span class="mono">{{ batch.mappingSnapshot.versionId }}</span>
              <span>{{ batch.watermark.start }} ~ {{ batch.watermark.end }}</span>
            </div>
            <div class="object-meta">
              <span class="chip info">纳入 {{ batch.candidates.length }}</span>
              <span class="chip">已确认分片 {{ batch.shards.filter((shard) => shard.status === '已确认').length }}/{{ batch.shards.length }}</span>
            </div>
          </button>
        </div>
        <p v-if="!syncGroups.length" class="inline-note">还没有可引用的回放批次，请先在贴源层建模页发起水位回放</p>
      </aside>

      <div>
        <section v-if="selectedBatch" class="section-block" style="margin-top: 0">
          <div class="section-head">
            <div>
              <h3>引用批次 {{ selectedBatch.batchNo }}</h3>
              <p>下游链路会固定这次回放的映射版本与水位含义，后续重建也不会改变既有解释。</p>
            </div>
            <span class="chip" :class="selectedBatch.status === '已确认' ? 'ok' : 'warn'">{{ selectedBatch.status }}</span>
          </div>

          <dl class="kv-grid">
            <div>
              <dt>贴源表</dt>
              <dd>{{ selectedBatch.tableName }}（{{ selectedBatch.odsCode }}）</dd>
            </div>
            <div>
              <dt>源表 → 目标表</dt>
              <dd class="mono">{{ selectedBatch.sourceTable }} → {{ selectedBatch.targetTable }}</dd>
            </div>
            <div>
              <dt>冻结映射版本</dt>
              <dd class="mono">{{ selectedBatch.mappingSnapshot.versionId }}</dd>
            </div>
            <div>
              <dt>冻结水位区间</dt>
              <dd class="mono">{{ selectedBatch.watermark.start }} ~ {{ selectedBatch.watermark.end }}</dd>
            </div>
            <div>
              <dt>冻结分区边界</dt>
              <dd class="mono">
                {{ selectedBatch.watermark.partitionStart }} ~ {{ selectedBatch.watermark.partitionEnd }}
              </dd>
            </div>
            <div>
              <dt>已确认分片 / 保留行</dt>
              <dd>{{ selectedBatch.shards.filter((shard) => shard.status === '已确认').length }} 个分片 · {{ retainedCount }} 行</dd>
            </div>
          </dl>

          <div class="summary-strip">
            <div class="summary-item"><strong>{{ selectedBatch.candidates.length }}</strong>纳入源行</div>
            <div class="summary-item"><strong>{{ selectedBatch.excludedRows.length }}</strong>分区边界排除</div>
            <div class="summary-item"><strong>{{ retainedCount }}</strong>已确认保留行</div>
            <div class="summary-item"><strong>{{ selectedBatch.excludedRows.length + selectedBatch.candidates.length }}</strong>本次引用覆盖行</div>
          </div>

          <form class="form-grid" @submit.prevent="submitLink">
            <label>
              <span>下游目标连接</span>
              <input v-model="targetConnection" placeholder="如 dwd_trade_order_inc" />
            </label>
            <label>
              <span>引用范围说明</span>
              <input :value="referenceText" readonly />
            </label>
            <div class="form-actions">
              <button class="btn primary" type="submit">引用本批次建立同步链路</button>
            </div>
          </form>
          <p v-if="createMessage" class="feedback" :class="createTone">{{ createMessage }}</p>
          <p class="inline-note">
            仅「已确认」批次或至少有一个已确认分片的失败批次可建立同步；同一批次不能重复登记。
          </p>
        </section>

        <section class="section-block">
          <div class="section-head">
            <div>
              <h3>同步链路</h3>
              <p>每条链路标注引用的回放批次，回看时可追溯到具体分片与命中行。</p>
            </div>
            <span class="chip">{{ links.length }} 条</span>
          </div>

          <div class="table-wrap">
            <table class="data-table compact">
              <thead>
                <tr>
                  <th>链路编号</th>
                  <th>引用批次</th>
                  <th>贴源表</th>
                  <th>冻结水位</th>
                  <th>映射版本</th>
                  <th>保留行</th>
                  <th>目标连接</th>
                  <th>状态</th>
                  <th>负责人</th>
                  <th>回看</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="link in links" :key="link.linkNo">
                  <td class="mono">{{ link.linkNo }}</td>
                  <td class="mono">{{ link.batchNo }}</td>
                  <td>{{ link.tableName }}<br /><small class="mono">{{ link.sourceTable }} → {{ link.targetTable }}</small></td>
                  <td class="mono">{{ link.watermarkText }}</td>
                  <td class="mono">{{ link.mappingVersionId }}</td>
                  <td>{{ link.included }}</td>
                  <td class="mono">{{ link.targetConnection }}</td>
                  <td>
                    <span class="chip" :class="link.status === '运行中' ? 'ok' : 'warn'">{{ link.status }}</span>
                  </td>
                  <td>{{ link.owner }}</td>
                  <td>
                    <RouterLink class="link" :to="{ path: '/ods', query: { ods: link.odsCode, batch: link.batchNo } }">
                      核对贴源批次
                    </RouterLink>
                  </td>
                </tr>
                <tr v-if="!links.length">
                  <td colspan="10" class="empty-state">暂无同步链路，可引用左侧回放批次建立</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据同步记录 · 链路引用回放批次而非汇总数字</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import { materializedRows } from '@/data/replay-engine'
import {
  createSyncFromBatch,
  listSyncGroups,
  listSyncLinks,
} from '@/api/replay-service'

const meta = moduleMeta('datasync')
const total = ref(0)
const errorMessage = ref('')
const syncGroups = ref(listSyncGroups())
const links = ref(listSyncLinks())
const selectedBatchNo = ref('')
const targetConnection = ref('')
const createMessage = ref('')
const createTone = ref('ok')
const revision = ref(0)
const route = useRoute()

const selectedBatch = computed(() => {
  void revision.value
  for (const group of syncGroups.value) {
    const found = group.batches.find((batch) => batch.batchNo === selectedBatchNo.value)
    if (found) {
      return found
    }
  }
  return null
})

const retainedCount = computed(() =>
  selectedBatch.value ? materializedRows(selectedBatch.value).filter((row) => row.retained).length : 0,
)

const referenceText = computed(() => {
  if (!selectedBatch.value) {
    return ''
  }
  return `${selectedBatch.value.batchNo} · ${selectedBatch.value.mappingSnapshot.versionId} · 已确认分片保留行`
})

const stats = computed(() => [
  { label: '同步链路总数', value: links.value.length },
  { label: '运行中链路', value: links.value.filter((link) => link.status === '运行中').length },
  { label: '可引用批次', value: syncGroups.value.reduce((sum, group) => sum + group.batches.length, 0) },
])

function refresh() {
  revision.value += 1
  syncGroups.value = listSyncGroups()
  links.value = listSyncLinks()
  const payload = listEntries(meta.key, {})
  total.value = payload.total
  const fromRoute = String(route.query.batch ?? '')
  const known = syncGroups.value.some((group) => group.batches.some((batch) => batch.batchNo === fromRoute))
  if (fromRoute && known) {
    selectedBatchNo.value = fromRoute
  }
  if (!selectedBatchNo.value) {
    selectedBatchNo.value = links.value[0]?.batchNo ?? syncGroups.value[0]?.batches[0]?.batchNo ?? ''
  }
}

function submitLink() {
  if (!selectedBatch.value) {
    createTone.value = 'bad'
    createMessage.value = '请先选择一个回放批次'
    return
  }
  const result = createSyncFromBatch(selectedBatch.value.batchNo, targetConnection.value, '值班管理员')
  createTone.value = result.ok ? 'ok' : 'bad'
  createMessage.value = result.message
  if (result.ok) {
    targetConnection.value = ''
    refresh()
  }
}

function exportRows() {
  downloadEntries(meta.key)
}

onMounted(refresh)
</script>
