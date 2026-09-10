"use client"

import { OverviewStats } from "@/components/overview-stats"
import { ModelStats } from "@/components/model-stats"
import { ChannelStats } from "@/components/channel-stats"
import { DetailedLogs } from "@/components/detailed-logs"

interface StatsViewerProps {
  apiKey: string
}

export function StatsViewer({ apiKey }: StatsViewerProps) {
  return (
    <div className="space-y-6">
      {/* 详细日志优先加载显示 */}
      <div id="logs">
        <DetailedLogs apiKey={apiKey} />
      </div>
      <div id="overview">
        <OverviewStats apiKey={apiKey} />
      </div>
      <div id="models">
        <ModelStats apiKey={apiKey} />
      </div>
      <div id="channels">
        <ChannelStats apiKey={apiKey} />
      </div>
    </div>
  )
}
