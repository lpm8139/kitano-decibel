import random
random.seed(11)
W, H = 1920, 1080
FONT = "'Zen Maru Gothic','M PLUS Rounded 1c',sans-serif"
YELLOW, CYAN, PINK, PURPLE = "#FFD166", "#8ED6FF", "#FF5A8A", "#C3B5FF"
RANK = [("はると", "1,620"), ("ゆい", "1,240"), ("そうた", "880"), ("あおい", "500"), ("りく", "430"), ("みお", "260"), ("けんた", "180")]

def stars(n=80, w=1380):
    return "".join(f'<div style="position:absolute;left:{random.randint(0,w)}px;top:{random.randint(0,H)}px;width:{s}px;height:{s}px;border-radius:50%;background:#fff;opacity:{random.choice([.3,.55,.85])}"></div>'
                   for s in [random.choice([3,4,5,6]) for _ in range(n)])

def rocket(body="#FFFFFF", accent="#FF5A5F", flame=True, opacity=1, scale=1.0):
    fl = '<path d="M40 150 L80 150 L60 220Z" fill="#FFB703"/><path d="M48 150 L72 150 L60 196Z" fill="#FFF3B0"/>' if flame else ''
    return f'''<svg width="{int(120*scale)}" height="{int(225*scale)}" viewBox="0 0 120 225" style="opacity:{opacity}">
<path d="M30 120 L5 168 L34 150Z" fill="{accent}"/><path d="M90 120 L115 168 L86 150Z" fill="{accent}"/>
<path d="M60 0 C96 40 100 110 90 150 L30 150 C20 110 24 40 60 0Z" fill="{body}"/>
<path d="M60 0 C78 20 88 45 92 70 L28 70 C32 45 42 20 60 0Z" fill="{accent}"/>
<circle cx="60" cy="98" r="17" fill="#8ED6FF" stroke="#1D2042" stroke-width="5"/>{fl}</svg>'''

def ghost_rocket(scale=1.0):
    return rocket("#E4DDFF", "#8B7CF6", True, 0.5, scale)

def bg(endless=False):
    g = "radial-gradient(circle at 30% 15%, #4A2B8F 0%, #241452 40%, #0D0826 100%)" if endless else \
        "radial-gradient(circle at 30% 15%, #3C44C9 0%, #1D2177 42%, #0B0D33 100%)"
    return f'background:{g};font-family:{FONT};color:#fff'

def ranking(highlight=None, title="きょうの ランキング", sub="とどいた たかさ"):
    rows = ""
    for i, (n, s) in enumerate(RANK):
        hl = "background:rgba(255,209,102,0.25);border:3px solid #FFD166" if n == highlight else "background:rgba(255,255,255,0.08);border:3px solid transparent"
        rows += f'<div style="display:flex;align-items:center;gap:18px;padding:14px 20px;margin-bottom:12px;border-radius:22px;{hl};font-size:34px;font-weight:700">' \
                f'<span style="width:52px;height:52px;border-radius:50%;background:{YELLOW if i<3 else "rgba(255,255,255,0.25)"};color:#12153D;text-align:center;line-height:52px;font-weight:900">{i+1}</span>' \
                f'<span style="flex:1">{n}</span><span style="color:{YELLOW};font-weight:900">{s}<span style="font-size:22px"> km</span></span></div>'
    return f'''<div style="position:absolute;right:0;top:0;width:540px;height:{H}px;background:rgba(255,255,255,0.06);border-left:2px solid rgba(255,255,255,0.12);padding:52px 40px;box-sizing:border-box">
<div style="font-size:42px;font-weight:900;color:{YELLOW};white-space:nowrap">{title}</div>
<div style="font-size:24px;color:#B9C0FF;margin:4px 0 22px">{sub}</div>{rows}
<div style="position:absolute;left:40px;right:40px;bottom:44px;padding:16px;border-radius:20px;background:rgba(255,255,255,0.08);font-size:24px;color:#D7DBFF;text-align:center">チャンピオンの ロケットが<br>「かげ」に なって いっしょに とぶよ</div></div>'''

