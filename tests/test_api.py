# -*- coding: utf-8 -*-
"""
保存サーバーの契約テスト。server.py と server.ps1 の両方に同じテストを当てる。

  python -m unittest discover -s tests -p "test_*.py"          … server.py
  KITANO_SERVER=powershell python -m unittest discover -s tests … server.ps1（pwsh / powershell が必要）
  KITANO_PWSH=<pwsh のパス> で PowerShell の実行ファイルを指定できる
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIND = os.environ.get("KITANO_SERVER", "python")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def start_server(data_dir, port):
    if KIND == "python":
        cmd = [sys.executable, os.path.join(ROOT, "server.py"), "--port", str(port), "--data-dir", data_dir, "--no-browser"]
    else:
        exe = os.environ.get("KITANO_PWSH") or shutil.which("pwsh") or shutil.which("powershell")
        if not exe:
            raise unittest.SkipTest("PowerShell が見つかりません")
        cmd = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(ROOT, "server.ps1"),
               "-Port", str(port), "-DataDir", data_dir, "-NoBrowser"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    base = "http://localhost:%d" % port
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=1) as r:
                if r.status == 200:
                    return proc, base
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.2)
        if proc.poll() is not None:
            out = proc.stdout.read().decode("utf-8", "replace")
            raise RuntimeError("server exited:\n" + out)
    proc.kill()
    raise RuntimeError("server did not start")


def req(base, path, body=None, method=None, raw=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode("utf-8"))
    r = urllib.request.Request(base + path, data=data, method=method or ("POST" if data is not None else "GET"),
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=10) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, None


def rec(i, ts, **kw):
    r = {"id": i, "name": "", "score": 80.5, "method": "mean", "duration": 5, "ts": ts, "updatedAt": ts,
         "clipped": False, "series": [[0, 70.1], [50, 80.25], [100, 90]]}
    r.update(kw)
    return r


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="kitano-test-")
        cls.data = os.path.join(cls.tmp, "data")
        cls.proc, cls.base = start_server(cls.data, free_port())

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        cls.proc.wait()
        cls.proc.stdout.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def read_file(self, name):
        with open(os.path.join(self.data, name), encoding="utf-8") as f:
            return json.load(f)

    def test_health(self):
        st, h = req(self.base, "/api/health")
        self.assertEqual(st, 200)
        self.assertTrue(h["ok"])
        self.assertEqual(h["server"], KIND)
        self.assertEqual(os.path.normcase(os.path.abspath(h["dataDir"])), os.path.normcase(os.path.abspath(self.data)))

    def test_static_index(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as r:
            self.assertIn("text/html", r.headers["Content-Type"])
            self.assertIn("声の大きさ競争", r.read().decode("utf-8"))

    def test_static_blocks_traversal_and_data(self):
        # data/ の中身は静的配信しない（API 経由のみ）
        req(self.base, "/api/records/2026-01-01", [rec("secret", 1)])
        # アプリのフォルダより外は見えない（%2e%2e = ..）
        for p in ["/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2f..%2f..%2fetc%2fpasswd", "/data/2026-01-01.json"]:
            try:
                with urllib.request.urlopen(self.base + p, timeout=5) as r:
                    body = r.read().decode("utf-8", "replace")
                    self.assertNotIn("root:", body)
                    self.assertNotIn("secret", body)
            except urllib.error.HTTPError as e:
                self.assertIn(e.code, (400, 404))

    def test_records_roundtrip_and_files(self):
        d = "2026-10-01"
        st, empty = req(self.base, "/api/records/" + d)
        self.assertEqual((st, empty), (200, []))

        st, merged = req(self.base, "/api/records/" + d, [rec("a", 1000, name="たろう")])
        self.assertEqual(st, 200)
        self.assertEqual([r["id"] for r in merged], ["a"])
        self.assertEqual(self.read_file(d + ".json")[0]["name"], "たろう")
        self.assertEqual(self.read_file(d + ".json")[0]["series"], [[0, 70.1], [50, 80.25], [100, 90]])

        st, got = req(self.base, "/api/records/" + d)
        self.assertEqual(got[0]["series"][1], [50, 80.25])
        self.assertFalse(os.path.exists(os.path.join(self.data, d + ".json.tmp")))

    def test_merge_keeps_newer_and_tombstones(self):
        d = "2026-10-02"
        req(self.base, "/api/records/" + d, [rec("a", 1000), rec("b", 2000)])
        # 古いクライアント（b を知らない・a が古い）が送ってきても消えない
        st, merged = req(self.base, "/api/records/" + d, [rec("a", 1000)])
        self.assertEqual([r["id"] for r in merged], ["a", "b"])
        # 名前変更（新しい updatedAt）は反映
        st, merged = req(self.base, "/api/records/" + d, [rec("a", 1000, name="X", updatedAt=5000)])
        self.assertEqual(merged[0]["name"], "X")
        # 破棄は tombstone としてファイルに残る
        st, merged = req(self.base, "/api/records/" + d, [rec("b", 2000, deleted=True, updatedAt=6000)])
        self.assertTrue([r for r in merged if r["id"] == "b"][0]["deleted"])
        # 古い版で上書きしようとしても復活しない
        st, merged = req(self.base, "/api/records/" + d, [rec("b", 2000)])
        self.assertTrue([r for r in merged if r["id"] == "b"][0]["deleted"])
        self.assertEqual(len(self.read_file(d + ".json")), 2)

    def test_history_generations(self):
        d = "2026-10-03"
        for i in range(25):
            req(self.base, "/api/records/" + d, [rec("r%02d" % i, 1000 + i)])
        hist = [n for n in os.listdir(os.path.join(self.data, "history")) if n.startswith(d + "_")]
        self.assertEqual(len(hist), 20)
        self.assertEqual(len(self.read_file(d + ".json")), 25)

    def test_log_jsonl_no_duplicates(self):
        d = "2026-10-04"
        req(self.base, "/api/records/" + d, [rec("a", 1), rec("b", 2)])
        req(self.base, "/api/records/" + d, [rec("a", 1, name="n", updatedAt=9), rec("c", 3)])
        req(self.base, "/api/records/" + d, [rec("b", 2, deleted=True, updatedAt=10)])
        with open(os.path.join(self.data, d + ".log.jsonl"), encoding="utf-8") as f:
            ids = [json.loads(line)["id"] for line in f if line.strip()]
        self.assertEqual(sorted(ids), ["a", "b", "c"])

    def test_invalid_requests(self):
        self.assertEqual(req(self.base, "/api/records/2026-1-1", [rec("a", 1)])[0], 400)
        self.assertEqual(req(self.base, "/api/records/..%2Fsettings", [rec("a", 1)])[0], 400)
        self.assertEqual(req(self.base, "/api/records/2026-10-05", {"id": "a"})[0], 400)
        self.assertEqual(req(self.base, "/api/records/2026-10-05", [{"noid": 1}])[0], 400)
        self.assertEqual(req(self.base, "/api/records/2026-10-05", raw=b"{broken")[0], 400)
        self.assertFalse(os.path.exists(os.path.join(self.data, "2026-10-05.json")))

    def test_settings(self):
        st, s = req(self.base, "/api/settings")
        self.assertEqual(st, 200)
        body = {"deviceId": "", "duration": 5, "threshold": 65, "floor": 40, "offset": 98.5, "scoreMethod": "leq"}
        self.assertEqual(req(self.base, "/api/settings", body)[0], 200)
        self.assertEqual(req(self.base, "/api/settings")[1], body)
        self.assertEqual(req(self.base, "/api/settings", [1, 2])[0], 400)

    def test_persists_across_restart(self):
        d = "2026-10-06"
        req(self.base, "/api/records/" + d, [rec("keep", 1)])
        port = free_port()
        proc, base = start_server(self.data, port)
        try:
            self.assertEqual([r["id"] for r in req(base, "/api/records/" + d)[1]], ["keep"])
        finally:
            proc.kill()
            proc.wait()
            proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
