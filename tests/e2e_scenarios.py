# -*- coding: utf-8 -*-
"""
シナリオ別のブラウザ通しテスト（Playwright + Chromium の仮想マイク）。ロケット版。

音量が分かっているテスト用の音（WAV）を仮想マイクに流して、画面操作から保存ファイルまでを確認する。
既定の難易度（floor 55dB・のびやすさ 5km/秒/dB）なら、70dB → 75km/秒、80dB → 125km/秒、90dB → 175km/秒 で上がる。

  python tests/e2e_scenarios.py                      … server.py に対して実行
  KITANO_SERVER=powershell python tests/e2e_scenarios.py … server.ps1 に対して実行
  python tests/e2e_scenarios.py S1 S7                 … 一部だけ

必要: pip install playwright && playwright install chromium（Chromium が入っていれば不要）
"""

import json
import math
import re
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
from test_api import KIND, ROOT, free_port, start_server  # noqa: E402

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
        "pulse": (lambda t: mid(t) if t < 7 else 0.0, 10),  # 80 dB を7秒 → 3秒無音（くり返し）
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




DEFAULT_SETTINGS = {
    "deviceId": "", "offset": OFFSET, "threshold": 65, "floor": 55, "kmRate": 5, "goal1Km": 100, "goal2Km": 500,
    "stage1Sec": 5, "endlessMaxSec": 10, "silenceEndSec": 1, "booster": True, "cheerBoost": True, "ghost": True,
    "nameInput": True, "bgm": True, "bgmVolume": 0.4, "muteBgmDuringRun": True, "se": True, "seVolume": 0.7,
    "seDuringRun": False, "theme": "light", "rehearsal": False, "adminPin": "0000",
}
RUN_STATES = ("stage1", "booster", "endless")


def api(base, path, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def state(p):
    return p.evaluate("document.getElementById('stage').dataset.state")


def diag(p):
    return p.evaluate("""({state: document.getElementById('stage').dataset.state, side: document.getElementById('stage').dataset.side,
      strip: document.getElementById('strip').textContent, mic: document.getElementById('mic-status').textContent,
      sync: document.getElementById('sync-status').textContent, toast: document.getElementById('toast').textContent,
      focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      admin: !document.getElementById('admin').hidden, modal: !document.getElementById('modal').hidden,
      pin: !document.getElementById('pin').hidden})""")


def wait_state(p, s, timeout=20):
    states = [s] if isinstance(s, str) else list(s)
    try:
        p.wait_for_function(f"{json.dumps(states)}.includes(document.getElementById('stage').dataset.state)", timeout=timeout * 1000)
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"状態 {states} にならない: {diag(p)} / errors={getattr(p, 'errors', [])}") from e


def wait_saved(p, timeout=20):
    p.wait_for_function("document.querySelector('#sync-status').textContent.includes('保存済み')", timeout=timeout * 1000)


def wait_ready(p):
    wait_saved(p)
    p.wait_for_function("document.querySelector('#mic-status').dataset.kind === 'ok'", timeout=15000)
    wait_state(p, "idle")


def today(p):
    return p.evaluate("(() => { const d = new Date(); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}`; })()")


def fly(p, manual=False):
    """待機から1回遊ぶ（結果画面まで）。途中で見えた状態・右上パネル・演出を返す。"""
    p.keyboard.press("Space")
    wait_state(p, ("standby",) + RUN_STATES, 10)
    if manual and state(p) == "standby":
        p.keyboard.press("Space")
    wait_state(p, RUN_STATES + ("result",), 20)
    seen = {"states": [], "sides": set(), "goalCard": False, "boosterPill": False, "ghost": set(), "speedlines": False}
    t0 = time.time()
    while state(p) in RUN_STATES and time.time() - t0 < 40:
        info = p.evaluate("""({s: document.getElementById('stage').dataset.state, side: document.getElementById('stage').dataset.side,
          goal: !document.getElementById('goal-card').hidden, boost: !document.getElementById('booster-pill').hidden,
          ghost: document.getElementById('stage').dataset.ghost})""")
        if not seen["states"] or seen["states"][-1] != info["s"]:
            seen["states"].append(info["s"])
        seen["sides"].add(info["side"])
        seen["goalCard"] |= info["goal"]
        seen["boosterPill"] |= info["boost"]
        seen["ghost"].add(info["ghost"])
        time.sleep(0.1)
    wait_state(p, "result", 10)
    seen["cells"] = p.evaluate("[0,1,2].map(i => document.querySelector('#cell-' + i + ' .cell-v').textContent)")
    seen["newRecord"] = p.is_visible("#newrecord-pill")
    seen["side"] = p.evaluate("document.getElementById('stage').dataset.side")
    return seen


