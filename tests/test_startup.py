# -*- coding: utf-8 -*-
"""
起動時の環境チェックの異常系テスト（server.py / server.ps1 共通。KITANO_SERVER で切替）。

  - ポート 8000〜 が使用中 → 空いている次のポートで起動する
  - アプリの data フォルダに書き込めない → %LOCALAPPDATA%\\kitano-decibel\\data に切り替える
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIND = os.environ.get("KITANO_SERVER", "python")
APP_FILES = ["server.py", "server.ps1", "index.html"]


def launch(app_dir, extra_env=None):
    """ポート指定なし（本番と同じ 8000〜8010 の自動選択）で起動し、(proc, port, 出力) を返す。"""
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", **(extra_env or {})}
    if KIND == "python":
        cmd = [sys.executable, os.path.join(app_dir, "server.py"), "--no-browser"]
    else:
        exe = os.environ.get("KITANO_PWSH") or shutil.which("pwsh") or shutil.which("powershell")
        if not exe:
            raise unittest.SkipTest("PowerShell が見つかりません")
        cmd = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(app_dir, "server.ps1"), "-NoBrowser"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    lines = []
    found = {}

    def reader():
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace")
            lines.append(line)
            m = re.search(r"localhost:(\d+)/", line)
            if m and "port" not in found:
                found["port"] = int(m.group(1))

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    deadline = time.time() + 30
    while "port" not in found and time.time() < deadline:
        if proc.poll() is not None:
            time.sleep(0.3)
            raise RuntimeError("server exited:\n" + "".join(lines))
        time.sleep(0.1)
    if "port" not in found:
        proc.kill()
        raise RuntimeError("no address line:\n" + "".join(lines))
    port = found["port"]
    for _ in range(100):
        try:
            with urllib.request.urlopen("http://localhost:%d/api/health" % port, timeout=1) as r:
                health = json.loads(r.read().decode("utf-8"))
            return proc, port, health, lines
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("health failed:\n" + "".join(lines))


def env_log(health):
    """環境チェックの記録（UTF-8 のファイル）。コンソール出力は Windows だと文字コードが変わるのでこちらで確認する。"""
    with open(os.path.join(health["dataDir"], "env-check.log"), encoding="utf-8") as f:
        return f.read()


def stop(proc):
    proc.kill()
    proc.wait()


def copy_app(dst):
    os.makedirs(dst, exist_ok=True)
    for f in APP_FILES:
        shutil.copy2(os.path.join(ROOT, f), os.path.join(dst, f))


def port_free(p):
    s = socket.socket()
    # サーバー側と同じ条件で空きを判定する（Linux 等: 終了待ちの古い接続だけなら「空き」）
    if os.name != "nt":
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", p))
        return True
    except OSError:
        return False
    finally:
        s.close()


class StartupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="kitano-startup-")
        self.app = os.path.join(self.tmp, "app")
        copy_app(self.app)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_busy_port_moves_to_next(self):
        # 8000〜8010 で最初に空いているポートをこちらで塞ぐ → サーバーはその先の空きを使うはず
        free = [p for p in range(8000, 8011) if port_free(p)]
        if len(free) < 2:
            self.skipTest("8000〜8010 に空きが足りません")
        blocker = socket.socket()
        if os.name != "nt":
            blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        blocker.bind(("127.0.0.1", free[0]))
        blocker.listen(1)
        try:
            proc, port, health, lines = launch(self.app)
            try:
                self.assertNotEqual(port, free[0])
                self.assertIn(port, free[1:])
                self.assertEqual(health["port"], port)
                if free[0] == 8000:
                    self.assertIn("使用中", env_log(health))
            finally:
                stop(proc)
        finally:
            blocker.close()

    def test_unwritable_data_dir_falls_back(self):
        # data という名前の「ファイル」を置いて、data フォルダを作れない状態にする
        with open(os.path.join(self.app, "data"), "w") as f:
            f.write("not a folder")
        local = os.path.join(self.tmp, "LocalAppData")
        proc, port, health, lines = launch(self.app, {"LOCALAPPDATA": local})
        try:
            expected = os.path.join(local, "kitano-decibel", "data")
            self.assertEqual(os.path.normcase(os.path.abspath(health["dataDir"])), os.path.normcase(os.path.abspath(expected)))
            self.assertIn("代わりに", env_log(health))
            # 切り替え先に実際に保存できる
            body = json.dumps([{"id": "x", "ts": 1, "updatedAt": 1, "series": []}]).encode("utf-8")
            req = urllib.request.Request("http://localhost:%d/api/records/2026-01-01" % port, data=body,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).read()
            self.assertTrue(os.path.exists(os.path.join(expected, "2026-01-01.json")))
            self.assertTrue(os.path.exists(os.path.join(expected, "env-check.log")))
        finally:
            stop(proc)


if __name__ == "__main__":
    unittest.main()
