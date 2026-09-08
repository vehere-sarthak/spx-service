import mysql from "mysql2/promise";
import { getMysqlConfig } from "./app-config";

const globalForMysql = globalThis as unknown as { __spiderxPool?: mysql.Pool };

export function mysqlPool() {
  if (!globalForMysql.__spiderxPool) {
    const m = getMysqlConfig();
    globalForMysql.__spiderxPool = mysql.createPool({
      host: m.host,
      port: m.port,
      user: m.user,
      password: m.password,
      database: m.database,
      waitForConnections: true,
      connectionLimit: m.connectionLimit,
      enableKeepAlive: true,
    });
  }
  return globalForMysql.__spiderxPool;
}

export async function sql<T = any>(query: string, params: any[] = []): Promise<T[]> {
  const [rows] = await mysqlPool().query(query, params);
  return rows as T[];
}

export async function sqlExec(query: string, params: any[] = []) {
  const [result] = await mysqlPool().execute(query, params);
  return result as mysql.ResultSetHeader;
}
