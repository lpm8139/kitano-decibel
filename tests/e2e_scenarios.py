# -*- coding: utf-8 -*-
"""
シナリオ別のブラウザ通しテスト（Playwright + Chromium の仮想マイク）。

音量が分かっているテスト用の音（WAV）を仮想マイクに流して、画面操作から保存ファイルまでを確認する。

  python tests/e2e_scenarios.py                      … server.py に対して実行
  KITANO_SERVER=powershell python tests/e2e_scenarios.py … server.ps1 に対して実行
  python tests/e2e_scenarios.py S1 S7                 … 一部だけ

必要: pip install playwright && playwright install chromium（Chromium が入っていれば不要）
"""

import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import traceback
import urllib.request
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_api import KIND, free_port, start_server  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

OFFSET = 100  # 既定の校正オフセット（表示dB = dBFS + 100）

# ---------------------------------------------------------------------------
# テスト用の音
# ---------------------------------------------------------------------------

SR = 48000


def _write_wav(path, gen, seconds):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        buf = bytearray()
        for i in range(int(SR * seconds)):
            v = max(-1.0, min(1.0, gen(i / SR)))
            buf += struct.pack("<h", int(round(v * 32767)))
        w.writeframes(bytes(buf))


def _sine(dbfs_rms, f=1000):
    a = 10 ** (dbfs_rms / 20) * math.sqrt(2)
    return lambda t: a * math.sin(2 * math.pi * f * t)


def make_sounds(d):
    hi, lo, mid = _sine(-10), _sine(-30), _sine(-20)
    specs = {
        "tone-20": (mid, 10),        # 表示 80 dB
        "tone-10": (hi, 10),         # 表示 90 dB
        "tone-30": (lo, 10),         # 表示 70 dB
        "alt": (lambda t: hi(t) if int(t) % 2 == 0 else lo(t), 10),  # 1秒ごとに 90/70 dB
        "square": (lambda t: 1.0 if math.sin(2 * math.pi * 500 * t) >= 0 else -1.0, 10),  # フルスケール（クリップ）
        "silence": (lambda t: 0.0, 20),
        "burst": (lambda t: 0.0 if t < 3 else mid(t), 12),  # 3秒無音 → 80 dB
    }
    out = {}
    for name, (gen, sec) in specs.items():
        p = os.path.join(d, name + ".wav")
        if not os.path.exists(p):
            _write_wav(p, gen, sec)
        out[name] = p
    return out


# ---------------------------------------------------------------------------
# 共通
# ---------------------------------------------------------------------------

class Env:
    def __init__(self, pw, sounds):
        self.pw = pw
        self.sounds = sounds
        self.browsers = {}
        self.tmp = tempfile.mkdtemp(prefix="kitano-e2e-")
        self.server = None
        self.contexts = []

    def close_contexts(self):
        """シナリオ終了時に、開いた画面を全部閉じる（失敗したシナリオの画面が次に影響しないように）。"""
        for c in self.contexts:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
        self.contexts = []

    def fresh(self, settings=None):
        """新しい data フォルダでサーバーを起動し直す。"""
        self.stop_server()
        self.data = tempfile.mkdtemp(prefix="data-", dir=self.tmp)
        self.port = free_port()
        self.start_server()
        if settings:
            api(self.base, "/api/settings", {**DEFAULT_SETTINGS, **settings})

    def start_server(self):
        self.server, self.base = start_server(self.data, self.port)

    def stop_server(self):
        if self.server:
            self.server.kill()
            self.server.wait()
            self.server.stdout.close()
            self.server = None

    def browser(self, sound):
        if sound not in self.browsers:
            self.browsers[sound] = self.pw.chromium.launch(args=[
                "--use-fake-device-for-media-stream",
                "--use-fake-ui-for-media-stream",
                "--use-file-for-fake-audio-capture=" + self.sounds[sound],
                "--autoplay-policy=no-user-gesture-required",
            ])
        return self.browsers[sound]

    def page(self, sound, init_script=None):
        ctx = self.browser(sound).new_context(viewport={"width": 1920, "height": 1080}, accept_downloads=True)
        self.contexts.append(ctx)
        ctx.grant_permissions(["microphone"])
        if init_script:
            ctx.add_init_script(init_script)
        p = ctx.new_page()
        p.errors = []
        p.on("pageerror", lambda e: p.errors.append(str(e)))
        p.goto(self.base + "/")
        wait_ready(p)
        return p

    def close(self):
        self.stop_server()
        for b in self.browsers.values():
            b.close()
        shutil.rmtree(self.tmp, ignore_errors=True)


