#!/usr/bin/env python3
"""Render a PDF next to every report page on the Absence Audit site.

Scope: c/<slug>/ concept reports (76), case-study, track-record.
PDFs land in the same folder as the page's index.html, named <slug>.pdf
(dossier convention). Renders via headless Chrome against the local
http.server (so absolute /style.css, /images, /fonts paths resolve).

Usage: python render_report_pdfs.py [--only <slug>] [--parallel N]
"""
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

SITE = r"C:\Users\jerid\absence-audit-site"
BASE = "http://127.0.0.1:8931"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

CANON_RE = re.compile(
    r'<link rel="canonical" href="[^"]*/([a-z0-9\-]+)/?"?>', re.I)

def slug_for(html_path):
    try:
        with open(html_path, encoding="utf-8") as f:
            head = f.read(6000)
        m = CANON_RE.search(head)
        if m:
            return m.group(1)
    except OSError:
        pass
    return os.path.basename(os.path.dirname(html_path))

def targets():
    out = []
    cdir = os.path.join(SITE, "c")
    for name in sorted(os.listdir(cdir)):
        p = os.path.join(cdir, name, "index.html")
        if os.path.isfile(p):
            out.append((p, slug_for(p)))
    for sec in ("case-study", "track-record"):
        p = os.path.join(SITE, sec, "index.html")
        if os.path.isfile(p):
            out.append((p, sec))
    return out

def render(item):
    html_path, slug = item
    pdf_path = os.path.join(os.path.dirname(html_path), slug + ".pdf")
    url = BASE + "/" + os.path.relpath(html_path, SITE).replace("\\", "/").rsplit("/index.html", 1)[0] + "/"
    t0 = time.time()
    r = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu",
         "--no-pdf-header-footer",
         "--virtual-time-budget=10000",
         "--run-all-compositor-stages-before-draw",
         f"--print-to-pdf={pdf_path}", url],
        capture_output=True, timeout=120)
    dt = time.time() - t0
    size = os.path.getsize(pdf_path) if os.path.exists(pdf_path) else 0
    ok = r.returncode == 0 and size > 25000
    return {"slug": slug, "ok": ok, "size": size, "secs": round(dt, 1),
            "rc": r.returncode, "err": r.stderr[-300:].decode(errors="replace") if not ok else ""}

def main():
    only = None
    parallel = 4
    args = sys.argv[1:]
    if "--only" in args:
        only = args[args.index("--only") + 1]
    if "--parallel" in args:
        parallel = int(args[args.index("--parallel") + 1])
    tgt = targets()
    if only:
        tgt = [t for t in tgt if t[1] == only]
    print(f"[render] {len(tgt)} pages, parallel={parallel}", flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=parallel) as ex:
        for res in ex.map(render, tgt):
            results.append(res)
            print(f"[{'OK ' if res['ok'] else 'FAIL'}] {res['slug']} "
                  f"{res['size']:,}B {res['secs']}s", flush=True)
    failed = [r for r in results if not r["ok"]]
    ok = [r for r in results if r["ok"]]
    print(f"[render] done: {len(ok)} ok, {len(failed)} failed", flush=True)
    if failed:
        for f in failed:
            print(f"[render] FAIL {f['slug']} rc={f['rc']} err={f['err']}", flush=True)
    with open(os.path.join(SITE, "pdf_render_report.json"), "w", encoding="utf-8") as fh:
        json.dump({"ok": ok, "failed": failed}, fh, indent=2)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
