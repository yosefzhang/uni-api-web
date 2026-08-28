// 共享表单字段组件：仅使用 Input 和 Select，附带 README 注释说明
"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus, Trash2, RefreshCw, Loader2, Wand2 } from "lucide-react"

// 单行字段：标签（上）+ 控件（下），注释以小字放在标签旁
export function FieldRow({
  id,
  label,
  required,
  description,
  children,
}: {
  id?: string
  label: string
  required?: boolean
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <Label htmlFor={id} className="text-lg font-medium leading-tight">
          {label} {required && <span className="text-destructive">*</span>}
        </Label>
        {description && (
          <span className="text-[11px] text-muted-foreground leading-tight">{description}</span>
        )}
      </div>
      {children}
    </div>
  )
}

// 文本输入字段
export function TextField({
  id,
  label,
  required,
  description,
  value,
  onChange,
  placeholder,
  mono,
}: {
  id?: string
  label: string
  required?: boolean
  description?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <FieldRow id={id} label={label} required={required} description={description}>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`h-9 ${mono ? "font-mono text-xs" : ""}`}
      />
    </FieldRow>
  )
}

// 下拉选择字段
export function SelectField({
  id,
  label,
  required,
  description,
  value,
  onChange,
  options,
  placeholder,
}: {
  id?: string
  label: string
  required?: boolean
  description?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <FieldRow id={id} label={label} required={required} description={description}>
      <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
        <SelectTrigger id={id} className="h-9 px-2">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{placeholder || "不设置"}</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  )
}