DEFAULT_SETTINGS = {"deviceId": "", "duration": 5, "threshold": 65, "floor": 40, "offset": OFFSET, "scoreMethod": "mean"}


def api(base, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def state(p):
    return p.evaluate("document.getElementById('app').dataset.state")


def diag(p):
    return p.evaluate("""({state: document.getElementById('app').dataset.state,
      msg: document.getElementById('message').textContent, mic: document.getElementById('mic-status').textContent,
      sync: document.getElementById('sync-status').textContent, toast: document.getElementById('toast').textContent,
      focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      settingsOpen: !document.getElementById('settings').hidden, modalOpen: !document.getElementById('modal').hidden})""")


def wait_state(p, s, timeout=20):
    try:
        p.wait_for_function(f"document.getElementById('app').dataset.state === '{s}'", timeout=timeout * 1000)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"状態 {s} にならない: {diag(p)} / errors={getattr(p, 'errors', [])}") from e


def wait_saved(p, timeout=20):
    p.wait_for_function("document.querySelector('#sync-status').textContent.includes('保存済み')", timeout=timeout * 1000)


def wait_ready(p):
    wait_saved(p)
    p.wait_for_function("document.querySelector('#mic-status').dataset.kind === 'ok'", timeout=15000)
    wait_state(p, "idle")


def today(p):
    return p.evaluate("(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; })()")


def live_db(p):
    t = p.text_content("#live-db")
    return None if t in (None, "--") else float(t)


def start_measure(p):
    """スタンバイ→手動スタート。大きな音が続いていて自動スタートした場合もそのまま進む。"""
    p.keyboard.press("Space")
    p.wait_for_function("['standby','measuring'].includes(document.getElementById('app').dataset.state)", timeout=10000)
    if state(p) == "standby":
        p.keyboard.press("Space")
    wait_state(p, "measuring")


def record(p, name="", manual=True):
    """1回計測して名前を付けて保存。計測中に見えたリード状態の集合を返す。"""
    p.keyboard.press("Space")
    # 大きな音が続いているとスタンバイから一瞬で自動スタートするので、どちらの状態でも進める
    p.wait_for_function("['standby','measuring','result'].includes(document.getElementById('app').dataset.state)", timeout=10000)
    if manual and state(p) == "standby":
        p.keyboard.press("Space")
    p.wait_for_function("['measuring','result'].includes(document.getElementById('app').dataset.state)", timeout=20000)
    leads = set()
    while state(p) == "measuring":
        leads.add(p.evaluate("document.getElementById('app').dataset.lead"))
        time.sleep(0.1)
    wait_state(p, "result")
    info = {
        "banner": p.is_visible("#result-banner"),
        "rank": p.text_content("#result-rank"),
        "score": float(p.text_content("#result-score")),
        "leads": leads,
    }
    p.fill("#result-name", name)
    p.press("#result-name", "Enter")
    wait_state(p, "idle")
    wait_saved(p)
    return info


def records(env, p, date=None, include_deleted=False):
    rs = api(env.base, "/api/records/" + (date or today(p)))
    return rs if include_deleted else [r for r in rs if not r.get("deleted")]


def top10(p):
    return [li.inner_text().replace("\n", " ") for li in p.query_selector_all("#top10 li:not(.empty)")]


def near(a, b, tol):
    return abs(a - b) <= tol


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# ---------------------------------------------------------------------------
# シナリオ
# ---------------------------------------------------------------------------

