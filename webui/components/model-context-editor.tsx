// 模型能力配置：编辑 model_context_windows.json（context_window / max_output_tokens / supports_vision）
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
import { Plus, Pencil, Trash2, RefreshCw, Save, Search } from "lucide-react"

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
  const [formModel, setFormModel] = useState("")
  const [formContext, setFormContext] = useState("")
  const [formOutput, setFormOutput] = useState("")
  const [formVision, setFormVision] = useState("null")

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

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return Object.entries(caps)
      .filter(([model]) => !q || model.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [caps, search])

  const openAdd = () => {
    setEditingModel(null)
    setFormModel("")
    setFormContext("")
    setFormOutput("")
    setFormVision("null")
    setDialogOpen(true)
  }

  const openEdit = (model: string) => {
    const cap: ModelCap = {
      context_window: null,
      max_output_tokens: null,
      supports_vision: null,
      ...caps[model],
    }
    setEditingModel(model)
    setFormModel(model)
    setFormContext(cap.context_window != null ? String(cap.context_window) : "")
    setFormOutput(cap.max_output_tokens != null ? String(cap.max_output_tokens) : "")
    setFormVision(cap.supports_vision == null ? "null" : cap.supports_vision ? "true" : "false")
    setDialogOpen(true)
  }

  const handleDialogSave = () => {
    const model = formModel.trim()
    if (!model) {
      toast({ title: "无法保存", description: "模型名不能为空", variant: "destructive" })
      return
    }
    if (!editingModel && caps[model]) {
      toast({ title: "无法保存", description: "该模型已存在", variant: "destructive" })
      return
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
    next[model] = cap
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
      toast({ title: "保存成功", description: "model_context_windows.json 已更新，重启 uni-api 后生效。" })
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
            编辑 model_context_windows.json，用于在 /v1/models 返回模型的上下文窗口、最大输出 tokens 与视觉支持信息。
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
                <TableHead className="bg-muted font-bold whitespace-nowrap">上下文窗口</TableHead>
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
              <Label htmlFor="mc-model">模型名 *</Label>
              <Input
                id="mc-model"
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                placeholder="如 gpt-4o"
                disabled={!!editingModel}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mc-context">上下文窗口</Label>
              <Input
                id="mc-context"
                type="number"
                value={formContext}
                onChange={(e) => setFormContext(e.target.value)}
                placeholder="留空表示未知"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mc-output">最大输出 tokens</Label>
              <Input
                id="mc-output"
                type="number"
                value={formOutput}
                onChange={(e) => setFormOutput(e.target.value)}
                placeholder="留空表示未知"
              />
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