import { handle } from "./mock";

const port = Number(process.env.MOCK_PORT ?? 8000);
Bun.serve({ port, fetch: handle });
console.log(`mock basal server on :${port} (made-up answers, no GPU)`);
