"""Shared Cribl.Cloud API helper for the Zscaler lab build."""
import json
import subprocess

TOKEN_PATH = "C:/Users/James Pederson/Desktop/git/Remote/jphltech/scripts/cribl-token.json"
BASE = "https://main-busy-yonath-kz1bxn7.cribl.cloud/api/v1"
GROUP = "DatacenterEast"
G = "/m/" + GROUP

with open(TOKEN_PATH) as _fh:
    TOKEN = json.load(_fh)["access_token"]


_BODY_FILE = "_body.json"


def call(method, path, body=None):
    args = ["curl.exe", "-s", "-w", "\n__HTTP__%{http_code}", "-X", method,
            BASE + path, "-H", "Authorization: Bearer " + TOKEN,
            "-H", "Content-Type: application/json"]
    if body is not None:
        # Windows caps the command line at ~32k; the CEF/LEEF sample bodies are
        # far larger, so the payload goes through a file rather than argv.
        with open(_BODY_FILE, "w", encoding="utf-8") as fh:
            json.dump(body, fh)
        args += ["--data-binary", "@" + _BODY_FILE]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    txt, _, code = out.rpartition("__HTTP__")
    txt = txt.strip()
    try:
        parsed = json.loads(txt)
    except Exception:
        # Search /results is NDJSON, so json.loads fails by design. Keep the
        # WHOLE body - truncating here once hid two of four log-type groups
        # and read as "the data is not there".
        parsed = {"_text": txt}
    return int(code.strip() or 0), parsed


def first(resp):
    return (resp.get("items") or [{}])[0]


DATASETS = [
    ("zscaler_csv", "csv"),
    ("zscaler_cef", "cef"),
    ("zscaler_leef", "leef"),
]
