import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// Query helpers re-exported so apps share this package's drizzle-orm instance: a package manager can resolve a
// second copy with different peers (e.g. next to better-auth), whose column types are incompatible.
export { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
export * from "./schema";
export { schema };

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(postgres(url, { max: 10 }), { schema });
}

export type Db = ReturnType<typeof createDb>;
