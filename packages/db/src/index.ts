import { eq, sql } from "drizzle-orm";
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

/** Balance in micro-USD from the source of truth: credits minus billed usage. */
export async function balanceMicroUsd(db: Db, userId: string): Promise<number> {
  const [credits] = await db
    .select({ v: sql<string>`coalesce(sum(${schema.creditTransactions.amountMicroUsd}), 0)` })
    .from(schema.creditTransactions)
    .where(eq(schema.creditTransactions.userId, userId));
  const [usage] = await db
    .select({ v: sql<string>`coalesce(sum(${schema.usageEvents.costMicroUsd}), 0)` })
    .from(schema.usageEvents)
    .where(eq(schema.usageEvents.userId, userId));
  return Number(credits?.v ?? 0) - Number(usage?.v ?? 0);
}
