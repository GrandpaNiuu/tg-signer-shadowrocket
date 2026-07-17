import os
import sys
import urllib.parse
import urllib.request

try:
    from .redact import redact_text
except ImportError:  # Direct execution: python scripts/notify.py
    from redact import redact_text

TOKEN = os.getenv("TELEGRAM_NOTIFY_BOT_TOKEN", "").strip()
CHAT_ID = os.getenv("TELEGRAM_NOTIFY_CHAT_ID", "").strip()
STATUS = os.getenv("CHECKIN_STATUS", "unknown").strip()
LOG_PATH = os.getenv("LOG_PATH", "run.log")
RUN_URL = os.getenv("GITHUB_RUN_URL", "").strip()


def read_log(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    except FileNotFoundError:
        return "No log file found."

    text = redact_text(text).strip()
    if not text:
        return "Log file is empty."
    return text[-3200:]


def build_message(status: str, log: str, run_url: str = "") -> str:
    icon = "✅" if status == "success" else "❌"
    message = f"{icon} TG task: {status}\n"
    if run_url:
        message += f"GitHub Actions: {run_url}\n"
    message += "\nLog tail:\n" + log
    return redact_text(message)


def send_message(text: str) -> None:
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    data = urllib.parse.urlencode(
        {
            "chat_id": CHAT_ID,
            "text": text,
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")

    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        if resp.status >= 400:
            raise RuntimeError(f"Telegram API returned HTTP {resp.status}")


def main() -> int:
    if not TOKEN or not CHAT_ID:
        print("[INFO] Telegram notification skipped: TELEGRAM_NOTIFY_BOT_TOKEN or TELEGRAM_NOTIFY_CHAT_ID is not set.")
        return 0

    log = read_log(LOG_PATH)
    message = build_message(STATUS, log, RUN_URL)

    try:
        send_message(message)
        print("[INFO] Telegram notification sent.")
        return 0
    except Exception as exc:
        print(
            f"[WARN] Failed to send Telegram notification: {redact_text(str(exc))}",
            file=sys.stderr,
        )
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
