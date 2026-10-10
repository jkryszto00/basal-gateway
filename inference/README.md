# basal on Modal

A template for running [basal](https://github.com/rkinas/basal) (`basal-serve`) on [Modal](https://modal.com):
serverless GPU that scales to zero, with a GPU memory snapshot so a cold start restores the loaded model instead of
loading it again. Useful when traffic is low or bursty and you do not want a GPU running all the time.

One-time setup:

```bash
cd inference
uv sync
uv run modal setup                                              # log in (browser)
uv run modal workspace proxy-tokens create --name basal-gateway   # prints wk-… and ws-…, shown once
```

Deploy (basal-1.5 4.5B on an L4, `fast-nocompile`, scale to zero after 60 s idle, GPU memory snapshot, at most 1 container):

```bash
uv run modal deploy modal_app.py                                # app basal-1-5-4-5b-fast-nocompile
BASAL_MODE=fast uv run modal deploy modal_app.py                # torch.compile variant (27 min snapshot build on L4)
```

The first start compiles the model and captures CUDA graphs (several minutes), then Modal takes the snapshot.
Later cold starts restore it. Measure:

```bash
MODAL_PROXY_TOKEN=wk-….ws-… uv run coldstart.py --url <URL from modal deploy> --rounds 3
```

Each round waits until the container has scaled to zero (`--idle 120`), then times the first request (cold start)
and 20 warm requests (p50 / p95). `GET /health` shows the model, mode, GPU and the original load time.

Measured 2026-10 (basal-1.5 4.5B, L4, client in Poland):

| | `fast` (torch.compile) | `fast-nocompile` |
|---|---|---|
| first start, building the snapshot | 1613 s | 252 s |
| cold start from the GPU snapshot (first request, end to end, 3 runs) | not measured | **7–21 s** |
| warm, basal compute: 1 question / 2 questions | – | 60 ms / 83 ms |
| warm, end to end from Poland (`us-east` routing) | – | 430–600 ms |

`fast-nocompile` is the default: a snapshot rebuild (every redeploy or Modal platform update) costs 4 minutes of
L4 instead of 27, and the compute difference is small next to the network overhead. Most of the end-to-end time is
the route to Modal's `us-east`; `routing_region="eu-west"` + `region="eu"` (1.15× GPU price) would cut it if the
gateway runs in Europe.

The endpoint requires a Modal proxy token (`requires_proxy_auth=True`), sent as `Authorization: Bearer <wk-id>.<ws-secret>`
(the gateway's upstream `token`). Modal checks it at its edge: a request without it gets 401 and never wakes a GPU
container, so nobody can burn credits by calling the URL. Tokens are rotated with `modal workspace proxy-tokens`,
without a redeploy.

Settings: `BASAL_MODEL` (`Remek/basal-1.5-mini`, `Remek/basal-1.5-max` on `BASAL_GPU=L40S`), `BASAL_GPU`,
`BASAL_MAX_CONTAINERS`. Weights and the compile cache live on the Modal volume `basal-cache`.

Point the gateway at it with the URL from `modal deploy` and the proxy token:

```bash
UPSTREAMS={"basal-1.5":{"url":"https://<workspace>--basal-1-5-4-5b-fast-nocompile-basal-web.modal.run","token":"wk-….ws-…"}}
```
