// 文件名: components/channel-tester.tsx
// 真实测试：选择目标 Base URL 与端点，勾选模型后发起真实请求测试。
"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Play, Loader2, ChevronDown } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { formatTime } from "@/lib/utils"

// --- Interfaces ---

interface ChannelTesterProps {
  apiKey: string
}

interface ModelConfig {
  original: string
  display: string
}

interface Provider {
  provider: string
  base_url: string
  api: string | string[]
  models: ModelConfig[]
}

interface TestResult {
  success: boolean
  message?: string
  responseTime?: number
  request?: {
    method: string
    url: string
    headers: Record<string, string>
    body: unknown
  }
  response?: {
    status: number
    body: string
  }
}

interface BaseUrlOption {
  key: string
  label: string
  baseUrl: string // 空串表示 uni-api 网关
  api: string
  models: string[]
}

// --- Component ---

export function ChannelTester({ apiKey }: ChannelTesterProps) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedBase, setSelectedBase] = useState<string>("__uni_api__")
  const [endpoint, setEndpoint] = useState<string>("chat/completions")
  const [selectedModels, setSelectedModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [openResults, setOpenResults] = useState<Record<string, boolean>>({})
  const [uniApiBaseUrl, setUniApiBaseUrl] = useState<string>("")
  const [customBaseUrl, setCustomBaseUrl] = useState<string>("")
  const [customModels, setCustomModels] = useState<string[]>([])
  const [customLoading, setCustomLoading] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)
  const [baseQuery, setBaseQuery] = useState("")
  const { toast } = useToast()

  // --- Data Loading ---

  const loadProviders = useCallback(async () => {
    if (!apiKey) {
      setProviders([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await fetch(`/api/providers/list?apiKey=${encodeURIComponent(apiKey)}`)
      if (response.ok) {
        const data = await response.json()
        setProviders(data.providers || [])
        setUniApiBaseUrl(data.uniApiBaseUrl || "")
      } else {
        toast({
          title: "错误",
          description: `加载渠道配置失败 (${response.status})`,
          variant: "destructive",
        })
        setProviders([])
      }
    } catch (error) {
      console.error("加载渠道配置时发生错误:", error)
      toast({
        title: "错误",
        description: "加载渠道配置时发生网络或解析错误",
        variant: "destructive",
      })
      setProviders([])
    } finally {
      setLoading(false)
    }
  }, [apiKey, toast])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  // 所有展示模型名（uni-api 客户端侧模型名），去重并排序
  const allModels = useMemo(
    () =>
      providers
        .flatMap((p) => p.models.map((m) => m.display))
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort(),
    [providers],
  )

  // Base URL 选项：uni-api 网关 + 各渠道（自定义地址由输入框提供）
  const baseUrlOptions: BaseUrlOption[] = useMemo(() => {
    const opts: BaseUrlOption[] = [
      {
        key: "__uni_api__",
        label: uniApiBaseUrl || "uni-api 网关",
        baseUrl: uniApiBaseUrl,
        api: apiKey,
        models: allModels,
      },
    ]
    for (const p of providers) {
      const api = Array.isArray(p.api) ? p.api[0] : p.api
      if (!p.base_url || !api) continue
      opts.push({
        key: p.base_url,
        label: p.base_url,
        baseUrl: p.base_url,
        api,
        models: p.models.map((m) => m.original),
      })
    }
    return opts
  }, [providers, allModels, apiKey, uniApiBaseUrl])

  const isCustom = selectedBase === "__custom__"
  const selectedOption = baseUrlOptions.find((o) => o.key === selectedBase)
  const currentModels = isCustom ? customModels : selectedOption?.models || []
  const effectiveBaseUrl = isCustom ? customBaseUrl : selectedOption?.baseUrl || ""
  const effectiveApi = isCustom ? apiKey : selectedOption?.api || ""
  const selectedLabel = isCustom
    ? customBaseUrl || "请输入自定义 Base URL"
    : selectedOption?.label || "选择 Base URL"
  const predefinedLabels = baseUrlOptions.map((o) => o.label)

  // --- Handlers ---

  const handleBaseChange = (key: string) => {
    setSelectedBase(key)
    setSelectedModels([])
    setResults({})
    setOpenResults({})
  }

  const handleEndpointChange = (value: string) => {
    setEndpoint(value)
  }

  const toggleModel = (model: string, checked: boolean) => {
    if (checked) {
      setSelectedModels((prev) => (prev.includes(model) ? prev : [...prev, model]))
    } else {
      setSelectedModels((prev) => prev.filter((x) => x !== model))
    }
  }

  const handleSelectAll = (checked: boolean) => {
    setSelectedModels(checked ? [...currentModels] : [])
  }

  const loadCustomModels = async (url?: string) => {
    const targetUrl = url || customBaseUrl
    if (!targetUrl) {
      toast({ title: "提示", description: "请先输入自定义 Base URL", variant: "destructive" })
      return
    }
    setCustomLoading(true)
    setCustomModels([])
    try {
      const response = await fetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, base_url: targetUrl, api: apiKey }),
      })
      const data = await response.json()
      if (data.success) {
        setCustomModels(data.models || [])
        setSelectedModels([])
        toast({ title: "成功", description: `已加载 ${data.models?.length ?? 0} 个模型` })
      } else {
        toast({ title: "错误", description: data.message || "加载模型失败", variant: "destructive" })
        setCustomModels([])
      }
    } catch (error: any) {
      toast({ title: "错误", description: error.message || "加载模型失败", variant: "destructive" })
      setCustomModels([])
    } finally {
      setCustomLoading(false)
    }
  }

  const allChecked = currentModels.length > 0 && selectedModels.length === currentModels.length
  const someChecked = selectedModels.length > 0 && selectedModels.length < currentModels.length

  const testReal = async () => {
    if (!selectedOption && !isCustom) {
      toast({ title: "提示", description: "请选择测试 Base URL", variant: "destructive" })
      return
    }
    if (isCustom && !customBaseUrl) {
      toast({ title: "提示", description: "请先输入自定义 Base URL", variant: "destructive" })
      return
    }
    if (selectedModels.length === 0) {
      toast({ title: "提示", description: "请先选择模型", variant: "destructive" })
      return
    }
    setTesting(true)
    setResults({})
    setOpenResults({})
    for (const model of selectedModels) {
      let result: TestResult
      try {
        const response = await fetch("/api/providers/test-real", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey,
            baseUrl: effectiveBaseUrl,
            api: effectiveApi,
            model,
            endpoint,
          }),
        })
        result = await response.json()
      } catch (error: any) {
        result = { success: false, message: error.message || "测试请求失败" }
      }
      setResults((prev) => ({ ...prev, [model]: result }))
    }
    setTesting(false)
  }

  const prettyJson = (text: string): string => {
    if (!text) return "(空)"
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }

  // --- Render ---

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">真实测试</h2>
        <p className="text-sm text-muted-foreground">选择目标 Base URL 与端点，按需勾选模型进行真实请求测试。</p>
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-6 space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-1/3" />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-end gap-3">
              {/* 测试 Base URL：可下拉选择，也可直接输入自定义地址 */}
              <div className="w-full sm:w-72 space-y-1">
                <Label className="text-xs">测试 Base URL</Label>
                <Popover open={baseOpen} onOpenChange={setBaseOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={baseOpen}
                      className="h-9 w-full justify-between text-xs font-normal"
                      disabled={testing}
                    >
                      <span className="truncate font-mono">{selectedLabel}</span>
                      <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        value={baseQuery}
                        onValueChange={setBaseQuery}
                        placeholder="输入或选择 Base URL…"
                        className="h-9 text-xs"
                      />
                      <CommandList>
                        <CommandEmpty className="py-2 text-center text-xs text-muted-foreground">
                          无匹配项，可直接使用下方输入值
                        </CommandEmpty>
                        <CommandGroup>
                          {baseQuery.trim() && !predefinedLabels.includes(baseQuery.trim()) && (
                            <CommandItem
                              value="__custom_query__"
                              onSelect={() => {
                                handleBaseChange("__custom__")
                                setCustomBaseUrl(baseQuery.trim())
                                setBaseOpen(false)
                                setBaseQuery("")
                                loadCustomModels(baseQuery.trim())
                              }}
                              className="text-xs"
                            >
                              使用自定义：<span className="font-mono truncate">{baseQuery.trim()}</span>
                            </CommandItem>
                          )}
                          {baseUrlOptions.map((o) => (
                            <CommandItem
                              key={o.key}
                              value={o.key}
                              onSelect={() => {
                                handleBaseChange(o.key)
                                setBaseOpen(false)
                                setBaseQuery("")
                              }}
                              className="text-xs"
                            >
                              <span className="font-mono truncate">{o.label}</span>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              {/* 端点 */}
              <div className="w-full sm:w-44 space-y-1">
                <Label className="text-xs">端点</Label>
                <Select value={endpoint} onValueChange={handleEndpointChange} disabled={testing}>
                  <SelectTrigger className="h-9 text-xs w-full">
                    <SelectValue placeholder="选择端点" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chat/completions" className="text-xs">chat/completions</SelectItem>
                    <SelectItem value="responses" className="text-xs">responses</SelectItem>
                    <SelectItem value="messages" className="text-xs">messages</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* 模型多选 */}
              <div className="flex-1 min-w-0 space-y-1">
                <Label className="text-xs">模型</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 w-full max-w-full justify-start text-xs font-normal"
                      disabled={testing || customLoading || currentModels.length === 0}
                    >
                      {selectedModels.length > 0 ? (
                        <span className="w-full truncate font-mono">
                          {selectedModels.join(", ")}
                        </span>
                      ) : customLoading ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          加载模型中...
                        </span>
                      ) : currentModels.length > 0 ? (
                        "选择模型"
                      ) : (
                        "无可用模型"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <label className="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium hover:bg-muted cursor-pointer">
                      <Checkbox
                        checked={allChecked ? true : someChecked ? "indeterminate" : false}
                        onCheckedChange={(c) => handleSelectAll(c === true)}
                      />
                      <span>全选</span>
                    </label>
                    <div className="max-h-64 overflow-y-auto p-1">
                      {currentModels.map((m) => (
                        <label key={m} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted cursor-pointer">
                          <Checkbox
                            checked={selectedModels.includes(m)}
                            onCheckedChange={(c) => toggleModel(m, c === true)}
                          />
                          <span className="font-mono">{m}</span>
                        </label>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>

              {/* 测试按钮 */}
              <Button onClick={testReal} disabled={testing || selectedModels.length === 0} size="sm" className="h-9">
                {testing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                {testing ? "测试中..." : "测试"}
              </Button>
            </div>

            {/* 结果列表 */}
            {Object.keys(results).length > 0 && (
              <div className="space-y-2">
                {selectedModels.map((model) => {
                  const r = results[model]
                  if (!r) return null
                  return (
                    <Collapsible
                      key={model}
                      open={openResults[model] ?? false}
                      onOpenChange={(open) => setOpenResults((prev) => ({ ...prev, [model]: open }))}
                      className="rounded-md border"
                    >
                      <CollapsibleTrigger asChild>
                        <button className="flex w-full items-center gap-2 flex-wrap text-sm px-3 py-2 rounded-md hover:bg-muted">
                          <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${openResults[model] ? "rotate-180" : ""}`} />
                          <span className="font-mono text-xs">{model}</span>
                          {r.success ? (
                            <Badge className="bg-green-100 text-green-700 border border-green-200 hover:bg-green-200">成功</Badge>
                          ) : (
                            <Badge variant="destructive">失败</Badge>
                          )}
                          {r.message && <span className="text-xs text-muted-foreground">{r.message}</span>}
                          {r.responseTime != null && (
                            <span className="text-xs text-muted-foreground">耗时 {formatTime(r.responseTime)}</span>
                          )}
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="px-3 pb-3">
                          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            {r.request && (
                              <div className="space-y-1">
                                <div className="text-xs font-medium">发送的请求</div>
                                <div className="rounded-md border bg-muted/50 p-3 text-xs font-mono overflow-auto max-h-96">
                                  <div className="mb-2 break-all">{r.request.method} {r.request.url}</div>
                                  <pre className="whitespace-pre-wrap break-all">{JSON.stringify({ headers: r.request.headers, body: r.request.body }, null, 2)}</pre>
                                </div>
                              </div>
                            )}
                            {r.response && (
                              <div className="space-y-1">
                                <div className="text-xs font-medium">返回内容 (HTTP {r.response.status})</div>
                                <div className="rounded-md border bg-muted/50 p-3 text-xs font-mono overflow-auto max-h-96">
                                  <pre className="whitespace-pre-wrap break-all">{prettyJson(r.response.body)}</pre>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}