def s1_accuracy(env):
    """既知の音量（70/80/90 dB）が ±0.7 dB 以内・約100サンプルで記録される"""
    env.fresh()
    out = []
    for sound, expect in [("tone-30", 70), ("tone-20", 80), ("tone-10", 90)]:
        p = env.page(sound)
        record(p, sound, manual=False)  # 本番と同じく、しきい値を超えた瞬間の自動スタートで測る
        r = records(env, p)[-1]
        n = len(r["series"])
        lows = [(t, v) for t, v in r["series"][1:] if v < expect - 1]  # 先頭は立ち上がりの区間なので除く
        gaps = [(a[0], b[0]) for a, b in zip(r["series"], r["series"][1:]) if b[0] - a[0] > 120]
        check(near(r["score"], expect, 0.7),
              f"{sound}: score {r['score']} != {expect}（{n}点・先頭 {r['series'][0]}・低いサンプル: {lows[:8]}・間隔の空き: {gaps[:5]}）")
        check(90 <= n <= 110, f"{sound}: samples {n}")
        vals = [v for _, v in r["series"]]
        out.append(f"{expect}dB→{r['score']} ({n}点, 最小{min(vals)} 最大{max(vals)})")
        p.context.close()
    return ", ".join(out)


def s2_mean_vs_leq(env):
    """1秒ごとに90/70dBを繰り返す声で、平均≈80・Leq≈87（4秒計測）"""
    res = {}
    for method in ["mean", "leq"]:
        env.fresh({"duration": 4, "scoreMethod": method})
        p = env.page("alt")
        record(p, method)
        r = records(env, p)[-1]
        res[method] = r["score"]
        check(r["method"] == method, f"method {r['method']}")
        p.context.close()
    check(near(res["mean"], 80, 2.0), f"mean {res['mean']}")
    check(near(res["leq"], 87.0, 1.2), f"leq {res['leq']}")
    check(res["leq"] > res["mean"] + 4, "Leq が平均より十分大きくない")
    return f"平均 {res['mean']} / Leq {res['leq']}"


def s3_durations(env):
    """計測秒数 3秒→約60点、10秒→約200点"""
    out = []
    for dur, lo, hi in [(3, 55, 65), (10, 190, 210)]:
        env.fresh({"duration": dur})
        p = env.page("tone-20")
        record(p)
        r = records(env, p)[-1]
        n = len(r["series"])
        check(lo <= n <= hi, f"{dur}秒: {n}点")
        check(r["series"][-1][0] <= dur * 1000, f"{dur}秒を超えたサンプルがある")
        out.append(f"{dur}秒→{n}点")
        p.context.close()
    return ", ".join(out)


def s4_threshold_autostart(env):
    """スタンバイ中、無音では始まらず、声(80dB)がしきい値65を超えた瞬間に計測開始"""
    env.fresh()
    p = env.page("burst")
    deadline = time.time() + 15
    while not (live_db(p) is not None and live_db(p) < 30):  # 無音区間に入るのを待つ
        check(time.time() < deadline, "無音区間が来ない")
        time.sleep(0.05)
    p.keyboard.press("Space")
    wait_state(p, "standby")
    time.sleep(0.5)
    check(state(p) == "standby", "無音なのに計測が始まった")
    wait_state(p, "measuring", 15)
    wait_state(p, "result", 10)
    p.press("#result-name", "Enter")
    wait_saved(p)
    r = records(env, p)[-1]
    first = r["series"][0][1]
    lows = [v for _, v in r["series"] if v < 65]
    check(first >= 65, f"開始時の値 {first}")
    check(not lows, f"しきい値未満のサンプル {len(lows)} 個")
    check(near(r["score"], 80, 0.7), f"score {r['score']}")
    return f"開始値 {first} dB・スコア {r['score']}"


def s5_standby_timeout(env):
    """無音のままスタンバイ15秒で待機に戻り、記録は増えない"""
    env.fresh()
    p = env.page("silence")
    p.keyboard.press("Space")
    wait_state(p, "standby")
    wait_state(p, "idle", 20)
    msg = p.text_content("#message")
    check("時間切れ" in msg, f"メッセージ: {msg}")
    check(not records(env, p), "記録が増えた")
    return "15秒で待機に戻った"


