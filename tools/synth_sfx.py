import numpy as np, subprocess, os
from scipy.io import wavfile
from scipy.signal import butter, sosfilt
SR=44100; rng=np.random.default_rng(7)
def t(d): return np.arange(int(SR*d))/SR
def env(n,a=0.005,r=0.05):
    e=np.ones(n); na=max(1,int(a*SR)); nr=max(1,int(r*SR)); e[:na]=np.linspace(0,1,na); e[-nr:]*=np.linspace(1,0,nr); return e
def adsr_decay(x,tau): return x*np.exp(-t(len(x)/SR)/tau)
def sine(f,d,ph=0): return np.sin(2*np.pi*f*t(d)+ph)
def sweep(f0,f1,d,exp=True):
    tt=t(d); f=f0*(f1/f0)**(tt/d) if exp else f0+(f1-f0)*tt/d
    return np.sin(2*np.pi*np.cumsum(f)/SR)
def noise(d): return rng.standard_normal(int(SR*d))
def bp(x,lo,hi,o=2): return sosfilt(butter(o,[lo,hi],btype='band',fs=SR,output='sos'),x)
def lp(x,f,o=2): return sosfilt(butter(o,f,btype='low',fs=SR,output='sos'),x)
def hp(x,f,o=2): return sosfilt(butter(o,f,btype='high',fs=SR,output='sos'),x)
def cat(*xs,gap=0):
    g=np.zeros(int(SR*gap)); out=[]
    for x in xs: out+=[x,g]
    return np.concatenate(out)
def mix(*xs):
    n=max(len(x) for x in xs); o=np.zeros(n)
    for x in xs: o[:len(x)]+=x
    return o
def at(x,off,total):
    o=np.zeros(int(SR*total)); i=int(SR*off); o[i:i+len(x)]+=x[:len(o)-i]; return o
def bell(f,d,tau=0.25): return adsr_decay(sine(f,d)+0.5*sine(f*2.76,d)+0.25*sine(f*5.4,d),tau)*env(int(SR*d),0.002,0.03)
def note(f,d,tau=0.12): return adsr_decay(sine(f,d)+0.3*sine(2*f,d),tau)*env(int(SR*d),0.003,0.02)
sounds={}
sounds['팝']=adsr_decay(sweep(900,300,0.12),0.04)*env(int(SR*0.12),0.001,0.02)
sounds['뽁']=adsr_decay(sweep(500,1500,0.09),0.03)*env(int(SR*0.09),0.002,0.02)
sounds['딩']=bell(1318,1.0,0.35)
sounds['띵동']=cat(bell(988,0.6,0.25),bell(740,0.9,0.35))
sounds['종소리']=bell(660,1.8,0.7)
sounds['성공 차임']=cat(note(523,0.12),note(659,0.12),note(784,0.12),note(1047,0.5,0.25))
sounds['레벨업']=cat(*[note(f,0.09) for f in (392,494,587,784,988)],note(1175,0.6,0.3))
sounds['실패 버저']=(sine(110,0.5)+0.5*sine(220,0.5)+0.3*np.sign(sine(110,0.5)))*env(int(SR*0.5),0.01,0.05)*0.6
sounds['오답 삐삑']=cat(np.sign(sine(300,0.15))*0.4*env(int(SR*0.15),0.005,0.02),np.sign(sine(300,0.15))*0.4*env(int(SR*0.15),0.005,0.02),gap=0.06)
sounds['슬픈 하락음']=cat(note(440,0.25,0.3),note(392,0.25,0.3),note(349,0.25,0.3),note(262,0.8,0.5))
sounds['코인']=cat(note(988,0.07,0.1),note(1319,0.5,0.22))
sounds['알림음']=cat(note(880,0.1,0.1),note(1175,0.3,0.15),gap=0.03)
sounds['클릭']=adsr_decay(hp(noise(0.03),2000),0.006)*0.8

def _clk(f=2400):
    d=0.06; return (adsr_decay(bp(noise(d),1500,6500),0.004)*0.9+adsr_decay(sine(f,d),0.006)*0.5)
