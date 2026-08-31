// 模型能力配置：编辑 data/model_extern_config.json（context_window / max_output_tokens / supports_vision）
"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Plus, Pencil, Trash2, RefreshCw, Save, Search, ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { Checkbox } from "@/components/ui/checkbox"

export interface ModelCap {
  context_window: number | null
  max_output_tokens: number | null
  supports_vision: boolean | null
}

type ModelCapsMap = Record<string, ModelCap>

interface ModelContextEditorProps {
  apiKey: string
}

const VISION_OPTIONS = [
  { value: "true", label: "支持" },
  { value: "false", label: "不支持" },
  { value: "null", label: "未知" },
]

function normalizeCap(raw: any): ModelCap {
  const num = (v: any): number | null => {
    if (v == null || v === "") return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const vision = (v: any): boolean | null => {
    if (v === true) return true
    if (v === false) return false
    return null
  }
  return {
    context_window: num(raw?.context_window),
    max_output_tokens: num(raw?.max_output_tokens),
    supports_vision: vision(raw?.supports_vision),
  }
}

export function ModelContextEditor({ apiKey }: ModelContextEditorProps) {
  const [caps, setCaps] = useState<ModelCapsMap>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")
  const { toast } = useToast()

  // 弹窗状态
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<string | null>(null)
  const [formModels, setFormModels] = useState<string[]>([])
  const [formContext, setFormContext] = useState("")
  const [formOutput, setFormOutput] = useState("")
  const [formVision, setFormVision] = useState("null")
  // 模型多选下拉
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelPopoverOpen, setModelPopoverOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/model-context/load?apiKey=${encodeURIComponent(apiKey)}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      const raw: Record<string, any> = data.data || {}
      const next: ModelCapsMap = {}
      for (const [k, v] of Object.entries(raw)) {
        next[k] = normalizeCap(v)
      }
      setCaps(next)
    } catch (e: any) {
      toast({ title: "加载失败", description: e.message || "无法加载配置", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }, [apiKey, toast])

  useEffect(() => {
    load()
  }, [load])

  const fetchAvailableModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const res = await fetch(`/api/providers/list?apiKey=${encodeURIComponent(apiKey)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const seen = new Set<string>()
      for (const provider of data.providers || []) {
        for (const model of provider.models || []) {
          if (model && model.display) seen.add(String(model.display))
        }
      }
      setAvailableModels(Array.from(seen).sort())
    } catch (e: any) {
      toast({ title: "获取模型列表失败", description: e.message || "无法获取映射模型列表", variant: "destructive" })
      setAvailableModels([])
    } finally {
      setModelsLoading(false)
    }
  }, [apiKey, toast])

  const toggleModel = (model: string) => {
    setFormModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    )
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return Object.entries(caps)
      .filter(([model]) => !q || model.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [caps, search])

  const openAdd = () => {
    setEditingModel(null)
    setFormModels([])
    setFormContext("")
    setFormOutput("")
    setFormVision("null")
    setAvailableModels([])
    setModelPopoverOpen(false)
    setDialogOpen(true)
    fetchAvailableModels()
  }

  const openEdit = (model: string) => {
    const cap: ModelCap = {
      context_window: null,
      max_output_tokens: null,
      supports_vision: null,
      ...caps[model],
    }
    setEditingModel(model)
    setFormModels([model])
    setFormContext(cap.context_window != null ? String(cap.context_window) : "")
    setFormOutput(cap.max_output_tokens != null ? String(cap.max_output_tokens) : "")
    setFormVision(cap.supports_vision == null ? "null" : cap.supports_vision ? "true" : "false")
    setDialogOpen(true)
  }

  const handleDialogSave = () => {
    const models = formModels.map((m) => m.trim()).filter(Boolean)
    if (models.length === 0) {
      toast({ title: "无法保存", description: "请至少选择一个模型", variant: "destructive" })
      return
    }
    if (!editingModel) {
      const dup = models.filter((m) => caps[m])
      if (dup.length > 0) {
        toast({ title: "无法保存", description: `以下模型已存在：${dup.join("、")}`, variant: "destructive" })
        return
      }
    }
    const cap: ModelCap = normalizeCap({
      context_window: formContext,
      max_output_tokens: formOutput,
      supports_vision: formVision === "null" ? null : formVision === "true",
    })
    const next: ModelCapsMap = {}
    for (const [k, v] of Object.entries(caps)) {
      if (editingModel && k === editingModel) continue
      next[k] = v
    }
    for (const m of models) next[m] = cap
    setCaps(next)
    setDialogOpen(false)
  }

  const handleDelete = (model: string) => {
    const next: ModelCapsMap = {}
    for (const [k, v] of Object.entries(caps)) {
      if (k !== model) next[k] = v
    }
    setCaps(next)
  }

  const persist = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/model-context/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, data: caps }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      toast({ title: "保存成功", description: "data/model_extern_config.json 已更新，/v1/models 下次请求即时生效。" })
    } catch (e: any) {
      toast({ title: "保存失败", description: e.message || "未知错误", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    await load()
    toast({ title: "已重新加载", description: "已撤销未保存的本地修改。" })
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    )
  }

  const renderVision = (v: boolean | null) => {
    if (v === true) return <Badge variant="default">支持</Badge>
    if (v === false) return <Badge variant="secondary">不支持</Badge>
    return <Badge variant="outline">未知</Badge>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">模型能力配置</h2>
          <p className="text-sm text-muted-foreground mt-1">
            编辑 data/model_extern_config.json，用于在 /v1/models 返回模型的上下文窗口、最大输出 tokens 与视觉支持信息。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload} disabled={saving}>
            <RefreshCw className="w-4 h-4 mr-2" />
            重新加载
          </Button>
          <Button size="sm" onClick={persist} disabled={saving}>
            <Save className="w-4 h-4 mr-2" />
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索模型名…"
            className="pl-8 h-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={openAdd}>
          <Plus className="w-4 h-4 mr-2" />
          新增模型
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="bg-muted font-bold">模型</TableHead>
                <TableHead className="bg-muted font-bold whitespace-nowrap">上下文窗口 (tokens)</TableHead>
                <TableHead className="bg-muted font-bold whitespace-nowrap">最大输出 tokens</TableHead>
                <TableHead className="bg-muted font-bold">支持视觉</TableHead>
                <TableHead className="bg-muted font-bold text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    暂无数据，点击【新增模型】开始配置。
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(([model, cap]) => (
                  <TableRow key={model}>
                    <TableCell className="font-mono text-xs break-all align-top">{model}</TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      {cap.context_window != null ? cap.context_window.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      {cap.max_output_tokens != null ? cap.max_output_tokens.toLocaleString() : "—"}
                    </TableCell>
                    <TableCell className="align-top">{renderVision(cap.supports_vision)}</TableCell>
                    <TableCell className="text-right align-top whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(model)}
                        disabled={saving}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        onClick={() => handleDelete(model)}
                        disabled={saving}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingModel ? `编辑模型：${editingModel}` : "新增模型"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="mc-model">模型名 *（可多选）</Label>
              {editingModel ? (
                <Input id="mc-model" value={editingModel} disabled className="font-mono text-xs" />
              ) : (
                <>
                  <Popover open={modelPopoverOpen} onOpenChange={setModelPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className="w-full justify-between h-9 font-normal"
                      >
                        <span className="truncate">
                          {formModels.length > 0 ? `已选 ${formModels.length} 个模型` : "选择模型…"}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="p-0 w-[var(--radix-popover-trigger-width)]"
                      align="start"
                    >
                      <Command>
                        <CommandInput placeholder="搜索模型…" />
                        <CommandList>
                          <CommandEmpty>{modelsLoading ? "加载中…" : "未找到模型"}</CommandEmpty>
                          <CommandGroup>
                            {availableModels.map((model) => {
                              const selected = formModels.includes(model)
                              return (
                                <CommandItem
                                  key={model}
                                  value={model}
                                  onSelect={() => toggleModel(model)}
                                >
                                  <Checkbox
                                    checked={selected}
                                    onCheckedChange={() => toggleModel(model)}
                                    className="mr-2 pointer-events-none"
                                  />
                                  <span className="font-mono text-xs">{model}</span>
                                </CommandItem>
                              )
                            })}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    选项来自当前 uni-api 各渠道映射后的模型名（即 /v1/models 返回的 id）。
                  </p>
                  {formModels.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {formModels.map((model) => (
                        <Badge key={model} variant="secondary" className="font-mono text-xs">
                          {model}
                        </Badge>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mc-context">上下文窗口 (tokens)</Label>
              <Input
                id="mc-context"
                type="number"
                value={formContext}
                onChange={(e) => setFormContext(e.target.value)}
                placeholder="如 128000，留空表示未知"
              />
              <p className="text-xs text-muted-foreground">
                模型可处理的总上下文长度，单位为 tokens。示例：gpt-4o 填 128000，gpt-4-turbo 填 128000。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mc-output">最大输出 tokens</Label>
              <Input
                id="mc-output"
                type="number"
                value={formOutput}
                onChange={(e) => setFormOutput(e.target.value)}
                placeholder="如 16384，留空表示未知"
              />
              <p className="text-xs text-muted-foreground">
                单次回复最大生成的 token 数，单位为 tokens。示例：gpt-4o 填 16384，o1 填 100000。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>支持视觉</Label>
              <Select value={formVision} onValueChange={setFormVision}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISION_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleDialogSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}