def s6_abort(env):
    """計測中に Esc で中断 → 記録されない"""
    env.fresh()
    p = env.page("tone-20")
    start_measure(p)
    time.sleep(1)
    p.keyboard.press("Escape")
    wait_state(p, "idle")
    time.sleep(1)
    check(not records(env, p), "中断したのに記録された")
    return "記録なし"


def s7_ghost_and_ranking(env):
    """80dB→90dB→70dB の3人：新記録判定・順位・ゴースト表示・リード/ビハインド"""
    env.fresh()
    a = env.page("tone-20")
    ia = record(a, "Aさん")
    a.context.close()
    b = env.page("tone-10")
    ghost = b.text_content("#ghost-name")
    check("Aさん" in ghost, f"ゴースト表示: {ghost}")
    ib = record(b, "Bさん")
    b.context.close()
    c = env.page("tone-30")
    ic = record(c, "Cさん")
    t = top10(c)
    c.context.close()
    check(ia["banner"] and "1 位 / 1" in ia["rank"], f"1人目: {ia}")
    check(ib["banner"] and "1 位 / 2" in ib["rank"] and "lead" in ib["leads"], f"2人目: {ib}")
    check(not ic["banner"] and "3 位 / 3" in ic["rank"] and "behind" in ic["leads"], f"3人目: {ic}")
    check([x.split()[1] for x in t] == ["Bさん", "Aさん", "Cさん"], f"TOP10: {t}")
    return f"TOP10 {[x.split()[1] for x in t]}・2人目リード・3人目ビハインド"


def s8_clip(env):
    """フルスケールの音でクリップ警告が出て、記録にクリップ印が付く"""
    env.fresh()
    p = env.page("square")
    start_measure(p)
    time.sleep(0.5)
    seen = p.is_visible("#clip-warning")
    wait_state(p, "result", 10)
    p.press("#result-name", "Enter")
    wait_saved(p)
    r = records(env, p)[-1]
    check(seen, "CLIP 警告が出ない")
    check(r["clipped"] is True, "clipped が付いていない")
    return f"CLIP 表示あり・スコア {r['score']}"


def s9_discard(env):
    """結果画面で破棄 → ランキングから消え、ファイルには deleted で残る。再読み込み・CSV でも復活しない"""
    env.fresh()
    p = env.page("tone-20")
    record(p, "残す")
    start_measure(p)
    wait_state(p, "result", 15)
    p.fill("#result-name", "消す")
    p.click("#btn-result-discard")
    p.click("#modal-ok")
    wait_state(p, "idle")
    wait_saved(p)
    all_ = records(env, p, include_deleted=True)
    check(len(all_) == 2 and sum(1 for r in all_ if r.get("deleted")) == 1, f"ファイル: {all_}")
    p.reload()
    wait_ready(p)
    names = [x.split()[1] for x in top10(p)]
    check(names == ["残す"], f"再読み込み後 TOP10: {names}")
    with p.expect_download() as dl:
        p.click("#btn-csv")
    csv = open(dl.value.path(), encoding="utf-8-sig", newline="").read()
    check("残す" in csv and "消す" not in csv and csv.count("\r\n") == 2, f"CSV: {csv!r}")
    return "破棄分は表示・CSVから除外、ファイルには残存"


def s10_reset(env):
    """本日の記録をリセット → 全件非表示・ファイルとログには残る・再読み込みでも空"""
    env.fresh()
    p = env.page("tone-20")
    record(p, "1")
    record(p, "2")
    p.click("#btn-reset")
    p.click("#modal-ok")
    wait_saved(p)
    check(top10(p) == [], "リセット後も表示が残る")
    all_ = records(env, p, include_deleted=True)
    check(len(all_) == 2 and all(r.get("deleted") for r in all_), f"ファイル: {all_}")
    with open(os.path.join(env.data, today(p) + ".log.jsonl"), encoding="utf-8") as f:
        logged = [json.loads(x)["id"] for x in f if x.strip()]
    check(len(logged) == 2, f"ログ {len(logged)} 件")
    p.reload()
    wait_ready(p)
    check(top10(p) == [], "再読み込みで復活した")
    record(p, "リセット後")
    check([x.split()[1] for x in top10(p)] == ["リセット後"], "リセット後の新記録が出ない")
    return "非表示化・ログ残存・再読み込みでも空・その後の記録は正常"


