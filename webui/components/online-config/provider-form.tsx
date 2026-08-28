// Provider 编辑弹窗表单：仅使用 Input 和 Select，每项附 README 注释
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
import { Separator } from "@/components/ui/separator"
import { useToast } from "@/hooks/use-toast"
import {
  TextField,
  SelectField,
  StringListField,
  ModelListField,
  KeyValueField,
  apiToList,
  listToApi,
  modelToRows,
  rowsToModel,
  objectToPairs,
  pairsToObject,
} from "./fields"

export interface ProviderItem {
  provider?: string
  base_url?: string
  api?: string | string[]
  model?: any[]
  tools?: boolean
  notes?: string
  engine?: string
  preferences?: any
  [key: string]: any
}

export function ProviderDialog({
  open,
  onOpenChange,
  initial,
  onSave,
  apiKey,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: ProviderItem | null
  onSave: (item: ProviderItem) => void
  apiKey: string
}) {
  const { toast } = useToast()
  const [item, setItem] = useState<ProviderItem>({})
  const [apiList, setApiList] = useState<string[]>([])
  const [modelList, setModelList] = useState<{ upstream: string; alias: string }[]>([])
  const [modelTimeoutPairs, setModelTimeoutPairs] = useState<{ key: string; value: string }[]>([])
  const [keepalivePairs, setKeepalivePairs] = useState<{ key: string; value: string }[]>([])
  const [headersPairs, setHeadersPairs] = useState<{ key: string; value: string }[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)

  useEffect(() => {
    if (!open) return
    const prefs = initial?.preferences || {}
    setItem(initial ? { ...initial } : {})
    setApiList(apiToList(initial?.api))
    setModelList(modelToRows(initial?.model))
    setModelTimeoutPairs(objectToPairs(prefs.model_timeout))
    setKeepalivePairs(objectToPairs(prefs.keepalive_interval))
    setHeadersPairs(objectToPairs(prefs.headers))
    setFetchingModels(false)
  }, [open, initial])

  const update = (patch: Partial<ProviderItem>) => {
    setItem((prev) => ({ ...prev, ...patch }))
  }

  const updatePrefs = (patch: any) => {
    setItem((prev) => ({
      ...prev,
      preferences: { ...(prev.preferences || {}), ...patch },
    }))
  }

  const fetchModels = async () => {
    if (!item.base_url) {
      toast({ title: "无法获取", description: "请先填写 base_url", variant: "destructive" })
      return
    }
    const channelApi = apiList.map((s) => s.trim()).filter(Boolean)
    if (channelApi.length === 0) {
      toast({ title: "无法获取", description: "请先填写 api Key", variant: "destructive" })
      return
    }
    setFetchingModels(true)
    try {
      const res = await fetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, base_url: item.base_url, api: channelApi }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        throw new Error(data.message || `HTTP ${res.status}`)
      }
      const models: string[] = data.models || []
      if (models.length === 0) {
        toast({ title: "未获取到模型", description: "该渠道未返回任何模型列表" })
        return
      }
      setModelList(models.map((m) => ({ upstream: m, alias: "" })))
      toast({ title: "获取成功", description: `已填入 ${models.length} 个模型` })
    } catch (e: any) {
      toast({ title: "获取失败", description: e?.message || "未知错误", variant: "destructive" })
    } finally {
      setFetchingModels(false)
    }
  }

  const handleSave = () => {
    const prefs: any = { ...(item.preferences || {}) }
    // 处理 KeyValueField 的回写
    const mt = pairsToObject(modelTimeoutPairs)
    if (mt) prefs.model_timeout = mt
    else delete prefs.model_timeout

    const ka = pairsToObject(keepalivePairs)
    if (ka) prefs.keepalive_interval = ka
    else delete prefs.keepalive_interval

    const hd = pairsToObject(headersPairs)
    if (hd) prefs.headers = hd
    else delete prefs.headers

    const result: ProviderItem = {
      ...item,
      api: listToApi(apiList),
      model: rowsToModel(modelList),
      preferences: Object.keys(prefs).length > 0 ? prefs : undefined,
    }
    // 清理 undefined
    Object.keys(result).forEach((k) => {
      if (result[k] === undefined || result[k] === "") delete (result as any)[k]
    })
    onSave(result)
    onOpenChange(false)
  }

  const prefs = item.preferences || {}

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {initial?.provider ? `编辑渠道：${initial.provider}` : "新增渠道"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pl-1.5 pr-4">
          <div className="space-y-4 py-2">
            {/* ---------- 基础字段 ---------- */}
            <TextField
              id="provider"
              label="provider"
              required
              description="服务提供商名称，如 openai、anthropic、gemini、openrouter，随便取名字，必填"
              value={item.provider || ""}
              onChange={(v) => update({ provider: v })}
              placeholder="openai"
            />
            <TextField
              id="base_url"
              label="base_url"
              required
              description="后端服务的 API 地址，必填。支持 /v1/chat/completions、/v1/messages、/responses 等端点"
              value={item.base_url || ""}
              onChange={(v) => update({ base_url: v })}
              placeholder="https://api.xxx.com/v1/chat/completions"
              mono
            />
            <StringListField
              label="api"
              required
              description="提供商的 API Key，必填。支持多个 Key，多个 key 自动开启轮训负载均衡。至少一个 key"
              values={apiList}
              onChange={setApiList}
              placeholder="sk-xxx"
              mono
            />
            <ModelListField
              label="model"
              description="选填，不配置则自动通过 /v1/models 获取。左列为渠道实际模型ID，右列为映射后的模型名（可为空，等价于只配置上游模型）"
              values={modelList}
              onChange={setModelList}
              actionLabel="获取渠道模型"
              onAction={fetchModels}
              actionLoading={fetchingModels}
            />
            <SelectField
              id="tools"
              label="tools"
              description="是否支持工具（如生成代码、生成文档等），默认 true，选填"
              value={item.tools === false ? "false" : "true"}
              onChange={(v) => update({ tools: v === "true" })}
              options={[
                { value: "true", label: "启用" },
                { value: "false", label: "禁用" },
              ]}
            />
            <SelectField
              id="engine"
              label="engine"
              description="强制使用某个消息格式，目前支持 gpt、claude、gemini、openrouter、codex 原生格式，选填"
              value={item.engine || ""}
              onChange={(v) => update({ engine: v || undefined })}
              options={[
                { value: "gpt", label: "gpt" },
                { value: "claude", label: "claude" },
                { value: "gemini", label: "gemini" },
                { value: "openrouter", label: "openrouter" },
                { value: "codex", label: "codex" },
              ]}
              placeholder="不设置（自动识别）"
            />
            <TextField
              id="notes"
              label="notes"
              description="可以放服务商的网址、备注信息、官方文档，选填"
              value={item.notes || ""}
              onChange={(v) => update({ notes: v })}
              placeholder="https://xxx.com/"
            />

            <Separator />
            <p className="text-xs font-semibold text-muted-foreground">preferences（渠道级，选填）</p>

            {/* ---------- preferences 字段 ---------- */}
            <TextField
              id="pref-proxy"
              label="proxy"
              description="代理地址，选填。支持 socks5 和 http 代理，默认不使用代理。如 socks5://user:pass@ip:port"
              value={prefs.proxy || ""}
              onChange={(v) => updatePrefs({ proxy: v || undefined })}
              placeholder="socks5://[用户名]:[密码]@[IP]:[端口]"
            />
            <TextField
              id="pref-rate-limit"
              label="api_key_rate_limit"
              description="每个 API Key 每分钟最多请求次数，选填。默认 999999/min。支持多个频率约束：15/min,10/day"
              value={typeof prefs.api_key_rate_limit === "string" ? prefs.api_key_rate_limit : ""}
              onChange={(v) => updatePrefs({ api_key_rate_limit: v || undefined })}
              placeholder="15/min"
            />
            <TextField
              id="pref-cooldown"
              label="api_key_cooldown_period"
              description="每个 API Key 遭遇 429 错误后的冷却时间，单位秒，选填。默认 0 不启用。当存在多个 API key 时才生效"
              value={prefs.api_key_cooldown_period != null ? String(prefs.api_key_cooldown_period) : ""}
              onChange={(v) => updatePrefs({ api_key_cooldown_period: v === "" ? undefined : Number(v) })}
              placeholder="60"
            />
            <SelectField
              id="pref-schedule"
              label="api_key_schedule_algorithm"
              description="设置多个 API Key 的请求顺序，选填。默认 round_robin。当存在多个 API key 时才生效"
              value={prefs.api_key_schedule_algorithm || ""}
              onChange={(v) => updatePrefs({ api_key_schedule_algorithm: v || undefined })}
              options={[
                { value: "round_robin", label: "round_robin（轮询）" },
                { value: "random", label: "random（随机）" },
                { value: "fixed_priority", label: "fixed_priority（固定优先级）" },
                { value: "smart_round_robin", label: "smart_round_robin（智能调度）" },
              ]}
              placeholder="round_robin（默认）"
            />
            <TextField
              id="pref-cooldown-channel"
              label="cooldown_period"
              description="渠道冷却时间，单位秒，选填。当为 0 时该渠道不启用冷却机制，优先级高于全局配置"
              value={prefs.cooldown_period != null ? String(prefs.cooldown_period) : ""}
              onChange={(v) => updatePrefs({ cooldown_period: v === "" ? undefined : Number(v) })}
              placeholder="0"
            />
            <KeyValueField
              label="model_timeout"
              description="模型超时时间，单位秒，默认 100。可设 default 作为兜底；不设 default 则使用全局配置"
              pairs={modelTimeoutPairs}
              onChange={setModelTimeoutPairs}
              keyPlaceholder="模型名，如 gpt-5.2 或 default"
              valuePlaceholder="秒数，如 500"
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
            <KeyValueField
              label="headers"
              description="额外附加自定义 HTTP 请求头，选填"
              pairs={headersPairs}
              onChange={setHeadersPairs}
              keyPlaceholder="Header 名，如 Custom-Header-1"
              valuePlaceholder="Header 值，如 Value-1"
            />
            <TextField
              id="pref-max-body"
              label="max_request_body_bytes"
              description="当入站 JSON 请求体大于该字节数时跳过该渠道。支持数字或 '20MB'/'20MiB' 字符串"
              value={prefs.max_request_body_bytes != null ? String(prefs.max_request_body_bytes) : ""}
              onChange={(v) => updatePrefs({ max_request_body_bytes: v || undefined })}
              placeholder="20000000"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!item.provider || !item.base_url}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
