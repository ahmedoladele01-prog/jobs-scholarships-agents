from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import os, requests, json
from datetime import datetime
from openai import OpenAI

app = FastAPI(title="Jobs & Scholarships API")
WORKER_URL = os.getenv("WORKER_URL", "http://worker:3000")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
client = OpenAI(api_key=OPENAI_API_KEY)

class ApplyPayload(BaseModel):
    url: str
    profile_id: str = "ahmed"
    target_role: str = "General Role"
    jd_text: str | None = None  # optional: provide JD text to tailor bullets

def tailor_bullets(jd_text: str, target_role: str):
    """Return exactly 3 crisp, metric-driven bullets aligned to the JD."""
    if not jd_text:
        return None
    prompt = f"""
You are a CV bullet writer. Write exactly 3 resume bullets for the target role "{target_role}".
Each bullet = Action + Metric/Outcome + Business impact. Keep each to one line, concise, no fluff.
Use the job description below as the only guidance:

JOB DESCRIPTION:
{jd_text}
"""
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role":"user","content": prompt}],
        temperature=0.4,
    )
    text = resp.choices[0].message.content.strip()
    raw = [l.strip("-• ").strip() for l in text.splitlines() if l.strip()]
    return raw[:3] if raw else None

def log_result(entry: dict):
    try:
        os.makedirs("/data/logs", exist_ok=True)
        with open("/data/logs/applications.jsonl", "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass

@app.get("/health")
def health():
    return {"ok": True, "service": "api"}

@app.post("/tasks/apply")
def tasks_apply(payload: ApplyPayload):
    try:
        bullets = tailor_bullets(payload.jd_text, payload.target_role) if payload.jd_text else None
        body = payload.model_dump() | ({"bullets": bullets} if bullets else {})
        r = requests.post(f"{WORKER_URL}/apply", json=body, timeout=180)
        r.raise_for_status()
        result = r.json()
        log_result({
            "ts": datetime.utcnow().isoformat(),
            "url": payload.url,
            "role": payload.target_role,
            "bullets": bullets,
            "result": result
        })
        return result | {"tailored_bullets": bullets}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ---- Bulk mode ----
class BulkItem(BaseModel):
    url: str
    role: str = "General Role"
    jd_text: str | None = None

class BulkPayload(BaseModel):
    targets: list[BulkItem]
    profile_id: str = "ahmed"
    limit: int = 10  # safety cap

@app.post("/bulk/apply")
def bulk_apply(payload: BulkPayload):
    results = []
    count = 0
    for t in payload.targets:
        if count >= payload.limit:
            break
        try:
            one = ApplyPayload(url=t.url, profile_id=payload.profile_id,
                               target_role=t.role, jd_text=t.jd_text)
            r = tasks_apply(one)
            results.append({"url": t.url, "role": t.role, "ok": True, "data": r})
        except Exception as e:
            results.append({"url": t.url, "role": t.role, "ok": False, "error": str(e)})
        count += 1
    summary = {"attempted": count, "success": sum(1 for x in results if x["ok"]), "failed": sum(1 for x in results if not x["ok"])}
    return {"summary": summary, "results": results}

@app.get("/report")
def report(n: int = 30):
    path = "/data/logs/applications.jsonl"
    if not os.path.exists(path):
        return {"entries": []}
    with open(path, "r") as f:
        lines = f.readlines()[-n:]
    return {"entries": [json.loads(x) for x in lines]}
