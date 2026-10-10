import random
random.seed(7)
RANK = [("はると", 96.2), ("ゆい", 94.8), ("そうた", 91.5), ("あおい", 88.0), ("りく", 85.3)]
DB, LEFT, YOU, GHOST = "92.4", "2.1", 0.62, 0.55

def caption(tag, name, color, concept, good, care, fit):
    def col(h, items):
        lis = "".join(f'<li>{i}</li>' for i in items)
        return f'<div class="cap-col"><div class="cap-h">{h}</div><ul>{lis}</ul></div>'
    return f'''<div class="cap">
  <div class="cap-top"><span class="cap-tag" style="background:{color}">{tag}</span><span class="cap-name">{name}</span><span class="cap-concept">{concept}</span></div>
  <div class="cap-cols">{col("子どもに刺さるポイント", good)}{col("気になる点", care)}{col("向いている会場・運営", fit)}</div>
</div>'''

def rocket(body, accent, flame=True, opacity=1):
    fl = '<path d="M40 150 L80 150 L60 215Z" fill="#FFB703"/><path d="M48 150 L72 150 L60 192Z" fill="#FFF3B0"/>' if flame else ''
    return f'''<svg width="120" height="220" viewBox="0 0 120 220" style="opacity:{opacity}">
<path d="M30 120 L5 168 L34 150Z" fill="{accent}"/><path d="M90 120 L115 168 L86 150Z" fill="{accent}"/>
<path d="M60 0 C96 40 100 110 90 150 L30 150 C20 110 24 40 60 0Z" fill="{body}"/>
<path d="M60 0 C78 20 88 45 92 70 L28 70 C32 45 42 20 60 0Z" fill="{accent}"/>
<circle cx="60" cy="98" r="17" fill="#8ED6FF" stroke="#1D2042" stroke-width="5"/>{fl}</svg>'''

# ---------------- A: うちゅうロケット ----------------
def screen_a():
    stars = "".join(f'<div style="position:absolute;left:{random.randint(0,1380)}px;top:{random.randint(0,1080)}px;width:{s}px;height:{s}px;border-radius:50%;background:#FFFFFF;opacity:{random.choice([0.35,0.6,0.9])}"></div>'
                    for s in [random.choice([3,4,5,7]) for _ in range(70)])
    track_h, top = 760, 230
    def track(x, label, color, prog, rk):
        y = top + track_h - 220 - (track_h - 220) * prog
        return f'''<div style="position:absolute;left:{x}px;top:{top}px;width:210px;height:{track_h}px;border-radius:105px;background:rgba(255,255,255,0.07);border:3px dashed rgba(255,255,255,0.25)"></div>
<div style="position:absolute;left:{x+45}px;top:{y}px">{rk}</div>
<div style="position:absolute;left:{x-60}px;top:{top+track_h+18}px;width:330px;white-space:nowrap;text-align:center;font-size:30px;font-weight:900;color:{color}">{label}</div>'''
    marks = "".join(f'<div style="position:absolute;left:640px;top:{top+ (track_h-40)*(1-i/4)}px;font-size:24px;color:rgba(255,255,255,0.55)">{n}</div>' for i, n in enumerate(["ちきゅう","くも","そら","うちゅう","つき"]))
    ranking = "".join(f'<div class="a-rank"><span class="a-no">{i+1}</span><span class="a-nm">{n}</span><span class="a-sc">{s}</span></div>' for i,(n,s) in enumerate(RANK))
    return f'''<div class="screen" style="background:radial-gradient(circle at 30% 20%, #2B2F77 0%, #12153D 45%, #070818 100%);font-family:'Zen Maru Gothic','M PLUS Rounded 1c',sans-serif;color:#fff">
{stars}
<div style="position:absolute;left:150px;top:40px;width:150px;height:150px;border-radius:50%;background:#FFF4C2;box-shadow:0 0 80px 20px rgba(255,244,194,0.45)"></div>
<div style="position:absolute;left:330px;top:70px;font-size:56px;font-weight:900;letter-spacing:4px">こえで ロケットを とばそう！</div>
<div style="position:absolute;left:330px;top:145px;font-size:28px;color:#B9C0FF">つきまで とどくかな？　5びょう こえを だしつづけよう</div>
{track(110,"きみ","#FFD166",YOU,rocket("#FFFFFF","#FF5A5F"))}
{track(390,"きょうの チャンピオン","#C3B5FF",GHOST,rocket("#D9D2FF","#8B7CF6",True,0.5))}
{marks}
<div style="position:absolute;left:760px;top:300px;width:600px;text-align:center">
  <div style="font-size:40px;color:#B9C0FF;font-weight:700">いまの こえ</div>
  <div style="font-size:230px;font-weight:900;line-height:1;color:#FFD166;text-shadow:0 0 40px rgba(255,209,102,0.6)">{DB}</div>
  <div style="font-size:52px;font-weight:900;margin-top:-6px">デシベル</div>
  <div style="display:inline-block;margin-top:34px;padding:16px 44px;border-radius:999px;background:#FF5A5F;font-size:42px;font-weight:900;white-space:nowrap">チャンピオンを おいこせ！</div>
  <div style="margin-top:36px;font-size:46px;font-weight:700">のこり <span style="font-size:80px;color:#8ED6FF">{LEFT}</span> びょう</div>
</div>
<div style="position:absolute;right:0;top:0;width:540px;height:1080px;background:rgba(255,255,255,0.06);border-left:2px solid rgba(255,255,255,0.12);padding:60px 44px;box-sizing:border-box">
  <div style="font-size:44px;font-weight:900;color:#FFD166;margin-bottom:28px">きょうの ランキング</div>{ranking}
  <div style="position:absolute;left:44px;bottom:50px;font-size:24px;color:rgba(255,255,255,0.5)">スペースキーで スタート</div>
</div></div>'''

