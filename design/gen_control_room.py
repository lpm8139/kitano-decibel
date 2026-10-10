# 管制室テーマ（明るい背景）v3
import random
import gen_a as A   # rocket(), planet_svg(), peek(), stars() などを再利用
random.seed(5)
W, H = 1920, 1080
FONT = "'Zen Maru Gothic','M PLUS Rounded 1c',sans-serif"
NAVY, ORANGE, YEL, CYAN = "#1F2A44", "#FF7A1A", "#FFD166", "#8ED6FF"
RANK = [("はると", "1,620"), ("ゆい", "1,240"), ("そうた", "880"), ("あおい", "500"), ("りく", "430")]

def lamp(x, y, c, glow=True):
    g = f"box-shadow:0 0 14px 4px {c}" if glow else ""
    return f'<div style="position:absolute;left:{x}px;top:{y}px;width:22px;height:22px;border-radius:50%;background:{c};{g}"></div>'

def header(status="ファイルに保存済み ✓"):
    lamps = "".join(lamp(1500 + i * 40, 44, c, i % 2 == 0) for i, c in enumerate(["#4CD964", "#FFD166", "#4CD964", "#FF5A5F", "#4CD964"]))
    return f'''<div style="position:absolute;left:0;top:0;width:{W}px;height:112px;background:linear-gradient(180deg,#FFFFFF,#E9EFF8);border-bottom:4px solid #C8D3E6"></div>
<div style="position:absolute;left:40px;top:22px;padding:10px 26px;border-radius:16px;background:{NAVY};color:#fff;font-size:44px;font-weight:900;letter-spacing:3px;white-space:nowrap">ロケット かんせいしつ</div>
<div style="position:absolute;left:660px;top:38px;font-size:32px;font-weight:900;color:{NAVY};white-space:nowrap">きみの こえが ロケットの エンジン！</div>
{lamps}
<div style="position:absolute;left:1730px;top:40px;font-size:20px;color:#5B6B88;white-space:nowrap">{status}</div>'''

def monitor(x, y, w, h, inner, title=None, title_color="#5B6B88"):
    t = f'<div style="position:absolute;left:{x+24}px;top:{y-34}px;font-size:24px;font-weight:900;color:{title_color};letter-spacing:2px;white-space:nowrap">{title}</div>' if title else ""
    return f'''{t}<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;border-radius:28px;background:#2B3347;padding:14px;box-sizing:border-box;box-shadow:0 10px 0 #C3CEE0">
<div style="position:relative;width:100%;height:100%;border-radius:18px;overflow:hidden;background:radial-gradient(circle at 30% 20%,#3C44C9 0%,#1D2177 45%,#0B0D33 100%)">{inner}</div></div>'''

def console():
    btns = "".join(f'<div style="position:absolute;left:{x}px;top:{y}px;width:{s}px;height:{s}px;border-radius:50%;background:{c};box-shadow:inset 0 -6px 0 rgba(0,0,0,0.25)"></div>'
                   for x, y, s, c in [(120,972,54,"#FF5A5F"),(200,980,40,"#FFD166"),(260,980,40,"#4CD964"),(320,980,40,"#5AA9FF"),(1560,972,54,"#FF5A5F"),(1640,980,40,"#4CD964")])
    sliders = "".join(f'<div style="position:absolute;left:{x}px;top:965px;width:16px;height:80px;border-radius:8px;background:#1A2030"></div><div style="position:absolute;left:{x-10}px;top:{975+o}px;width:36px;height:18px;border-radius:6px;background:#E9EFF8"></div>'
                      for x, o in [(420,10),(470,40),(520,25),(1460,30),(1500,5)])
    return f'''<div style="position:absolute;left:0;top:930px;width:{W}px;height:150px;background:linear-gradient(180deg,#4A5875,#36425B);border-top:6px solid #5F6E8E"></div>{btns}{sliders}'''

def strip(text, color=ORANGE, fs=38):  # 卓の中央の案内表示
    return f'<div style="position:absolute;left:620px;top:958px;width:780px;height:90px;border-radius:18px;background:#0E1428;border:4px solid #1A2238;color:{color};font-size:{fs}px;font-weight:900;text-align:center;line-height:82px;white-space:nowrap">{text}</div>'