# 高度トラック（縦）: marks = [(名前, km, 種別)]  pos 0..1
def track(marks, you, ghost, x=90, top=110, h=900, w=380, earth=False, psize=300):
    out = earth_horizon() if earth else ""
    for name, km, kind, pos in marks:
        if name in PLANET:
            out += peek(PLANET[name], top + h - 60 - (h - 120) * pos, psize)
    out += f'<div style="position:absolute;left:{x}px;top:{top}px;width:{w}px;height:{h}px;border-radius:40px;background:linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02));border:3px solid rgba(255,255,255,0.18)"></div>'
    for name, km, kind, pos in marks:
        y = top + h - 60 - (h - 120) * pos
        if kind == "goal":
            out += f'<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:6px;background:{YELLOW}"></div>' \
                   f'<div style="position:absolute;left:{x+w+16}px;top:{y-26}px;padding:6px 18px;border-radius:999px;background:{YELLOW};color:#12153D;font-size:26px;font-weight:900;white-space:nowrap">★ {name} {km}</div>'
        elif kind == "done":
            out += f'<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:6px;background:#7CF29C"></div>' \
                   f'<div style="position:absolute;left:{x+w+16}px;top:{y-26}px;padding:6px 18px;border-radius:999px;background:#7CF29C;color:#0B3B1E;font-size:26px;font-weight:900;white-space:nowrap">✓ {name} クリア</div>'
        else:
            out += f'<div style="position:absolute;left:{x+20}px;top:{y}px;width:{w-40}px;height:2px;background:rgba(255,255,255,0.25)"></div>' \
                   f'<div style="position:absolute;left:{x+w+16}px;top:{y-18}px;font-size:24px;color:rgba(255,255,255,0.7);white-space:nowrap">{name} {km}</div>'
    def place(prog, svg, lx, label, color):
        y = top + h - 60 - (h - 120) * prog - 150
        return f'<div style="position:absolute;left:{lx}px;top:{y}px">{svg}</div>' \
               f'<div style="position:absolute;left:{lx-20}px;top:{y+160}px;width:140px;text-align:center;font-size:24px;font-weight:900;color:{color};white-space:nowrap">{label}</div>'
    if ghost is not None:
        out += place(ghost, ghost_rocket(0.75), x + 220, "チャンピオン", PURPLE)
    out += place(you, rocket(scale=0.75), x + 70, "きみ", YELLOW)
    return out

def db_box(x, y, db, w=560, label="いまの こえ"):
    return f'''<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;text-align:center">
<div style="font-size:34px;color:#B9C0FF;font-weight:700">{label}</div>
<div style="font-size:170px;font-weight:900;line-height:1;color:{YELLOW};text-shadow:0 0 36px rgba(255,209,102,0.55)">{db}</div>
<div style="font-size:42px;font-weight:900">デシベル</div></div>'''

def pill(text, bgc, color="#fff", size=40):
    return f'<span style="display:inline-block;padding:12px 34px;border-radius:999px;background:{bgc};color:{color};font-size:{size}px;font-weight:900;white-space:nowrap">{text}</span>'