# ---------------- B: どうぶつかけっこ ----------------
def lion(opacity=1, ghost=False):
    mane, face = ("#FFFFFF", "#F1EEFF") if ghost else ("#F08A24", "#FFD166")
    return f'''<svg width="150" height="150" viewBox="0 0 150 150" style="opacity:{opacity}">
<circle cx="75" cy="75" r="70" fill="{mane}"/><circle cx="75" cy="78" r="48" fill="{face}"/>
<circle cx="58" cy="70" r="7" fill="#3A2E39"/><circle cx="92" cy="70" r="7" fill="#3A2E39"/>
<ellipse cx="75" cy="90" rx="11" ry="8" fill="#A0522D"/><path d="M62 102 Q75 114 88 102" stroke="#3A2E39" stroke-width="5" fill="none" stroke-linecap="round"/>
<circle cx="45" cy="92" r="8" fill="#FF9AA2" opacity="0.7"/><circle cx="105" cy="92" r="8" fill="#FF9AA2" opacity="0.7"/></svg>'''
def screen_b():
    clouds = "".join(f'<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;border-radius:999px;background:#FFFFFF;opacity:.95"></div>' for x,y,w,h in [(120,120,220,70),(190,90,140,80),(980,160,260,74),(1060,124,150,84)])
    lane_w = 1180
    def lane(y, label, color, prog, ghost):
        cx = 90 + (lane_w - 150) * prog
        return f'''<div style="position:absolute;left:70px;top:{y}px;width:{lane_w+40}px;height:170px;border-radius:30px;background:#E9A15B;border:6px solid #FFFFFF"></div>
<div style="position:absolute;left:{cx}px;top:{y+10}px">{lion(0.55 if ghost else 1, ghost)}</div>
<div style="position:absolute;left:96px;top:{y+60}px;padding:8px 22px;border-radius:999px;background:{color};font-size:30px;font-weight:900;color:#fff">{label}</div>'''
    ranking = "".join(f'<div class="b-rank"><span class="b-medal" style="background:{c}">{i+1}</span><span class="b-nm">{n}</span><span class="b-sc">{s}</span></div>' for i,((n,s),c) in enumerate(zip(RANK,["#FFC93C","#C9D1D9","#E3A46F","#9AD0F5","#9AD0F5"])))
    return f'''<div class="screen" style="background:linear-gradient(180deg,#7FD3FF 0%,#BDEBFF 52%,#8BD46A 52%,#6CC04A 100%);font-family:'M PLUS Rounded 1c','Zen Maru Gothic',sans-serif;color:#3A2E39">
{clouds}
<div style="position:absolute;left:1180px;top:40px;width:130px;height:130px;border-radius:50%;background:#FFE066;box-shadow:0 0 0 18px rgba(255,224,102,0.35)"></div>
<div style="position:absolute;left:80px;top:40px;padding:14px 40px;border-radius:999px;background:#FFFFFF;font-size:50px;font-weight:900;color:#F08A24;box-shadow:0 8px 0 #F2C48D">どうぶつ かけっこ</div>
<div style="position:absolute;left:330px;top:150px;width:720px;height:330px;border-radius:60px;background:#FFFFFF;box-shadow:0 12px 0 rgba(58,46,57,0.15);text-align:center">
  <div style="margin-top:22px;font-size:34px;font-weight:700;color:#8C7B8A">いまの こえ</div>
  <div style="font-size:170px;font-weight:900;line-height:1;color:#F08A24">{DB}<span style="font-size:52px;color:#3A2E39"> dB</span></div>
  <div style="display:inline-block;margin-top:10px;padding:8px 30px;border-radius:999px;background:#FFF1C9;font-size:38px;font-weight:900">ライオンなみ！ がおー！</div>
</div>
<div style="position:absolute;left:1075px;top:360px;padding:12px 28px;border-radius:999px;background:#3A2E39;font-size:40px;font-weight:900;color:#FFFFFF;white-space:nowrap">のこり {LEFT}びょう</div>
{lane(560,"きみ","#F08A24",YOU,False)}
{lane(760,"チャンピオンの かげ","#9B8CF0",GHOST,True)}
<div style="position:absolute;left:1260px;top:520px;width:12px;height:430px;background:#FFFFFF"></div>
<div style="position:absolute;left:1272px;top:520px;width:90px;height:60px;background:#FF5A5F;border-radius:0 12px 12px 0"></div>
<div style="position:absolute;left:1210px;top:960px;font-size:30px;font-weight:900;color:#fff">ゴール</div>
<div style="position:absolute;right:30px;top:30px;width:480px;height:1020px;border-radius:40px;background:#FFFFFF;padding:44px 36px;box-sizing:border-box;box-shadow:0 12px 0 rgba(58,46,57,0.12)">
  <div style="font-size:40px;font-weight:900;color:#F08A24;margin-bottom:24px;white-space:nowrap">きょうの ランキング</div>{ranking}
  <div style="position:absolute;left:36px;bottom:40px;right:36px;padding:18px;border-radius:24px;background:#EAF8FF;font-size:26px;text-align:center">マイクに むかって<br>おおきな こえで「わー！」</div>
</div></div>'''

