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
def track(marks, you, ghost, x=90, top=110, h=900, w=380):
    out = f'<div style="position:absolute;left:{x}px;top:{top}px;width:{w}px;height:{h}px;border-radius:40px;background:linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03));border:3px solid rgba(255,255,255,0.18)"></div>'
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

STAGE_MARKS = [("ちきゅう", "", "mark", 0.0), ("くも", "10km", "mark", 0.14),
               ("うちゅう", "100km", "goal", 0.45), ("つき", "500km", "goal", 0.92)]

def note(text):  # 画面外のメモ（デザイン説明）
    return f'<div class="note">{text}</div>'

def screen(name, inner, style):
    return f'<div class="shot"><div class="shot-title">{name}</div><div class="screen" style="{style}">{inner}</div></div>'

S = []
# 1 待機
S.append(screen("① 待機中（つぎの人を待っている）", f'''{stars()}
<div style="position:absolute;left:90px;top:56px;font-size:64px;font-weight:900;letter-spacing:3px;white-space:nowrap">こえで ロケットを とばそう！</div>
<div style="position:absolute;left:90px;top:150px;font-size:30px;color:#B9C0FF">5びょうで つきまで とどいたら「エンドレスモード」に とつにゅう！</div>
<div style="position:absolute;left:150px;top:640px;width:300px;height:60px;border-radius:12px;background:#5A5F8C"></div>
<div style="position:absolute;left:230px;top:390px">{rocket(scale=1.1)}</div>
<div style="position:absolute;left:100px;top:700px;width:420px;height:120px;border-radius:999px;background:rgba(255,255,255,0.18)"></div>
<div style="position:absolute;left:580px;top:250px;width:760px">
  <div style="display:flex;flex-direction:column;gap:22px">
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">① マイクの まえに たつ</div>
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">② 「わーーーっ！」と こえを だす</div>
    <div style="padding:22px 30px;border-radius:28px;background:rgba(255,255,255,0.10);font-size:36px;font-weight:900;white-space:nowrap">③ ★うちゅう → ★つき を めざせ！</div>
  </div>
  <div style="margin-top:44px;display:flex;align-items:center;gap:24px"><span style="font-size:30px;color:#B9C0FF">いまの こえ</span>
    <div style="flex:1;height:28px;border-radius:14px;background:rgba(255,255,255,0.15)"><div style="width:38%;height:100%;border-radius:14px;background:{CYAN}"></div></div>
    <span style="font-size:44px;font-weight:900;color:{CYAN}">48.2 dB</span></div>
  <div style="margin-top:46px;text-align:center">{pill("こえを だすと スタート！", "#FF5A5F", size=48)}</div>
</div>{ranking()}''', bg()))
# 2 ステージ1 計測中
S.append(screen("② ステージ1 計測中（5びょう）", f'''{stars()}{track(STAGE_MARKS, 0.36, 0.40)}
<div style="position:absolute;left:760px;top:60px;width:560px;text-align:center">{pill("ステージ1", "rgba(255,255,255,0.15)", size=34)}
  <div style="margin-top:18px;font-size:44px;font-weight:700">のこり <span style="font-size:110px;color:{CYAN};font-weight:900">3.4</span> びょう</div></div>
{db_box(760, 330, "86.2")}
<div style="position:absolute;left:760px;top:650px;width:560px;text-align:center">
  <div style="font-size:34px;color:#B9C0FF">いまの たかさ</div>
  <div style="font-size:96px;font-weight:900;line-height:1.1">72<span style="font-size:44px"> km</span></div>
  <div style="margin-top:18px">{pill("★うちゅう まで あと 28km！", "#FF5A5F", size=36)}</div></div>
{ranking()}''', bg()))
# 3 目標1クリア
S.append(screen("③ もくひょう1 クリアの瞬間（ステージ1のとちゅう）", f'''{stars()}{track([m if m[0]!="うちゅう" else ("うちゅう","100km","done",0.45) for m in STAGE_MARKS], 0.47, 0.44)}
<div style="position:absolute;left:640px;top:250px;width:700px;height:470px;border-radius:48px;background:linear-gradient(135deg,#FFD166,#FF9F43);color:#3A1F00;text-align:center;box-shadow:0 0 0 14px rgba(255,209,102,0.25),0 30px 80px rgba(0,0,0,0.4)">
  <div style="margin-top:44px;font-size:44px;font-weight:900">もくひょう1</div>
  <div style="font-size:140px;font-weight:900;line-height:1.05">クリア！</div>
  <div style="font-size:52px;font-weight:900">うちゅうに とうちゃく！</div>
  <div style="margin-top:22px;font-size:32px;white-space:nowrap">つぎは ★つき！ こえを だしつづけよう</div></div>
<div style="position:absolute;left:640px;top:780px;width:700px;text-align:center;font-size:40px;font-weight:700;white-space:nowrap">のこり <span style="font-size:80px;color:{CYAN};font-weight:900">2.1</span> びょう　<span style="color:{YELLOW};font-weight:900">89.0 dB</span></div>
{ranking()}''', bg()))
# 4 エンドレス
END_MARKS = [("つき", "500km", "done", 0.05), ("かせい", "800km", "mark", 0.30), ("もくせい", "1,200km", "mark", 0.58), ("どせい", "1,600km", "mark", 0.86)]
S.append(screen("④ エンドレスモード（つき クリア後・タイマーなし）", f'''{stars(110)}{track(END_MARKS, 0.62, 0.86)}
<div style="position:absolute;left:740px;top:50px;width:600px;text-align:center">
  {pill("∞ エンドレスモード", "linear-gradient(90deg,#FF5A8A,#B14CFF)", size=44)}
  <div style="margin-top:12px;font-size:30px;color:#F3D9FF;white-space:nowrap">つきの その先へ！ こえが つづくかぎり とべ！</div></div>
{db_box(760, 250, "91.8")}
<div style="position:absolute;left:760px;top:560px;width:560px;text-align:center">
  <div style="font-size:34px;color:#E2C9FF">いまの たかさ</div>
  <div style="font-size:110px;font-weight:900;line-height:1.05;color:#fff">1,240<span style="font-size:48px"> km</span></div>
  <div style="margin-top:10px">{pill("チャンピオンまで あと 380km！", "#B14CFF", size=34)}</div></div>
<div style="position:absolute;left:760px;top:900px;width:560px">
  <div style="display:flex;justify-content:space-between;font-size:26px;color:#E2C9FF"><span style="white-space:nowrap">こえが とぎれたら おわり</span><span style="white-space:nowrap">8.2 / 15びょう</span></div>
  <div style="margin-top:10px;height:30px;border-radius:15px;background:rgba(255,255,255,0.15)"><div style="width:82%;height:100%;border-radius:15px;background:linear-gradient(90deg,#7CF29C,#FFD166)"></div></div></div>
{ranking()}''', bg(True)))
# 5 結果（ステージ1のみ）
def result(title, km, place, badges, new=False, endless=False):
    b = "".join(f'<div style="width:150px;height:150px;border-radius:50%;background:{c};display:flex;align-items:center;justify-content:center;flex-direction:column;color:{fc};font-weight:900"><div style="font-size:56px;line-height:1">{i}</div><div style="font-size:24px">{t}</div></div>'
                for i, t, c, fc in badges)
    newb = f'<div style="position:absolute;left:600px;top:40px;width:740px;text-align:center">{pill("★ きょうの しんきろく！ ★", "linear-gradient(90deg,#FFD166,#FF9F43)", "#3A1F00", 52)}</div>' if new else ""
    confetti = "".join(f'<div style="position:absolute;left:{random.randint(560,1360)}px;top:{random.randint(0,1040)}px;width:{random.choice([14,18,22])}px;height:{random.choice([8,10])}px;border-radius:3px;background:{random.choice([YELLOW,PINK,CYAN,"#7CF29C"])};transform:rotate({random.randint(0,180)}deg)"></div>' for _ in range(60)) if new else ""
    return f'''{stars()}{confetti}
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
S.append(screen("⑤ 結果（もくひょう1 まで）", result("うちゅうまで とどいた！", "180", "きょう 7い", [("★", "うちゅう", YELLOW, "#3A1F00"), ("☆", "つき", "rgba(255,255,255,0.15)", "#B9C0FF")]), bg()))
S.append(screen("⑥ 結果（エンドレス＋しんきろく）", result("どせい まで いった！", "1,620", "きょう 1い", [("★", "うちゅう", YELLOW, "#3A1F00"), ("★", "つき", YELLOW, "#3A1F00"), ("∞", "エンドレス", "#B14CFF", "#fff")], new=True, endless=True), bg(True)))

RULES = '''<div class="shot"><div class="shot-title">ルール案（この内容で作り込みます・変えたい所を教えてください）</div>
<div class="rules">
<div class="r-col"><div class="r-h">ゲームの流れ</div><ol>
<li>声を出すと自動でスタート（今と同じ）</li>
<li><b>ステージ1：5秒</b>。声の大きさが積み重なって、ロケットの高さになる</li>
<li>途中で <b>★もくひょう1「うちゅう」</b>、<b>★もくひょう2「つき」</b>。届いた瞬間に「クリア！」演出</li>
<li>5秒以内に「つき」に届いたら <b>∞エンドレスモード</b>：タイマーが消え、声が続くかぎり上昇（かせい→もくせい→どせい…）</li>
<li>エンドレスは <b>声が 1秒 とぎれたら終了</b>。のどを守るため <b>最長 15秒</b> で終了</li>
<li>届かなかった人も「うちゅうまで行けた！」などのバッジで終われる</li></ol></div>
<div class="r-col"><div class="r-h">スコアとゴースト</div><ul>
<li>ランキングは <b>とどいた高さ（km）</b>。デシベルの数字は画面に大きく出し続ける（担当の「測定値の表示」）</li>
<li>平均デシベルも結果に表示（参考値）</li>
<li>ゴースト＝<b>きょうの1位の飛び方</b>を、同じ時間で横に再生。ステージ1でもエンドレスでも一緒に飛ぶ</li>
<li>高さの km はゲーム内の数字（本物の距離ではない）</li></ul></div>
<div class="r-col"><div class="r-h">【要確認】決めたいこと</div><ul>
<li>もくひょう2「つき」の難しさ：何割くらいの子がエンドレスに行けるのがよい？（例：3人に1人）</li>
<li>エンドレスの最長時間：15秒でよい？（列の進み・のどの負担）</li>
<li>小さい子向けに「やさしいモード」（もくひょうを低く）を用意する？</li>
<li>名前入力：スタッフが入れる／入れない（ニックネームのみ）</li>
<li>明るい会場の場合は背景をもう少し明るい青にする</li></ul></div>
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
