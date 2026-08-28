import { NextRequest, NextResponse } from 'next/server';
import { readConfig, findKey } from '@/lib/status-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const apiKey = body.apiKey;
    if (!apiKey) {
      return NextResponse.json({ valid: false, error: 'API Key is required' }, { status: 400 });
    }
    const { config } = readConfig();
    if (!Array.isArray(config.api_keys)) {
      return NextResponse.json({ valid: false, error: 'Invalid configuration' }, { status: 500 });
    }
    const entry = findKey(config, apiKey);
    if (entry) {
      return NextResponse.json({ valid: true, role: entry.role || 'user' });
    }
    return NextResponse.json({ valid: false });
  } catch (e: any) {
    return NextResponse.json({ valid: false, error: e.message }, { status: 500 });
  }
}
