# -*- coding: utf-8 -*-
"""
server.py — 声の大きさ競争 の保存サーバー（Python 標準ライブラリのみ）

役割
  1. アプリ（index.html / js / css）を http://localhost:<port>/ で配信する
     （マイクは http://localhost か https でしか使えないため）
  2. 記録・設定を PC のディスク（data/ フォルダ）にファイルとして保存する API

起動時の環境チェック
  - data/ フォルダに書き込めるか（だめなら %LOCALAPPDATA%\\kitano-decibel\\data に切り替え）
  - ポート 8000 が空いているか（使用中なら 8001〜8010 を順に試す）
  - ブラウザは Chrome → Edge → 既定ブラウザ の順で開く
  結果はコンソールと data/env-check.log に残す。

保存の仕組み（3重）
  data/<日付>.json             … その日の全記録。tmp に書いてから置き換える（途中で落ちても壊れない）
  data/history/<日付>_<時刻>.json … 上書き前の世代コピー（日付ごとに直近 HISTORY_KEEP 件）
  data/<日付>.log.jsonl        … 初めて届いた記録を1行ずつ追記するだけのログ（破棄・リセットでも消えない）

API（server.ps1 と完全に同じ）
  GET  /api/health                → {"ok":true,"server":"python","dataDir":...,"port":...}
  GET  /api/records/<YYYY-MM-DD>  → その日の全記録（無ければ []）
  POST /api/records/<YYYY-MM-DD>  → 送られた全記録をサーバー側とマージして保存し、マージ結果を返す
  GET  /api/settings              → 設定（無ければ null）
  POST /api/settings              → 設定を保存

テスト用オプション: --port N（固定）/ --data-dir PATH / --no-browser
"""

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT_CANDIDATES = list(range(8000, 8011))
HISTORY_KEEP = 20
MAX_BODY = 5 * 1024 * 1024  # 5MB
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_write_lock = threading.Lock()
_logged_ids = {}  # date -> set(id)。jsonl に書いた ID のキャッシュ


# ---------------------------------------------------------------------------
# マージ（js/sync.js の mergeRecords と同じ規則）
# ---------------------------------------------------------------------------

def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def record_stamp(r):
    """更新時刻。updatedAt が無い古い記録は ts を使う。"""
    for key in ("updatedAt", "ts"):
        v = _num(r.get(key))
        if v is not None:
            return v
    return 0


def merge_records(a, b):
    """ID ごとに新しい方（updatedAt が大きい方）を残す。同時刻なら破棄済み(deleted)を優先。ts 昇順で返す。"""
    by_id = {}
    for r in list(a or []) + list(b or []):
        if not isinstance(r, dict) or not isinstance(r.get("id"), str):
            continue
        cur = by_id.get(r["id"])
        if cur is None:
            by_id[r["id"]] = r
            continue
        sr, sc = record_stamp(r), record_stamp(cur)
        if sr > sc or (sr == sc and r.get("deleted") and not cur.get("deleted")):
            by_id[r["id"]] = r
    return sorted(by_id.values(), key=lambda r: (_num(r.get("ts")) or 0, r["id"]))


# ---------------------------------------------------------------------------
# ファイル操作
# ---------------------------------------------------------------------------