_down=_clk(2600); _up=_clk(1900)*0.6
sounds['마우스 클릭']=mix(_down,at(_up,0.07,0.14))*0.9
sounds['마우스 더블클릭']=mix(_down,at(_up,0.07,0.5),at(_down,0.2,0.5),at(_up,0.27,0.5))*0.9
sounds['카메라 셔터']=cat(adsr_decay(hp(noise(0.04),1500),0.01),adsr_decay(bp(noise(0.06),800,5000),0.02),gap=0.05)
sounds['휙']=bp(noise(0.35),400,6000)*np.sin(np.pi*np.linspace(0,1,int(SR*0.35)))**2*0.7
sounds['휘익 빠른']=sweep(400,2500,0.25)*np.sin(np.pi*np.linspace(0,1,int(SR*0.25)))*0.6+0.25*bp(noise(0.25),500,6000)*np.sin(np.pi*np.linspace(0,1,int(SR*0.25)))
sounds['슝 하강']=sweep(2000,250,0.4)*np.sin(np.pi*np.linspace(0.1,1,int(SR*0.4)))*0.7
sounds['띠용']=sweep(250,900,0.25,False)*(1+0.3*sine(25,0.25))*env(int(SR*0.25),0.01,0.08)*0.7
sounds['또잉']=adsr_decay(sine(260,0.6)*(1+0.5*sine(18,0.6)),0.25)+0.0
sounds['쿵']=adsr_decay(sweep(120,40,0.5)*1.0,0.18)*env(int(SR*0.5),0.001,0.05)
sounds['큰북']=adsr_decay(sweep(160,70,0.6),0.22)*env(int(SR*0.6),0.001,0.05)+0.3*adsr_decay(lp(noise(0.6),400),0.05)
sounds['충격음']=mix(adsr_decay(sweep(90,35,0.8),0.3),adsr_decay(lp(noise(0.8),600),0.12)*0.8,adsr_decay(hp(noise(0.8),3000),0.03)*0.4)*env(int(SR*0.8),0.001,0.1)
sounds['팡']=mix(adsr_decay(lp(noise(0.35),3500),0.07),adsr_decay(sweep(300,90,0.35),0.1))*env(int(SR*0.35),0.001,0.05)
sounds['반짝 마법']=mix(*[at(note(f,0.5,0.15)*0.5,0.07*i,1.3) for i,f in enumerate((1568,1976,2349,2637,3136,3951))])
sounds['등장 쨘']=mix(adsr_decay(sine(262,1.2)+sine(330,1.2)+sine(392,1.2)+0.5*sine(524,1.2),0.5),adsr_decay(hp(noise(1.2),4000),0.1)*0.2)*env(int(SR*1.2),0.005,0.2)*0.4
sounds['긴장감 두근']=at(adsr_decay(sweep(80,45,0.25),0.09),0,1.4)+at(adsr_decay(sweep(80,45,0.25),0.09)*0.7,0.28,1.4)+at(adsr_decay(sweep(80,45,0.25),0.09),0.9,1.4)+at(adsr_decay(sweep(80,45,0.25),0.09)*0.7,1.18,1.4)
sounds['긴장감 상승']=(sweep(100,900,2.0,True)*np.linspace(0.1,1,int(SR*2.0))+0.3*bp(noise(2.0),300,3000)*np.linspace(0,1,int(SR*2.0)))*env(int(SR*2.0),0.05,0.05)*0.6
sounds['공포 저음']=(sine(55,2.5)+0.6*sine(58,2.5)+0.3*sine(110.5,2.5))*np.sin(np.pi*np.linspace(0,1,int(SR*2.5)))*0.8
sounds['드럼롤']=(adsr_decay(lp(noise(1.5),2500),1.0)*0+bp(noise(1.5),300,3000)*(0.5+0.5*np.abs(sine(28,1.5)))*np.linspace(0.3,1,int(SR*1.5)))*env(int(SR*1.5),0.01,0.05)
sounds['빠바밤']=cat(note(392,0.15,0.2),note(392,0.15,0.2),note(392,0.15,0.2),note(311,0.9,0.5),gap=0.05)
sounds['뿌우 나팔']=(sine(233,0.6)+0.6*sine(466,0.6)+0.4*sine(699,0.6)+0.3*sine(932,0.6))*env(int(SR*0.6),0.06,0.15)*0.5
sounds['웃음 효과 두둥']=cat(adsr_decay(sweep(110,50,0.45),0.25)*env(int(SR*0.45),0.001,0.05),adsr_decay(sweep(90,40,0.8),0.35)*env(int(SR*0.8),0.001,0.1),gap=0.25)
sounds['물방울']=adsr_decay(sweep(800,2200,0.12),0.04)*env(int(SR*0.12),0.002,0.03)
sounds['병따기 뽕']=adsr_decay(sweep(180,420,0.1),0.06)*env(int(SR*0.1),0.001,0.02)+0.3*adsr_decay(bp(noise(0.1),500,3000),0.02)
tick_t=0; ticks=np.zeros(int(SR*1.8)); k=0
while tick_t<1.7:
    i=int(SR*tick_t); seg=adsr_decay(hp(noise(0.02),2500),0.005); ticks[i:i+len(seg)]+=seg[:len(ticks)-i]; tick_t+=0.04+0.0035*k; k+=1
sounds['룰렛 틱틱']=ticks*0.8
sounds['전화 벨']=cat(*[(sine(440,0.08)+sine(480,0.08))*env(int(SR*0.08),0.003,0.01)*0.4 for _ in range(10)],gap=0.012)
sounds['카운트다운 삑']=cat(note(880,0.12,0.2),gap=0.4)
sounds['시작 휘슬']=(sine(2900,0.5)*(1+0.3*sine(40,0.5)))*env(int(SR*0.5),0.02,0.08)*0.45
os.makedirs('out',exist_ok=True)
for name,x in sounds.items():
    x=np.asarray(x,dtype=float); pk=np.max(np.abs(x)) or 1; x=x/pk
    act=x[np.abs(x)>0.08]; rms=float(np.sqrt(np.mean(act**2))) if len(act) else 0.3
    x=x*min(0.17/max(rms,1e-6),0.92)   # 소리 크기를 비슷하게 맞춰요(체감 크기 기준, 최대치는 넘지 않게)
    x=np.concatenate([x,np.zeros(int(SR*0.03))])
    wavfile.write('/tmp/synth/tmp.wav',SR,(x*32767).astype(np.int16))
    subprocess.run(['ffmpeg','-v','error','-y','-i','/tmp/synth/tmp.wav','-codec:a','libmp3lame','-q:a','3',f'/tmp/synth/out/{name}.mp3'],check=True)
print(len(sounds),'made')