# ---- 星（簡易イラスト）。画面の左端から半分だけのぞかせる ----
def planet_svg(kind, d):
    r = d / 2
    if kind == "moon":
        body = f'<circle cx="{r}" cy="{r}" r="{r}" fill="#D9DAE6"/><circle cx="{r*0.62}" cy="{r*0.7}" r="{r*0.16}" fill="#B9BACB"/><circle cx="{r*1.25}" cy="{r*1.2}" r="{r*0.22}" fill="#B9BACB"/><circle cx="{r*1.3}" cy="{r*0.55}" r="{r*0.1}" fill="#B9BACB"/>'
        return f'<svg width="{d}" height="{d}" viewBox="0 0 {d} {d}">{body}</svg>'
    if kind == "mars":
        body = f'<circle cx="{r}" cy="{r}" r="{r}" fill="#E4572E"/><ellipse cx="{r*0.7}" cy="{r*0.8}" rx="{r*0.3}" ry="{r*0.18}" fill="#B8401F"/><ellipse cx="{r*1.3}" cy="{r*1.35}" rx="{r*0.25}" ry="{r*0.14}" fill="#B8401F"/><ellipse cx="{r}" cy="{r*0.12}" rx="{r*0.35}" ry="{r*0.1}" fill="#FBE3D8"/>'
        return f'<svg width="{d}" height="{d}" viewBox="0 0 {d} {d}">{body}</svg>'
    if kind == "jupiter":
        bands = "".join(f'<rect x="0" y="{r*y0}" width="{d}" height="{r*h}" fill="{c}"/>' for y0, h, c in [(0.35,0.18,"#C98C5A"),(0.7,0.12,"#F3D6A8"),(0.95,0.2,"#B9774A"),(1.32,0.14,"#F3D6A8"),(1.55,0.12,"#C98C5A")])
        return f'<svg width="{d}" height="{d}" viewBox="0 0 {d} {d}"><defs><clipPath id="jc{d}"><circle cx="{r}" cy="{r}" r="{r}"/></clipPath></defs><circle cx="{r}" cy="{r}" r="{r}" fill="#E0B07A"/><g clip-path="url(#jc{d})">{bands}</g><ellipse cx="{r*1.25}" cy="{r*1.05}" rx="{r*0.2}" ry="{r*0.11}" fill="#D2603A"/></svg>'
    if kind == "saturn":
        w = d * 1.7
        cx = w / 2
        return f'<svg width="{w}" height="{d}" viewBox="0 0 {w} {d}"><ellipse cx="{cx}" cy="{r}" rx="{w*0.48}" ry="{r*0.3}" fill="none" stroke="#E9D9A6" stroke-width="{d*0.07}"/><circle cx="{cx}" cy="{r}" r="{r*0.82}" fill="#F0D58C"/><rect x="{cx-r}" y="{r*0.75}" width="{d}" height="{r*0.12}" fill="#DDBB6A" opacity=".7"/><path d="M {cx-w*0.48} {r} A {w*0.48} {r*0.3} 0 0 0 {cx+w*0.48} {r}" fill="none" stroke="#E9D9A6" stroke-width="{d*0.07}"/></svg>'
    if kind == "earth":
        return f'<svg width="{d}" height="{d}" viewBox="0 0 {d} {d}"><circle cx="{r}" cy="{r}" r="{r}" fill="#3A86FF"/><ellipse cx="{r*0.55}" cy="{r*0.35}" rx="{r*0.28}" ry="{r*0.14}" fill="#4CC38A"/><ellipse cx="{r*1.3}" cy="{r*0.25}" rx="{r*0.22}" ry="{r*0.1}" fill="#4CC38A"/><ellipse cx="{r}" cy="{r*0.12}" rx="{r*0.5}" ry="{r*0.05}" fill="#BFE3FF" opacity=".6"/></svg>'
    return ""

PLANET = {"つき": "moon", "かせい": "mars", "もくせい": "jupiter", "どせい": "saturn"}

def peek(kind, cy, d, left=None):
    w = d * 1.7 if kind == "saturn" else d
    x = -w / 2 if left is None else left
    return f'<div style="position:absolute;left:{x}px;top:{cy - d/2}px">{planet_svg(kind, d)}</div>'

def earth_horizon():  # ステージ1の足元：地球の丸い地平線
    return f'<div style="position:absolute;left:-260px;top:930px">{planet_svg("earth", 1100)}</div>'

STAGE_MARKS = [("ちきゅう", "", "mark", 0.0), ("くも", "10km", "mark", 0.14),
               ("うちゅう", "100km", "goal", 0.45), ("つき", "500km", "goal", 0.92)]

def note(text):  # 画面外のメモ（デザイン説明）
    return f'<div class="note">{text}</div>'

def screen(name, inner, style):
    return f'<div class="shot"><div class="shot-title">{name}</div><div class="screen" style="{style}">{inner}</div></div>'

