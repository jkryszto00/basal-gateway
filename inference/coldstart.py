"""Measure cold start and warm latency of a deployed basal endpoint.

  MODAL_PROXY_TOKEN=<wk-id>.<ws-secret> uv run coldstart.py --url https://<workspace>--basal-1-5-4-5b-fast-basal-web.modal.run

The first request is timed end to end (includes a cold start when no container is running: wait longer than
scaledown_window, 60 s, or stop the container with `modal container stop <id>`). Then --warm sequential requests
give p50 / p95 of a warm container. --rounds N repeats the whole thing, idling --idle seconds in between so the
container scales to zero.
"""
import argparse
import json
import os
import statistics
import time
import urllib.request

REQUEST = {
    "state": "Zgłoszenie z oddziału w Gdańsku: od 7:40 nie działa żaden terminal płatniczy, klienci odchodzą od kas, "
             "kolejka na 30 osób. Obejście: tylko gotówka.",
    "questions": {
        "urgency": {"type": "score", "instructions": "Jak pilne jest to zgłoszenie?",
                    "criteria": ["niska", "średnia", "wysoka", "krytyczna"]},
        "cards": {"type": "noul", "instructions": "Czy problem dotyczy płatności kartą?"},
    },
}


class Redirects(urllib.request.HTTPRedirectHandler):
    # Modal answers a request still running after 150 s with a 303 to its result URL; urllib follows only 4 by default
    max_repeats = 20
    max_redirections = 40


opener = urllib.request.build_opener(Redirects)


def call(url, token, path="/v1/systemone", body=REQUEST, timeout=1800):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url.rstrip("/") + path, data=data, method="POST" if data else "GET",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
    t0 = time.perf_counter()
    with opener.open(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return (time.perf_counter() - t0) * 1000, out


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(p / 100 * (len(xs) - 1)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--token", default=os.environ.get("MODAL_PROXY_TOKEN"), help="Modal proxy token <wk-id>.<ws-secret>")
    ap.add_argument("--warm", type=int, default=20)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--idle", type=int, default=120, help="seconds between rounds (> scaledown_window)")
    a = ap.parse_args()
    if not a.token:
        raise SystemExit("set MODAL_PROXY_TOKEN or pass --token")

    for r in range(a.rounds):
        if r:
            print(f"idle {a.idle}s so the container scales to zero ...", flush=True)
            time.sleep(a.idle)
        first, out = call(a.url, a.token)
        _, health = call(a.url, a.token, "/health", None)
        warm = [call(a.url, a.token)[0] for _ in range(a.warm)]
        server = out["usage"]["latency_ms"]
        print(f"round {r + 1}: first request {first / 1000:.1f}s | warm p50 {statistics.median(warm):.0f} ms "
              f"p95 {pct(warm, 95):.0f} ms (server {server} ms) | {health}")
    print("answers:", json.dumps(out["answers"], ensure_ascii=False))


if __name__ == "__main__":
    main()
