# -*- coding: utf-8 -*-
"""
長時間運用の耐久テスト（加速版）。

  A) 連続計測: 計測3秒の挑戦を N 回くり返し、ブラウザのメモリ（GC後のJSヒープ）・DOM数・
     サーバーのメモリ・1件保存にかかる時間の推移を記録する
  B) 待機放置: 何もしない状態でメーターだけ動かし、メモリが増え続けないかを見る

  python tests/soak.py [回数=300] [放置分=10]
"""
import os, sys, time, json, tempfile, resource
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_scenarios as E
from playwright.sync_api import sync_playwright

N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
IDLE_MIN = float(sys.argv[2]) if len(sys.argv) > 2 else 10


def rss_kb(pid):
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        return None


def heap(cdp, p):
    cdp.send("HeapProfiler.collectGarbage")
    m = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
    return round(m["JSHeapUsedSize"] / 1e6, 2), int(m["Nodes"]), int(m.get("JSEventListeners", 0))


def main():
    sounds = E.make_sounds(os.path.join(tempfile.gettempdir(), "kitano-e2e-sounds"))
    rows = []
    with sync_playwright() as pw:
        env = E.Env(pw, sounds)
        env.fresh({"duration": 3})
        p = env.page("tone-20")
        cdp = p.context.new_cdp_session(p)
        cdp.send("Performance.enable")
        t0 = time.time()
        for i in range(1, N + 1):
            ts = time.time()
            E.record(p, f"人{i}", manual=False)
            save = time.time() - ts - 3
            if i == 1 or i % 25 == 0:
                h, nodes, lis = heap(cdp, p)
                rows.append(("計測", i, round(time.time() - t0), h, nodes, lis, rss_kb(env.server.pid), round(save, 2)))
                print(rows[-1], flush=True)
        # B) 放置
        t1 = time.time()
        while time.time() - t1 < IDLE_MIN * 60:
            time.sleep(60)
            h, nodes, lis = heap(cdp, p)
            rows.append(("放置", round((time.time() - t1) / 60), round(time.time() - t0), h, nodes, lis, rss_kb(env.server.pid), None))
            print(rows[-1], flush=True)
        n_saved = len(E.records(env, p))
        print("saved records:", n_saved, "page errors:", p.errors, flush=True)
        env.close()


if __name__ == "__main__":
    main()