def space_track(you, ghost, marks, planets_size=230, earth=False, ghost_on=True, x=60, h=600, top=50, w=300):
    out = A.stars(60, 900)
    if earth:
        out += f'<div style="position:absolute;left:-220px;top:{top+h-30}px">{A.planet_svg("earth", 900)}</div>'
    for name, km, kind, pos in marks:
        if name in A.PLANET:
            yy = top + h - 50 - (h - 100) * pos
            sz = planets_size
            wd = sz * 1.7 if A.PLANET[name] == "saturn" else sz
            out += f'<div style="position:absolute;left:{-wd/2}px;top:{yy-sz/2}px">{A.planet_svg(A.PLANET[name], sz)}</div>'
    out += f'<div style="position:absolute;left:{x}px;top:{top}px;width:{w}px;height:{h}px;border-radius:30px;background:rgba(255,255,255,0.06);border:3px solid rgba(255,255,255,0.18)"></div>'
    for name, km, kind, pos in marks:
        yy = top + h - 50 - (h - 100) * pos
        if kind in ("goal", "done"):
            c = YEL if kind == "goal" else "#7CF29C"
            lab = f"★ {name} {km}" if kind == "goal" else f"✓ {name} クリア"
            out += f'<div style="position:absolute;left:{x}px;top:{yy}px;width:{w}px;height:5px;background:{c}"></div><div style="position:absolute;left:{x+w+12}px;top:{yy-22}px;padding:4px 14px;border-radius:999px;background:{c};color:#12153D;font-size:22px;font-weight:900;white-space:nowrap">{lab}</div>'
        else:
            out += f'<div style="position:absolute;left:{x+16}px;top:{yy}px;width:{w-32}px;height:2px;background:rgba(255,255,255,0.25)"></div><div style="position:absolute;left:{x+w+12}px;top:{yy-14}px;font-size:20px;color:rgba(255,255,255,0.75);white-space:nowrap">{name} {km}</div>'
    def place(prog, svg, lx, label, color):
        yy = top + h - 50 - (h - 100) * prog - 125
        return f'<div style="position:absolute;left:{lx}px;top:{yy}px">{svg}</div><div style="position:absolute;left:{lx-15}px;top:{yy+132}px;width:120px;text-align:center;font-size:20px;font-weight:900;color:{color};white-space:nowrap">{label}</div>'
    if ghost_on:
        out += place(ghost, A.ghost_rocket(0.6), x + 170, "チャンピオン", "#C3B5FF")
    out += place(you, A.rocket(scale=0.6), x + 50, "きみ", YEL)
    return out

STAGE = [("ちきゅう", "", "mark", 0.0), ("くも", "10km", "mark", 0.14), ("うちゅう", "100km", "goal", 0.45), ("つき", "500km", "goal", 0.92)]
ENDL = [("つき", "500km", "done", 0.05), ("かせい", "800km", "mark", 0.30), ("もくせい", "1,200km", "mark", 0.58), ("どせい", "1,600km", "mark", 0.86)]

def db_monitor(db, sub="デシベル", bar=0.7, title="こえパワー（エンジン出力）"):
    inner = f'''<div style="position:absolute;left:0;top:18px;width:100%;text-align:center;font-family:{FONT}">
<div style="font-size:150px;font-weight:900;line-height:1;color:{YEL};text-shadow:0 0 30px rgba(255,209,102,0.5)">{db}</div>
<div style="font-size:38px;font-weight:900;color:#fff">{sub}</div></div>
<div style="position:absolute;left:40px;right:40px;bottom:30px;height:26px;border-radius:13px;background:rgba(255,255,255,0.15)"><div style="width:{int(bar*100)}%;height:100%;border-radius:13px;background:linear-gradient(90deg,#4CD964,#FFD166 70%,#FF5A5F)"></div></div>'''
    return monitor(1040, 160, 840, 300, inner, title)

def status_monitor(rows, title="ミッション じょうきょう"):
    cells = "".join(f'<div style="flex:1;text-align:center;font-family:{FONT};color:#fff"><div style="font-size:24px;color:#B9C0FF">{k}</div><div style="font-size:{fs}px;font-weight:900;color:{c};line-height:1.15;white-space:nowrap">{v}</div></div>' for k, v, c, fs in rows)
    inner = f'<div style="display:flex;align-items:center;height:100%;padding:0 20px;gap:10px">{cells}</div>'
    return monitor(1040, 520, 840, 170, inner, title)