def s11_names_csv(env):
    """名前: 20文字で切る・数式に見える名前はCSVで無害化・空欄は名無し"""
    env.fresh()
    p = env.page("tone-20")
    record(p, "=1+1あいうえおかきくけこさしすせそたちつてと")
    record(p, "")
    rs = records(env, p)
    check(len(rs[0]["name"]) == 20, f"名前の長さ {len(rs[0]['name'])}")
    check(rs[1]["name"] == "", "空欄の名前")
    with p.expect_download() as dl:
        p.click("#btn-csv")
    csv = open(dl.value.path(), encoding="utf-8-sig", newline="").read()
    check("'=1+1" in csv, f"CSV 無害化されていない: {csv!r}")
    return "20文字切り・CSVの数式無害化 OK"


def s12_two_tabs(env):
    """2つの画面（別ブラウザ）で同時に計測 → 両方ファイルに残り、再読み込みで両方見える"""
    env.fresh()
    a = env.page("tone-20")
    b = env.page("tone-10")
    start_measure(a)
    start_measure(b)
    for p, n in ((a, "画面A"), (b, "画面B")):
        wait_state(p, "result", 15)
        p.fill("#result-name", n)
        p.press("#result-name", "Enter")
        wait_saved(p)
    names = sorted(r["name"] for r in records(env, a))
    check(names == ["画面A", "画面B"], f"ファイル: {names}")
    a.reload()
    wait_ready(a)
    check(len(top10(a)) == 2, f"画面A の TOP10: {top10(a)}")
    return "両方保存・相互に反映"


def s13_corrupt_file(env):
    """保存ファイルが壊れても、退避ファイルを作り、画面側の控えから全件復元される"""
    env.fresh()
    p = env.page("tone-20")
    record(p, "前1")
    record(p, "前2")
    path = os.path.join(env.data, today(p) + ".json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{壊れたデータ")
    record(p, "後")
    names = sorted(r["name"] for r in records(env, p))
    broken = [n for n in os.listdir(env.data) if ".broken-" in n]
    check(names == ["前1", "前2", "後"], f"復元後: {names}")
    check(broken, "壊れたファイルの退避がない")
    return f"3件復元・退避 {broken[0]}"


def s14_server_down(env):
    """計測中にサーバー停止 → 赤帯・未保存表示 → 再起動で自動保存"""
    env.fresh()
    p = env.page("tone-20")
    start_measure(p)
    env.stop_server()
    wait_state(p, "result", 10)
    p.fill("#result-name", "停止中")
    p.press("#result-name", "Enter")
    p.wait_for_function("document.querySelector('#sync-status').dataset.kind === 'error'", timeout=15000)
    banner = p.is_visible("#server-banner")
    env.start_server()
    wait_saved(p, 30)
    names = [r["name"] for r in records(env, p)]
    check(banner, "赤帯が出ない")
    check(names == ["停止中"], f"再起動後: {names}")
    return "停止中の記録が再起動後に保存"