# ---------------- C: かいじゅうメーター ----------------
def monster():
    return '''<svg width="430" height="430" viewBox="0 0 430 430">
<ellipse cx="215" cy="260" rx="170" ry="160" fill="#4CC38A" stroke="#1E1E2E" stroke-width="10"/>
<path d="M95 130 L120 60 L150 120Z M170 105 L200 30 L230 100Z M250 105 L285 35 L305 115Z" fill="#FF6FB5" stroke="#1E1E2E" stroke-width="8" stroke-linejoin="round"/>
<circle cx="160" cy="200" r="38" fill="#fff" stroke="#1E1E2E" stroke-width="8"/><circle cx="270" cy="200" r="38" fill="#fff" stroke="#1E1E2E" stroke-width="8"/>
<circle cx="168" cy="208" r="14" fill="#1E1E2E"/><circle cx="262" cy="208" r="14" fill="#1E1E2E"/>
<path d="M120 270 Q215 420 310 270Z" fill="#B3123E" stroke="#1E1E2E" stroke-width="10" stroke-linejoin="round"/>
<path d="M140 272 L158 300 L176 272Z M200 272 L215 300 L230 272Z M254 272 L272 300 L290 272Z" fill="#fff"/></svg>'''
def screen_c():
    levels = [("ドラゴン", 100, "#E63946"), ("かいじゅう", 95, "#F77F00"), ("ライオン", 85, "#FCBF49"), ("いぬ", 75, "#90BE6D"), ("ねこ", 60, "#43AA8B")]
    mtop, mh = 150, 820
    def ypos(v):  # 40..100 dB -> bottom..top
        return mtop + mh - (v - 40) / 60 * mh
    segs = "".join(f'<div style="position:absolute;left:150px;top:{ypos(v)}px;width:200px;height:{(v - (levels[i+1][1] if i+1 < len(levels) else 40))/60*mh}px;background:{c};opacity:.25"></div>' for i,(n,v,c) in enumerate(levels))
    fill_top = ypos(float(DB))
    labels = "".join(f'<div style="position:absolute;left:375px;top:{ypos(v)-24}px;font-size:34px;font-weight:900;color:#1E1E2E">{n}<span style="font-size:22px;color:#6B5E00"> {v}</span></div>' for n,v,c in levels)
    champ = ypos(RANK[0][1])
    ranking = "".join(f'<div class="c-rank" style="transform:rotate({[-2,1.5,-1,2,-1.5][i]}deg)"><span class="c-no">{i+1}い</span><span class="c-nm">{n}</span><span class="c-sc">{s}</span></div>' for i,(n,s) in enumerate(RANK))
    return f'''<div class="screen" style="background:#FFD43B;font-family:'Dela Gothic One','M PLUS Rounded 1c',sans-serif;color:#1E1E2E">
<div style="position:absolute;left:-120px;top:-160px;width:620px;height:620px;border-radius:50%;background:#FFE680"></div>
<div style="position:absolute;left:150px;top:{mtop}px;width:200px;height:{mh}px;border-radius:100px;background:#FFFFFF;border:10px solid #1E1E2E;box-sizing:border-box"></div>
<div style="position:absolute;left:160px;top:{fill_top}px;width:180px;height:{mtop+mh-fill_top-10}px;border-radius:24px 24px 90px 90px;background:linear-gradient(0deg,#43AA8B,#FCBF49 60%,#F77F00)"></div>
<div style="position:absolute;left:110px;top:{champ}px;width:280px;height:8px;background:#7B2CBF"></div>
<div style="position:absolute;left:-10px;top:{champ-60}px;padding:6px 16px;border-radius:12px;background:#7B2CBF;color:#fff;font-size:24px">チャンピオン ▶</div>
{labels}
<div style="position:absolute;left:60px;top:40px;font-size:64px;letter-spacing:2px">かいじゅう メーター</div>
<div style="position:absolute;left:640px;top:250px">{monster()}</div>
<div style="position:absolute;left:600px;top:130px;font-size:110px;color:#FF2E63;transform:rotate(-8deg);text-shadow:6px 6px 0 #1E1E2E">ガオーーッ!!</div>
<div style="position:absolute;left:1070px;top:330px;width:280px;padding:20px 0 26px;border-radius:30px;background:#FFFFFF;border:8px solid #1E1E2E;text-align:center;transform:rotate(4deg);box-shadow:10px 10px 0 #1E1E2E">
  <div style="font-size:26px">いまの こえ</div><div style="font-size:110px;line-height:1">{DB}</div><div style="font-size:30px">デシベル</div></div>
<div style="position:absolute;left:640px;top:720px;padding:18px 34px;border-radius:24px;background:#1E1E2E;color:#FFD43B;font-size:44px">かいじゅう まで あと 2.6！</div>
<div style="position:absolute;left:640px;top:840px;font-size:48px">のこり <span style="font-size:90px;color:#FF2E63">{LEFT}</span> びょう</div>
<div style="position:absolute;right:40px;top:40px;width:470px;height:1000px;padding:40px 30px;box-sizing:border-box;border-radius:36px;background:#FF6FB5;border:8px solid #1E1E2E">
  <div style="font-size:46px;color:#fff;text-shadow:4px 4px 0 #1E1E2E;margin-bottom:26px">きょうの つよい ひと</div>{ranking}</div></div>'''

