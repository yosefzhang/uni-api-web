// 模型别名管理：集中管理所有渠道的别名映射（模型别名 / 映射模型 / 优先级三列）
// 优先级复用原生 api key model 规则顺序（Provider/alias 精确规则 + all 兜底），零后端改动
"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as yaml from "js-yaml"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowDown, ArrowUp, Layers, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { rowsToModel } from "@/components/online-config/fields"

interface ModelAliasManagerProps {
  apiKey: string
}

type AliasRow = {
  id: number
  alias: string
  upstream: string
  provider: string
  providerIndex: number
  itemIndex: number
  isPlain: boolean
}

type ProviderMeta = {
  provider: string
  models?: { original: string; display: string }[]
}

/** 弹窗中的一行映射表单 */
type MappingForm = {
  key: number
  priority: string
  provider: string
  upstream: string
}

// 解析 api key 的 model 规则：
// editable = 空/["all"] 或全部规则均为 Provider/alias 精确形式（可由页面重建）
// 否则（通配、子 key 引用、权重对象等）只读，避免破坏原语义
function analyzeKeyRules(rules: unknown): { editable: boolean; overrides: Record<string, string[]> } {
  const list = (Array.isArray(rules) ? rules : [])
    .map((r) => String(r ?? "").trim())
    .filter(Boolean)
  if (list.length === 0 || (list.length === 1 && list[0] === "all")) {
    return { editable: true, overrides: {} }
  }
  const overrides: Record<string, string[]> = {}
  for (const rule of list) {
    if (rule === "all") continue
    const match = /^([^/]+)\/([^/*]+)$/.exec(rule)
    if (!match) return { editable: false, overrides: {} }
    const [, provider, alias] = match
    ;(overrides[alias] ||= []).push(provider)
  }
  return { editable: true, overrides }
}

export function ModelAliasManager({ apiKey }: ModelAliasManagerProps) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<any>({})
  const [providersMeta, setProvidersMeta] = useState<ProviderMeta[]>([])
  const [rows, setRows] = useState<AliasRow[]>([])
  const [orderOverrides, setOrderOverrides] = useState<Record<string, string[]>>({})
  const [selectedKeyValue, setSelectedKeyValue] = useState<string>("")
  const nextIdRef = useRef(1)

  // 行编辑弹窗（按别名分组编辑）
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAlias, setEditingAlias] = useState<string | null>(null)
  const [formAlias, setFormAlias] = useState("")
  const [formMappings, setFormMappings] = useState<MappingForm[]>([])

  const nextId = () => nextIdRef.current++

  // ----- 加载 -----
  const load = useCallback(async () => {
    if (!apiKey) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [configRes, providersRes] = await Promise.all([
        fetch(`/api/config/load?apiKey=${encodeURIComponent(apiKey)}`),
        fetch(`/api/providers/list?apiKey=${encodeURIComponent(apiKey)}`),
      ])
      const configData = await configRes.json().catch(() => ({}))
      if (!configRes.ok) throw new Error(configData.error || `HTTP ${configRes.status}`)
      const providersData = providersRes.ok ? await providersRes.json().catch(() => ({})) : {}
      const parsed = (yaml.load(configData.config || "") as any) || {}
      setConfig(parsed)
      setProvidersMeta(providersData.providers || [])
      const expanded: AliasRow[] = []
      const providers = Array.isArray(parsed?.providers) ? parsed.providers : []
      providers.forEach((p: any, pi: number) => {
        const name = String(p?.provider ?? "")
        const model = Array.isArray(p?.model) ? p.model : []
        model.forEach((item: any, mi: number) => {
          if (typeof item === "string") {
            expanded.push({ id: nextId(), alias: item, upstream: item, provider: name, providerIndex: pi, itemIndex: mi, isPlain: true })
          } else if (item && typeof item === "object") {
            const entry = Object.entries(item)[0]
            if (!entry) return
            expanded.push({
              id: nextId(),
              alias: entry[1] == null ? "" : String(entry[1]),
              upstream: String(entry[0]),
              provider: name,
              providerIndex: pi,
              itemIndex: mi,
              isPlain: false,
            })
          }
        })
      })
      setRows(expanded)
      setOrderOverrides({})
    } catch (e: any) {
      toast({ title: "加载失败", description: e.message || "无法加载配置", variant: "destructive" })
      setConfig({})
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [apiKey, toast])

  useEffect(() => {
    load()
  }, [load])

  // ----- 数据访问 -----
  const providers: any[] = Array.isArray(config?.providers) ? config.providers : []
  const apiKeys: any[] = Array.isArray(config?.api_keys) ? config.api_keys : []

  // 默认选中当前登录 key，否则第一个 key
  const effectiveKeyValue =
    selectedKeyValue ||
    (apiKeys.find((k) => String(k?.api) === apiKey) ? String(apiKeys.find((k) => String(k?.api) === apiKey)?.api) : apiKeys.length > 0 ? String(apiKeys[0]?.api) : "")
  const selectedKeyIndex = apiKeys.findIndex((k) => String(k?.api) === effectiveKeyValue)
  const keyAnalysis = useMemo(
    () => analyzeKeyRules(selectedKeyIndex >= 0 ? apiKeys[selectedKeyIndex]?.model : undefined),
    [selectedKeyIndex, apiKeys],
  )
  const keyEditable = keyAnalysis.editable

  // 选择 key 时恢复其已有精确规则顺序
  useEffect(() => {
    if (keyEditable) setOrderOverrides(keyAnalysis.overrides)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKeyValue])

  // ----- 分组与排序 -----
  const groups = useMemo(() => {
    const byAlias = new Map<string, AliasRow[]>()
    for (const row of rows) {
      const alias = row.alias.trim() || row.upstream.trim()
      if (!alias) continue
      const list = byAlias.get(alias)
      if (list) list.push(row)
      else byAlias.set(alias, [row])
    }
    return byAlias
  }, [rows])

  // 组内有效顺序：override 中列出的渠道在前，其余按渠道在 yaml 中的顺序
  const sortGroup = useCallback((alias: string, groupRows: AliasRow[]): AliasRow[] => {
    const override = orderOverrides[alias] || []
    const rank = (r: AliasRow) => {
      const i = override.indexOf(r.provider)
      return i === -1 ? override.length + r.providerIndex : i
    }
    return groupRows.slice().sort((a, b) => rank(a) - rank(b) || a.providerIndex - b.providerIndex || a.itemIndex - b.itemIndex)
  }, [orderOverrides])

  const sortedAliases = useMemo(() => Array.from(groups.keys()).sort((a, b) => a.localeCompare(b)), [groups])

  // ----- 重复检测：同渠道同别名 -----
  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>()
    const dup = new Set<string>()
    for (const row of rows) {
      const alias = row.alias.trim() || row.upstream.trim()
      const key = `${row.provider}\u0000${alias}`
      if (seen.has(key)) dup.add(key)
      else seen.add(key)
    }
    return dup
  }, [rows])
  const isDuplicate = (row: AliasRow) => duplicateKeys.has(`${row.provider}\u0000${row.alias.trim() || row.upstream.trim()}`)

  // ----- 行操作 -----
  const openAdd = () => {
    setEditingAlias(null)
    setFormAlias("")
    setFormMappings([{ key: nextId(), priority: "1", provider: "", upstream: "" }])
    setDialogOpen(true)
  }

  const openEdit = (row: AliasRow) => {
    const alias = row.alias.trim() || row.upstream.trim()
    const groupRows = sortGroup(alias, groups.get(alias) || [])
    setEditingAlias(alias)
    setFormAlias(alias)
    setFormMappings(
      groupRows.map((r, i) => ({ key: nextId(), priority: String(i + 1), provider: r.provider, upstream: r.upstream })),
    )
    setDialogOpen(true)
  }

  const updateMapping = (key: number, patch: Partial<MappingForm>) => {
    setFormMappings((prev) => prev.map((m) => (m.key === key ? { ...m, ...patch } : m)))
  }

  const addMappingRow = () => {
    setFormMappings((prev) => [
      ...prev,
      { key: nextId(), priority: String(prev.length + 1), provider: "", upstream: "" },
    ])
  }

  const removeMappingRow = (key: number) => {
    setFormMappings((prev) => (prev.length > 1 ? prev.filter((m) => m.key !== key) : prev))
  }

  // 别名重名检测：新增时与所有现有别名比较，编辑时排除自身
  const aliasDuplicate = useMemo(() => {
    const alias = formAlias.trim()
    if (!alias || alias === editingAlias) return false
    return groups.has(alias)
  }, [formAlias, editingAlias, groups])

  // 指定供应商的可用模型列表（优先取 /api/providers/list，回退到 yaml 配置）
  const modelOptionsFor = useCallback(
    (providerName: string): string[] => {
      const fromMeta = providersMeta.find((p) => p.provider === providerName)?.models?.map((m) => m.original) || []
      if (fromMeta.length > 0) return Array.from(new Set(fromMeta))
      const provider = providers.find((p) => String(p?.provider) === providerName)
      const model = Array.isArray(provider?.model) ? provider.model : []
      return Array.from(
        new Set(
          model
            .map((item: any) => (typeof item === "string" ? item : Object.keys(item || {})[0]))
            .filter(Boolean) as string[],
        ),
      )
    },
    [providersMeta, providers],
  )

  const handleDialogSave = () => {
    const alias = formAlias.trim()
    if (!alias) {
      toast({ title: "请填写别名", description: "模型别名不能为空", variant: "destructive" })
      return
    }
    if (aliasDuplicate) {
      toast({ title: "别名重复", description: `别名「${alias}」已存在，请换一个名称`, variant: "destructive" })
      return
    }
    const entries = formMappings
      .map((m) => ({ ...m, priorityNumber: Number.parseInt(m.priority, 10) }))
      .sort((a, b) => a.priorityNumber - b.priorityNumber)
    if (entries.length === 0) {
      toast({ title: "请添加映射", description: "至少需要一组映射模型", variant: "destructive" })
      return
    }
    const invalid = entries.some(
      (m) => !m.provider || !m.upstream.trim() || !Number.isFinite(m.priorityNumber) || m.priorityNumber < 1,
    )
    if (invalid) {
      toast({ title: "请完整填写", description: "每组映射的优先级、供应商与模型名均不能为空", variant: "destructive" })
      return
    }
    const providersInGroup = entries.map((m) => m.provider)
    if (new Set(providersInGroup).size !== providersInGroup.length) {
      toast({ title: "供应商重复", description: "同一别名下不能配置重复的供应商", variant: "destructive" })
      return
    }
    if (new Set(entries.map((m) => m.priorityNumber)).size !== entries.length) {
      toast({ title: "优先级重复", description: "每组映射的优先级不能重复", variant: "destructive" })
      return
    }

    // 编辑时按 供应商+模型 复用原行（保留 itemIndex/isPlain），保证写回顺序稳定
    const existingByKey = new Map(
      (editingAlias ? groups.get(editingAlias) || [] : []).map((r) => [`${r.provider}\u0000${r.upstream}`, r]),
    )
    const newRows: AliasRow[] = entries.map((m, i) => {
      const upstream = m.upstream.trim()
      const existing = existingByKey.get(`${m.provider}\u0000${upstream}`)
      if (existing) return { ...existing, alias, upstream }
      return {
        id: nextId(),
        alias,
        upstream,
        provider: m.provider,
        providerIndex: providers.findIndex((p) => String(p?.provider) === m.provider),
        itemIndex: 1_000_000 + rows.length + i,
        isPlain: false,
      }
    })

    setRows((prev) => [
      ...(editingAlias ? prev.filter((r) => (r.alias.trim() || r.upstream.trim()) !== editingAlias) : prev),
      ...newRows,
    ])
    if (keyEditable) {
      setOrderOverrides((prev) => {
        const next = { ...prev }
        if (editingAlias) delete next[editingAlias]
        next[alias] = newRows.map((r) => r.provider)
        return next
      })
    }
    setDialogOpen(false)
  }

  const handleDelete = (row: AliasRow) => {
    setRows((prev) => prev.filter((r) => r.id !== row.id))
  }

  const handleMove = (alias: string, index: number, dir: -1 | 1) => {
    const groupRows = sortGroup(alias, groups.get(alias) || [])
    const target = index + dir
    if (target < 0 || target >= groupRows.length) return
    const swapped = groupRows.slice()
    ;[swapped[index], swapped[target]] = [swapped[target], swapped[index]]
    setOrderOverrides((prev) => ({ ...prev, [alias]: swapped.map((r) => r.provider) }))
  }

  // ----- 保存 -----
  const persist = async () => {
    setSaving(true)
    try {
      const copy = structuredClone(config || {})
      // 按 providerIndex + itemIndex 原序重建各渠道的 model 数组（严禁全局排序）
      const byProvider = new Map<number, AliasRow[]>()
      for (const row of rows) {
        if (row.alias.trim() || row.upstream.trim()) {
          const list = byProvider.get(row.providerIndex)
          if (list) list.push(row)
          else byProvider.set(row.providerIndex, [row])
        }
      }
      for (let pi = 0; pi < (copy.providers?.length || 0); pi++) {
        const list = (byProvider.get(pi) || []).slice().sort((a, b) => a.itemIndex - b.itemIndex)
        copy.providers[pi].model = rowsToModel(list.map((r) => ({ upstream: r.upstream, alias: r.isPlain ? "" : r.alias })))
      }
      // 更新目标 key 的 model 规则（仅可编辑 key）
      if (keyEditable && selectedKeyIndex >= 0) {
        const rules: string[] = []
        for (const alias of sortedAliases) {
          const groupRows = groups.get(alias) || []
          if (groupRows.length < 2) continue
          const effective = sortGroup(alias, groupRows).map((r) => r.provider)
          const def = groupRows.slice().sort((a, b) => a.providerIndex - b.providerIndex || a.itemIndex - b.itemIndex).map((r) => r.provider)
          if (effective.join("\u0000") !== def.join("\u0000")) {
            for (const p of effective) rules.push(`${p}/${alias}`)
          }
        }
        if (rules.length > 0) rules.push("all")
        copy.api_keys[selectedKeyIndex].model = rules
      }
      const ordered: any = {}
      if (copy.providers) ordered.providers = copy.providers
      if (copy.api_keys) ordered.api_keys = copy.api_keys
      if (copy.preferences) ordered.preferences = copy.preferences
      for (const k of Object.keys(copy)) {
        if (!["providers", "api_keys", "preferences"].includes(k)) ordered[k] = copy[k]
      }
      const yamlStr = yaml.dump(ordered, { indent: 2, lineWidth: 100, noRefs: true })
      const res = await fetch("/api/config/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, config: yamlStr }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      toast({ title: "保存成功", description: "api.yaml 已保存，约 2 秒内热重载生效。" })
      await load()
    } catch (e: any) {
      toast({ title: "保存失败", description: e.message || "未知错误", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            模型别名管理
          </CardTitle>
          <CardDescription>
            集中管理各渠道的模型别名映射。同一别名可挂多个渠道实现聚合与故障转移；
            优先级通过所选 API Key 的 model 规则顺序实现（Provider/别名 + all 兜底），权限语义不变。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="key-select">API Key</Label>
              <Select value={effectiveKeyValue} onValueChange={setSelectedKeyValue}>
                <SelectTrigger id="key-select" className="w-64">
                  <SelectValue placeholder="选择 API Key" />
                </SelectTrigger>
                <SelectContent>
                  {apiKeys.map((k, i) => {
                    const value = String(k?.api)
                    const analysis = analyzeKeyRules(k?.model)
                    return (
                      <SelectItem key={i} value={value} disabled={k?.enabled === false}>
                        <span className="font-mono text-xs">
                          {value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value}
                        </span>
                        <Badge variant={analysis.editable ? "secondary" : "outline"} className="ml-2">
                          {analysis.editable ? "可调优先级" : "自定义规则(只读)"}
                        </Badge>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1" />
            <Button variant="outline" size="sm" onClick={() => load()}>
              <RefreshCw className="w-4 h-4 mr-2" />
              重新加载
            </Button>
            <Button variant="outline" size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4 mr-2" />
              新增映射
            </Button>
            <Button variant="outline" size="sm" onClick={persist} disabled={saving || duplicateKeys.size > 0}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? "保存中..." : "保存"}
            </Button>
          </div>
          {!keyEditable && (
            <p className="text-sm text-muted-foreground">
              该 Key 含自定义路由规则（通配/子 Key/权重），优先级列为只读，请改用 YAML 编辑。
            </p>
          )}
          {duplicateKeys.size > 0 && (
            <p className="text-sm text-red-600 dark:text-red-400">
              存在 {duplicateKeys.size} 组同渠道同别名重复（运行时后写覆盖前者），已禁止保存，请先修正标红行。
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">暂无别名映射，点击「新增映射」创建。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">模型别名</TableHead>
                  <TableHead className="w-full whitespace-nowrap">映射模型（优先级 - 渠道 / 模型）</TableHead>
                  <TableHead className="text-right whitespace-nowrap">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedAliases.map((alias) => {
                  const groupRows = sortGroup(alias, groups.get(alias) || [])
                  const groupDup = groupRows.some(isDuplicate)
                  return (
                    <TableRow key={alias} className={groupDup ? "bg-red-50 dark:bg-red-900/20" : undefined}>
                      <TableCell
                        className={`align-top whitespace-nowrap font-medium leading-9 ${
                          groupDup ? "text-red-600 dark:text-red-400" : ""
                        }`}
                      >
                        {alias}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-col">
                          {groupRows.map((row, index) => (
                            <div key={row.id} className="flex h-9 items-center gap-2 whitespace-nowrap">
                              <span className="w-5 text-right text-sm text-muted-foreground">{index + 1}</span>
                              <span className="text-muted-foreground">-</span>
                              <span className="font-medium">{row.provider}</span>
                              {providers[row.providerIndex]?.enabled === false && (
                                <Badge variant="outline">已停用</Badge>
                              )}
                              <span className="text-muted-foreground">/</span>
                              <span className="font-mono text-sm">{row.upstream}</span>
                              {row.isPlain && <span className="text-xs text-muted-foreground">(同名直通)</span>}
                              {isDuplicate(row) && <span className="text-xs text-red-600 dark:text-red-400">重复</span>}
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="flex flex-col items-end">
                          {groupRows.map((row, index) => (
                            <div key={row.id} className="flex h-9 items-center justify-end gap-1">
                              {keyEditable && groupRows.length > 1 && (
                                <>
                                  <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === 0} onClick={() => handleMove(alias, index, -1)}>
                                    <ArrowUp className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-6 w-6" disabled={index === groupRows.length - 1} onClick={() => handleMove(alias, index, 1)}>
                                    <ArrowDown className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              )}
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(row)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleDelete(row)}>
                                <Trash2 className="h-3.5 w-3.5 text-red-500" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新增/编辑弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingAlias ? `编辑别名「${editingAlias}」` : "新增映射"}</DialogTitle>
            <DialogDescription>
              配置对外别名与实际渠道模型的映射关系，可为一个别名配置多组映射模型。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="alias-input">模型别名（对外名称）</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="alias-input"
                  value={formAlias}
                  onChange={(e) => setFormAlias(e.target.value)}
                  placeholder="如 test"
                  className={aliasDuplicate ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {aliasDuplicate && <X className="h-5 w-5 shrink-0 text-red-500" aria-label="别名重复" />}
              </div>
              {aliasDuplicate && <p className="text-xs text-red-600 dark:text-red-400">该别名已存在</p>}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>映射模型</Label>
                <Button variant="outline" size="sm" onClick={addMappingRow}>
                  <Plus className="w-4 h-4 mr-2" />
                  添加映射
                </Button>
              </div>
              <div className="grid grid-cols-[4.5rem_1fr_1fr_2rem] items-center gap-2 text-xs text-muted-foreground">
                <span className="text-center">优先级</span>
                <span>供应商</span>
                <span>模型名</span>
                <span />
              </div>
              <div className="space-y-2">
                {formMappings.map((m) => {
                  const options = m.provider ? modelOptionsFor(m.provider) : []
                  return (
                    <div key={m.key} className="grid grid-cols-[4.5rem_1fr_1fr_2rem] items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        value={m.priority}
                        onChange={(e) => updateMapping(m.key, { priority: e.target.value })}
                        className="text-center"
                        aria-label="优先级"
                      />
                      <Select
                        value={m.provider}
                        onValueChange={(value) => updateMapping(m.key, { provider: value, upstream: "" })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="选择供应商" />
                        </SelectTrigger>
                        <SelectContent>
                          {providers.map((p, i) => (
                            <SelectItem key={i} value={String(p?.provider ?? "")} disabled={p?.enabled === false}>
                              {String(p?.provider ?? "")}
                              {p?.enabled === false ? "（已停用）" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={m.upstream}
                        onValueChange={(value) => updateMapping(m.key, { upstream: value })}
                        disabled={!m.provider || options.length === 0}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={m.provider ? "选择模型名" : "请先选供应商"} />
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => removeMappingRow(m.key)}
                        disabled={formMappings.length <= 1}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">优先级数字越小越优先（1 为最高）。</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleDialogSave}>{editingAlias ? "保存修改" : "添加"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