def s15_many_records(env):
    """1日500件（各100サンプル）: 表示・保存の速さ"""
    env.fresh()
    now = int(time.time() * 1000)
    bulk = [{"id": f"bulk{i:04d}", "name": f"人{i}", "score": round(60 + (i * 7919 % 400) / 10, 1), "method": "mean",
             "duration": 5, "ts": now - 1000000 + i, "updatedAt": now - 1000000 + i, "clipped": False,
             "series": [[t * 50, 75.5] for t in range(100)]} for i in range(500)]
    t0 = time.time()
    c0 = env.browser("tone-10").new_context()
    env.contexts.append(c0)
    p0 = c0.new_page()
    p0.goto(env.base + "/")
    date = today(p0)
    p0.context.close()
    api(env.base, "/api/records/" + date, bulk)
    t_bulk = time.time() - t0
    t1 = time.time()
    p = env.page("tone-10")
    p.wait_for_function("document.querySelectorAll('#top10 li:not(.empty)').length === 10", timeout=30000)
    t_load = time.time() - t1
    t2 = time.time()
    record(p, "最後の人")
    t_rec = time.time() - t2 - 5  # 計測5秒を除いた時間
    best = max(bulk, key=lambda r: r["score"])["score"]
    check(len(records(env, p)) == 501, "件数")
    check(t_rec < 5, f"保存が遅い {t_rec:.1f}s")
    return f"一括保存 {t_bulk:.1f}s・読込 {t_load:.1f}s・1件追加の保存 {t_rec:.1f}s（最高 {best}）"


DATE_SHIFT = """
(() => {
  const R = Date; let off = 0;
  window.__shiftDays = (n) => { off = n * 86400000; };
  class D extends R {
    constructor(...a) { if (a.length === 0) super(R.now() + off); else super(...a); }
    static now() { return R.now() + off; }
  }
  window.Date = D;
})();
"""


def s16_date_rollover(env):
    """日付が変わると、新しい日のファイルに記録され、前日の記録は表示から外れる"""
    env.fresh()
    p = env.page("tone-20", init_script=DATE_SHIFT)
    record(p, "きのう")
    d1 = today(p)
    p.evaluate("window.__shiftDays(1)")
    d2 = today(p)
    record(p, "きょう")
    r1 = [r["name"] for r in records(env, p, d1)]
    r2 = [r["name"] for r in records(env, p, d2)]
    check(d1 != d2, "日付が変わっていない")
    check(r1 == ["きのう"] and r2 == ["きょう"], f"{d1}: {r1} / {d2}: {r2}")
    check([x.split()[1] for x in top10(p)] == ["きょう"], f"TOP10: {top10(p)}")
    return f"{d1}→{d2} で別ファイル"


SCENARIOS = [
    ("S1", "計測精度（70/80/90dB）", s1_accuracy),
    ("S2", "平均とLeqの違い", s2_mean_vs_leq),
    ("S3", "計測秒数 3秒/10秒", s3_durations),
    ("S4", "しきい値で自動スタート", s4_threshold_autostart),
    ("S5", "スタンバイのタイムアウト", s5_standby_timeout),
    ("S6", "計測中の中断", s6_abort),
    ("S7", "ゴースト・新記録・順位", s7_ghost_and_ranking),
    ("S8", "クリップ検出", s8_clip),
    ("S9", "記録の破棄", s9_discard),
    ("S10", "本日の記録リセット", s10_reset),
    ("S11", "名前とCSV", s11_names_csv),
    ("S12", "2画面同時", s12_two_tabs),
    ("S13", "保存ファイル破損からの復元", s13_corrupt_file),
    ("S14", "計測中のサーバー停止", s14_server_down),
    ("S15", "大量データ（500件）", s15_many_records),
    ("S16", "日付またぎ", s16_date_rollover),
]


def main(only):
    tmp_sounds = os.path.join(tempfile.gettempdir(), "kitano-e2e-sounds")
    os.makedirs(tmp_sounds, exist_ok=True)
    sounds = make_sounds(tmp_sounds)
    results = []
    with sync_playwright() as pw:
        env = Env(pw, sounds)
        try:
            for sid, title, fn in SCENARIOS:
                if only and sid not in only:
                    continue
                t0 = time.time()
                try:
                    detail = fn(env)
                    ok = True
                except Exception as e:  # noqa: BLE001
                    ok, detail = False, f"{type(e).__name__}: {e}"
                    traceback.print_exc()
                env.close_contexts()
                results.append((sid, title, ok, detail, time.time() - t0))
                print(f"{'PASS' if ok else 'FAIL'} {sid} {title} … {detail} ({time.time() - t0:.0f}s)", flush=True)
        finally:
            env.close()
    passed = sum(1 for r in results if r[2])
    print(f"\n[{KIND}] {passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main(set(sys.argv[1:])))
