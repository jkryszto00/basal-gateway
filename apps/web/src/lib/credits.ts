import "server-only";
import { creditTransactions } from "@basal/db";
import { db } from "./db";

// Credits granted to every new account once its email is confirmed; 0 (the default) grants nothing and an admin
// adds credits instead.
const SIGNUP_CREDIT = Number(process.env.SIGNUP_CREDIT_MICROUSD ?? 0);

/** Once per account (externalId makes the grant idempotent). Returns whether a credit was granted. */
export async function grantSignupCredit(user: { id: string; email: string }): Promise<boolean> {
  if (SIGNUP_CREDIT <= 0) return false;
  const rows = await db
    .insert(creditTransactions)
    .values({ userId: user.id, amountMicroUsd: SIGNUP_CREDIT, reason: "signup", externalId: `signup:${user.id}` })
    .onConflictDoNothing()
    .returning();
  return rows.length > 0;
}