def name_and_close(p, name=""):
    """結果画面で名前を入れて Enter（待機に戻る）。"""
    if name:
        p.fill("#result-name", name)
    p.press("#result-name", "Enter")
    wait_state(p, "idle")
    wait_saved(p)


def play(p, name="", manual=False):
    seen = fly(p, manual)
    name_and_close(p, name)
    return seen


def records(env, p, date=None, include_deleted=False):
    rs = api(env.base, "/api/records/" + (date or today(p)))
    return rs if include_deleted else [r for r in rs if not r.get("deleted")]


def ranking(p):
    return [(li.query_selector(".n").inner_text(), li.query_selector(".s").inner_text())
            for li in p.query_selector_all("#rank-list li:not(.empty)")]


def open_admin(p, pin="0000"):
    p.keyboard.press("Control+Shift+A")
    p.wait_for_selector("#pin:not([hidden])", timeout=5000)
    p.keyboard.type(pin)
    p.keyboard.press("Enter")
    p.wait_for_selector("#admin:not([hidden])", timeout=5000)


def save_admin(p):
    p.click("#admin >> text=保存して戻る")
    p.wait_for_selector("#admin", state="hidden", timeout=5000)
    wait_saved(p)


def download_csv(p):
    open_admin(p)
    with p.expect_download() as dl:
        p.click("#admin >> text=CSV出力")
    csv = open(dl.value.path(), encoding="utf-8-sig", newline="").read()
    p.click("#admin >> text=キャンセル")
    return csv


def near(a, b, tol):
    return abs(a - b) <= tol


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def monotonic(series):
    return all(series[i][0] >= series[i - 1][0] and series[i][1] >= series[i - 1][1] for i in range(1, len(series)))


# ---------------------------------------------------------------------------
# シナリオ
# ---------------------------------------------------------------------------

def s1_accuracy(env):
    """既知の音量（70/80/90 dB）の平均が ±0.7 dB 以内で記録され、声の履歴は 100ms ごと"""
    env.fresh()
    out = []
    for sound, expect in [("tone-30", 70), ("tone-20", 80), ("tone-10", 90)]:
        p = env.page(sound)
        play(p, sound)  # 本番と同じく、しきい値を超えた瞬間の自動スタートで測る
        r = [x for x in records(env, p) if x["name"] == sound][0]
        check(near(r["meanDb"], expect, 0.7), f"{sound}: 平均 {r['meanDb']} (期待 {expect})")
        gaps = [b[0] - a[0] for a, b in zip(r["series"], r["series"][1:])]
        check(min(gaps[:-1] or [100]) >= 99, f"{sound}: 履歴の間隔 {min(gaps)}ms")
        out.append(f"{expect}dB→{r['meanDb']}")
    return " / ".join(out)


