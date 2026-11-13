<template>
  <section class="page" data-module="ods">
    <header class="page-head">
      <div>
        <h2>贴源层建模管理</h2>
        <p class="page-desc">
          维护贴源层同步表，并在同一条贴源表上发起可重复的水位回放：冻结起止水位与字段映射版本，
          按分片确认命中行、分区边界排除行与同键保留结果。回放证据建立后不再随映射修改而变化。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出贴源层建模清单</button>
      </div>
    </header>

    <div class="detail-tabs">
      <button type="button" :class="{ active: pageView === 'replay' }" @click="pageView = 'replay'">
        水位回放工作区
      </button>
      <button type="button" :class="{ active: pageView === 'ledger' }" @click="pageView = 'ledger'">
        贴源表台账
      </button>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="pageView === 'replay'" class="object-layout">
      <aside class="section-block" style="margin-top: 0">
        <div class="section-head">
          <div>
            <h3>贴源表对象分组</h3>
            <p>按回放占用与证据状态分组，点选后在右侧发起或回看批次。</p>
          </div>
        </div>

        <div v-for="group in objectGroups" :key="group.key" class="object-list" style="margin-bottom: 14px">
          <div class="section-head" style="margin-bottom: 4px">
            <div>
              <h4 style="margin: 0; font-size: 13px">{{ group.title }}（{{ group.items.length }}）</h4>
              <p>{{ group.hint }}</p>
            </div>
          </div>
          <button
            v-for="object in group.items"
            :key="object.odsCode"
            class="object-card"
            :class="{ active: object.odsCode === selectedOdsCode }"
            type="button"
            @click="selectObject(object.odsCode)"
          >
            <div class="object-title">
              <span class="object-code">{{ object.odsCode }}</span>
              <span class="object-name">{{ object.tableName }}</span>
            </div>
            <div class="object-meta">
              <span>{{ object.sourceTable }} → {{ object.targetTable }}</span>
            </div>
            <div class="object-meta">
              <span class="chip info">水位 {{ object.watermarkField }}</span>
              <span class="chip">源行 {{ object.sourceRowCount }}</span>
              <span class="chip">批次 {{ object.batchCount }}</span>
              <span v-if="object.lock" class="chip lock">占用中</span>
              <span v-else-if="object.confirmedCount" class="chip ok">已有证据</span>
              <span v-else class="chip warn">尚未回放</span>
            </div>
          </button>
          <p v-if="!group.items.length" class="inline-note">暂无该分组的贴源表</p>
        </div>
      </aside>

      <div>
        <section v-if="selectedObject" class="section-block" style="margin-top: 0">
          <div class="section-head">
            <div>
              <h3>{{ selectedObject.odsCode }} · {{ selectedObject.tableName }}</h3>
              <p>同一贴源表同一时间只允许一个回放批次推进，其余操作必须得到冲突说明。</p>
            </div>
            <div class="section-tools">
              <span v-if="selectedObject.lock" class="chip lock">
                占用：{{ selectedObject.lock.batchNo }} / {{ selectedObject.lock.operator }}
              </span>
              <span v-else class="chip ok">当前空闲</span>
            </div>
          </div>

          <dl class="kv-grid">
            <div>
              <dt>源表 → 目标表</dt>
              <dd>{{ selectedObject.sourceTable }} → {{ selectedObject.targetTable }}</dd>
            </div>
            <div>
              <dt>增量水位字段</dt>
              <dd class="mono">{{ selectedObject.watermarkField }}</dd>
            </div>
            <div>
              <dt>分区字段</dt>
              <dd class="mono">{{ selectedObject.partitionField }}</dd>
            </div>
            <div>
              <dt>业务键</dt>
              <dd class="mono">{{ selectedObject.businessKeyField }}</dd>
            </div>
            <div>
              <dt>源行水位范围</dt>
              <dd>{{ selectedObject.minWatermark || '—' }} ~ {{ selectedObject.maxWatermark || '—' }}</dd>
            </div>
            <div>
              <dt>源行分区范围</dt>
              <dd>{{ selectedObject.minPartition || '—' }} ~ {{ selectedObject.maxPartition || '—' }}</dd>
            </div>
            <div>
              <dt>已建批次 / 已确认</dt>
              <dd>{{ selectedObject.batchCount }} / {{ selectedObject.confirmedCount }}</dd>
            </div>
            <div>
              <dt>最近映射版本</dt>
              <dd class="mono">{{ selectedObject.latestMapping?.id ?? '—' }}</dd>
            </div>
          </dl>

          <div v-if="selectedObject.lock" class="feedback warn">
            贴源表被批次 {{ selectedObject.lock.batchNo }}（{{ selectedObject.lock.operator }}，{{ selectedObject.lock.claimedAt }}）占用。
            新建批次会直接返回冲突，不会产生第二个并行批次。
          </div>

          <div class="section-head" style="margin-top: 14px">
            <div>
              <h4 style="margin: 0; font-size: 14px">发起水位回放</h4>
              <p>起止水位与分区边界在创建时冻结；映射版本固定为快照，后续修改映射不影响本批次。</p>
            </div>
            <div class="section-tools">
              <button class="btn ghost" type="button" @click="handleAppendMapping">追加映射版本</button>
            </div>
          </div>

          <form class="form-grid" @submit.prevent="submitBatch">
            <label>
              <span>起始水位</span>
              <input v-model="form.startWatermark" placeholder="YYYY-MM-DD HH:mm:ss" />
            </label>
            <label>
              <span>结束水位</span>
              <input v-model="form.endWatermark" placeholder="YYYY-MM-DD HH:mm:ss" />
            </label>
            <label class="checkbox-inline">
              <input v-model="form.includeStart" type="checkbox" />
              <span>包含起始水位</span>
            </label>
            <label class="checkbox-inline">
              <input v-model="form.includeEnd" type="checkbox" />
              <span>包含结束水位</span>
            </label>
            <label>
              <span>分区起点</span>
              <input v-model="form.partitionStart" placeholder="YYYY-MM-DD" />
            </label>
            <label>
              <span>分区终点</span>
              <input v-model="form.partitionEnd" placeholder="YYYY-MM-DD" />
            </label>
            <label>
              <span>字段映射版本</span>
              <select v-model="form.mappingVersionId">
                <option v-for="mapping in mappingOptions" :key="mapping.id" :value="mapping.id">
                  {{ mapping.id }} · {{ mapping.label }}
                </option>
              </select>
            </label>
            <div class="form-actions">
              <button class="btn primary" type="submit">创建回放批次</button>
              <button class="btn ghost" type="button" @click="resetForm">恢复源行范围</button>
            </div>
          </form>

          <p v-if="createMessage" class="feedback" :class="createTone">{{ createMessage }}</p>
        </section>

        <section class="section-block">
          <div class="section-head">
            <div>
              <h3>回放批次</h3>
              <p>选中批次后可在下方查看分片、命中结果与冻结证据。</p>
            </div>
            <span class="chip">{{ tableBatches.length }} 个批次</span>
          </div>

          <div class="table-wrap">
            <table class="data-table compact">
              <thead>
                <tr>
                  <th>批次号</th>
                  <th>状态</th>
                  <th>水位区间</th>
                  <th>映射版本</th>
                  <th>纳入 / 排除</th>
                  <th>已确认分片</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="batch in tableBatches"
                  :key="batch.batchNo"
                  :class="{ 'row-selected': batch.batchNo === selectedBatchNo }"
                >
                  <td class="mono">{{ batch.batchNo }}</td>
                  <td>
                    <span class="chip" :class="statusTone(batch.status)">{{ batch.status }}</span>
                  </td>
                  <td class="mono">{{ batch.watermark.start }}<br />~ {{ batch.watermark.end }}</td>
                  <td class="mono">{{ batch.mappingSnapshot.versionId }}</td>
                  <td>{{ batch.candidates.length }} / {{ batch.excludedRows.length }}</td>
                  <td>{{ confirmedShards(batch) }} / {{ batch.shards.length }}</td>
                  <td>{{ batch.createdAt }}</td>
                  <td class="row-actions">
                    <button class="link" type="button" @click="selectBatch(batch.batchNo)">
                      {{ batch.batchNo === selectedBatchNo ? '正在查看' : '查看' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="!tableBatches.length">
                  <td colspan="8" class="empty-state">该贴源表还没有回放批次，可在上方发起一次水位回放</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-if="detail" class="section-block">
          <div class="section-head">
            <div>
              <h3>批次 {{ detail.batch.batchNo }} · {{ detail.batch.status }}</h3>
              <p>
                证据 {{ detail.batch.evidenceCode }} · 操作员 {{ detail.batch.operator }} ·
                创建 {{ detail.batch.createdAt }}
              </p>
            </div>
            <div class="section-tools">
              <span class="chip info">映射冻结 {{ detail.batch.mappingSnapshot.versionId }}</span>
              <span v-if="detail.mappingChanged" class="chip warn">映射已更新，本批次解释不变</span>
            </div>
          </div>

          <div class="detail-tabs">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              type="button"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
            </button>
          </div>

          <div v-if="actionMessage" class="feedback" :class="actionTone">{{ actionMessage }}</div>

          <template v-if="activeTab === 'shards'">
            <div class="summary-strip">
              <div class="summary-item"><strong>{{ detail.stats.included }}</strong>纳入源行</div>
              <div class="summary-item"><strong>{{ detail.stats.excluded }}</strong>分区边界排除</div>
              <div class="summary-item"><strong>{{ detail.stats.retainedKeys }}</strong>保留业务键</div>
              <div class="summary-item"><strong>{{ detail.stats.covered }}</strong>已落库行</div>
              <div class="summary-item">
                <strong>{{ detail.stats.confirmedShards }} / {{ detail.stats.totalShards }}</strong>已确认分片
              </div>
              <div class="summary-item"><strong>{{ detail.batch.resumeCount }}</strong>续跑次数</div>
            </div>

            <div class="shard-list">
              <div
                v-for="shard in detail.batch.shards"
                :key="shard.index"
                class="shard-row"
                :class="shard.status === '已确认' ? 'confirmed' : shard.status === '已失败' ? 'failed' : ''"
              >
                <span class="mono">分片 {{ shard.index }}</span>
                <span class="mono">{{ shard.partition }}</span>
                <span class="chip" :class="shard.status === '已确认' ? 'ok' : shard.status === '已失败' ? 'bad' : 'warn'">
                  {{ shard.status }}
                </span>
                <span>
                  {{ shard.rowCount }} 行{{ shard.confirmedAt ? ` · 确认于 ${shard.confirmedAt}` : '' }}
                </span>
              </div>
            </div>

            <div class="form-actions" style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 8px">
              <button
                class="btn primary"
                type="button"
                :disabled="!detail.batch.shards.some((shard) => shard.status === '待执行')"
                @click="handleRunShard(false)"
              >
                执行下一分片
              </button>
              <button
                class="btn"
                type="button"
                :disabled="!detail.batch.shards.some((shard) => shard.status === '待执行')"
                @click="handleRunShard(true)"
              >
                模拟分片失败
              </button>
              <button
                class="btn"
                type="button"
                :disabled="detail.batch.status !== '已失败'"
                @click="handleResume"
              >
                从已确认分片续跑
              </button>
              <button
                class="btn ghost"
                type="button"
                :disabled="detail.batch.status === '已确认' || detail.batch.status === '已终止'"
                @click="handleTerminate"
              >
                终止批次
              </button>
              <RouterLink
                class="btn"
                :to="{ path: '/datasync', query: { batch: detail.batch.batchNo } }"
              >
                引用本批次建立下游同步
              </RouterLink>
            </div>

            <p class="inline-note">
              续跑只清理失败分片及其后的待执行分片，已确认分片不重跑、命中行不重复追加。
            </p>

            <div v-if="detail.batch.resumeHistory.length" style="margin-top: 12px">
              <strong style="font-size: 13px">续跑记录</strong>
              <ul class="timeline" style="margin-top: 6px">
                <li v-for="(item, index) in detail.batch.resumeHistory" :key="index">
                  <strong>{{ item.at }} · 从分片 {{ item.fromShardIndex }} 续跑</strong>
                  {{ item.message }}
                </li>
              </ul>
            </div>
          </template>

          <template v-else-if="activeTab === 'groups'">
            <div class="group-grid">
              <div v-for="group in hitGroups" :key="group.key" class="group-panel">
                <header>
                  <div>
                    <h4>{{ group.title }}（{{ group.rows.length }}）</h4>
                    <p>{{ group.hint }}</p>
                  </div>
                  <span class="chip" :class="group.key === 'retained' ? 'ok' : group.key === 'superseded' ? 'warn' : 'bad'">
                    {{ group.rows.length }} 行
                  </span>
                </header>
                <div class="group-body">
                  <article
                    v-for="row in group.rows"
                    :key="row.sourceRowId"
                    class="hit-card"
                    :class="group.key"
                  >
                    <div class="hit-head">
                      <span class="hit-key">{{ row.businessKey }}</span>
                      <span class="chip" :class="group.key === 'retained' ? 'ok' : group.key === 'superseded' ? 'warn' : 'bad'">
                        {{ row.decision }}{{ row.retained ? ' · 保留' : ' · 不落库' }}
                      </span>
                    </div>
                    <div class="hit-values">
                      <span><em>源行</em> {{ row.sourceRowId }}</span>
                      <span><em>分区</em> {{ row.partition }}</span>
                      <span><em>水位</em> {{ row.updatedAt }}</span>
                      <span><em>分片</em> {{ row.shardIndex >= 0 ? row.shardIndex : '—' }}</span>
                    </div>
                    <div v-if="Object.keys(row.mappingValues).length" class="hit-values">
                      <span v-for="(value, key) in row.mappingValues" :key="key">
                        <em>{{ key }}</em> {{ value || '—' }}
                      </span>
                    </div>
                    <p class="hit-reason">{{ row.reason }}</p>
                  </article>
                  <p v-if="!group.rows.length" class="inline-note">没有命中该分组的源行</p>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="activeTab === 'keys'">
            <div class="table-wrap">
              <table class="data-table compact">
                <thead>
                  <tr>
                    <th>业务键</th>
                    <th>版本数</th>
                    <th>保留源行</th>
                    <th>保留水位</th>
                    <th>保留结果</th>
                    <th>各版本水位</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="group in detail.keyGroups" :key="group.businessKey">
                    <td class="mono">{{ group.businessKey }}</td>
                    <td>{{ group.duplicateCount }}</td>
                    <td>{{ group.retained?.sourceRowId ?? '—' }}</td>
                    <td>{{ group.retained?.updatedAt ?? '—' }}</td>
                    <td>
                      <span class="chip" :class="group.retainedLabel.includes('待执行') ? 'warn' : 'ok'">
                        {{ group.retainedLabel }}
                      </span>
                    </td>
                    <td class="mono">
                      <span v-for="(row, index) in group.versions" :key="row.sourceRowId">
                        {{ row.updatedAt }}（源行 {{ row.sourceRowId }}）{{ index < group.versions.length - 1 ? ' → ' : '' }}
                      </span>
                    </td>
                  </tr>
                  <tr v-if="!detail.keyGroups.length">
                    <td colspan="6" class="empty-state">水位与分区范围内没有命中的业务键</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>

          <template v-else>
            <div class="summary-strip">
              <div class="summary-item"><strong class="mono">{{ detail.batch.evidenceCode }}</strong>证据编号</div>
              <div class="summary-item"><strong>{{ detail.batch.mappingSnapshot.frozenAt }}</strong>证据冻结时间</div>
              <div class="summary-item"><strong>{{ detail.batch.watermark.timezone }}</strong>水位时区</div>
              <div class="summary-item"><strong>{{ detail.batch.watermark.includeStart ? '包含' : '不包含' }} / {{ detail.batch.watermark.includeEnd ? '包含' : '不包含' }}</strong>起止端点</div>
            </div>

            <div class="mapping-diff">
              <div class="mapping-card">
                <h4>本批次冻结的水位含义</h4>
                <dl class="kv-grid">
                  <div>
                    <dt>水位字段</dt>
                    <dd class="mono">{{ detail.batch.watermark.field }}</dd>
                  </div>
                  <div>
                    <dt>起止水位</dt>
                    <dd class="mono">{{ detail.batch.watermark.start }} ~ {{ detail.batch.watermark.end }}</dd>
                  </div>
                  <div>
                    <dt>分区边界</dt>
                    <dd class="mono">
                      {{ detail.batch.watermark.partitionField }}：
                      {{ detail.batch.watermark.partitionStart }} ~ {{ detail.batch.watermark.partitionEnd }}
                    </dd>
                  </div>
                  <div>
                    <dt>源表 / 目标表</dt>
                    <dd class="mono">{{ detail.batch.sourceTable }} → {{ detail.batch.targetTable }}</dd>
                  </div>
                </dl>
              </div>

              <div class="mapping-card">
                <h4>本批次冻结的字段映射（{{ detail.batch.mappingSnapshot.versionId }}）</h4>
                <ul>
                  <li v-for="field in detail.batch.mappingSnapshot.fields" :key="field.target">
                    {{ field.source }} → {{ field.target }}
                  </li>
                </ul>
              </div>

              <div class="mapping-card">
                <h4>
                  当前最新映射
                  <span v-if="detail.latestMapping" class="mono">{{ detail.latestMapping.id }}</span>
                </h4>
                <ul v-if="detail.latestMapping">
                  <li
                    v-for="field in detail.latestMapping.fields"
                    :key="field.target"
                    :class="{ added: mappingDelta.added.includes(field.source + '→' + field.target) }"
                  >
                    {{ field.source }} → {{ field.target }}
                  </li>
                </ul>
                <p class="inline-note">
                  {{ detail.mappingChanged ? '最新映射与冻结快照不同，但本批次仍按快照解释。' : '当前最新映射与本批次快照一致。' }}
                </p>
              </div>
            </div>

            <div v-if="detail.previousComparison" style="margin-top: 14px">
              <div class="section-head">
                <div>
                  <h4 style="margin: 0; font-size: 14px">
                    与上一批次 {{ detail.previousComparison.previousBatchNo }} 的保留结果差异
                  </h4>
                  <p>用于确认重复回放是否稳定：同键保留行是否发生变化。</p>
                </div>
              </div>
              <div class="summary-strip">
                <div class="summary-item"><strong>{{ detail.previousComparison.summary.same }}</strong>一致</div>
                <div class="summary-item"><strong>{{ detail.previousComparison.summary.changed }}</strong>保留变更</div>
                <div class="summary-item"><strong>{{ detail.previousComparison.summary.previousOnly }}</strong>仅上次</div>
                <div class="summary-item"><strong>{{ detail.previousComparison.summary.currentOnly }}</strong>仅本次</div>
              </div>
              <div class="table-wrap">
                <table class="data-table compact">
                  <thead>
                    <tr>
                      <th>业务键</th>
                      <th>上次保留行 / 水位</th>
                      <th>本次保留行 / 水位</th>
                      <th>结论</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in detail.previousComparison.rows" :key="row.businessKey">
                      <td class="mono">{{ row.businessKey }}</td>
                      <td>{{ row.previousRowId ?? '—' }}<br /><small>{{ row.previousUpdatedAt }}</small></td>
                      <td>{{ row.currentRowId ?? '—' }}<br /><small>{{ row.currentUpdatedAt }}</small></td>
                      <td>
                        <span class="chip" :class="row.change === '一致' ? 'ok' : row.change === '保留变更' ? 'warn' : 'info'">
                          {{ row.change }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>
        </section>

        <section class="section-block">
          <div class="section-head">
            <div>
              <h3>占用冲突记录</h3>
              <p>同一贴源表被并发占用时，后到批次不会创建，只留一条冲突说明。</p>
            </div>
            <span class="chip">{{ conflicts.length }} 条</span>
          </div>
          <ul class="timeline">
            <li v-for="(conflict, index) in conflicts" :key="index">
              <strong>{{ conflict.at }} · {{ conflict.attemptedBatchNo }} 被拒</strong>
              {{ conflict.message }}
            </li>
          </ul>
          <p v-if="!conflicts.length" class="inline-note">暂无冲突记录</p>
        </section>
      </div>
    </div>

    <section v-if="pageView === 'ledger'" class="section-block">
      <div class="section-head">
        <div>
          <h3>贴源表台账</h3>
          <p>原始登记信息与状态流转；回放批次以贴源层建模为主对象，可在「水位回放工作区」中发起。</p>
        </div>
        <span class="chip">{{ total }} 条</span>
      </div>
      <p v-for="item in statusSummary" :key="item.status" class="status-legend" style="margin: 0 0 8px">
        <span class="legend-item">{{ item.status }}：{{ item.count }}</span>
      </p>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>可执行动作</th>
              <th>回放</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in ledgerRows" :key="String(row.id)">
              <td v-for="column in ledgerColumns" :key="column">{{ row[column] ?? '—' }}</td>
              <td>{{ row.status }}</td>
              <td class="row-actions">
                <button
                  v-for="action in ledgerActions"
                  :key="action"
                  class="link"
                  type="button"
                  @click="runLedgerAction(action, row)"
                >
                  {{ action }}
                </button>
              </td>
              <td>
                <button class="link" type="button" @click="jumpToReplay(String(row['表编号'] ?? ''))">
                  查看回放批次
                </button>
              </td>
            </tr>
            <tr v-if="!ledgerRows.length">
              <td :colspan="ledgerColumns.length + 3" class="empty-state">暂无贴源层建模数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <footer class="page-foot">
      <span>共 {{ total }} 条贴源层建模记录 · 回放证据保存在本机浏览器</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  appendMappingVersion,
  createBatch,
  getBatchDetail,
  groupHitRows,
  listBatches,
  listConflicts,
  listMappingVersions,
  listReplayObjects,
  resumeBatch,
  runShard,
  terminateBatch,
} from '@/api/replay-service'
import type { BatchDetail, OdsReplayObject, ReplayBatch } from '@/data/replay-types'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'
import { useRoute } from 'vue-router'

const session = useSessionStore()
const route = useRoute()

const meta = moduleMeta('ods')
const tabs = [
  { key: 'shards', label: '分片与执行' },
  { key: 'groups', label: '命中结果分组' },
  { key: 'keys', label: '业务键保留' },
  { key: 'evidence', label: '冻结证据与比对' },
] as const
type TabKey = (typeof tabs)[number]['key']

const pageView = ref<'replay' | 'ledger'>('replay')
const total = ref(0)
const errorMessage = ref('')
const ledgerRows = ref<EntryRow[]>([])
const ledgerActions: string[] = ["提交校验", "启用同步", "停用同步"]
const ledgerColumns = ["表编号", "源表名称", "目标表名", "同步模式", "分区字段", "保留天数", "字段映射", "增量水位"]
const ledgerStatuses = ["草稿", "待校验", "已启用", "已停用"]
const objects = ref<OdsReplayObject[]>([])
const conflicts = ref<ReturnType<typeof listConflicts>>([])
const selectedOdsCode = ref('')
const selectedBatchNo = ref('')
const activeTab = ref<TabKey>('shards')
const createMessage = ref('')
const createTone = ref('ok')
const actionMessage = ref('')
const actionTone = ref('ok')
// 本地存储不是响应式的：动作完成后靠 revision 触发重算。
const revision = ref(0)

const form = reactive({
  startWatermark: '',
  endWatermark: '',
  partitionStart: '',
  partitionEnd: '',
  includeStart: true,
  includeEnd: true,
  mappingVersionId: '',
})

const selectedObject = computed(() => objects.value.find((item) => item.odsCode === selectedOdsCode.value) ?? null)
const tableBatches = computed(() => {
  void revision.value
  return selectedOdsCode.value ? listBatches(selectedOdsCode.value) : []
})
const mappingOptions = computed(() => {
  void revision.value
  return selectedOdsCode.value ? listMappingVersions(selectedOdsCode.value) : []
})
const detail = computed<BatchDetail | null>(() => {
  void revision.value
  return selectedBatchNo.value ? getBatchDetail(selectedBatchNo.value) : null
})
const hitGroups = computed(() => (detail.value ? groupHitRows(detail.value.batch) : []))
const mappingDelta = computed(() => {
  const added: string[] = []
  if (!detail.value?.latestMapping) {
    return { added }
  }
  const frozen = new Set(
    detail.value.batch.mappingSnapshot.fields.map((field) => `${field.source}→${field.target}`),
  )
  for (const field of detail.value.latestMapping.fields) {
    const pair = `${field.source}→${field.target}`
    if (!frozen.has(pair)) {
      added.push(pair)
    }
  }
  return { added }
})

const objectGroups = computed(() => {
  const locked = objects.value.filter((item) => item.lock !== null)
  const evidenced = objects.value.filter((item) => item.lock === null && item.confirmedCount > 0)
  const fresh = objects.value.filter((item) => item.lock === null && item.confirmedCount === 0)
  return [
    { key: 'locked', title: '占用中 · 只允许一个批次推进', hint: '其他批次必须等待或得到冲突说明', items: locked },
    { key: 'evidenced', title: '已有回放证据', hint: '存在已确认批次，可继续重复回放', items: evidenced },
    { key: 'fresh', title: '尚未回放', hint: '可发起首次水位回放', items: fresh },
  ]
})

const stats = computed(() => {
  void revision.value
  const allBatches = listBatches()
  const pending = allBatches.filter(
    (batch) => batch.status === '待执行' || batch.status === '运行中' || batch.status === '已失败',
  ).length
  const confirmed = allBatches.filter((batch) => batch.status === '已确认').length
  return [
    { label: '贴源表总数', value: objects.value.length },
    { label: '已确认批次', value: confirmed },
    { label: '推进中 / 失败批次', value: pending },
  ]
})

const statusSummary = computed(() =>
  ledgerStatuses.map((status) => ({
    status,
    count: ledgerRows.value.filter((row) => String(row.status) === status).length,
  })),
)

function runLedgerAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  loadLedger()
}

function loadLedger() {
  try {
    const payload = listEntries(meta.key, {})
    ledgerRows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '贴源层建模列表读取失败'
  }
}

function jumpToReplay(odsCode: string) {
  pageView.value = 'replay'
  if (objects.value.some((item) => item.odsCode === odsCode)) {
    selectObject(odsCode)
  }
}

function statusTone(status: string): string {
  if (status === '已确认') return 'ok'
  if (status === '已失败' || status === '已终止') return 'bad'
  if (status === '运行中') return 'info'
  return 'warn'
}

function confirmedShards(batch: ReplayBatch): number {
  return batch.shards.filter((shard) => shard.status === '已确认').length
}

function refresh(keepBatch = true) {
  revision.value += 1
  objects.value = listReplayObjects()
  conflicts.value = listConflicts()
  loadLedger()
  if (!objects.value.some((item) => item.odsCode === selectedOdsCode.value)) {
    selectedOdsCode.value = objects.value[0]?.odsCode ?? ''
    selectedBatchNo.value = ''
    resetForm()
  }
  if (!keepBatch) {
    selectedBatchNo.value = ''
  }
  if (!selectedBatchNo.value) {
    const batches = selectedOdsCode.value ? listBatches(selectedOdsCode.value) : []
    if (batches.length) {
      selectedBatchNo.value = batches[0].batchNo
    }
  }
}

function selectObject(odsCode: string) {
  selectedOdsCode.value = odsCode
  selectedBatchNo.value = ''
  createMessage.value = ''
  actionMessage.value = ''
  resetForm()
  const batches = listBatches(odsCode)
  if (batches.length) {
    selectedBatchNo.value = batches[0].batchNo
  }
}


function selectBatch(batchNo: string) {
  selectedBatchNo.value = batchNo
  activeTab.value = 'shards'
  actionMessage.value = ''
}

function resetForm() {
  const object = selectedObject.value
  if (!object) {
    return
  }
  form.startWatermark = object.minWatermark
  form.endWatermark = object.maxWatermark
  form.partitionStart = object.minPartition
  form.partitionEnd = object.maxPartition
  form.includeStart = true
  form.includeEnd = true
  form.mappingVersionId = object.latestMapping?.id ?? ''
}

function submitBatch() {
  const object = selectedObject.value
  if (!object) {
    return
  }
  const result = createBatch({
    odsCode: object.odsCode,
    operator: session.operator,
    startWatermark: form.startWatermark,
    endWatermark: form.endWatermark,
    partitionStart: form.partitionStart,
    partitionEnd: form.partitionEnd,
    includeStart: form.includeStart,
    includeEnd: form.includeEnd,
    mappingVersionId: form.mappingVersionId,
  })
  createTone.value = result.ok ? 'ok' : result.conflict ? 'warn' : 'bad'
  createMessage.value = result.message
  if (result.ok) {
    selectedBatchNo.value = result.batch.batchNo
    activeTab.value = 'shards'
    refresh()
    selectedBatchNo.value = result.batch.batchNo
  } else {
    refresh()
  }
}

function handleAppendMapping() {
  const object = selectedObject.value
  if (!object) {
    return
  }
  const result = appendMappingVersion(object.odsCode, session.operator)
  createTone.value = result.ok ? 'ok' : 'bad'
  createMessage.value = result.message
  refresh()
}

function runActionWithFeedback(run: () => { ok: boolean; message: string }) {
  const result = run()
  actionTone.value = result.ok ? 'ok' : 'bad'
  actionMessage.value = result.message
  refresh()
}

function handleRunShard(fail: boolean) {
  if (!selectedBatchNo.value) {
    return
  }
  runActionWithFeedback(() => runShard(selectedBatchNo.value, fail))
}

function handleResume() {
  if (!selectedBatchNo.value) {
    return
  }
  runActionWithFeedback(() => resumeBatch(selectedBatchNo.value))
}

function handleTerminate() {
  if (!selectedBatchNo.value) {
    return
  }
  runActionWithFeedback(() => terminateBatch(selectedBatchNo.value))
}

function exportRows() {
  downloadEntries(meta.key)
}

onMounted(() => {
  const odsCode = String(route.query.ods ?? '')
  const batchNo = String(route.query.batch ?? '')
  refresh()
  if (odsCode && objects.value.some((item) => item.odsCode === odsCode)) {
    selectedOdsCode.value = odsCode
    resetForm()
  }
  if (batchNo && listBatches(selectedOdsCode.value).some((batch) => batch.batchNo === batchNo)) {
    selectedBatchNo.value = batchNo
  }
})
</script>
