// 在线配置主组件：三大分类（API 密钥 / Providers / 全局配置）列表 + 弹窗编辑
"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { RefreshCw, Plus, Server, KeyRound, SlidersHorizontal, Pencil, Trash2 } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import yaml from "js-yaml"
import { ProviderDialog, type ProviderItem } from "./provider-form"
import { ApiKeyDialog, type ApiKeyItem } from "./api-key-form"
import { modelToRows } from "./fields"
import {
  PreferencesDialog,
  PreferenceItemDialog,
  PREFERENCE_FIELDS,
  formatPreferenceValue,
  type PreferenceFieldMeta,
} from "./preferences-form"

interface OnlineConfigProps {
  apiKey: string
}

const MODEL_COLLAPSE_LIMIT = 5

// model 列表单元格：渠道模型ID / 映射模型ID 两列表格，默认最多展示 5 行，超出可展开/收起
function ModelListCell({ model }: { model?: any[] }) {
  const [expanded, setExpanded] = useState(false)
  const rows = modelToRows(model)
  if (rows.length === 0) {
    return <span className="text-xs text-muted-foreground">（自动获取全部模型）</span>
  }
  const showAll = expanded || rows.length <= MODEL_COLLAPSE_LIMIT
  const visible = showAll ? rows : rows.slice(0, MODEL_COLLAPSE_LIMIT)
  return (
    <div className="space-y-1">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-auto bg-muted px-3 py-2 text-xs font-bold text-foreground whitespace-nowrap">
              渠道模型ID
            </TableHead>
            <TableHead className="h-auto bg-muted px-3 py-2 text-xs font-bold text-foreground whitespace-nowrap">
              映射模型ID
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((r, idx) => (
            <TableRow key={idx} className="hover:bg-transparent">
              <TableCell className="border-t px-3 py-1.5 text-xs break-all align-top">
                {r.upstream}
              </TableCell>
              <TableCell className="border-t px-3 py-1.5 text-xs break-all align-top text-muted-foreground">
                {r.alias || "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > MODEL_COLLAPSE_LIMIT && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? `收起（共 ${rows.length} 项）` : `展开（共 ${rows.length} 项）`}
        </Button>
      )}
    </div>
  )
}

export function OnlineConfig({ apiKey }: OnlineConfigProps) {
  const [config, setConfig] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState("providers")
  const { toast } = useToast()

  // 弹窗状态
  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null)
  const [providerIndex, setProviderIndex] = useState<number>(-1)

  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)
  const [editingApiKey, setEditingApiKey] = useState<ApiKeyItem | null>(null)
  const [apiKeyIndex, setApiKeyIndex] = useState<number>(-1)

  const [prefsDialogOpen, setPrefsDialogOpen] = useState(false)
  const [prefItemOpen, setPrefItemOpen] = useState(false)
  const [prefItemField, setPrefItemField] = useState<PreferenceFieldMeta | null>(null)

  const loadConfig = useCallback(async () => {
    if (!apiKey) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`/api/config/load?apiKey=${encodeURIComponent(apiKey)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const yamlStr: string = data.config || ""
      try {
        const parsed = (yaml.load(yamlStr) as any) || {}
        setConfig(parsed)
      } catch (e: any) {
        throw new Error(`YAML 解析失败: ${e.message}`)
      }
    } catch (e: any) {
      toast({ title: "加载失败", description: e.message || "无法加载配置", variant: "destructive" })
      setConfig({})
    } finally {
      setLoading(false)
    }
  }, [apiKey, toast])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  // ----- 数据访问 -----
  const providers: ProviderItem[] = Array.isArray(config?.providers) ? config.providers : []
  const apiKeys: ApiKeyItem[] = Array.isArray(config?.api_keys) ? config.api_keys : []
  const preferences: any = config?.preferences

  // ----- Provider 弹窗操作 -----
  const openAddProvider = () => {
    setEditingProvider(null)
    setProviderIndex(-1)
    setProviderDialogOpen(true)
  }
  const openEditProvider = (item: ProviderItem, index: number) => {
    setEditingProvider(item)
    setProviderIndex(index)
    setProviderDialogOpen(true)
  }
  const handleProviderSave = (item: ProviderItem) => {
    const list = Array.isArray(config?.providers) ? config.providers.slice() : []
    if (providerIndex >= 0) {
      list[providerIndex] = item
    } else {
      list.push(item)
    }
    const next = { ...(config || {}), providers: list }
    setConfig(next)
    void persist(next)
  }
  const handleProviderDelete = (index: number) => {
    const list = providers.filter((_, i) => i !== index)
    const next = { ...(config || {}), providers: list }
    setConfig(next)
    void persist(next)
  }

  // ----- API Key 弹窗操作 -----
  const openAddApiKey = () => {
    setEditingApiKey(null)
    setApiKeyIndex(-1)
    setApiKeyDialogOpen(true)
  }
  const openEditApiKey = (item: ApiKeyItem, index: number) => {
    setEditingApiKey(item)
    setApiKeyIndex(index)
    setApiKeyDialogOpen(true)
  }
  const handleApiKeySave = (item: ApiKeyItem) => {
    const list = Array.isArray(config?.api_keys) ? config.api_keys.slice() : []
    if (apiKeyIndex >= 0) {
      list[apiKeyIndex] = item
    } else {
      list.push(item)
    }
    const next = { ...(config || {}), api_keys: list }
    setConfig(next)
    void persist(next)
  }
  const handleApiKeyDelete = (index: number) => {
    const list = apiKeys.filter((_, i) => i !== index)
    const next = { ...(config || {}), api_keys: list }
    setConfig(next)
    void persist(next)
  }

  // ----- Preferences 弹窗操作 -----
  const openEditPrefs = () => {
    setPrefsDialogOpen(true)
  }
  const handlePrefsSave = (prefs: any) => {
    const copy = { ...(config || {}) }
    if (prefs && Object.keys(prefs).length > 0) {
      copy.preferences = prefs
    } else {
      delete copy.preferences
    }
    setConfig(copy)
    void persist(copy)
  }

  const openEditPrefItem = (field: PreferenceFieldMeta) => {
    setPrefItemField(field)
    setPrefItemOpen(true)
  }
  const handlePrefItemSave = (key: string, value: any) => {
    const copy = { ...(config || {}) }
    const prefs = { ...(copy.preferences || {}) }
    if (value == null) {
      delete prefs[key]
    } else {
      prefs[key] = value
    }
    if (Object.keys(prefs).length > 0) {
      copy.preferences = prefs
    } else {
      delete copy.preferences
    }
    setConfig(copy)
    void persist(copy)
  }

  // ----- 保存（序列化并写入 api.yaml）-----
  const persist = async (cfg: any) => {
    setSaving(true)
    try {
      const ordered: any = {}
      if (cfg.providers) ordered.providers = cfg.providers
      if (cfg.api_keys) ordered.api_keys = cfg.api_keys
      if (cfg.preferences) ordered.preferences = cfg.preferences
      for (const k of Object.keys(cfg)) {
        if (!["providers", "api_keys", "preferences"].includes(k)) {
          ordered[k] = cfg[k]
        }
      }
      const yamlStr = yaml.dump(ordered, { indent: 2, lineWidth: 100, noRefs: true })
      const res = await fetch("/api/config/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, config: yamlStr }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      toast({ title: "保存成功", description: "api.yaml 已写入磁盘，请按需重启 uni-api 让新配置生效。" })
    } catch (e: any) {
      toast({ title: "保存失败", description: e.message || "未知错误", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    await loadConfig()
    toast({ title: "已重新加载", description: "已撤销未保存的本地修改。" })
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <Skeleton className="h-[400px] w-full" />
      </div>
    )
  }

  // 渲染 model 列表为可读字符串
  const renderModel = (model: any[]): string => {
    if (!Array.isArray(model) || model.length === 0) return "（自动获取全部模型）"
    return model.slice(0, 3).map((m: any) => {
      if (typeof m === "string") return m
      const [[k, v]] = Object.entries(m)
      return `${k}: ${v}`
    }).join("，") + (model.length > 3 ? ` …（共 ${model.length} 项）` : "")
  }

  // ApiKey 表格行（配置项 -> 值），仅显示已配置字段
  const apiKeyRows = (k: ApiKeyItem): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = []
    rows.push({ label: "model", value: renderModel(k.model) })
    const prefs = k.preferences || {}
    if (prefs.SCHEDULING_ALGORITHM) rows.push({ label: "SCHEDULING_ALGORITHM", value: String(prefs.SCHEDULING_ALGORITHM) })
    if (prefs.AUTO_RETRY != null) rows.push({ label: "AUTO_RETRY", value: String(prefs.AUTO_RETRY) })
    if (prefs.rate_limit) rows.push({ label: "rate_limit", value: String(prefs.rate_limit) })
    if (prefs.ENABLE_MODERATION != null) rows.push({ label: "ENABLE_MODERATION", value: prefs.ENABLE_MODERATION ? "开启" : "关闭" })
    if (prefs.credits != null) rows.push({ label: "credits", value: String(prefs.credits) })
    if (prefs.created_at) rows.push({ label: "created_at", value: String(prefs.created_at) })
    return rows
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* 头部 */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">在线配置</h2>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={reload} disabled={saving}>
              <RefreshCw className="w-4 h-4 mr-2" />
              重新加载
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex items-center justify-between gap-3">
            <TabsList className="bg-transparent p-0 h-auto">
              <TabsTrigger value="providers" className="flex-1 md:flex-none">
                <Server className="w-4 h-4 mr-2" />
                Providers
                <Badge variant="secondary" className="ml-2">{providers.length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="api_keys" className="flex-1 md:flex-none">
                <KeyRound className="w-4 h-4 mr-2" />
                API 密钥
                <Badge variant="secondary" className="ml-2">{apiKeys.length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="preferences" className="flex-1 md:flex-none">
                <SlidersHorizontal className="w-4 h-4 mr-2" />
                全局配置
              </TabsTrigger>
            </TabsList>
            {activeTab === "providers" && (
              <Button variant="outline" size="sm" onClick={openAddProvider}>
                <Plus className="w-4 h-4 mr-2" />
                新增渠道
              </Button>
            )}
            {activeTab === "api_keys" && (
              <Button variant="outline" size="sm" onClick={openAddApiKey}>
                <Plus className="w-4 h-4 mr-2" />
                新增 API Key
              </Button>
            )}
            {activeTab === "preferences" && (
              <Button variant="outline" size="sm" onClick={openEditPrefs}>
                <Pencil className="w-4 h-4 mr-2" />
                编辑
              </Button>
            )}
          </div>

          {/* ---------- Providers Tab ---------- */}
          <TabsContent value="providers" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2 items-start">
            {providers.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="p-8 text-center text-muted-foreground">
                  暂无 providers，点击右上角【新增渠道】开始配置。
                </CardContent>
              </Card>
            ) : (
              providers.map((p, i) => (
                <Card key={i} className="border">
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <Badge variant="outline">#{i + 1}</Badge>
                        <span className="font-medium">{p.provider || "未命名"}</span>
                        {p.engine && <Badge variant="secondary">{p.engine}</Badge>}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditProvider(p, i)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => handleProviderDelete(i)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <div className="px-4 py-3">
                      <ModelListCell model={p.model} />
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          {/* ---------- API Keys Tab ---------- */}
          <TabsContent value="api_keys" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-2 items-start">
            {apiKeys.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="p-8 text-center text-muted-foreground">
                  暂无 api_keys，点击右上角【新增 API Key】。
                </CardContent>
              </Card>
            ) : (
              apiKeys.map((k, i) => (
                <Card key={i} className="border">
                  <CardContent className="p-0">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <Badge variant="outline">#{i + 1}</Badge>
                        <span className="font-mono text-sm break-all">{k.api || "未设置"}</span>
                        {k.role === "admin" && <Badge>admin</Badge>}
                        {k.preferences?.SCHEDULING_ALGORITHM && (
                          <Badge variant="secondary">{k.preferences.SCHEDULING_ALGORITHM}</Badge>
                        )}
                      </div>
                      <div className="flex gap-1 shrink-0">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditApiKey(k, i)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => handleApiKeyDelete(i)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <Table>
                      <TableBody>
                        {apiKeyRows(k).map((r) => (
                          <TableRow key={r.label}>
                            <TableCell className="w-[220px] font-mono text-xs">{r.label}</TableCell>
                            <TableCell className="text-xs break-all">{r.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          {/* ---------- Preferences Tab ---------- */}
          <TabsContent value="preferences">
            <Card className="border">
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">配置项</TableHead>
                      <TableHead>值</TableHead>
                      <TableHead>描述</TableHead>
                      <TableHead className="w-[80px] text-right">编辑</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {PREFERENCE_FIELDS.map((field) => {
                      const val = preferences ? preferences[field.key] : undefined
                      return (
                        <TableRow key={field.key}>
                          <TableCell className="font-mono text-xs">{field.label}</TableCell>
                          <TableCell className="text-xs break-all">
                            {formatPreferenceValue(field, val)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {field.description}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openEditPrefItem(field)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ---------- 弹窗 ---------- */}
        <ProviderDialog
          open={providerDialogOpen}
          onOpenChange={setProviderDialogOpen}
          initial={editingProvider}
          onSave={handleProviderSave}
          apiKey={apiKey}
        />
        <ApiKeyDialog
          open={apiKeyDialogOpen}
          onOpenChange={setApiKeyDialogOpen}
          initial={editingApiKey}
          onSave={handleApiKeySave}
        />
        <PreferencesDialog
          open={prefsDialogOpen}
          onOpenChange={setPrefsDialogOpen}
          initial={preferences || {}}
          onSave={handlePrefsSave}
        />
        <PreferenceItemDialog
          open={prefItemOpen}
          onOpenChange={setPrefItemOpen}
          field={prefItemField || PREFERENCE_FIELDS[0]}
          value={prefItemField ? preferences?.[prefItemField.key] : undefined}
          onSave={handlePrefItemSave}
        />
      </div>
    </TooltipProvider>
  )
}
