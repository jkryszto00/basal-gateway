"""basal-serve on Modal: scale to zero, GPU memory snapshot of the compiled model.

The basal `Server` (model load, torch.compile, CUDA graph capture for every shape) is built in
`@modal.enter(snap=True)`, so a cold start restores the snapshot instead of compiling again. The HTTP API is the
same as `basal-serve` (POST /v1/systemone, POST /v1/basal, GET /v1/models, GET /health).

Access needs a Modal proxy token (`requires_proxy_auth`): Modal checks it at its edge, so an unauthenticated request
is refused with 401 without waking a GPU container. Send `Authorization: Bearer <wk-id>.<ws-secret>`
(`modal workspace proxy-tokens create`). Tokens are rotated in Modal without a redeploy.

Configuration (read at deploy time and baked into the image env, so the container sees the same values):
  BASAL_MODEL   Hugging Face repo id            default Remek/basal-1.5-4.5B
  BASAL_MODE    basal-serve mode                default fast-nocompile (or fast: torch.compile, 27 min build)
  BASAL_GPU     Modal GPU type                  default L4
  BASAL_MAX_CONTAINERS                          default 1 (cost guard while we live on free credits)

  uv run modal deploy modal_app.py
  BASAL_MODE=fast uv run modal deploy modal_app.py   # separate app, for comparison
"""
import os
import time

import modal

MODEL = os.environ.get("BASAL_MODEL", "Remek/basal-1.5-4.5B")
MODE = os.environ.get("BASAL_MODE", "fast-nocompile")
GPU = os.environ.get("BASAL_GPU", "L4")
MAX_CONTAINERS = int(os.environ.get("BASAL_MAX_CONTAINERS", "1"))
BASAL_REF = "v1.5.0"

SLUG = MODEL.rstrip("/").split("/")[-1].lower().replace(".", "-")
CACHE = "/cache"
GPU_KEY = GPU.lower().replace(":", "x")  # compiled kernels are only valid on the GPU type that built them

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("build-essential")  # torch.compile (inductor / triton) needs a C compiler
    # torch first, from the CUDA 12.8 index (basal README: PyPI's newest torch may need a newer driver)
    .uv_pip_install("torch==2.11.0", index_url="https://download.pytorch.org/whl/cu128")
    .uv_pip_install(f"basal @ https://github.com/rkinas/basal/archive/refs/tags/{BASAL_REF}.tar.gz")
    .env({
        "BASAL_MODEL": MODEL,
        "BASAL_MODE": MODE,
        "BASAL_GPU": GPU,
        "BASAL_MAX_CONTAINERS": str(MAX_CONTAINERS),
        "HF_HOME": f"{CACHE}/hf",
        # fallback when a snapshot has to be (re)created: the compile cache survives on the volume
        "TORCHINDUCTOR_CACHE_DIR": f"{CACHE}/inductor/{GPU_KEY}",
        "TRITON_CACHE_DIR": f"{CACHE}/triton/{GPU_KEY}",
        "TORCHINDUCTOR_COMPILE_THREADS": "1",  # Modal docs: avoids snapshot failures after torch.compile
    })
)

app = modal.App(f"{SLUG}-{MODE}")
volume = modal.Volume.from_name("basal-cache", create_if_missing=True)

WARMUP = {
    "state": "Klient: od wczoraj nie mogę zalogować się do bankowości internetowej, system pokazuje błąd hasła.",
    "questions": {"dept": {"type": "choice", "instructions": "Do którego działu skierować zgłoszenie?",
                           "criteria": {"cards": "Reklamacje kart", "online": "Wsparcie bankowości elektronicznej",
                                        "loans": "Kredyty"}}},
}


@app.cls(
    gpu=GPU,
    image=image,
    volumes={CACHE: volume},
    # idle seconds before scaling to zero: every wake-up bills ~this long on top of the request; a cold start from
    # the GPU snapshot takes 7-21 s, so a short window costs little latency
    scaledown_window=60,
    max_containers=MAX_CONTAINERS,
    timeout=60,
    startup_timeout=30 * 60,  # first compile of the 4.5B model takes minutes
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
@modal.concurrent(max_inputs=64)  # basal batches concurrent requests itself (--max-batch 64)
class Basal:
    @modal.enter(snap=True)
    def load(self):
        import asyncio

        from basal.server import Server, parser

        t0 = time.perf_counter()
        self.srv = Server(parser().parse_args(["--model", MODEL, "--mode", MODE]))
        self.load_s = round(time.perf_counter() - t0, 1)

        async def warm():  # one real request through the whole path before the snapshot is taken
            task = asyncio.get_running_loop().create_task(self.srv.worker())
            try:
                await self.srv.decide(WARMUP)
            finally:
                task.cancel()

        asyncio.run(warm())
        self.srv.queue = asyncio.Queue()  # the warm-up queue is bound to a closed event loop
        volume.commit()
        print(f"basal: {MODEL} mode {MODE} on {GPU} loaded in {self.load_s}s", flush=True)

    @modal.enter(snap=False)
    def started(self):
        self.started_at = time.time()

    @modal.asgi_app(requires_proxy_auth=True)
    def web(self):
        import asyncio
        import json
        from contextlib import asynccontextmanager

        from basal.server import models_payload
        from starlette.applications import Starlette
        from starlette.responses import JSONResponse
        from starlette.routing import Route

        srv = self.srv

        async def systemone(request):
            try:
                body = await request.json()
            except json.JSONDecodeError:
                return JSONResponse({"error": "invalid JSON"}, status_code=400)
            try:
                return JSONResponse(await srv.decide(body))
            except (ValueError, KeyError, TypeError) as e:  # bad request: not billable
                return JSONResponse({"error": str(e)}, status_code=422)
            except Exception as e:  # noqa: BLE001  engine failure: not the caller's fault
                return JSONResponse({"error": f"inference failed: {e}"}, status_code=500)

        async def models(_):
            return JSONResponse(models_payload(srv.name, MODE, getattr(srv.backend, "policies", {})))

        async def health(_):
            return JSONResponse({"status": "ok", "model": MODEL, "mode": MODE, "gpu": GPU,
                                 "load_s": self.load_s, "container_age_s": round(time.time() - self.started_at, 1)})

        @asynccontextmanager
        async def lifespan(_app):
            task = asyncio.get_running_loop().create_task(srv.worker())
            yield
            task.cancel()

        return Starlette(routes=[Route("/v1/systemone", systemone, methods=["POST"]),
                                 Route("/v1/basal", systemone, methods=["POST"]),
                                 Route("/v1/models", models), Route("/health", health)], lifespan=lifespan)