S = []
# 1 待機
S.append(screen("① 待機中（つぎの人を待っている）", f'''{stars()}{earth_horizon()}
<div style="position:absolute;left:90px;top:56px;font-size:64px;font-weight:900;letter-spacing:3px;white-space:nowrap">こえで ロケットを とばそう！</div>
<div style="position:absolute;left:90px;top:150px;font-size:30px;color:#B9C0FF">うちゅう → つき に とどいたら、∞エンドレスモードへ！</div>
<div style="position:absolute;left:150px;top:640px;width:300px;height:60px;border-radius:12px;background:#5A5F8C"></div>
<div style="position:absolute;left:230px;top:390px">{rocket(scale=1.1)}</div>
<div style="position:absolute;left:100px;top:700px;width:420px;height:120px;border-radius:999px;background:rgba(255,255,255,0.18)"></div>
<div style="position:absolute;left:580px;top:250px;width:760px">
  <div style="display:flex;flex-direction:column;gap:22px">
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">① マイクの まえに たつ</div>
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">② 「わーーーっ！」と こえを だす</div>
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">③ ★うちゅう → ★つき → ∞エンドレス！</div>
  </div>
  <div style="margin-top:44px;display:flex;align-items:center;gap:24px"><span style="font-size:30px;color:#B9C0FF">いまの こえ</span>
    <div style="flex:1;height:28px;border-radius:14px;background:rgba(255,255,255,0.15)"><div style="width:38%;height:100%;border-radius:14px;background:{CYAN}"></div></div>
    <span style="font-size:44px;font-weight:900;color:{CYAN}">48.2 dB</span></div>
  <div style="margin-top:46px;text-align:center">{pill("こえを だすと スタート！", "#FF5A5F", size=48)}</div>
</div>{ranking()}''', bg()))
# 2 ステージ1 計測中
S.append(screen("② ステージ1 計測中（5びょう）", f'''{stars()}{track(STAGE_MARKS, 0.36, 0.40, earth=True)}
<div style="position:absolute;left:760px;top:60px;width:560px;text-align:center">{pill("ステージ1", "rgba(255,255,255,0.15)", size=34)}
  <div style="margin-top:18px;font-size:44px;font-weight:700">のこり <span style="font-size:110px;color:{CYAN};font-weight:900">3.4</span> びょう</div></div>
{db_box(760, 330, "86.2")}
<div style="position:absolute;left:760px;top:650px;width:560px;text-align:center">
  <div style="font-size:34px;color:#B9C0FF">いまの たかさ</div>
  <div style="font-size:96px;font-weight:900;line-height:1.1">72<span style="font-size:44px"> km</span></div>
  <div style="margin-top:18px">{pill("★うちゅう まで あと 28km！", "#FF5A5F", size=36)}</div></div>
{ranking()}''', bg()))
# 3 目標1クリア
S.append(screen("③ もくひょう1 クリアの瞬間（ステージ1のとちゅう）", f'''{stars()}{track([m if m[0]!="うちゅう" else ("うちゅう","100km","done",0.45) for m in STAGE_MARKS], 0.47, 0.44, earth=True)}
<div style="position:absolute;left:640px;top:250px;width:700px;height:470px;border-radius:48px;background:linear-gradient(135deg,#FFD166,#FF9F43);color:#3A1F00;text-align:center;box-shadow:0 0 0 14px rgba(255,209,102,0.25),0 30px 80px rgba(0,0,0,0.4)">
  <div style="margin-top:44px;font-size:44px;font-weight:900">もくひょう1</div>
  <div style="font-size:140px;font-weight:900;line-height:1.05">クリア！</div>
  <div style="font-size:52px;font-weight:900">うちゅうに とうちゃく！</div>
  <div style="margin-top:22px;font-size:32px;white-space:nowrap">つぎは ★つき！ こえを だしつづけよう</div></div>
<div style="position:absolute;left:640px;top:780px;width:700px;text-align:center;font-size:40px;font-weight:700;white-space:nowrap">のこり <span style="font-size:80px;color:{CYAN};font-weight:900">2.1</span> びょう　<span style="color:{YELLOW};font-weight:900">89.0 dB</span></div>
{ranking()}''', bg()))
# 3.5 ブースター
S.append(screen("④ ブースター発射！（5びょうで つきに とどかなかったとき）", f'''{stars(110)}
<div style="position:absolute;left:250px;top:180px;width:180px;height:780px;border-radius:90px;background:linear-gradient(0deg,rgba(255,183,3,0) 0%,rgba(255,183,3,0.55) 45%,rgba(255,243,176,0.9) 100%)"></div>
<div style="position:absolute;left:250px;top:40px">{rocket(scale=0.95)}</div>
<div style="position:absolute;left:200px;top:300px;width:280px;height:120px;border-radius:999px;background:rgba(255,255,255,0.18)"></div>
<div style="position:absolute;left:600px;top:150px;width:740px;text-align:center">
  {pill("ブースター はっしゃ！", "linear-gradient(90deg,#FF9F43,#FF5A5F)", size=64)}
  <div style="margin-top:28px;font-size:52px;font-weight:900;white-space:nowrap">つきまで ワープ！</div>
  <div style="margin-top:14px;font-size:32px;color:#B9C0FF;white-space:nowrap">うちゅう までは じぶんの ちからで とどいたよ</div></div>
<div style="position:absolute;left:640px;top:520px;width:660px;padding:34px 40px;border-radius:40px;background:rgba(255,255,255,0.10);border:3px solid rgba(255,255,255,0.2);text-align:center">
  <div style="font-size:38px;font-weight:900;white-space:nowrap">みんなで おうえん！「がんばれー！」</div>
  <div style="margin-top:22px;height:40px;border-radius:20px;background:rgba(255,255,255,0.15)"><div style="width:72%;height:100%;border-radius:20px;background:linear-gradient(90deg,#FFD166,#FF5A5F)"></div></div>
  <div style="margin-top:14px;font-size:28px;color:#D7DBFF;white-space:nowrap">おうえんの こえで ブースターが パワーアップ</div></div>
<div style="position:absolute;left:640px;top:830px;width:660px;text-align:center;font-size:34px;color:#B9C0FF;white-space:nowrap">このあと ∞エンドレスモード へ！</div>
{ranking()}''', bg()))
# 4 エンドレス
END_MARKS = [("つき", "500km", "done", 0.05), ("かせい", "800km", "mark", 0.30), ("もくせい", "1,200km", "mark", 0.58), ("どせい", "1,600km", "mark", 0.86)]
S.append(screen("⑤ エンドレスモード（全員・最長10びょう）", f'''{stars(110)}{track(END_MARKS, 0.62, 0.86, psize=190)}
<div style="position:absolute;left:740px;top:50px;width:600px;text-align:center">
  {pill("∞ エンドレスモード", "linear-gradient(90deg,#FF5A8A,#B14CFF)", size=44)}
  <div style="margin-top:12px;font-size:30px;color:#F3D9FF;white-space:nowrap">つきの その先へ！ こえが つづくかぎり とべ！</div></div>
{db_box(760, 250, "91.8")}
<div style="position:absolute;left:760px;top:560px;width:560px;text-align:center">
  <div style="font-size:34px;color:#E2C9FF">いまの たかさ</div>
  <div style="font-size:110px;font-weight:900;line-height:1.05;color:#fff">1,240<span style="font-size:48px"> km</span></div>
  <div style="margin-top:10px">{pill("チャンピオンまで あと 380km！", "#B14CFF", size=34)}</div></div>
<div style="position:absolute;left:760px;top:900px;width:560px">
  <div style="display:flex;justify-content:space-between;font-size:26px;color:#E2C9FF"><span style="white-space:nowrap">こえが とぎれたら おわり</span><span style="white-space:nowrap">6.4 / 10びょう</span></div>
  <div style="margin-top:10px;height:30px;border-radius:15px;background:rgba(255,255,255,0.15)"><div style="width:64%;height:100%;border-radius:15px;background:linear-gradient(90deg,#7CF29C,#FFD166)"></div></div></div>
{ranking()}''', bg(True)))
# 5 結果（ステージ1のみ）
def result(title, km, place, badges, new=False, endless=False, planet=None):
    b = "".join(f'<div style="width:150px;height:150px;border-radius:50%;background:{c};display:flex;align-items:center;justify-content:center;flex-direction:column;color:{fc};font-weight:900"><div style="font-size:56px;line-height:1">{i}</div><div style="font-size:24px">{t}</div></div>'
                for i, t, c, fc in badges)
    newb = f'<div style="position:absolute;left:600px;top:40px;width:740px;text-align:center">{pill("★ きょうの しんきろく！ ★", "linear-gradient(90deg,#FFD166,#FF9F43)", "#3A1F00", 52)}</div>' if new else ""
    confetti = "".join(f'<div style="position:absolute;left:{random.randint(560,1360)}px;top:{random.randint(0,1040)}px;width:{random.choice([14,18,22])}px;height:{random.choice([8,10])}px;border-radius:3px;background:{random.choice([YELLOW,PINK,CYAN,"#7CF29C"])};transform:rotate({random.randint(0,180)}deg)"></div>' for _ in range(60)) if new else ""
    big = peek(planet, 950, 460, left=-260) if planet else ""
    return f'''{stars()}{big}{confetti}
<div style="position:absolute;left:120px;top:250px">{rocket(scale=1.5)}</div>
{newb}
<div style="position:absolute;left:560px;top:150px;width:780px;text-align:center">
  <div style="font-size:56px;font-weight:900">{title}</div>
  <div style="margin-top:20px;font-size:34px;color:#B9C0FF">とどいた たかさ</div>
  <div style="font-size:150px;font-weight:900;line-height:1.05;color:{YELLOW}">{km}<span style="font-size:56px"> km</span></div>
  <div style="margin-top:8px;font-size:34px;white-space:nowrap">へいきんの こえ <b style="color:{CYAN}">84.6</b> デシベル　／　<b>{place}</b></div>
  <div style="margin-top:34px;display:flex;justify-content:center;gap:26px">{b}</div>
  <div style="margin-top:40px;display:flex;justify-content:center;gap:20px">
    <div style="width:420px;padding:18px;border-radius:20px;background:#fff;color:#12153D;font-size:34px;text-align:left">なまえ：<span style="color:#8A8FB8">（スタッフが にゅうりょく）</span></div>
    {pill("けってい", "#FF5A5F", size=34)}</div></div>
{ranking("はると" if new else None)}'''
S.append(screen("⑥ 結果（ふつう）", result("かせい まで いった！", "820", "きょう 5い", [("★", "うちゅう", YELLOW, "#3A1F00"), ("★", "つき", YELLOW, "#3A1F00"), ("∞", "かせい", "#B14CFF", "#fff")], planet="mars"), bg(True)))
S.append(screen("⑦ 結果（しんきろく）", result("どせい まで いった！", "1,620", "きょう 1い", [("★", "うちゅう", YELLOW, "#3A1F00"), ("★", "つき", YELLOW, "#3A1F00"), ("∞", "どせい", "#B14CFF", "#fff")], new=True, endless=True, planet="saturn"), bg(True)))

