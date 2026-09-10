import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const STATS_DB_PATH = process.env.STATS_DB_PATH || path.join(process.cwd(), '..', 'data', 'stats.db');

// 使用一个缓存数据库连接
let cachedDb: Database.Database | null = null;

interface QueryOptions {
  sql: string;
  params: any[];
}

function getDb(): Database.Database | null {
  if (cachedDb) {
    return cachedDb;
  }
  if (!fs.existsSync(STATS_DB_PATH)) {
    return null;
  }
  cachedDb = new Database(STATS_DB_PATH, { readonly: true, fileMustExist: true });
  cachedDb.pragma('journal_mode = WAL');
  cachedDb.pragma('synchronous = NORMAL');
  return cachedDb;
}

export function queryRows({ sql, params }: QueryOptions): Record<string, unknown>[] {
  const db = getDb();
  if (!db) {
    return [];
  }
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows;
  } catch (e) {
    console.error('查询数据库失败:', e);
    return [];
  }
}

export { STATS_DB_PATH };