def s2_flow_loud(env):
    """80dB: うちゅう→つきに4秒で届く（ブースターなし）→ エンドレス10秒 → 約1,750km（どせい）"""
    env.fresh()
    p = env.page("tone-20")
    seen = fly(p)
    check(seen["states"] == ["stage1", "endless"], f"状態の流れ: {seen['states']}")
    check(seen["goalCard"], "もくひょう1 クリアの表示が出ない")
    check("db" in seen["sides"], f"こえパワー表示: {seen['sides']}")
    check(seen["side"] == "name", f"結果画面の右上: {seen['side']}")
    check(seen["newRecord"], "最初の記録なのに しんきろく が出ない")
    name_and_close(p, "どせい")
    r = records(env, p)[0]
    check(near(r["score"], 1750, 25), f"高さ {r['score']}")
    check(r["reached"] == "saturn" and r["boosted"] is False and r["endReason"] == "max", f"{r['reached']} {r['boosted']} {r['endReason']}")
    check(near(r["durationMs"], 14000, 250), f"時間 {r['durationMs']}ms")
    check(monotonic(r["alt"]) and r["alt"][-1][1] == r["score"], "高さの履歴")
    check(r["game"] == "rocket" and r["cfg"]["kmRate"] == 5, "記録の形式")
    return f"{r['score']}km・{r['durationMs']}ms・どせい"


def s3_booster(env):
    """70dB: 5秒で月に届かず → ブースター（おうえんメーター）→ エンドレス → 約1,250km（もくせい）"""
    env.fresh()
    p = env.page("tone-30")
    seen = fly(p)
    check(seen["states"] == ["stage1", "booster", "endless"], f"状態の流れ: {seen['states']}")
    check("cheer" in seen["sides"] and seen["boosterPill"], f"ブースター表示: {seen['sides']} pill={seen['boosterPill']}")
    name_and_close(p)
    r = records(env, p)[0]
    check(near(r["score"], 1250, 20) and r["boosted"] is True and r["reached"] == "jupiter", f"{r['score']} {r['boosted']} {r['reached']}")
    voice_t = [t for t, _ in r["series"]]
    check(not any(5100 < t < 7900 for t in voice_t), "ブースター中の声が記録に入っている")
    return f"{r['score']}km・ブースターあり・もくせい"


def s4_silence_end(env):
    """エンドレス中に声が1秒とぎれると終わる"""
    env.fresh()
    p = env.page("pulse")
    seen = fly(p)
    name_and_close(p)
    r = records(env, p)[0]
    check(r["endReason"] == "silence", f"終了理由 {r['endReason']} / {seen['states']}")
    return f"{r['score']}km・{r['durationMs']}ms で終了（とぎれ）"


def s5_booster_off(env):
    """ブースターをオフ: 70dB は5秒で終了（つきに届かない）"""
    env.fresh({"booster": False})
    p = env.page("tone-30")
    seen = fly(p)
    check(seen["states"] == ["stage1"], f"状態の流れ: {seen['states']}")
    name_and_close(p)
    r = records(env, p)[0]
    check(r["endReason"] == "time" and near(r["score"], 375, 12) and r["reached"] == "space", f"{r['endReason']} {r['score']} {r['reached']}")
    return f"{r['score']}km（うちゅう）で終了"


def s6_standby_timeout(env):
    """スタンバイで15秒だれも声を出さないと待機に戻る"""
    env.fresh()
    p = env.page("silence")
    p.keyboard.press("Space")
    wait_state(p, "standby", 5)
    t0 = time.time()
    wait_state(p, "idle", 20)
    dt = time.time() - t0
    check(near(dt, 15, 1.5), f"{dt:.1f}秒で戻った")
    check("じかんぎれ" in p.text_content("#strip"), p.text_content("#strip"))
    return f"{dt:.1f}秒で待機へ"


def s7_abort(env):
    """飛んでいる途中に Esc → 待機に戻り、記録は残らない"""
    env.fresh()
    p = env.page("tone-20")
    p.keyboard.press("Space")
    wait_state(p, RUN_STATES, 10)
    time.sleep(1)
    p.keyboard.press("Escape")
    wait_state(p, "idle", 5)
    time.sleep(1)
    check(records(env, p, include_deleted=True) == [], "中断したのに記録が残った")
    check("ちゅうだん" in p.text_content("#strip"), p.text_content("#strip"))
    return "中断・記録なし"


