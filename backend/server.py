"""
AudioVis local texture server — sd-turbo on Apple MPS (or CUDA/CPU).

One process: FastAPI + a single worker thread that owns the diffusion
pipeline. The frontend asks for a texture by cache key + prompt; results are
PNGs on disk, served statically, so every mood/palette combo is generated
exactly once and reused forever after.

Run:
    backend/.venv/bin/python backend/server.py
First run downloads the sd-turbo model (~2.5 GB) into ~/.cache/huggingface.
"""

import queue
import re
import threading
import time
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

TEXTURE_DIR = Path(__file__).parent / "textures"
TEXTURE_DIR.mkdir(exist_ok=True)

PORT = 8787  # not 5000 — macOS AirPlay Receiver squats on that
SIZE = 512
DEFAULT_STEPS = 2  # sd-turbo is built for 1–4 steps
KEY_RE = re.compile(r"^[a-z0-9_-]{1,80}$")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local-only server; the frontend runs on another port
    allow_methods=["*"],
    allow_headers=["*"],
)

state = {"ready": False, "device": "?", "error": ""}
jobs = {}  # key -> {status, error}
work = queue.Queue()  # (key, prompt, steps)
lock = threading.Lock()


class GenerateBody(BaseModel):
    key: str
    prompt: str
    steps: Optional[int] = None


def texture_path(key: str) -> Path:
    return TEXTURE_DIR / f"{key}.png"


def worker() -> None:
    """Owns the pipeline. Loads the model once, then drains the queue."""
    import torch
    from diffusers import AutoPipelineForText2Image

    if torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    elif torch.cuda.is_available():
        device, dtype = "cuda", torch.float16
    else:
        device, dtype = "cpu", torch.float32

    print(f"[worker] loading sd-turbo on {device} (first run downloads ~2.5 GB)...")
    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            "stabilityai/sd-turbo", torch_dtype=dtype
        )
        pipe.to(device)
        pipe.set_progress_bar_config(disable=True)
        # Trades a little speed for much lower memory pressure — keeps
        # generation from starving the WebGL renderer sharing this GPU.
        pipe.enable_attention_slicing()
    except Exception as e:  # noqa: BLE001
        state["error"] = f"model load failed: {e}"
        print(f"[worker] FATAL: {state['error']}")
        return

    state["device"] = device
    state["ready"] = True
    print(f"[worker] ready on {device} — waiting for jobs")

    while True:
        key, prompt, steps = work.get()
        t0 = time.time()
        try:
            image = pipe(
                prompt,
                num_inference_steps=steps,
                guidance_scale=0.0,  # sd-turbo works without CFG
                height=SIZE,
                width=SIZE,
            ).images[0]
            image.save(texture_path(key))
            with lock:
                jobs[key] = {"status": "done"}
            print(f"[worker] {key} done in {time.time() - t0:.1f}s  ({prompt[:60]}...)")
        except Exception as e:  # noqa: BLE001
            with lock:
                jobs[key] = {"status": "failed", "error": str(e)}
            print(f"[worker] {key} FAILED: {e}")


@app.get("/health")
def health():
    return {
        "ok": True,
        "ready": state["ready"],
        "device": state["device"],
        "queue": work.qsize(),
        "error": state["error"],
    }


@app.post("/generate")
def generate(body: GenerateBody):
    key = body.key.lower()
    if not KEY_RE.match(key):
        return {"status": "failed", "error": "bad key"}
    if texture_path(key).exists():
        return {"status": "done", "url": f"/textures/{key}.png"}
    with lock:
        job = jobs.get(key)
        if job and job["status"] in ("queued", "working"):
            return {"status": job["status"]}
        jobs[key] = {"status": "queued"}
    work.put((key, body.prompt, body.steps or DEFAULT_STEPS))
    return {"status": "queued"}


@app.get("/status/{key}")
def status(key: str):
    key = key.lower()
    if not KEY_RE.match(key):
        return {"status": "failed", "error": "bad key"}
    if texture_path(key).exists():
        return {"status": "done", "url": f"/textures/{key}.png"}
    with lock:
        job = jobs.get(key)
    if not job:
        return {"status": "unknown"}
    resp = {"status": job["status"]}
    if "error" in job:
        resp["error"] = job["error"]
    return resp


app.mount("/textures", StaticFiles(directory=TEXTURE_DIR), name="textures")

if __name__ == "__main__":
    threading.Thread(target=worker, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
