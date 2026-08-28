import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, writeConfig } from '@/lib/status-config';
import { load as yamlLoad } from 'js-yaml';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = body.apiKey;
    const config = body.config;
    if (!apiKey || !config) {
      return NextResponse.json({ error: 'API Key and config are required' }, { status: 400 });
    }
    requireAdmin(apiKey);
    try {
      yamlLoad(config);
    } catch {
      return NextResponse.json({ error: 'Invalid YAML syntax' }, { status: 400 });
    }
    writeConfig(config);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json(e.body || { error: e.message }, { status: e.status || 500 });
  }
}