def s8_ghost_ranking(env):
    """ゴースト（今日の1位）・しんきろく・順位・ランキングの並び"""
    env.fresh()
    a = env.page("tone-30")
    s_a = play(a, "あおい")
    check(s_a["newRecord"] and "none" in s_a["ghost"], f"1人目: {s_a}")
    b = env.page("tone-20")
    s_b = fly(b)
    check("has" in s_b["ghost"], "2人目でゴーストが出ない")
    check(s_b["newRecord"] and s_b["cells"][2] == "1 い", f"2人目: {s_b['cells']}")
    name_and_close(b, "はると")
    s_c = play(env.page("tone-30"), "ゆい")
    check(not s_c["newRecord"] and s_c["cells"][2] == "3 い", f"3人目: {s_c['cells']}")
    rk = ranking(b)
    b.reload()
    wait_ready(b)
    rk = ranking(b)
    check([n for n, _ in rk] == ["はると", "あおい", "ゆい"], f"ランキング: {rk}")
    label = b.evaluate("document.querySelector('.rocket.ghost .rocket-label').textContent")
    return f"ランキング {rk}・{label}"


def s9_name_off(env):
    """名前入力オフ: 結果は高さを大きく表示、Space ですぐ次の人のスタンバイ"""
    env.fresh({"nameInput": False})
    p = env.page("tone-20")
    seen = fly(p)
    check(seen["side"] == "score", f"右上: {seen['side']}")
    p.keyboard.press("Space")
    wait_state(p, ("standby",) + RUN_STATES, 5)
    p.keyboard.press("Escape")
    wait_state(p, "idle", 5)
    wait_saved(p)
    rs = records(env, p)
    check(len(rs) == 1 and rs[0]["name"] == "", f"記録: {[(r['name'], r['score']) for r in rs]}")
    return "名前なしで次へ"


def s10_names(env):
    """名前: 20文字で切る・Esc で名前なし・空欄で Space → 次の人・CSV で数式を無害化"""
    env.fresh()
    p = env.page("tone-20")
    play(p, "=1+1あいうえおかきくけこさしすせそたちつてと")
    fly(p)
    p.fill("#result-name", "けす")
    p.press("#result-name", "Escape")
    wait_state(p, "idle")
    fly(p)
    p.press("#result-name", "Space")
    wait_state(p, ("standby",) + RUN_STATES, 5)
    p.keyboard.press("Escape")
    wait_state(p, "idle")
    wait_saved(p)
    rs = records(env, p)
    check(len(rs) == 3, f"件数 {len(rs)}")
    check(len(rs[0]["name"]) == 20 and rs[1]["name"] == "" and rs[2]["name"] == "", f"名前: {[r['name'] for r in rs]}")
    csv = download_csv(p)
    check("'=1+1" in csv and csv.startswith("順位,名前,高さ(km)"), f"CSV: {csv[:200]!r}")
    return "20文字切り・Esc で名前なし・Space で次へ・CSV 無害化"


def s11_discard(env):
    """結果画面で破棄 → ランキングから消え、ファイルには deleted で残る（再読み込み・CSV でも復活しない）"""
    env.fresh()
    p = env.page("tone-20")
    play(p, "のこす")
    fly(p)
    p.fill("#result-name", "けす")
    p.click("#btn-discard")
    p.click("#modal-ok")
    wait_state(p, "idle")
    wait_saved(p)
    all_ = records(env, p, include_deleted=True)
    check(len(all_) == 2 and sum(1 for r in all_ if r.get("deleted")) == 1, f"ファイル: {all_}")
    p.reload()
    wait_ready(p)
    check([n for n, _ in ranking(p)] == ["のこす"], f"ランキング: {ranking(p)}")
    csv = download_csv(p)
    check("のこす" in csv and "けす" not in csv and csv.count("\r\n") == 2, f"CSV: {csv!r}")
    return "破棄分は表示・CSVから除外、ファイルには残存"