# ---------------- D: ゲームセンター ----------------
def screen_d():
    grid = "".join(f'<div style="position:absolute;left:0;top:{y}px;width:1380px;height:2px;background:rgba(255,0,200,0.18)"></div>' for y in range(640, 1080, 55)) + \
           "".join(f'<div style="position:absolute;left:{x}px;top:640px;width:2px;height:440px;background:rgba(0,240,255,0.14)"></div>' for x in range(30, 1380, 90))
    bars, n = "", 28
    for i in range(n):
        h = int(120 + 380 * (0.55 + 0.45 * abs(__import__('math').sin(i * 0.55))) * (0.75 if i > 20 else 1))
        bars += f'<div style="position:absolute;left:{70 + i*44}px;top:{980-h}px;width:32px;height:{h}px;border-radius:6px;background:linear-gradient(0deg,#00F0FF,#7A5CFF 55%,#FF00C8)"></div>'
    ranking = "".join(f'<div class="d-rank"><span class="d-no">{["1ST","2ND","3RD","4TH","5TH"][i]}</span><span class="d-nm">{n}</span><span class="d-sc">{s}</span></div>' for i,(n,s) in enumerate(RANK))
    return f'''<div class="screen" style="background:linear-gradient(180deg,#0B0420 0%,#1A0B3D 60%,#2A0A4A 100%);font-family:'DotGothic16','M PLUS Rounded 1c',monospace;color:#fff">
{grid}{bars}
<div style="position:absolute;left:40px;top:430px;width:1300px;height:6px;border-top:6px dashed #FFE45E"></div>
<div style="position:absolute;left:40px;top:388px;font-size:30px;color:#FFE45E">CHAMPION 96.2 ─ きょうの チャンピオン</div>
<div style="position:absolute;left:60px;top:40px;font-size:72px;color:#00F0FF;text-shadow:0 0 18px #00F0FF">こえパワー ゲージ</div>
<div style="position:absolute;left:60px;top:130px;font-size:30px;color:#FF7AE0">VOICE POWER CHALLENGE</div>
<div style="position:absolute;left:760px;top:40px;width:560px;text-align:right">
  <div style="font-size:200px;line-height:1;color:#FFFFFF;text-shadow:0 0 24px #FF00C8, 0 0 60px #FF00C8">{DB}</div>
  <div style="font-size:40px;color:#FF7AE0">dB　のこり {LEFT}s</div></div>
<div style="position:absolute;left:1090px;top:300px;width:110px;height:110px;border:6px solid #FFE45E;border-radius:20px;text-align:center;font-size:84px;line-height:110px;color:#FFE45E;text-shadow:0 0 16px #FFE45E">A</div>
<div style="position:absolute;left:820px;top:318px;font-size:30px;color:#FFE45E">いまの ランク</div>
<div style="position:absolute;left:60px;top:200px;width:620px">
  <div style="font-size:28px;color:#00F0FF">YOU</div><div style="height:34px;border:3px solid #00F0FF;border-radius:6px"><div style="width:{int(YOU*100)}%;height:100%;background:#00F0FF;box-shadow:0 0 20px #00F0FF"></div></div>
  <div style="font-size:28px;color:#FF7AE0;margin-top:14px">GHOST</div><div style="height:34px;border:3px dashed #FF7AE0;border-radius:6px"><div style="width:{int(GHOST*100)}%;height:100%;background:rgba(255,122,224,0.45)"></div></div></div>
<div style="position:absolute;right:0;top:0;width:540px;height:1080px;background:#07020F;border-left:4px solid #FF00C8;padding:60px 40px;box-sizing:border-box">
  <div style="font-size:52px;color:#FFE45E;text-shadow:0 0 14px #FFE45E;margin-bottom:30px">HIGH SCORE</div>{ranking}
  <div style="position:absolute;left:40px;bottom:60px;font-size:34px;color:#00F0FF">PUSH SPACE TO START</div></div></div>'''

