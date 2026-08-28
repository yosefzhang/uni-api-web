import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const STATS_DB_PATH = process.env.STATS_DB_PATH || path.join(process.cwd(), '..', 'data', 'stats.db');

interface QueryOptions {
  sql: string;
  params: any[];
}

export function queryRows({ sql, params }: QueryOptions): Record<string, unknown>[] {
  if (!fs.existsSync(STATS_DB_PATH)) {
    return [];
  }
  const db = new Database(STATS_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows;
  } finally {
    db.close();
  }
}

export { STATS_DB_PATH };
