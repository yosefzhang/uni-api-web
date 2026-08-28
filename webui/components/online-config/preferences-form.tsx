// 全局 Preferences 编辑弹窗表单：仅使用 Input 和 Select，每项附 README 注释
"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  TextField,
  StringListField,
  KeyValueField,
  objectToPairs,
  pairsToObject,
  triggersToList,
  listToTriggers,
} from "./fields"

export function PreferencesDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: any
  onSave: (prefs: any) => void
}) {
  const [prefs, setPrefs] = useState<any>({})
  const [modelTimeoutPairs, setModelTimeoutPairs] = useState<{ key: string; value: string }[]>([])
  const [keepalivePairs, setKeepalivePairs] = useState<{ key: string; value: string }[]>([])
  const [modelPricePairs, setModelPricePairs] = useState<{ key: string; value: string }[]>([])
  const [errorTriggers, setErrorTriggers] = useState<string[]>([])

  useEffect(() => {
    if (open && initial) {
      setPrefs({ ...initial })
      setModelTimeoutPairs(objectToPairs(initial.model_timeout))
      setKeepalivePairs(objectToPairs(initial.keepalive_interval))
      setModelPricePairs(objectToPairs(initial.model_price))
      setErrorTriggers(triggersToList(initial.error_triggers))
    }
  }, [open, initial])

  const update = (patch: any) => {
    setPrefs((prev) => ({ ...prev, ...patch }))
  }

  const handleSave = () => {
    const result: any = { ...prefs }
    const mt = pairsToObject(modelTimeoutPairs)
    if (mt) result.model_timeout = mt
    else delete result.model_timeout

    const ka = pairsToObject(keepalivePairs)
    if (ka) result.keepalive_interval = ka
    else delete result.keepalive_interval

    const mp = pairsToObject(modelPricePairs)
    if (mp) result.model_price = mp
    else delete result.model_price

    const et = listToTriggers(errorTriggers)
    if (et) result.error_triggers = et
    else delete result.error_triggers

    onSave(result)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>编辑全局 preferences</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pl-1.5 pr-4">
          <div className="space-y-4 py-2">
            <TextField
              id="g-cooldown"
              label="cooldown_period"
              description="渠道冷却时间，单位秒，默认 300。模型请求失败时自动将该渠道排除冷却一段时间。设为 0 不启用冷却机制"
              value={prefs.cooldown_period != null ? String(prefs.cooldown_period) : ""}
              onChange={(v) => update({ cooldown_period: v === "" ? undefined : Number(v) })}
              placeholder="300"
            />
            <TextField
              id="g-rate-limit"
              label="rate_limit"
              description="uni-api 全局速率限制，默认 999999/min。支持多个频率约束条件，如 15/min,10/day"
              value={typeof prefs.rate_limit === "string" ? prefs.rate_limit : ""}
              onChange={(v) => update({ rate_limit: v || undefined })}
              placeholder="999999/min"
            />
            <TextField
              id="g-proxy"
              label="proxy"
              description="全局代理地址，选填。如 socks5://[username]:[password]@[ip]:[port]"
              value={prefs.proxy || ""}
              onChange={(v) => update({ proxy: v || undefined })}
              placeholder="socks5://[username]:[password]@[ip]:[port]"
            />
            <KeyValueField
              label="model_timeout"
              description="模型超时时间，单位秒，默认 100。可设 default 作为兜底；不设 default 则使用环境变量 TIMEOUT（默认 100 秒）"
              pairs={modelTimeoutPairs}
              onChange={setModelTimeoutPairs}
              keyPlaceholder="模型名，如 gpt-5.2 或 default"
              valuePlaceholder="秒数，如 10"
              valueMono
            />
            <KeyValueField
              label="keepalive_interval"
              description="心跳间隔，单位秒，默认 99999。适合 cloudflare 托管 + 推理模型。必须小于 model_timeout 设置的超时时间，否则忽略"
              pairs={keepalivePairs}
              onChange={setKeepalivePairs}
              keyPlaceholder="模型名，如 gemini-2.5-pro"
              valuePlaceholder="秒数，如 50"
              valueMono
            />
            <StringListField
              label="error_triggers"
              description="错误触发器，当模型返回的消息包含其中任意一个字符串时，该渠道自动返回报错，选填"
              values={errorTriggers}
              onChange={setErrorTriggers}
              placeholder="如 The bot's usage is covered by the developer"
            />
            <KeyValueField
              label="model_price"
              description="模型价格，单位美元/M tokens，选填。格式 输入价,输出价。默认 1,2 表示输入 1 美元/100 万 tokens，输出 2 美元/100 万 tokens"
              pairs={modelPricePairs}
              onChange={setModelPricePairs}
              keyPlaceholder="模型名，如 gpt-5.2 或 default"
              valuePlaceholder="如 1,2 或 0.12,0.48"
              valueMono
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 字段元数据：用于表格展示与单项编辑 ----------

export type PreferenceFieldType = "text" | "numeric" | "keyvalue" | "stringlist"

export interface PreferenceFieldMeta {
  key: string
  label: string
  type: PreferenceFieldType
  description: string
  placeholder?: string
  keyPlaceholder?: string
  valuePlaceholder?: string
}

export const PREFERENCE_FIELDS: PreferenceFieldMeta[] = [
  {
    key: "cooldown_period",
    label: "cooldown_period",
    type: "numeric",
    description: "渠道冷却时间，单位秒，默认 300。模型请求失败时自动将该渠道排除冷却一段时间。设为 0 不启用冷却机制",
    placeholder: "300",
  },
  {
    key: "rate_limit",
    label: "rate_limit",
    type: "text",
    description: "uni-api 全局速率限制，默认 999999/min。支持多个频率约束条件，如 15/min,10/day",
    placeholder: "999999/min",
  },
  {
    key: "proxy",
    label: "proxy",
    type: "text",
    description: "全局代理地址，选填。如 socks5://[username]:[password]@[ip]:[port]",
    placeholder: "socks5://[username]:[password]@[ip]:[port]",
  },
  {
    key: "model_timeout",
    label: "model_timeout",
    type: "keyvalue",
    description: "模型超时时间，单位秒，默认 100。可设 default 作为兜底；不设 default 则使用环境变量 TIMEOUT（默认 100 秒）",
    keyPlaceholder: "模型名，如 gpt-5.2 或 default",
    valuePlaceholder: "秒数，如 10",
  },
  {
    key: "keepalive_interval",
    label: "keepalive_interval",
    type: "keyvalue",
    description: "心跳间隔，单位秒，默认 99999。适合 cloudflare 托管 + 推理模型。必须小于 model_timeout 设置的超时时间，否则忽略",
    keyPlaceholder: "模型名，如 gemini-2.5-pro",
    valuePlaceholder: "秒数，如 50",
  },
  {
    key: "error_triggers",
    label: "error_triggers",
    type: "stringlist",
    description: "错误触发器，当模型返回的消息包含其中任意一个字符串时，该渠道自动返回报错，选填",
    placeholder: "如 The bot's usage is covered by the developer",
  },
  {
    key: "model_price",
    label: "model_price",
    type: "keyvalue",
    description: "模型价格，单位美元/M tokens，选填。格式 输入价,输出价。默认 1,2 表示输入 1 美元/100 万 tokens，输出 2 美元/100 万 tokens",
    keyPlaceholder: "模型名，如 gpt-5.2 或 default",
    valuePlaceholder: "如 1,2 或 0.12,0.48",
  },
]

// 表格「值」列的格式化展示
export function formatPreferenceValue(field: PreferenceFieldMeta, value: any): string {
  if (value == null) return "—"
  if (field.type === "keyvalue") {
    const entries = Object.entries(value as Record<string, any>)
    if (entries.length === 0) return "—"
    return entries.map(([k, v]) => `${k}: ${v}`).join("，")
  }
  if (field.type === "stringlist") {
    const arr = value as string[]
    if (!arr.length) return "—"
    return arr.join("，")
  }
  return String(value)
}

// 单个偏好项编辑弹窗
export function PreferenceItemDialog({
  open,
  onOpenChange,
  field,
  value,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  field: PreferenceFieldMeta
  value: any
  onSave: (key: string, value: any) => void
}) {
  const [textValue, setTextValue] = useState("")
  const [pairs, setPairs] = useState<{ key: string; value: string }[]>([])
  const [list, setList] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    if (field.type === "text" || field.type === "numeric") {
      setTextValue(value == null ? "" : String(value))
    } else if (field.type === "keyvalue") {
      setPairs(objectToPairs(value))
    } else if (field.type === "stringlist") {
      setList(triggersToList(value))
    }
  }, [open, field, value])

  const handleSave = () => {
    let result: any
    if (field.type === "text") {
      result = textValue.trim() === "" ? undefined : textValue
    } else if (field.type === "numeric") {
      result = textValue.trim() === "" ? undefined : Number(textValue)
    } else if (field.type === "keyvalue") {
      result = pairsToObject(pairs)
    } else {
      result = listToTriggers(list)
    }
    onSave(field.key, result)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>编辑 {field.label}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pl-1.5 pr-4 py-2">
          {field.type === "keyvalue" ? (
            <KeyValueField
              label={field.label}
              description={field.description}
              pairs={pairs}
              onChange={setPairs}
              keyPlaceholder={field.keyPlaceholder}
              valuePlaceholder={field.valuePlaceholder}
              valueMono
            />
          ) : field.type === "stringlist" ? (
            <StringListField
              label={field.label}
              description={field.description}
              values={list}
              onChange={setList}
              placeholder={field.placeholder}
            />
          ) : (
            <TextField
              label={field.label}
              description={field.description}
              value={textValue}
              onChange={setTextValue}
              placeholder={field.placeholder}
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
