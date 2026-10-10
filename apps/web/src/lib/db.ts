import "server-only";
import { createDb, type Db } from "@basal/db";

const g = globalThis as unknown as { __db?: Db };
export const db = (g.__db ??= createDb()); // one pool across dev hot reloads