def rank_monitor(highlight=None):
    rows = "".join(f'<div style="display:flex;align-items:center;gap:14px;padding:4px 18px;font-size:26px;font-weight:700;color:#fff;{"background:rgba(255,209,102,0.25);border-radius:12px" if n==highlight else ""}"><span style="width:34px;color:{YEL};font-weight:900">{i+1}</span><span style="flex:1">{n}</span><span style="color:{YEL};font-weight:900">{s} km</span></div>' for i, (n, s) in enumerate(RANK))
    inner = f'<div style="padding:10px 6px;font-family:{FONT};display:grid;grid-template-columns:1fr 1fr;column-gap:10px">{rows}</div>'
    return monitor(1040, 730, 840, 180, inner, "きょうの ランキング（とどいた たかさ）")

def main_monitor(inner, title="メインモニター：ロケット"):
    return monitor(40, 160, 970, 750, inner, title)

def overlay_center(html):
    return f'<div style="position:absolute;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center">{html}</div>'

def room(content):
    return f'<div class="screen" style="background:linear-gradient(180deg,#EEF3FA 0%,#DDE6F3 100%);font-family:{FONT};color:{NAVY}">{content}</div>'

def shot(title, content):
    return f'<div class="shot"><div class="shot-title">{title}</div>{room(content)}</div>'

S = []
# ① 待機
wait_main = A.stars(60, 900) + f'<div style="position:absolute;left:-220px;top:520px">{A.planet_svg("earth", 1300)}</div>' + \
    f'<div style="position:absolute;left:400px;top:230px">{A.rocket(scale=1.0, flame=False)}</div>' + \
    f'<div style="position:absolute;left:330px;top:460px;width:260px;height:30px;border-radius:8px;background:#5A5F8C"></div>' + \
    '<div style="position:absolute;left:40px;top:40px;font-size:40px;font-weight:900;color:#fff;white-space:nowrap">はっしゃ じゅんび OK！</div>' + \
    f'<div style="position:absolute;left:40px;top:100px;font-size:26px;color:#B9C0FF;white-space:nowrap">★うちゅう → ★つき → ∞エンドレス を めざそう</div>'
howto = "".join(f'<div style="display:flex;align-items:center;gap:18px;font-family:{FONT};color:#fff;font-size:34px;font-weight:900;padding:8px 0;white-space:nowrap"><span style="width:56px;height:56px;border-radius:50%;background:{ORANGE};text-align:center;line-height:56px">{i}</span>{t}</div>' for i, t in [(1, "マイクの まえに たつ"), (2, "「わーーーっ！」と こえを だす"), (3, "ロケットを うちゅうへ！")])
S.append(shot("① 待機中（明るい管制室）", header() + main_monitor(wait_main) +
    monitor(1040, 160, 840, 300, f'<div style="padding:30px 40px">{howto}</div>', "あそびかた") +
    status_monitor([("いまの こえ", "48.2 dB", CYAN, 56), ("もくひょう", "うちゅう・つき", YEL, 40)], "マイク チェック") +
    rank_monitor() + console() + strip("こえを だすと はっしゃ！")))
# ② ステージ1
S.append(shot("② ステージ1（5びょう）", header() + main_monitor(space_track(0.36, 0.40, STAGE, 260, earth=True)) + db_monitor("86.2", bar=0.72) +
    status_monitor([("のこり", "3.4 びょう", CYAN, 54), ("たかさ", "72 km", "#fff", 54), ("つぎの もくひょう", "うちゅう あと28km", YEL, 34)]) +
    rank_monitor() + console() + strip("ステージ1：うちゅうへ むかって いるよ！")))
