import fs from 'fs';
import path from 'path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const API_YAML_PATH = process.env.API_YAML_PATH || path.join(process.cwd(), '..', 'api.yaml');
const MODEL_CONTEXT_PATH =
  process.env.MODEL_CONTEXT_PATH ||
  path.join(process.cwd(), '..', 'data', 'model_extern_config.json');

export interface ApiKeyEntry {
  api: string;
  role?: string;
  name?: string;
  [key: string]: unknown;
}

export function readConfig(): { content: string; config: any } {
  const content = fs.readFileSync(API_YAML_PATH, 'utf-8');
  const config = yamlLoad(content) as any;
  return { content, config };
}

export function findKey(config: any, apiKey: string): ApiKeyEntry | null {
  const keys: any[] = config?.api_keys ?? [];
  for (const entry of keys) {
    if (entry.api === apiKey) return entry as ApiKeyEntry;
  }
  return null;
}

export function requireKey(apiKey: string | null): { entry: ApiKeyEntry; config: any } {
  if (!apiKey) {
    throw { status: 400, body: { error: 'API Key is required' } };
  }
  const { config } = readConfig();
  const entry = findKey(config, apiKey);
  if (!entry) {
    throw { status: 403, body: { error: 'Unauthorized' } };
  }
  return { entry, config };
}

export function requireAdmin(apiKey: string | null): { content: string; config: any } {
  const { entry, config } = requireKey(apiKey);
  if (entry.role !== 'admin') {
    throw { status: 403, body: { error: 'Unauthorized' } };
  }
  return readConfig();
}

export function writeConfig(content: string): void {
  fs.writeFileSync(API_YAML_PATH, content, 'utf-8');
}

export function readModelContext(): Record<string, any> {
  try {
    const content = fs.readFileSync(MODEL_CONTEXT_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      fs.mkdirSync(path.dirname(MODEL_CONTEXT_PATH), { recursive: true });
      fs.writeFileSync(MODEL_CONTEXT_PATH, '{}\n', 'utf-8');
      return {};
    }
    throw e;
  }
}

export function writeModelContext(data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(MODEL_CONTEXT_PATH), { recursive: true });
  fs.writeFileSync(MODEL_CONTEXT_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export { API_YAML_PATH, MODEL_CONTEXT_PATH };