def s12_admin(env):
    """管理者画面: 暗証番号・設定の保存（ファイルにも）・計測中は開けない・本日の記録リセット"""
    env.fresh()
    p = env.page("tone-20")
    p.keyboard.press("Control+Shift+A")
    p.wait_for_selector("#pin:not([hidden])")
    p.keyboard.type("1234")
    p.keyboard.press("Enter")
    check("ちがいます" in p.text_content("#pin-error"), "まちがった暗証番号で開いた")
    p.keyboard.press("Escape")
    p.wait_for_selector("#pin", state="hidden")
    open_admin(p)
    p.fill("input[data-key=kmRate]", "10")
    p.select_option("select[data-key=theme]", "dark")
    p.uncheck("input[data-key=nameInput]")
    p.fill("input[data-key=adminPin]", "2468")
    preview = p.text_content("#admin .hint-box")
    save_admin(p)
    s = api(env.base, "/api/settings")
    check(s["kmRate"] == 10 and s["theme"] == "dark" and s["nameInput"] is False and s["adminPin"] == "2468", f"保存された設定: {s}")
    check(p.evaluate("document.getElementById('stage').dataset.theme") == "dark", "背景が変わらない")
    p.reload()
    wait_ready(p)
    check(p.evaluate("window.__kitano.settings.kmRate") == 10, "再読み込みで設定が戻らない")
    # 計測中は開けない
    p.keyboard.press("Space")
    wait_state(p, RUN_STATES, 10)
    p.keyboard.press("Control+Shift+A")
    time.sleep(0.3)
    check(not p.is_visible("#pin") and "計測中" in p.text_content("#toast"), f"計測中に開けた: {diag(p)}")
    wait_state(p, "result", 30)
    p.keyboard.press("Enter")
    wait_state(p, "idle")
    # リセット（新しい暗証番号で）
    open_admin(p, "2468")
    p.click("#admin >> text=本日の記録をリセット")
    p.click("#modal-ok")
    p.click("#admin >> text=キャンセル")
    wait_saved(p)
    check(ranking(p) == [], f"リセット後も表示が残る: {ranking(p)}")
    all_ = records(env, p, include_deleted=True)
    check(len(all_) == 1 and all(r.get("deleted") for r in all_), f"ファイル: {all_}")
    return f"設定保存・復元・計測中ブロック・リセット OK（めやす: {preview.splitlines()[0] if preview else ''}…）"


def s13_rehearsal(env):
    """リハーサルモード: 記録はファイルに残るが、ランキング・ゴーストに入らない"""
    env.fresh({"rehearsal": True})
    p = env.page("tone-20")
    check(p.is_visible("#rehearsal-badge"), "リハーサル表示が出ない")
    seen = play(p, "れんしゅう")
    rs = records(env, p)
    check(len(rs) == 1 and rs[0]["rehearsal"] is True, f"記録: {rs}")
    check(seen["cells"][2] == "リハーサル" and not seen["newRecord"], f"結果: {seen['cells']}")
    check(ranking(p) == [], f"ランキング: {ranking(p)}")
    return "ファイルには rehearsal:true・ランキング外"


def s14_clip(env):
    """フルスケールの音でクリップ警告が出て、記録にクリップ印が付く"""
    env.fresh()
    p = env.page("square")
    p.keyboard.press("Space")
    wait_state(p, RUN_STATES, 10)
    time.sleep(0.5)
    seen = p.is_visible("#clip-warning")
    wait_state(p, "result", 30)
    name_and_close(p)
    r = records(env, p)[-1]
    check(seen, "CLIP 警告が出ない")
    check(r["clipped"] is True, "clipped が付いていない")
    return f"CLIP 表示あり・{r['score']}km"