CSS = '''
*{box-sizing:border-box} body{margin:0;background:#E9E9EF}
.candidate{width:1920px;background:#FFFFFF;margin:0 0 120px 0}
.screen{position:relative;width:1920px;height:1080px;overflow:hidden}
.cap{padding:44px 60px 40px;font-family:'Noto Sans JP',sans-serif;color:#1F2330;background:#FFFFFF}
.cap-top{display:flex;align-items:center;gap:22px;margin-bottom:26px}
.cap-tag{white-space:nowrap;padding:8px 22px;border-radius:12px;color:#fff;font-size:34px;font-weight:900}
.cap-name{font-size:52px;font-weight:900;white-space:nowrap}
.cap-concept{font-size:28px;color:#5A6072}
.cap-cols{display:flex;gap:40px}
.cap-col{flex:1;background:#F4F5F9;border-radius:20px;padding:24px 28px}
.cap-h{font-size:26px;font-weight:900;margin-bottom:10px}
.cap-col ul{margin:0;padding-left:28px} .cap-col li{font-size:24px;line-height:1.6}
.a-rank{display:flex;align-items:center;gap:20px;padding:18px 22px;margin-bottom:14px;border-radius:24px;background:rgba(255,255,255,0.08);font-size:38px;font-weight:700}
.a-no{width:56px;height:56px;border-radius:50%;background:#FFD166;color:#12153D;text-align:center;line-height:56px;font-weight:900}
.a-nm{flex:1} .a-sc{color:#FFD166;font-weight:900}
.b-rank{display:flex;align-items:center;gap:18px;padding:16px 18px;margin-bottom:14px;border-radius:24px;background:#FFF7EA;font-size:38px;font-weight:700}
.b-medal{width:60px;height:60px;border-radius:50%;text-align:center;line-height:60px;color:#fff;font-weight:900}
.b-nm{flex:1} .b-sc{color:#F08A24;font-weight:900}
.c-rank{display:flex;align-items:center;gap:16px;padding:16px 20px;margin-bottom:18px;border-radius:18px;background:#FFFFFF;border:6px solid #1E1E2E;font-size:36px;box-shadow:6px 6px 0 #1E1E2E}
.c-no{color:#FF2E63} .c-nm{flex:1}
.d-rank{display:flex;align-items:center;gap:20px;padding:16px 0;border-bottom:2px dashed rgba(0,240,255,0.35);font-size:40px}
.d-no{width:110px;color:#FF7AE0} .d-nm{flex:1;color:#FFFFFF} .d-sc{color:#00F0FF;text-shadow:0 0 10px #00F0FF}
'''

