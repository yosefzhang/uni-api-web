// API Key 编辑弹窗表单：仅使用 Input 和 Select，每项附 README 注释
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
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { RefreshCw } from "lucide-react"
import {
  TextField,
  FieldRow,
  SelectField,
  StringListField,
  modelToList,
  listToModel,
} from "./fields"

export interface ApiKeyItem {
  api?: string
  model?: any[]
  role?: string
  preferences?: any
  [key: string]: any
}

export function ApiKeyDialog({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: ApiKeyItem | null
  onSave: (item: ApiKeyItem) => void
}) {
  const [item, setItem] = useState<ApiKeyItem>({})
  const [modelList, setModelList] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setItem(initial ? { ...initial } : {})
    setModelList(modelToList(initial?.model))
  }, [open, initial])

  const update = (patch: Partial<ApiKeyItem>) => {
    setItem((prev) => ({ ...prev, ...patch }))
  }

  const updatePrefs = (patch: any) => {
    setItem((prev) => ({
      ...prev,
      preferences: { ...(prev.preferences || {}), ...patch },
    }))
  }

  const handleSave = () => {
    const result: ApiKeyItem = {
      ...item,
      model: listToModel(modelList),
      preferences: item.preferences && Object.keys(item.preferences).length > 0 ? item.preferences : undefined,
    }
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
            {initial?.api ? `编辑 API Key` : "新增 API Key"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto pl-1.5 pr-4">
          <div className="space-y-4 py-2">
            {/* ---------- 基础字段 ---------- */}
            <FieldRow id="key-api" label="api" required description="API Key，用户请求 uni-api 需要 API key，必填">
              <div className="flex gap-1.5">
                <Input
                  id="key-api"
                  value={item.api || ""}
                  onChange={(e) => update({ api: e.target.value })}
                  placeholder="sk-xxx"
                  className={`h-9 flex-1 font-mono text-xs`}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  onClick={() => {
                    const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
                    let key = "sk-"
                    for (let i = 0; i < 32; i++) {
                      key += chars[Math.floor(Math.random() * chars.length)]
                    }
                    update({ api: key })
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  随机生成
                </Button>
              </div>
            </FieldRow>
            <StringListField
              label="model"
              description="可用模型列表。支持：模型名（gpt-5.2）、provider/* 通配（gemini/*）、provider/model 精确（anthropic/claude-sonnet-4-5）、provider/*: 权重（gcp1/*: 5）、<model> 整体匹配"
              values={modelList}
              onChange={setModelList}
              placeholder="gpt-5.2 或 gemini/* 或 gcp1/*: 5"
              mono
            />
            <SelectField
              id="key-role"
              label="role"
              description="API key 的别名，请求日志会显示该别名。如果 role 为 admin，则仅有此 API key 可请求管理端点。如果都没有 admin，则默认第一个为 admin"
              value={item.role || ""}
              onChange={(v) => update({ role: v || undefined })}
              options={[
                { value: "admin", label: "admin（管理员）" },
              ]}
              placeholder="不设置（普通用户）"
            />

            <Separator />
            <p className="text-xs font-semibold text-muted-foreground">preferences（API Key 级，选填）</p>

            {/* ---------- preferences 字段 ---------- */}
            <SelectField
              id="pref-sched"
              label="SCHEDULING_ALGORITHM"
              description="调度算法，选填。缺省 fixed_priority。fixed_priority 固定优先级、round_robin 轮询、weighted_round_robin 加权轮询（需配合权重）、lottery 抽奖、random 随机"
              value={prefs.SCHEDULING_ALGORITHM || ""}
              onChange={(v) => updatePrefs({ SCHEDULING_ALGORITHM: v || undefined })}
              options={[
                { value: "fixed_priority", label: "fixed_priority（固定优先级）" },
                { value: "round_robin", label: "round_robin（轮询）" },
                { value: "weighted_round_robin", label: "weighted_round_robin（加权轮询）" },
                { value: "lottery", label: "lottery（抽奖）" },
                { value: "random", label: "random（随机）" },
                { value: "smart_round_robin", label: "smart_round_robin（智能调度）" },
              ]}
              placeholder="fixed_priority（默认）"
            />
            <SelectField
              id="pref-auto-retry"
              label="AUTO_RETRY"
              description="是否自动重试下一个提供商。true 自动重试，false 不自动重试，默认 true。也可设置为数字表示重试次数"
              value={
                prefs.AUTO_RETRY === true || prefs.AUTO_RETRY === undefined
                  ? "true"
                  : prefs.AUTO_RETRY === false
                  ? "false"
                  : String(prefs.AUTO_RETRY)
              }
              onChange={(v) => {
                if (v === "true") updatePrefs({ AUTO_RETRY: true })
                else if (v === "false") updatePrefs({ AUTO_RETRY: false })
                else updatePrefs({ AUTO_RETRY: Number(v) })
              }}
              options={[
                { value: "true", label: "true（自动重试，默认）" },
                { value: "false", label: "false（不重试）" },
                { value: "1", label: "1（重试 1 次）" },
                { value: "2", label: "2（重试 2 次）" },
                { value: "3", label: "3（重试 3 次）" },
              ]}
            />
            <TextField
              id="pref-rate-limit"
              label="rate_limit"
              description="限流，如 2/min、5/hour、10/day、10/month、10/year。默认 999999/min。支持多个频率约束：15/min,10/day"
              value={typeof prefs.rate_limit === "string" ? prefs.rate_limit : ""}
              onChange={(v) => updatePrefs({ rate_limit: v || undefined })}
              placeholder="15/min"
            />
            <SelectField
              id="pref-moderation"
              label="ENABLE_MODERATION"
              description="是否开启消息道德审查。开启后会对用户消息进行道德审查，需要 omni-moderation-latest 模型，默认 false"
              value={
                prefs.ENABLE_MODERATION === true ? "true" : "false"
              }
              onChange={(v) => updatePrefs({ ENABLE_MODERATION: v === "true" })}
              options={[
                { value: "false", label: "false（关闭，默认）" },
                { value: "true", label: "true（开启）" },
              ]}
            />
            <TextField
              id="pref-credits"
              label="credits"
              description="设置余额，单位美元，选填。默认无限余额。设为 0 则 key 不可用。用完后请求会被阻止。设置后需配合 created_at"
              value={prefs.credits != null ? String(prefs.credits) : ""}
              onChange={(v) => updatePrefs({ credits: v === "" ? undefined : Number(v) })}
              placeholder="10"
            />
            <TextField
              id="pref-created-at"
              label="created_at"
              description="当设置 credits 后必须设置，表示使用费用从该时间开始计算。默认从当前时间的第 30 天前开始计算"
              value={prefs.created_at ? String(prefs.created_at) : ""}
              onChange={(v) => updatePrefs({ created_at: v || undefined })}
              placeholder="2024-01-01T00:00:00+08:00"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!item.api}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