RULES = '''<div class="shot"><div class="shot-title">ルール案 v2（全員エンドレス・最長10秒）</div>
<div class="rules">
<div class="r-col"><div class="r-h">ゲームの流れ</div><ol>
<li>声を出すと自動でスタート</li>
<li><b>ステージ1：5秒</b>。声の大きさが積み重なって、ロケットの高さになる</li>
<li><b>★もくひょう1「うちゅう」→ ★もくひょう2「つき」</b>。ふつうの声で届く難しさにして、届くたびに「クリア！」</li>
<li>5秒で「つき」に届かなかった子は <b>「ブースター発射！」</b>で月までワープ（失敗を見せない）。会場の「がんばれー！」の声でブースターがパワーアップ</li>
<li><b>全員が ∞エンドレスモードへ</b>：声が続くかぎり上昇（かせい→もくせい→どせい…）</li>
<li>エンドレスは <b>声が1秒とぎれたら終了</b>、<b>最長10秒</b></li></ol></div>
<div class="r-col"><div class="r-h">スコアとゴースト</div><ul>
<li>勝負はエンドレスで <b>どこまで行けたか（高さ km）</b>。ランキングもこれ</li>
<li>デシベルの数字は全画面で大きく表示（担当の「測定値の表示」）。結果には平均デシベルも出す</li>
<li>ゴースト＝<b>きょうの1位の飛び方</b>を同じ時間で横に再生</li>
<li>星（うちゅう・つき・かせい…）を通るたびにバッジ。結果で「どこまで行けたか」を言葉で言える</li>
<li>高さの km はゲーム内の数字（本物の距離ではない）</li></ul></div>
<div class="r-col"><div class="r-h">【要確認】決めたいこと</div><ul>
<li>ブースター中の「おうえん」を同じマイクで拾う？（拾うと盛り上がるが、記録には入れない）</li>
<li>名前入力：スタッフが入れる／入れない（ニックネームのみ）</li>
<li>明るい会場の場合は背景をもう少し明るい青にする</li>
<li>BGM・効果音を出す？（スピーカーの音をマイクが拾わないよう配置に注意）</li></ul></div>
</div></div>'''

CSS = f'''*{{box-sizing:border-box}} body{{margin:0;background:#E9E9EF}}
.shot{{width:1920px;background:#fff;margin-bottom:120px}}
.shot-title{{padding:28px 48px;font-family:'Noto Sans JP',sans-serif;font-size:40px;font-weight:900;color:#1F2330;background:#fff}}
.screen{{position:relative;width:1920px;height:1080px;overflow:hidden}}
.rules{{display:flex;gap:36px;padding:10px 48px 56px;font-family:'Noto Sans JP',sans-serif;color:#1F2330}}
.r-col{{flex:1;background:#F4F5F9;border-radius:24px;padding:30px 34px}}
.r-h{{font-size:32px;font-weight:900;margin-bottom:12px}}
.r-col li{{font-size:26px;line-height:1.7;margin-bottom:6px}}'''
html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>' + RULES + "".join(S) + '</body></html>'
open("rocket_detail.html", "w", encoding="utf-8").write(html)
print(len(html))
