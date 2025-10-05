from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import os, requests

app = FastAPI(title="Jobs & Scholarships API")
WORKER_URL = os.getenv("WORKER_URL", "http://worker:3000")

@app.get("/health")
def health():
    return {"ok": True, "service": "api"}

class ApplyPayload(BaseModel):
    url: str
    profile_id: str = "ahmed"
    target_role: str = "General Role"
    jd_text: str | None = None  # (phase 2) supply JD text to tailor bullets

@app.post("/tasks/apply")
def tasks_apply(payload: ApplyPayload):
    try:
        r = requests.post(f"{WORKER_URL}/apply", json=payload.model_dump(), timeout=180)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
