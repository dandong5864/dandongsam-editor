from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, sys
S=2
KEY=60*S; GAP=6*S; PAD=26*S
F='/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'
CAP='/home/claude/VideoToolkit/public/fonts/Cafe24Supermagic-Bold.otf'
def font(s,idx=1): return ImageFont.truetype(F,int(s*S),index=idx)
def capfont(s): return ImageFont.truetype(CAP,int(s*S))
rows=[
 [('~\n`',1),('1',1),('2',1),('3',1),('4',1),('5',1),('6',1),('7',1),('8',1),('9',1),('0',1),('_\n-',1),('+\n=',1),('Backspace',2)],
 [('Tab',1.5)]+[(c,1) for c in 'QWERTYUIOP']+[('{\n[',1),('}\n]',1),('|\n\\',1.5)],
 [('Caps Lock',1.75)]+[(c,1) for c in 'ASDFGHJKL']+[(':\n;',1),('"\n\'',1),('Enter',2.25)],
 [('Shift',2.25)]+[(c,1) for c in 'ZXCVBNM']+[('<\n,',1),('>\n.',1),('?\n/',1),('Shift',2.75)],
 [('Ctrl',1.75),('Win',1.25),('Alt',1.5),('Space',6.5),('Alt',1.5),('Ctrl',2.5)],
]
# 오른쪽 이동키 묶음 (행 번호, 열 번호, 글자)
cluster=[(0,0,'Delete'),(0,1,'Home'),(0,2,'End'),(3,1,'↑'),(4,0,'←'),(4,1,'↓'),(4,2,'→')]
MAINW=15*KEY+14*GAP; CLW=3*KEY+2*GAP; SEP=int(0.6*KEY)
def keyboard(hl, caption, out):
    W=int(MAINW+SEP+CLW+2*PAD); H0=int(5*KEY+4*GAP+2*PAD); capf=capfont(46)
    H=H0+int(76*S)
    im=Image.new('RGBA',(W,H),(0,0,0,0))
    d=ImageDraw.Draw(im)
    d.rounded_rectangle((4*S,4*S,W-4*S,H0-6*S),radius=26*S,fill=(206,208,214,255),outline=(170,172,180,255),width=3*S)
    def key(x,y,kw,lab,on):
        fill=(255,128,0,255) if on else (240,240,242,255)
        edge=(200,95,0,255) if on else (150,152,160,255)
        d.rounded_rectangle((x,y+3*S,x+kw,y+KEY+3*S),radius=10*S,fill=(120,122,130,255))
        d.rounded_rectangle((x,y,x+kw,y+KEY),radius=10*S,fill=fill,outline=edge,width=2*S)
        col=(0,0,0,255) if on else (50,50,56,255); cx,cy=x+kw/2,y+KEY/2
        if lab=='Win':
            s=11*S; g=2*S
            for i in range(2):
                for j in range(2): d.rectangle((cx-s-g/2+i*(s+g),cy-s-g/2+j*(s+g),cx-g/2+i*(s+g),cy-g/2+j*(s+g)),fill=(255,255,255,255) if on else (60,60,66,255))
        elif '\n' in lab:
            a,b=lab.split('\n'); f=font(22); d.text((cx,cy-12*S),a,font=f,fill=col,anchor='mm'); d.text((cx,cy+12*S),b,font=f,fill=col,anchor='mm')
        else:
            if lab in '↑←↓→': size=30
            elif len(lab)==1: size=26
            elif lab in('Ctrl','Shift','Alt','Enter','Space','Tab'): size=22
            else: size=17
            if lab in('Ctrl','Win'): size=28 if on else 24
            d.text((cx,cy),lab,font=font(size),fill=col,anchor='mm')
    counts={}; y=PAD
    for r in rows:
        x=PAD
        for lab,w in r:
            kw=w*KEY+(w-1)*GAP if w!=1 else KEY
            counts[lab]=counts.get(lab,0)+1
            key(x,y,kw,lab,lab in hl and counts[lab]==1)
            x+=kw+GAP
        y+=KEY+GAP
    x0=PAD+MAINW+SEP
    for r,c,lab in cluster:
        key(x0+c*(KEY+GAP),PAD+r*(KEY+GAP),KEY,lab,lab in hl)
    cd=ImageDraw.Draw(im); cy=H0+38*S
    cd.text((W/2,cy),caption,font=capf,fill=(0,0,0,255),anchor='mm',stroke_width=7*S,stroke_fill=(255,255,255,255))
    cd.text((W/2,cy),caption,font=capf,fill=(0,0,0,255),anchor='mm')
    OFF=10*S; SW=7*S   # 아래 글자와 같은 흰색, 같은 굵기(7) 테두리
    big=Image.new('RGBA',(W+2*OFF,H+2*OFF),(0,0,0,0)); bd=ImageDraw.Draw(big)
    bd.rounded_rectangle((OFF+4*S-SW,OFF+4*S-SW,OFF+W-4*S+SW,OFF+H0-6*S+SW),radius=26*S+SW,fill=(255,255,255,255))
    big.alpha_composite(im,(OFF,OFF)); im=big; W,H=im.size
    im=im.resize((W//S,H//S),Image.LANCZOS); im.save(out)
def textsticker(label,out):
    f=capfont(86); sw=14*S; pad=34*S
    tmp=Image.new('RGBA',(10,10)); bb=ImageDraw.Draw(tmp).textbbox((0,0),label,font=f,stroke_width=sw,anchor='la')
    w=bb[2]-bb[0]+2*pad; h=bb[3]-bb[1]+2*pad
    im=Image.new('RGBA',(w,h),(0,0,0,0)); d=ImageDraw.Draw(im); pos=(pad-bb[0],pad-bb[1])
    d.text(pos,label,font=f,fill=(0,0,0,255),anchor='la',stroke_width=sw,stroke_fill=(255,255,255,255))
    d.text(pos,label,font=f,fill=(0,0,0,255),anchor='la')
    im=im.resize((w//S,h//S),Image.LANCZOS); im.save(out)
EQ='+\n='; MIN='_\n-'; DOT='>\n.'; COM='<\n,'
items=[
 ('복사','Ctrl + C',['Ctrl','C']),('붙여넣기','Ctrl + V',['Ctrl','V']),('잘라내기','Ctrl + X',['Ctrl','X']),
 ('되돌리기','Ctrl + Z',['Ctrl','Z']),('다시 실행','Ctrl + Y',['Ctrl','Y']),('저장','Ctrl + S',['Ctrl','S']),
 ('전체 선택','Ctrl + A',['Ctrl','A']),('찾기','Ctrl + F',['Ctrl','F']),('새로 만들기','Ctrl + N',['Ctrl','N']),
 ('인쇄','Ctrl + P',['Ctrl','P']),('화면 캡처','Win + Shift + S',['Win','Shift','S']),('바탕화면 보기','Win + D',['Win','D']),
 ('재생 일시정지','Space',['Space']),
 ('분할','Ctrl + B',['Ctrl','B']),('모든 트랙 분할','Ctrl + Shift + B',['Ctrl','Shift','B']),
 ('앞부분 삭제','Q',['Q']),('뒷부분 삭제','W',['W']),('클립 삭제','Delete',['Delete']),
 ('다시 실행 2','Ctrl + Shift + Z',['Ctrl','Shift','Z']),
 ('속성 복사','Ctrl + Shift + C',['Ctrl','Shift','C']),('속성 붙여넣기','Ctrl + Shift + V',['Ctrl','Shift','V']),
 ('1프레임 이동','← →',['←','→']),('10프레임 이동','Shift + ← →',['Shift','←','→']),
 ('이전 다음 컷','↑ ↓',['↑','↓']),('처음으로','Home',['Home']),('끝으로','End',['End']),
 ('선택 모드','A',['A']),('클릭 자르기 모드','B',['B']),
 ('뒤로 감기','J',['J']),('멈춤','K',['K']),('빠르게 감기','L',['L']),
 ('타임라인 전체 보기','Shift + Z',['Shift','Z']),
 ('타임라인 확대','Ctrl + =',['Ctrl',EQ]),('타임라인 축소','Ctrl + -',['Ctrl',MIN]),
 ('음량 올리기','Ctrl + .',['Ctrl',DOT]),('음량 내리기','Ctrl + ,',['Ctrl',COM]),
 ('현재 장면 캡처','Ctrl + P',['Ctrl','P']),('내보내기','Ctrl + E',['Ctrl','E']),
 ('줄바꿈','Enter',['Enter']),
]
if __name__=='__main__':
    o=sys.argv[1]; os.makedirs(o,exist_ok=True)
    for n,k,h in items:
        keyboard(set(h),f'{n} : {k}',f'{o}/단축키_{n}.png'); textsticker(f'{n} : {k}',f'{o}/텍스트_{n}.png')
    print(len(os.listdir(o)))