# ③ もくひょう1 クリア
clear = overlay_center(f'<div style="width:620px;padding:40px 0;border-radius:40px;background:linear-gradient(135deg,#FFD166,#FF9F43);color:#3A1F00;text-align:center;box-shadow:0 0 0 12px rgba(255,209,102,0.3)"><div style="font-size:40px;font-weight:900">もくひょう1</div><div style="font-size:120px;font-weight:900;line-height:1.05">クリア！</div><div style="font-size:46px;font-weight:900">うちゅうに とうちゃく！</div></div>')
S.append(shot("③ もくひょう1 クリア", header() + main_monitor(space_track(0.47, 0.44, [m if m[0] != "うちゅう" else ("うちゅう", "100km", "done", 0.45) for m in STAGE], 260, earth=True) + clear) +
    db_monitor("89.0", bar=0.78) + status_monitor([("のこり", "2.1 びょう", CYAN, 54), ("たかさ", "104 km", "#fff", 54), ("つぎの もくひょう", "★つき", YEL, 44)]) +
    rank_monitor() + console() + strip("「うちゅう とうちゃく、かくにん！」", "#7CF29C")))
# ④ ブースター
boost = A.stars(60, 900) + '<div style="position:absolute;left:380px;top:200px;width:160px;height:560px;border-radius:80px;background:linear-gradient(0deg,rgba(255,183,3,0) 0%,rgba(255,183,3,0.6) 50%,rgba(255,243,176,0.95) 100%)"></div>' + \
    f'<div style="position:absolute;left:400px;top:60px">{A.rocket(scale=0.9)}</div>' + \
    f'<div style="position:absolute;left:640px;top:-90px">{A.planet_svg("moon", 380)}</div>' + \
    overlay_center(f'<div style="margin-top:420px">{A.pill("ブースター はっしゃ！ つきまで ワープ！", "linear-gradient(90deg,#FF9F43,#FF5A5F)", size=48)}</div>')
cheer = f'<div style="padding:26px 40px;font-family:{FONT};color:#fff;text-align:center"><div style="font-size:40px;font-weight:900;white-space:nowrap">みんなで おうえん！「がんばれー！」</div><div style="margin-top:26px;height:40px;border-radius:20px;background:rgba(255,255,255,0.15)"><div style="width:72%;height:100%;border-radius:20px;background:linear-gradient(90deg,#FFD166,#FF5A5F)"></div></div><div style="margin-top:16px;font-size:26px;color:#D7DBFF">おうえんの こえで ブースターが パワーアップ（きろくには はいらない）</div></div>'
S.append(shot("④ ブースター発射（5びょうで つきに とどかなかったとき）", header() + main_monitor(boost) + monitor(1040, 160, 840, 300, cheer, "おうえん メーター") +
    status_monitor([("うちゅう", "クリア ✓", "#7CF29C", 50), ("つき", "ワープちゅう", YEL, 50)]) + rank_monitor() + console() + strip("このあと ∞エンドレスモード！", "#FF7AE0")))
# ⑤ エンドレス
endless_title = f'<div style="position:absolute;right:30px;top:24px">{A.pill("∞ エンドレスモード", "linear-gradient(90deg,#FF5A8A,#B14CFF)", size=36)}</div>'
S.append(shot("⑤ エンドレスモード（全員・最長10びょう）", header() + main_monitor(space_track(0.62, 0.86, ENDL, 140) + endless_title, "メインモニター：エンドレス") +
    db_monitor("91.8", bar=0.82) + status_monitor([("たかさ", "1,240 km", "#fff", 56), ("チャンピオンまで", "あと 380km", "#E2A7FF", 44), ("のこり", "3.6 / 10びょう", CYAN, 36)]) +
    rank_monitor() + console() + strip("こえが とぎれたら おわり！ とびつづけろ！", "#FF7AE0")))
# ⑥ 結果＋名前入力
res_main = A.stars(60, 900) + f'<div style="position:absolute;left:-200px;top:470px">{A.planet_svg("mars", 520)}</div>' + f'<div style="position:absolute;left:330px;top:120px">{A.rocket(scale=1.2)}</div>' + \
    '<div style="position:absolute;left:560px;top:160px;font-size:52px;font-weight:900;color:#fff;white-space:nowrap">かせい まで<br>いった！</div>' + \
    "".join(f'<div style="position:absolute;left:{560+i*130}px;top:360px;width:110px;height:110px;border-radius:50%;background:{c};color:{fc};text-align:center;font-weight:900"><div style="font-size:44px;line-height:72px">{s}</div><div style="font-size:20px;margin-top:-14px">{t}</div></div>' for i, (s, t, c, fc) in enumerate([("★", "うちゅう", YEL, "#3A1F00"), ("★", "つき", YEL, "#3A1F00"), ("∞", "かせい", "#B14CFF", "#fff")]))
