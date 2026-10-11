// Shown in the header, page titles and emails; set APP_NAME to brand your instance.
export const APP_NAME = process.env.APP_NAME ?? "basal gateway";

/** Public URL of the dashboard, for links in emails. */
export const APP_URL = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
