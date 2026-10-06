/** Minimal database surface the repo needs; Neon (prod/dev) and PGlite (tests) implement it. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  /** Run several statements (no parameters) - used by migrations. */
  exec(sql: string): Promise<void>;
  /** Run fn inside BEGIN/COMMIT; any throw rolls back. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Schemas {
  sidecar: string;
  mock: string;
}