def atomic_write_json(path, data):
    """tmp に書いて fsync → os.replace。書き込み途中で落ちても元のファイルは壊れない。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError):
        # 壊れていた場合は捨てずに退避して、空として扱う
        try:
            shutil.copy2(path, path + ".broken-" + _dt.datetime.now().strftime("%Y%m%d%H%M%S"))
        except OSError:
            pass
        return default


def backup_history(data_dir, date, path):
    if not os.path.exists(path):
        return
    hist = os.path.join(data_dir, "history")
    os.makedirs(hist, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%H%M%S_%f")
    shutil.copy2(path, os.path.join(hist, "%s_%s.json" % (date, stamp)))
    mine = sorted(n for n in os.listdir(hist) if n.startswith(date + "_") and n.endswith(".json"))
    for old in mine[:-HISTORY_KEEP]:
        try:
            os.remove(os.path.join(hist, old))
        except OSError:
            pass


def append_log(data_dir, date, records):
    """初めて見た ID の記録だけ jsonl に追記（fsync）。"""
    path = os.path.join(data_dir, "%s.log.jsonl" % date)
    seen = _logged_ids.get(date)
    if seen is None:
        seen = set()
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        rid = json.loads(line).get("id")
                        if isinstance(rid, str):
                            seen.add(rid)
                    except ValueError:
                        continue
        except FileNotFoundError:
            pass
        _logged_ids[date] = seen
    new = [r for r in records if r["id"] not in seen]
    if not new:
        return
    with open(path, "a", encoding="utf-8") as f:
        for r in new:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            seen.add(r["id"])
        f.flush()
        os.fsync(f.fileno())


def save_records(data_dir, date, incoming):
    path = os.path.join(data_dir, "%s.json" % date)
    with _write_lock:
        current = read_json(path, [])
        if not isinstance(current, list):
            current = []
        merged = merge_records(current, incoming)
        if merged != current:
            backup_history(data_dir, date, path)
            atomic_write_json(path, merged)
        append_log(data_dir, date, merged)
        return merged


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    data_dir = None
    port = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # アクセスログは静かに（エラーだけ表示）
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send_json({"ok": False, "error": message}, status)

    def _read_raw(self):
        """本文を先に全部読む（読まずに応答すると、Windows では接続がリセットされることがある）。"""
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.close_connection = True
            return None
        return self.rfile.read(length) if length > 0 else b""

    @staticmethod
    def _parse(raw):
        if raw is None:
            raise OverflowError("body too large")
        if not raw:
            raise ValueError("empty body")
        return json.loads(raw.decode("utf-8"))

    def _route(self):
        path = self.path.split("?", 1)[0]
        if not path.startswith("/api/"):
            return None, None
        parts = path[len("/api/"):].strip("/").split("/")
        return parts[0], parts[1:]

    def do_GET(self):
        name, rest = self._route()
        if name is None:
            if self.path.split("?", 1)[0].startswith("/data/"):
                return self._error(HTTPStatus.NOT_FOUND, "not found")
            return super().do_GET()
        try:
            if name == "health" and not rest:
                return self._send_json({"ok": True, "server": "python", "dataDir": self.data_dir, "port": self.port})
            if name == "records" and len(rest) == 1 and DATE_RE.match(rest[0]):
                data = read_json(os.path.join(self.data_dir, "%s.json" % rest[0]), [])
                return self._send_json(data if isinstance(data, list) else [])
            if name == "settings" and not rest:
                return self._send_json(read_json(os.path.join(self.data_dir, "settings.json"), None))
            return self._error(HTTPStatus.BAD_REQUEST, "bad request")
        except Exception as e:  # noqa: BLE001
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

    def do_POST(self):
        raw = self._read_raw()
        name, rest = self._route()
        if name is None:
            return self._error(HTTPStatus.NOT_FOUND, "not found")
        try:
            if name == "records" and len(rest) == 1 and DATE_RE.match(rest[0]):
                body = self._parse(raw)
                if not isinstance(body, list) or not all(isinstance(r, dict) and isinstance(r.get("id"), str) for r in body):
                    return self._error(HTTPStatus.BAD_REQUEST, "records must be an array of objects with string id")
                return self._send_json(save_records(self.data_dir, rest[0], body))
            if name == "settings" and not rest:
                body = self._parse(raw)
                if not isinstance(body, dict):
                    return self._error(HTTPStatus.BAD_REQUEST, "settings must be an object")
                with _write_lock:
                    atomic_write_json(os.path.join(self.data_dir, "settings.json"), body)
                return self._send_json({"ok": True})
            return self._error(HTTPStatus.BAD_REQUEST, "bad request")
        except OverflowError:
            return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body too large")
        except ValueError:
            return self._error(HTTPStatus.BAD_REQUEST, "invalid json")
        except Exception as e:  # noqa: BLE001
            print("[エラー] 保存に失敗:", e, file=sys.stderr)
            return self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))


# ---------------------------------------------------------------------------
# 環境チェック
# ---------------------------------------------------------------------------

def _writable(d):
    try:
        os.makedirs(d, exist_ok=True)
        test = os.path.join(d, ".write-test")
        with open(test, "w", encoding="utf-8") as f:
            f.write("ok")
            f.flush()
            os.fsync(f.fileno())
        os.remove(test)
        return True
    except OSError:
        return False


def choose_data_dir(explicit=None):
    if explicit:
        d = os.path.abspath(explicit)
        if not _writable(d):
            raise SystemExit("[NG] 保存先に書き込めません: %s" % d)
        return d, []
    notes = []
    primary = os.path.join(ROOT, "data")
    if _writable(primary):
        return primary, notes
    notes.append("[注意] %s に書き込めません（読み取り専用の場所/USBの書き込み禁止など）" % primary)
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    fallback = os.path.join(base, "kitano-decibel", "data")
    if _writable(fallback):
        notes.append("[注意] 代わりに %s に保存します" % fallback)
        return fallback, notes
    raise SystemExit("[NG] 保存先フォルダに書き込めません: %s / %s" % (primary, fallback))


class LocalHTTPServer(ThreadingHTTPServer):
    """ポートを確実に専有するサーバー。
    Windows の SO_REUSEADDR は「他のプログラムが使用中のポートにも割り込める」意味になるため使わず、
    代わりに SO_EXCLUSIVEADDRUSE を付ける（これで使用中なら確実にエラー → 次のポートへ）。"""
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class ThreadingHTTPServerV6(LocalHTTPServer):
    address_family = socket.AF_INET6


def _ipv6_available():
    if not socket.has_ipv6:
        return False
    try:
        s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        s.bind(("::1", 0))
        s.close()
        return True
    except OSError:
        return False


def bind_server(ports):
    """127.0.0.1 と ::1 の両方で待ち受ける。
    ブラウザや Windows は「localhost」をまず IPv6(::1) で試すため、IPv4 だけだと
    接続のたびに約2秒待たされる（Windows 実機で確認）。どちらも外部には公開しない。"""
    v6 = _ipv6_available()
    last = None
    for p in ports:
        try:
            s4 = LocalHTTPServer(("127.0.0.1", p), Handler)
        except OSError as e:
            last = e
            continue
        s6 = None
        if v6:
            try:
                s6 = ThreadingHTTPServerV6(("::1", p), Handler)
            except OSError as e:
                s4.server_close()  # ::1 側を別アプリが使っている → ブラウザがそちらに繋がるので避ける
                last = e
                continue
        return [s for s in (s4, s6) if s], p
    raise SystemExit("[NG] ポート %d〜%d がすべて使用中です（%s）。他のサーバーを閉じてから再実行してください。" % (ports[0], ports[-1], last))


def find_browser():
    if os.name != "nt":
        return None, "既定のブラウザ"
    env = os.environ.get
    cands = [
        ("Chrome", [env("ProgramFiles"), env("ProgramFiles(x86)"), env("LOCALAPPDATA")], r"Google\Chrome\Application\chrome.exe"),
        ("Edge", [env("ProgramFiles(x86)"), env("ProgramFiles"), env("LOCALAPPDATA")], r"Microsoft\Edge\Application\msedge.exe"),
    ]
    for label, bases, rel in cands:
        for b in bases:
            if b and os.path.exists(os.path.join(b, rel)):
                return os.path.join(b, rel), label
    return None, "既定のブラウザ"


def open_browser(url, exe):
    try:
        if exe:
            subprocess.Popen([exe, url])
        elif os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            webbrowser.open(url)
    except OSError as e:
        print("[注意] ブラウザを開けませんでした（%s）。手動で %s を開いてください。" % (e, url))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int)
    ap.add_argument("--data-dir")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    lines = ["===== 環境チェック %s =====" % _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
             "[OK] サーバー: Python %s" % sys.version.split()[0]]
    data_dir, notes = choose_data_dir(args.data_dir)
    lines += notes
    lines.append("[OK] 保存先: %s" % data_dir)

    servers, port = bind_server([args.port] if args.port else PORT_CANDIDATES)
    if port != PORT_CANDIDATES[0] and not args.port:
        lines.append("[注意] ポート 8000 が使用中のため %d を使います（記録はファイルから復元されるので問題ありません）" % port)
    lines.append("[OK] アドレス: http://localhost:%d/" % port)

    exe, label = find_browser()
    if not args.no_browser:
        lines.append("[OK] ブラウザ: %s" % label)

    Handler.data_dir = data_dir
    Handler.port = port
    for ln in lines:
        print(ln)
    try:
        with open(os.path.join(data_dir, "env-check.log"), "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except OSError:
        pass

    print()
    print("このウィンドウは本番中は閉じないでください（閉じると保存サーバーが止まります）。")
    print("止まっても、もう一度 start.bat を実行すれば記録はそのまま戻ります。")
    sys.stdout.flush()

    if not args.no_browser:
        threading.Timer(0.8, open_browser, args=("http://localhost:%d/" % port, exe)).start()
    for extra in servers[1:]:
        threading.Thread(target=extra.serve_forever, daemon=True).start()
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for s in servers:
            s.server_close()


if __name__ == "__main__":
    main()