name_box = f'''<div style="padding:24px 36px;font-family:{FONT};color:#fff">
<div style="font-size:30px;color:#B9C0FF">うちゅうひこうしの なまえを おしえてね</div>
<div style="margin-top:14px;padding:14px 24px;border-radius:18px;background:#fff;color:{NAVY};font-size:64px;font-weight:900;white-space:nowrap">はると<span style="color:#C3CEE0">｜</span></div>
<div style="margin-top:14px;font-size:22px;color:#D7DBFF;white-space:nowrap">（スタッフ用）Enter で けってい ／ Esc で なまえなし</div></div>'''
S.append(shot("⑥ 結果＋名前入力（管理者画面でオフにすると名前なしで進む）", header() + main_monitor(res_main, "ミッション せいこう！") + monitor(1040, 160, 840, 300, name_box, "なまえ にゅうりょく") +
    status_monitor([("とどいた たかさ", "820 km", YEL, 56), ("へいきんの こえ", "84.6 dB", CYAN, 50), ("きょうの じゅんい", "5 い", "#fff", 56)], "けっか") +
    rank_monitor() + console() + strip("ミッション せいこう！ おつかれさま！", "#7CF29C")))
# ⑦ 新記録
conf = "".join(f'<div style="position:absolute;left:{random.randint(0,1900)}px;top:{random.randint(120,930)}px;width:{random.choice([14,18,22])}px;height:{random.choice([8,10])}px;border-radius:3px;background:{random.choice([YEL,"#FF5A8A",CYAN,"#7CF29C",ORANGE])};transform:rotate({random.randint(0,180)}deg)"></div>' for _ in range(90))
rec_main = A.stars(60, 900) + f'<div style="position:absolute;left:-260px;top:420px">{A.planet_svg("saturn", 480)}</div>' + f'<div style="position:absolute;left:380px;top:120px">{A.rocket(scale=1.2)}</div>' + \
    overlay_center(f'<div style="margin-top:-500px;margin-left:120px">{A.pill("★ きょうの しんきろく！ ★", "linear-gradient(90deg,#FFD166,#FF9F43)", "#3A1F00", 52)}</div>') + \
    '<div style="position:absolute;left:600px;top:240px;font-size:52px;font-weight:900;color:#fff;white-space:nowrap">どせい まで<br>いった！</div>'
S.append(shot("⑦ 結果（しんきろく）", header() + main_monitor(rec_main, "ミッション だいせいこう！！") + db_monitor("1,620", "km（とどいた たかさ）", 1.0, "しんきろく") +
    status_monitor([("へいきんの こえ", "88.9 dB", CYAN, 50), ("きょうの じゅんい", "1 い", YEL, 60), ("なまえ", "はると", "#fff", 50)], "けっか") +
    rank_monitor("はると") + console() + conf + strip("「しんきろく、かくにん！！」", YEL)))

# ⑧ 管理者画面
def sw(on): 
    return f'<span style="display:inline-block;width:76px;height:40px;border-radius:20px;background:{"#34C759" if on else "#C7CDD8"};position:relative;vertical-align:middle"><span style="position:absolute;top:4px;{"right" if on else "left"}:4px;width:32px;height:32px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></span></span>'
def num(v, unit=""):
    return f'<span style="display:inline-block;min-width:120px;padding:6px 14px;border:2px solid #C8D0DD;border-radius:10px;background:#fff;font-size:24px;text-align:right">{v}</span><span style="margin-left:8px;font-size:22px;color:#5B6B88">{unit}</span>'
def slider(p):
    return f'<span style="display:inline-block;width:220px;height:8px;border-radius:4px;background:#C8D0DD;position:relative;vertical-align:middle"><span style="position:absolute;left:0;top:0;width:{p}%;height:100%;border-radius:4px;background:#2F6FED"></span><span style="position:absolute;left:calc({p}% - 12px);top:-8px;width:24px;height:24px;border-radius:50%;background:#2F6FED"></span></span>'
def row(label, ctrl, note=""):
    n = f'<div style="font-size:18px;color:#7A869C;margin-top:2px">{note}</div>' if note else ""
    return f'<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #E3E8F0"><div><div style="font-size:24px;font-weight:700">{label}</div>{n}</div><div style="white-space:nowrap">{ctrl}</div></div>'
