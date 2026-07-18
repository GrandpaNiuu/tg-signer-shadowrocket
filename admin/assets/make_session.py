"""Generate a Kurigram/Pyrogram session string entirely on the user's device."""

from getpass import getpass
from typing import Dict, Optional

from pyrogram import Client


def read_api_id() -> int:
    raw = input("API_ID（不是手机号，例如 12345678）: ").strip()
    if not raw.isdigit():
        raise SystemExit("API_ID 必须是 Telegram 应用提供的纯数字，不能填写手机号。")
    value = int(raw)
    if not 1 <= value <= 2_147_483_647:
        raise SystemExit("API_ID 超出有效范围；请勿在这里填写手机号。")
    return value


def read_api_hash() -> str:
    value = getpass("API_HASH（输入时不会显示）: ").strip()
    if len(value) != 32 or any(character not in "0123456789abcdefABCDEF" for character in value):
        raise SystemExit("API_HASH 应为 Telegram 应用提供的 32 位十六进制字符串。")
    return value


def read_proxy() -> Optional[Dict[str, object]]:
    answer = input("是否使用本机代理？中国大陆网络通常需要 [y/N]: ").strip().lower()
    if answer not in {"y", "yes", "1", "是"}:
        return None

    scheme = input("代理协议 [socks5]: ").strip().lower() or "socks5"
    if scheme not in {"socks4", "socks5", "http"}:
        raise SystemExit("代理协议只支持 socks4、socks5 或 http。")
    hostname = input("代理地址 [127.0.0.1]: ").strip() or "127.0.0.1"
    raw_port = input("代理端口 [10808]: ").strip() or "10808"
    if not raw_port.isdigit() or not 1 <= int(raw_port) <= 65_535:
        raise SystemExit("代理端口必须是 1 到 65535 之间的数字。")

    proxy: Dict[str, object] = {
        "scheme": scheme,
        "hostname": hostname,
        "port": int(raw_port),
    }
    username = input("代理用户名（没有请直接回车）: ").strip()
    if username:
        proxy["username"] = username
        proxy["password"] = getpass("代理密码（输入时不会显示）: ")
    return proxy


def main() -> None:
    print("手机号稍后会由 Telegram 单独询问，请不要把手机号填入 API_ID。")
    api_id = read_api_id()
    api_hash = read_api_hash()
    proxy = read_proxy()

    try:
        with Client(
            "session-export",
            api_id=api_id,
            api_hash=api_hash,
            in_memory=True,
            proxy=proxy,
        ) as app:
            print("\n仅复制下面两条分隔线之间的 Session：")
            print("----- SESSION START -----")
            print(app.export_session_string())
            print("----- SESSION END -----")
    except OSError:
        raise SystemExit(
            "无法连接 Telegram。请确认代理软件正在运行，然后重新执行脚本并选择使用代理；"
            "v2rayN 常用 socks5、127.0.0.1、10808。"
        ) from None


if __name__ == "__main__":
    main()