def s15_two_screens(env):
    """2つの画面（別ブラウザ）で同時に遊ぶ → 両方ファイルに残り、再読み込みで両方見える"""
    env.fresh()
    a = env.page("tone-20")
    b = env.page("tone-10")
    for p in (a, b):
        p.keyboard.press("Space")
    for p, n in ((a, "画面A"), (b, "画面B")):
        wait_state(p, "result", 40)
        name_and_close(p, n)
    names = sorted(r["name"] for r in records(env, a))
    check(names == ["画面A", "画面B"], f"ファイル: {names}")
    a.reload()
    wait_ready(a)
    check(len(ranking(a)) == 2, f"画面A のランキング: {ranking(a)}")
    return "両方保存・相互に反映"


def s16_corrupt_file(env):
    """保存ファイルが壊れても、退避ファイルを作り、画面側の控えから全件復元される"""
    env.fresh()
    p = env.page("tone-20")
    play(p, "前1")
    play(p, "前2")
    path = os.path.join(env.data, today(p) + ".json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{壊れたデータ")
    play(p, "後")  # 届いた1件だけでファイルが作り直されるが、画面側が足りない分をすぐ送り直す
    p.wait_for_function("document.querySelector('#sync-status').textContent.includes('保存済み')", timeout=10000)
    time.sleep(1)
    names = sorted(r["name"] for r in records(env, p))
    broken = [n for n in os.listdir(env.data) if ".broken-" in n]
    check(names == ["前1", "前2", "後"], f"復元後: {names}")
    check(broken, "壊れたファイルの退避がない")
    return f"3件復元・退避 {broken[0]}"


def s17_server_down(env):
    """飛んでいる途中にサーバー停止 → 赤帯・未保存表示 → 再起動で自動保存"""
    env.fresh()
    p = env.page("tone-20")
    p.keyboard.press("Space")
    wait_state(p, RUN_STATES, 10)
    env.stop_server()
    wait_state(p, "result", 30)
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


def s18_many_records(env):
    """1日800件（本番と同じ大きさの記録）: 表示・保存の速さ"""
    env.fresh()
    now = int(time.time() * 1000)
    bulk = []
    for i in range(800):
        score = 300 + (i * 7919 % 2000)
        bulk.append({"id": f"bulk{i:04d}", "name": f"人{i}", "game": "rocket", "score": score, "meanDb": 78.5,
                     "reached": "mars", "boosted": False, "endReason": "max", "durationMs": 15000,
                     "ts": now - 1000000 + i, "updatedAt": now - 1000000 + i, "clipped": False, "rehearsal": False,
                     "series": [[t * 100, 78.5] for t in range(150)],
                     "alt": [[t * 100, round(score * t / 150)] for t in range(151)]})
    c0 = env.browser("tone-10").new_context()
    env.contexts.append(c0)
    p0 = c0.new_page()
    p0.goto(env.base + "/")
    date = today(p0)
    c0.close()
    t0 = time.time()
    api(env.base, "/api/records/" + date, bulk)
    t_bulk = time.time() - t0
    t1 = time.time()
    p = env.page("tone-10")
    p.wait_for_function("document.querySelectorAll('#rank-list li:not(.empty)').length === 6", timeout=30000)
    t_load = time.time() - t1
    seen = fly(p)
    t2 = time.time()
    name_and_close(p, "最後の人")
    t_save = time.time() - t2
    check(len(records(env, p)) == 801, "件数")
    # PowerShell 版（Python が無い PC 用の予備）は JSON の読み書きが遅いので、1日800件だと数秒かかる（画面は止まらない）
    limit = 5 if KIND == "python" else 12
    check(t_save < limit, f"保存が遅い {t_save:.1f}s")
    check("has" in seen["ghost"], "ゴーストが出ない")
    return f"一括保存 {t_bulk:.1f}s・読込 {t_load:.1f}s・1件追加の保存 {t_save:.1f}s"


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


