import { NextRequest, NextResponse } from 'next/server';
import { readConfig, findKey } from '@/lib/status-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const adminKey = body.adminKey;
    if (!adminKey) {
      return NextResponse.json({ error: 'Admin key is required' }, { status: 400 });
    }
    const { config } = readConfig();
    if (!Array.isArray(config.api_keys)) {
      return NextResponse.json({ error: 'Invalid configuration' }, { status: 500 });
    }
    const entry = findKey(config, adminKey);
    if (!entry || entry.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const keys = (config.api_keys as any[]).map((item) => {
      const key: any = { api: item.api || null, role: item.role || 'user' };
      if (item.name != null) key.name = item.name;
      return key;
    });
    return NextResponse.json({ keys });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
