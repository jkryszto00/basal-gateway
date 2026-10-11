// Admin CLI: `bun run admin <command>` from the repository root (reads its .env). `bun run admin help` lists commands.
import { parseArgs } from "node:util";
import { createDb } from "@basal/db";
import { Redis } from "ioredis";
import {
  addMember,
  addUser,
  type Ctx,
  deleteUser,
  disableUser,
  enableUser,
  inviteToSignUp,
  listKeys,
  listOrgs,
  listSignupInvitations,
  listUsers,
  revokeKey,
  setOrgQuota,
  usageReport,
  verifyUser,
} from "@basal/admin";

const HELP = `Usage: bun run admin <command>

  users                                   list accounts
  users add <email> [--name N] [--password P]
                                          create an account with a confirmed email and its personal organization
                                          (prints a generated password)
  users verify <email>                    mark an account's email as confirmed
  users disable <email> | enable <email>  a disabled account cannot sign in (its organizations' keys keep working)
  users invite <email>                    invite to sign up (SIGNUP_MODE=invite); prints the link to send
  users invitations                       pending sign up invitations
  users delete <email> --yes              delete an account with the organizations only it belongs to
  orgs                                    list organizations (slug, members, keys, last request)
  orgs add-member <org> <email> [--role member|admin|owner]
                                          add an existing account to an organization, no invitation
  orgs quota <org> [--requests N] [--tokens N]
                                          monthly quota (UTC month) of requests / input tokens; 0 clears
  keys <org>                              list an organization's API keys (org: slug or id)
  keys revoke <key-id>                    revoke an API key at once
  usage [--days 30] [--csv]               requests, decisions and tokens per organization and model`;

type Row = Record<string, unknown>;

const cell = (v: unknown) =>
  v === null || v === undefined ? "–" : v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : String(v);

function table(rows: Row[]) {
  if (!rows.length) return console.log("(none)");
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(width[i]!))
      .join("  ")
      .trimEnd();
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
      role: { type: "string", default: "member" },
      requests: { type: "string" },
      tokens: { type: "string" },
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
  if (cmd === "users" && (sub === "disable" || sub === "enable") && arg) {
    await (sub === "disable" ? disableUser : enableUser)(ctx, arg);
    return console.log(`${sub}d ${arg}`);
  }
  if (cmd === "users" && sub === "invite" && arg) {
    const inv = await inviteToSignUp(ctx, arg);
    const url = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
    return console.log(
      `invited ${inv.email} until ${inv.expiresAt.toISOString().slice(0, 10)}: ${url}/signup?email=${encodeURIComponent(inv.email)}`,
    );
  }
  if (cmd === "users" && sub === "invitations") return table(await listSignupInvitations(ctx));
  if (cmd === "users" && sub === "delete" && arg) {
    if (!opts.yes)
      throw new Error("deleting removes the account and the organizations only it belongs to; add --yes to confirm");
    return (await deleteUser(ctx, arg), console.log(`deleted ${arg}`));
  }
  if (cmd === "orgs" && !sub) return table(await listOrgs(ctx));
  if (cmd === "orgs" && sub === "add-member" && arg && args[3]) {
    await addMember(ctx, arg, args[3], opts.role);
    return console.log(`added ${args[3]} to ${arg} as ${opts.role}`);
  }
  if (cmd === "orgs" && sub === "quota" && arg) {
    const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
    const q = await setOrgQuota(ctx, arg, { requests: num(opts.requests), tokens: num(opts.tokens) });
    return console.log(`${arg}: ${q.requests ?? "default"} requests, ${q.tokens ?? "default"} input tokens per month`);
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
