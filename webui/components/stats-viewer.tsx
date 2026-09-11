"use client"

import { OverviewStats } from "@/components/overview-stats"
import { ModelStats } from "@/components/model-stats"
import { ChannelStats } from "@/components/channel-stats"

interface StatsViewerProps {
  apiKey: string
}

export function StatsViewer({ apiKey }: StatsViewerProps) {
  return (
    <div className="space-y-6">
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
