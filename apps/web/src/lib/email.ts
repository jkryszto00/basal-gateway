import "server-only";
import { createTransport, type Transporter } from "nodemailer";
import { APP_NAME } from "./app-name";

// Transactional email: SMTP when SMTP_URL is set (smtp://user:pass@host:587, smtps://… for TLS on 465), else
// Resend's HTTP API with RESEND_API_KEY, else printed to the server log, so sign up and password reset work locally
// without an email account.
const SMTP_URL = process.env.SMTP_URL;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? `${APP_NAME} <noreply@localhost>`;

/**
 * Accounts must confirm their email before signing in (default). EMAIL_VERIFICATION=false for installs that cannot
 * send email, e.g. on an internal network: accounts work right after sign up.
 */
export const EMAIL_VERIFICATION = !["false", "0", "no", "off"].includes(
  (process.env.EMAIL_VERIFICATION ?? "true").toLowerCase(),
);

type Email = { to: string; subject: string; text: string; html: string };

let smtp: Transporter | undefined;

export async function sendEmail(email: Email) {
  if (SMTP_URL) {
    smtp ??= createTransport(SMTP_URL);
    await smtp.sendMail({ from: EMAIL_FROM, ...email });
    return;
  }
  if (RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    return;
  }
  console.info(`[email] to ${email.to}: ${email.subject}\n${email.text}`);
}

/** Logs instead of throwing: a failed send must not fail the sign up, the user can ask for a new link. */
export async function trySendEmail(email: Email) {
  try {
    await sendEmail(email);
  } catch (e) {
    console.error(`[email] sending "${email.subject}" failed`, e);
  }
}

// Only fixed text and our own links go into the messages: user-chosen fields such as the name are left out, so an
// attacker cannot use sign up to send arbitrary text from our domain.
function linkEmail(to: string, subject: string, intro: string, action: string, url: string, outro: string): Email {
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1c1917;max-width:480px">
<p>${intro}</p>
<p><a href="${url}" style="display:inline-block;background:#0a7d5a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">${action}</a></p>
<p style="color:#78716c;font-size:13px">${outro}<br>If the button does not work, open this link:<br><a href="${url}" style="color:#78716c;word-break:break-all">${url}</a></p>
</div>`;
  return { to, subject, html, text: `${intro}\n\n${action}: ${url}\n\n${outro}` };
}

export const verificationEmail = (to: string, url: string) =>
  linkEmail(
    to,
    `Confirm your email for ${APP_NAME}`,
    `Confirm your email address to activate your ${APP_NAME} account.`,
    "Confirm email",
    url,
    "The link expires in 24 hours. If you did not create an account, ignore this email.",
  );

// The organization's name and the inviter are left out on purpose (both chosen by users); the invitation page shows
// them once the recipient has signed in.
export const invitationEmail = (to: string, url: string) =>
  linkEmail(
    to,
    `You are invited to an organization on ${APP_NAME}`,
    `Someone invited you to join their organization on ${APP_NAME}, to use its API keys and see its usage.`,
    "See the invitation",
    url,
    "The invitation expires in 7 days. Sign in or create an account with this email address to accept it.",
  );

export const resetPasswordEmail = (to: string, url: string) =>
  linkEmail(
    to,
    `Reset your ${APP_NAME} password`,
    `Someone asked to reset the password of your ${APP_NAME} account.`,
    "Choose a new password",
    url,
    "The link expires in 1 hour and works once. If you did not ask for it, ignore this email: your password stays the same.",
  );