// 字符串列表字段（动态增删 Input 行）
// 每项是纯字符串，用于 api（Key 列表）、model（模型列表）、error_triggers 等
export function StringListField({
  label,
  required,
  description,
  values,
  onChange,
  placeholder,
  mono,
  actionLabel,
  onAction,
  actionLoading,
}: {
  label: string
  required?: boolean
  description?: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  mono?: boolean
  actionLabel?: string
  onAction?: () => void
  actionLoading?: boolean
}) {
  const items = values.length > 0 ? values : [""]
  return (
    <FieldRow label={label} required={required} description={description}>
      <div className="space-y-1.5">
        {items.map((v, i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              value={v}
              onChange={(e) => {
                const next = items.slice()
                next[i] = e.target.value
                onChange(next)
              }}
              placeholder={placeholder}
              className={`h-9 ${mono ? "font-mono text-xs" : ""}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
              onClick={() => {
                if (items.length === 1) {
                  onChange([""])
                } else {
                  onChange(items.filter((_, idx) => idx !== i))
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, ""])}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            添加一行
          </Button>
          {onAction && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAction}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </FieldRow>
  )
}

// 模型映射字段：两列表格（渠道模型ID / 映射模型ID），支持动态增删行
// 用于 Provider 的 model 字段，映射列可为空（等价于只配置 upstream）
export function ModelListField({
  label,
  description,
  values,
  onChange,
  actionLabel,
  onAction,
  actionLoading,
}: {
  label: string
  description?: string
  values: { upstream: string; alias: string }[]
  onChange: (next: { upstream: string; alias: string }[]) => void
  actionLabel?: string
  onAction?: () => void
  actionLoading?: boolean
}) {
  const items = values.length > 0 ? values : [{ upstream: "", alias: "" }]
  const [prefix, setPrefix] = useState("")

  const handleAutoFillPrefix = () => {
    const p = prefix.trim()
    onChange(
      items.map((m) => {
        const upstream = m.upstream.trim()
        if (!upstream) return m
        return { ...m, alias: p ? `${p}/${upstream}` : upstream }
      }),
    )
  }

  return (
    <FieldRow label={label} description={description}>
      <div className="space-y-1.5">
        <div className="flex gap-1.5 px-1 text-xs text-muted-foreground">
          <span className="flex-1">渠道模型ID</span>
          <span className="flex-1">映射模型ID</span>
          <span className="w-9" />
        </div>
        {items.map((m, i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              value={m.upstream}
              onChange={(e) => {
                const next = items.slice()
                next[i] = { ...next[i], upstream: e.target.value }
                onChange(next)
              }}
              placeholder="gpt-5.2"
              className="flex-1 h-9 font-mono text-xs"
            />
            <Input
              value={m.alias}
              onChange={(e) => {
                const next = items.slice()
                next[i] = { ...next[i], alias: e.target.value }
                onChange(next)
              }}
              placeholder="可选，重命名"
              className="flex-1 h-9 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
              onClick={() => {
                if (items.length === 1) {
                  onChange([{ upstream: "", alias: "" }])
                } else {
                  onChange(items.filter((_, idx) => idx !== i))
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...items, { upstream: "", alias: "" }])}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            添加一行
          </Button>
          {onAction && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onAction}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              {actionLabel}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onChange([])}
            title="清空所有模型配置"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            清空模型
          </Button>
          <div className="basis-full" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleAutoFillPrefix}
            title="将「映射模型ID」填充为「前缀/渠道模型ID」"
          >
            <Wand2 className="h-3.5 w-3.5 mr-1" />
            自动填充前缀
          </Button>
          <Input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="输入前缀"
            className="h-8 w-24 shrink-0 font-mono text-xs"
          />
        </div>
      </div>
    </FieldRow>
  )
}

// 键值对列表字段（动态增删 key-value Input 对）
// 用于 model_timeout / keepalive_interval / model_price / headers 等对象类型
export function KeyValueField({
  label,
  description,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  valueMono,
}: {
  label: string
  description?: string
  pairs: { key: string; value: string }[]
  onChange: (next: { key: string; value: string }[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  valueMono?: boolean
}) {
  const items = pairs.length > 0 ? pairs : [{ key: "", value: "" }]
  return (
    <FieldRow label={label} description={description}>
      <div className="space-y-1.5">
        {items.map((p, i) => (
          <div key={i} className="flex gap-1.5">
            <Input
              value={p.key}
              onChange={(e) => {
                const next = items.slice()
                next[i] = { ...next[i], key: e.target.value }
                onChange(next)
              }}
              placeholder={keyPlaceholder}
              className="flex-1 h-9"
            />
            <Input
              value={p.value}
              onChange={(e) => {
                const next = items.slice()
                next[i] = { ...next[i], value: e.target.value }
                onChange(next)
              }}
              placeholder={valuePlaceholder}
            className={`flex-1 h-9 ${valueMono ? "font-mono text-xs" : ""}`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
              onClick={() => {
                if (items.length === 1) {
                  onChange([{ key: "", value: "" }])
                } else {
                  onChange(items.filter((_, idx) => idx !== i))
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...items, { key: "", value: "" }])}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          添加一行
        </Button>
      </div>
    </FieldRow>
  )
}

// ---------- 数据转换工具函数 ----------

// api 字段：string | string[] → string[]
export function apiToList(api: unknown): string[] {
  if (!api) return []
  if (Array.isArray(api)) return api.map(String)
  return [String(api)]
}

// string[] → string | string[]（单元素返回 string，多元素返回数组）
export function listToApi(list: string[]): string | string[] {
  const filtered = list.map((s) => s.trim()).filter(Boolean)
  if (filtered.length === 0) return ""
  if (filtered.length === 1) return filtered[0]
  return filtered
}

// model 字段：(string | {key: value})[] → string[]（对象转 "key: value" 字符串）
export function modelToList(model: unknown): string[] {
  if (!Array.isArray(model)) return []
  return model.map((item: any) => {
    if (item === null || item === undefined) return ""
    if (typeof item === "string") return item
    if (typeof item === "object") {
      const [[k, v]] = Object.entries(item)
      return `${k}: ${v}`
    }
    return String(item)
  })
}

// string[] → (string | {key: value})[]（含冒号的转对象，数字 value 转数字）
export function listToModel(list: string[]): any[] {
  return list
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]+):\s*(.+)$/)
      if (m) {
        const rawVal = m[2].trim()
        const obj: any = {}
        obj[m[1].trim()] = /^\d+$/.test(rawVal) ? Number(rawVal) : rawVal
        return obj
      }
      return line
    })
}

// model 字段：原始 model 数组 → { upstream, alias }[]（两列表格用）
export function modelToRows(model: unknown): { upstream: string; alias: string }[] {
  if (!Array.isArray(model)) return []
  return model.map((item: any) => {
    if (typeof item === "string") return { upstream: item, alias: "" }
    if (item && typeof item === "object") {
      const [[k, v]] = Object.entries(item)
      return { upstream: String(k), alias: v == null ? "" : String(v) }
    }
    return { upstream: "", alias: "" }
  })
}

// { upstream, alias }[] → model 数组（纯数字 alias 转权重数字，字符串 alias 转映射对象，空 alias 用字符串）
export function rowsToModel(rows: { upstream: string; alias: string }[]): any[] {
  const out: any[] = []
  for (const r of rows) {
    const upstream = r.upstream.trim()
    const alias = r.alias.trim()
    if (!upstream) continue
    if (alias) {
      const obj: any = {}
      obj[upstream] = /^\d+$/.test(alias) ? Number(alias) : alias
      out.push(obj)
    } else {
      out.push(upstream)
    }
  }
  return out
}

// 对象 → {key, value}[] （用于 KeyValueField）
export function objectToPairs(obj: unknown): { key: string; value: string }[] {
  if (!obj || typeof obj !== "object") return []
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: String(value),
  }))
}

// {key, value}[] → 对象（空 key 跳过；数字 value 转数字）
export function pairsToObject(pairs: { key: string; value: string }[]): any | undefined {
  const obj: any = {}
  for (const p of pairs) {
    const k = p.key.trim()
    if (!k) continue
    const v = p.value.trim()
    obj[k] = /^\d+$/.test(v) ? Number(v) : v
  }
  return Object.keys(obj).length > 0 ? obj : undefined
}

// error_triggers: string[] → string[]
export function triggersToList(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr.map(String)
}

export function listToTriggers(list: string[]): string[] | undefined {
  const filtered = list.map((s) => s.trim()).filter(Boolean)
  return filtered.length > 0 ? filtered : undefined
}