cands = [
  (caption("案A", "うちゅうロケット", "#4B4FC9", "声の大きさ＝ロケットの高さ。チャンピオンの「かげロケット」と月を目指して競争",
     ["高さで比べるので、数字が読めない小さい子にも勝ち負けが一目でわかる", "ロケット・宇宙は年齢・性別を問わず人気", "数字が光る演出と相性がよく、新記録の盛り上げを作りやすい"],
     ["暗い背景は、明るい会場だとプロジェクターで白っぽく沈みやすい", "縦レースなので、2人分を並べると画面の横幅を使い切れない"],
     ["暗めの教室・体育館のステージ横", "男女・学年が混ざる自由参加ブース"]), screen_a()),
  (caption("案B", "どうぶつかけっこ", "#F08A24", "声の大きさ＝どうぶつの走る速さ。チャンピオンの「かげ」とゴールまでかけっこ",
     ["かけっこは幼稚園児にもルール説明がいらない", "「ライオンなみ！」など声の大きさを動物で言い換えられる", "明るく、保護者が写真を撮りたくなる雰囲気"],
     ["かわいい寄りで、高学年には少し子どもっぽく感じられるかも", "動物キャラのデザイン・動きの作り込みに手間がかかる"],
     ["明るい屋内・昼間の会場", "未就学児〜低学年が中心のとき"]), screen_b()),
  (caption("案C", "かいじゅうメーター", "#E63946", "声の大きさで「ねこ→いぬ→ライオン→かいじゅう→ドラゴン」に進化。太い縦メーターで見せる",
     ["段階が名前になっているので「かいじゅうまで行った！」と言葉で盛り上がる", "黄色＋太い線のマンガ調で、明るい会場でも遠くから読める", "大声を出すこと自体が「かいじゅうごっこ」になり、恥ずかしさが減る"],
     ["ゴーストとの競争はメーター上の線になり、レース感は弱い", "かいじゅうを怖がる小さい子がいる可能性"],
     ["明るい会場・遠くから見る大きなスクリーン", "幼稚園〜高学年まで幅広く"]), screen_c()),
  (caption("案D", "ゲームセンター", "#FF00C8", "アーケードゲーム風。イコライザーのバーとネオン、S/A/B ランクで「ハイスコア」を競う",
     ["高学年にいちばん「かっこいい」と感じてもらいやすい", "ランク（S/A/B）でゲームらしく何度も挑戦したくなる", "音に反応して動くバーが見ていて楽しい"],
     ["暗い背景＋細い文字は、明るい会場・小さい子には読みにくい", "英語・ドット文字が多く、未就学児には意味が伝わりにくい"],
     ["暗めの会場", "高学年が中心のとき"]), screen_d()),
]
html = '<!doctype html><html lang="ja"><head><meta charset="utf-8">' + \
  '<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@700;900&family=M+PLUS+Rounded+1c:wght@700;900&family=Dela+Gothic+One&family=DotGothic16&family=Noto+Sans+JP:wght@400;900&display=swap" rel="stylesheet">' + \
  f'<style>{CSS}</style></head><body>' + "".join(f'<div class="candidate">{c}{s}</div>' for c, s in cands) + '</body></html>'
open('candidates.html', 'w', encoding='utf-8').write(html)
print(len(html))