def card(title, rows):
    return f'<div style="background:#fff;border-radius:20px;padding:22px 28px;box-shadow:0 2px 8px rgba(31,42,68,0.08)"><div style="font-size:28px;font-weight:900;margin-bottom:6px">{title}</div>{"".join(rows)}</div>'
admin = f'''<div class="screen" style="background:#F2F5FA;font-family:'Noto Sans JP',sans-serif;color:{NAVY};padding:36px 44px;box-sizing:border-box">
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:22px">
  <div style="font-size:40px;font-weight:900">管理者画面 <span style="font-size:22px;color:#7A869C;font-weight:400">Ctrl+Shift+A ＋ 暗証番号で開く ／ 計測中は開けない</span></div>
  <div style="display:flex;gap:14px"><span style="padding:12px 26px;border-radius:12px;background:#E3E8F0;font-size:24px;font-weight:700">キャンセル</span><span style="padding:12px 26px;border-radius:12px;background:#2F6FED;color:#fff;font-size:24px;font-weight:700">保存して戻る</span></div></div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:22px">
{card("ゲーム", [row("名前入力", sw(True), "オフ：結果の後そのまま次の人へ"), row("ブースター（月までワープ）", sw(True)), row("おうえんブースト", sw(True), "ブースター中の会場の声でゲージが増える"), row("ゴースト（今日の1位）", sw(True)), row("ステージ1の時間", num("5", "秒")), row("エンドレスの最長", num("10", "秒")), row("声が途切れたら終了", num("1.0", "秒"))])}
{card("サウンド", [row("BGM", sw(True) + "　" + slider(40)), row("計測中は BGM を消す", sw(True), "スピーカーの音で dB が上がらないように"), row("効果音", sw(True) + "　" + slider(70)), row("計測中の効果音", sw(False), "クリア音などを計測中にも鳴らす（dBに影響）"), row("BGM ファイル", '<span style="font-size:22px;color:#2F6FED">sound/bgm.mp3 を変更</span>')])}
{card("マイク・計測", [row("入力デバイス", '<span style="font-size:22px">DJI MIC MINI ▼</span>'), row("いまの入力", '<span style="font-size:26px;font-weight:900;color:#2F6FED">-38.2 dBFS → 61.8 dB</span>'), row("開始しきい値", num("65", "dB")), row("校正オフセット", num("100.0", "dB")), row("もくひょう：うちゅう / つき", num("100", "km") + " " + num("500", "km")), row("背景", '<span style="font-size:22px">明るい管制室 ▼</span>', "暗い会場なら「宇宙（暗い）」も選べる")])}
</div>
<div style="margin-top:22px;display:grid;grid-template-columns:2fr 1fr;gap:22px">
{card("記録", [row("保存先", '<span style="font-size:20px">C:\\\\Users\\\\…\\\\kitano-decibel\\\\data　✓ 保存済み</span>'), row("本日の記録", '<span style="font-size:26px;font-weight:900">128 件</span>　<span style="padding:8px 18px;border-radius:10px;background:#E3E8F0;font-size:22px">CSV出力</span>　<span style="padding:8px 18px;border-radius:10px;background:#FFE3E3;color:#C0392B;font-size:22px">本日の記録をリセット</span>')])}
{card("テスト", [row("効果音・BGM を試し再生", '<span style="padding:8px 18px;border-radius:10px;background:#E3E8F0;font-size:22px">▶ 再生</span>'), row("リハーサルモード", sw(False), "オン中の記録はランキングに入れない")])}
</div></div>'''
S.append(f'<div class="shot"><div class="shot-title">⑧ 管理者画面（当日の状況に合わせてオン/オフ）</div>{admin}</div>')

CSS = '''*{box-sizing:border-box} body{margin:0;background:#E9E9EF}
.shot{width:1920px;background:#fff;margin-bottom:120px}
.shot-title{padding:28px 48px;font-family:'Noto Sans JP',sans-serif;font-size:40px;font-weight:900;color:#1F2330;background:#fff}
.screen{position:relative;width:1920px;height:1080px;overflow:hidden}'''
html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>' + "".join(S) + '</body></html>'
open("control_room.html", "w", encoding="utf-8").write(html)
print(len(html))