def s19_date_rollover(env):
    """日付が変わると、新しい日のファイルに記録され、前日の記録は表示から外れる"""
    env.fresh()
    p = env.page("tone-20", init_script=DATE_SHIFT)
    play(p, "きのう")
    d1 = today(p)
    p.evaluate("window.__shiftDays(1)")
    d2 = today(p)
    play(p, "きょう")
    r1 = [r["name"] for r in records(env, p, d1)]
    r2 = [r["name"] for r in records(env, p, d2)]
    check(d1 != d2, "日付が変わっていない")
    check(r1 == ["きのう"] and r2 == ["きょう"], f"{d1}: {r1} / {d2}: {r2}")
    check([n for n, _ in ranking(p)] == ["きょう"], f"ランキング: {ranking(p)}")
    return f"{d1}→{d2} で別ファイル"


def _ensure_test_bgm():
    """sound フォルダに音楽が無ければ、テスト用の小さな音（3秒・小音量）を一時的に置く。置いたファイルのパスを返す。"""
    d = os.path.join(ROOT, "sound")
    os.makedirs(d, exist_ok=True)
    if any(n.lower().endswith((".mp3", ".ogg", ".wav", ".m4a")) for n in os.listdir(d)):
        return None
    path = os.path.join(d, "zz-e2e-test.wav")
    _write_wav(path, _sine(-40, 440), 3)
    return path


def s20_bgm(env):
    """BGM: 待機中は流れ、スタンバイ〜飛行中は止まり、結果で戻る（計測中は BGM を消す 設定）"""
    made = _ensure_test_bgm()
    try:
        env.fresh()
        p = env.page("silence")
        p.keyboard.press("Shift")  # ブラウザの「操作するまで音を出さない」を解除
        p.wait_for_function("window.__kitano.bgm.playing === true", timeout=10000)
        files = p.evaluate("window.__kitano.bgm.files")
        p.keyboard.press("Space")
        wait_state(p, "standby", 5)
        p.wait_for_function("window.__kitano.bgm.playing === false", timeout=3000)
        p.keyboard.press("Space")  # 無音なので手動スタート
        wait_state(p, RUN_STATES, 5)
        check(not p.evaluate("window.__kitano.bgm.playing"), "飛行中に BGM が鳴っている")
        p.keyboard.press("Escape")
        wait_state(p, "idle", 5)
        p.wait_for_function("window.__kitano.bgm.playing === true", timeout=5000)
        return f"待機で再生・計測中は停止・戻ると再開（{len(files)} 曲）"
    finally:
        if made:
            os.remove(made)


SCENARIOS = [
    ("S1", "計測精度（70/80/90dB）", s1_accuracy),
    ("S2", "80dB: つき到達→エンドレス", s2_flow_loud),
    ("S3", "70dB: ブースター→エンドレス", s3_booster),
    ("S4", "エンドレスで声がとぎれて終了", s4_silence_end),
    ("S5", "ブースター オフ", s5_booster_off),
    ("S6", "スタンバイのタイムアウト", s6_standby_timeout),
    ("S7", "飛行中の中断", s7_abort),
    ("S8", "ゴースト・しんきろく・順位", s8_ghost_ranking),
    ("S9", "名前入力オフ", s9_name_off),
    ("S10", "名前（20文字・Esc・Space）とCSV", s10_names),
    ("S11", "記録の破棄", s11_discard),
    ("S12", "管理者画面", s12_admin),
    ("S13", "リハーサルモード", s13_rehearsal),
    ("S14", "クリップ検出", s14_clip),
    ("S15", "2画面同時", s15_two_screens),
    ("S16", "保存ファイル破損からの復元", s16_corrupt_file),
    ("S17", "飛行中のサーバー停止", s17_server_down),
    ("S18", "大量データ（800件）", s18_many_records),
    ("S19", "日付またぎ", s19_date_rollover),
    ("S20", "BGM の自動停止", s20_bgm),
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
                errs = [e for c in env.contexts for pg in c.pages for e in getattr(pg, "errors", [])]
                if ok and errs:
                    ok, detail = False, f"画面のエラー: {errs}"
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
