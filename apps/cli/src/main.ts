// Admin CLI: `bun run admin <command>` from the repository root (reads its .env). `bun run admin help` lists commands.
import { parseArgs } from "node:util";
import { createDb } from "@basal/db";
import { Redis } from "ioredis";
import {
  addUser,
  type Ctx,
  deleteUser,
  listKeys,
  listUsers,
  revokeKey,
  usageReport,
  verifyUser,
} from "./commands";

const HELP = `Usage: bun run admin <command>

  users                                   list accounts
  users add <email> [--name N] [--password P]
                                          create an account with a confirmed email (prints a generated password)
  users verify <email>                    mark an account's email as confirmed
  users delete <email> --yes              delete an account with its keys and usage
  keys <email>                            list an account's API keys
  keys revoke <key-id>                    revoke an API key at once
  usage [--days 30] [--csv]               requests, decisions and tokens per account and model`;

type Row = Record<string, unknown>;

const cell = (v: unknown) =>
  v === null || v === undefined ? "–" : v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : String(v);

function table(rows: Row[]) {
  if (!rows.length) return console.log("(none)");
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i]!)).join("  ").trimEnd();
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => cell(r[c]))));
}

function csv(rows: Row[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = cell(v) === "–" ? "" : cell(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  console.log(cols.join(","));
  for (const r of rows) console.log(cols.map((c) => esc(r[c])).join(","));
}

async function run(ctx: Ctx, argv: string[]) {
  const { positionals: args, values: opts } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      password: { type: "string" },
      days: { type: "string", default: "30" },
      csv: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  const [cmd, sub, arg] = args;
  if (cmd === "users" && !sub) return table(await listUsers(ctx));
  if (cmd === "users" && sub === "add" && arg) {
    const created = await addUser(ctx, arg, { name: opts.name, password: opts.password });
    console.log(`created ${created.email}`);
    if (created.password) console.log(`password: ${created.password}   (shown once; change it in Settings)`);
    return;
  }
  if (cmd === "users" && sub === "verify" && arg) return (await verifyUser(ctx, arg), console.log(`confirmed ${arg}`));
  if (cmd === "users" && sub === "delete" && arg) {
    if (!opts.yes) throw new Error("deleting removes the account, its keys and usage; add --yes to confirm");
    return (await deleteUser(ctx, arg), console.log(`deleted ${arg}`));
  }
  if (cmd === "keys" && sub === "revoke" && arg) return (await revokeKey(ctx, arg), console.log(`revoked ${arg}`));
  if (cmd === "keys" && sub) return table(await listKeys(ctx, sub));
  if (cmd === "usage") {
    const days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1) throw new Error("--days takes a whole number of days");
    const rows = await usageReport(ctx, days);
    return opts.csv ? csv(rows) : table(rows);
  }
  console.log(HELP);
  if (cmd && cmd !== "help") process.exitCode = 1;
}

const db = createDb();
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true });
try {
  await run({ db, redis }, process.argv.slice(2));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  redis.disconnect();
  await db.$client.end();
}
