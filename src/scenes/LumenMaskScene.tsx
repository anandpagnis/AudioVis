import * as THREE from 'three'
import { createShaderScene } from '../engine/createShaderScene'
import { bipolar, drastic } from './contract'

/**
 * Lumen Mask — a machined light-panel head mounted on a béton-brut hall wall.
 * Pure 2D SDF compositing: chassis plates, emissive panels, greeble masks and a
 * bevel light model taken from the field gradient. No raymarching.
 *
 * Provided by the user for this project — the source carries its own
 * "AudioVis: delete bands() and write these three from your analyser" porting
 * note and no external attribution or URL, so it is treated as project-original
 * (`license: 'original'`). If it turns out to be derived from a licensed source,
 * requarantine it into `DISABLED_SCENES` + `KNOWN_NC_SOURCE_IDS`.
 *
 * ## Port — what changed on the way in (everything else is verbatim)
 *
 * 1. **`USE_AUDIO` / `bands()` removed.** The shader already told us to: the
 *    three band levels `gLow` (jaw / mouth), `gMid` (ocular assemblies) and
 *    `gHigh` (manipulator digits) now come straight from `uBass` / `uMids` /
 *    `uHighs`, written from the engine's lilim audio state in `update()`.
 *    `s.kick` drives the jaw so it pumps on the downbeat; `s.mids` / `s.highs`
 *    drive the eyes and fingers. The `#else` synthetic-variety branches in
 *    `fingerLevel` / `stripLevel` are kept as the per-element jitter (they only
 *    read `gHigh` / `gMid` / noise, which stay live).
 * 2. **Shadertoy globals → prelude uniforms.** `iResolution` → `uRes`,
 *    `iTime` → `uT` (a JS-accumulated clock so `speed` stays continuous when it
 *    changes), `mainImage` → `main` with `gl_FragColor`. `uFade` is applied to
 *    the averaged output — the roster contract every scene must honour.
 * 3. **Steerable.** `zoom` (`fill`), `glow` (`contrast` → `gGain`), `detail`
 *    (`complexity` → greeble density, blends the fine cut-lines / bolts / vents
 *    back toward the bare plates) and a small signed framing `tilt`.
 * 4. **Palette.** A final multiplicative tint pulls the shader's fixed cold
 *    blue-white lighting toward the live five-slot palette (`uAccent`/`uGlow`
 *    hue, brightness preserved), so mood and palette recolour it like the rest
 *    of the roster. The hand-tuned light model and every geometry constant are
 *    untouched.
 */

export const FRAG = /* glsl */ `
#define AA 1                    // 2 => 4x supersampling

uniform float uT;              // JS-accumulated motion clock (speed applied)
uniform float uBass, uMids, uHighs;   // gLow / gMid / gHigh, 0..1
uniform float uEnergy;
uniform float uZoom;           // fill  -> frame coverage
uniform float uGlowGain;       // contrast -> emissive gain
uniform float uDetail;         // complexity -> greeble density
uniform float uTilt;           // signed framing offset
uniform float uPalMix;         // palette tint strength

const float HOR   = -0.66;      // wall / floor junction
const float PITCH = 0.200;      // column module
const float COLW  = 0.062;
const float COL0  = 0.120;
const float BOW   = 0.085;      // upward curve of the wide bands

float gT, gLow, gMid, gHigh;    // clock + band levels
float gBlink, gOpenU, gOpenL;   // eyelid, lip separation
float gGain, gScanY;            // emissive gain, projector sweep
float gDetail;                  // greeble density, 0..1
bool  gCheap;                   // reflections skip the fine detail

// ------------------------------------------------------------- noise
float h21(vec2 p){
    p = fract(p*vec2(127.31, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x*p.y);
}
float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f *= f*(3.0-2.0*f);
    return mix(mix(h21(i),          h21(i+vec2(1,0)), f.x),
               mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
    float s = 0.0, a = 0.5;
    for(int i=0;i<4;i++){ s += a*vnoise(p); p = p*2.02 + 13.7; a *= 0.5; }
    return s;
}
// band-limited stripe: fades out instead of aliasing when undersampled
float wave(float x, float w){
    return (0.5+0.5*cos(6.28318*x)) * (1.0 - smoothstep(0.14, 0.45, w));
}
// dark hairline every \`pitch\` along \`c\`
float hairline(float c, float pitch, float hw, float px){
    float dl = abs(mod(c + 0.5*pitch, pitch) - 0.5*pitch);
    return smoothstep(hw - px, hw + px, dl);
}

// ====================== AUDIO DRIVE ==================================
// Everything downstream reads only gLow / gMid / gHigh (0..1); the engine
// writes uBass / uMids / uHighs in update().
float blinkEnv(float t){
    float seg = floor(t/2.6);
    float u   = (t - seg*2.6 - (0.3 + 1.9*h21(vec2(seg,1.0))))/0.085;
    return exp(-u*u);
}
float fingerLevel(float i){
    float w = 0.55 + 0.45*sin(gT*7.0 + i*2.3);
    return clamp(gHigh*w*(0.65 + 0.55*h21(vec2(i,3.0))), 0.0, 1.0);
}
// per-segment level for the readout strip
float stripLevel(float i){
    return clamp(0.25 + 0.75*vnoise(vec2(i*0.7, gT*2.2))*(0.4+0.9*gMid), 0.0, 1.0);
}
void driveInit(float t){
    gT = t;
    vec3 a = clamp(vec3(uBass, uMids, uHighs), 0.0, 1.0);
    gLow = a.x; gMid = a.y; gHigh = a.z;
    gDetail = clamp(uDetail, 0.0, 1.0);
    gBlink = blinkEnv(t);
    gOpenU = 0.030*gLow;
    gOpenL = 0.080*gLow;
    gGain  = (0.93 + 0.13*max(gLow, max(gMid,gHigh))) * uGlowGain;
    gScanY = 0.95 - 1.75*fract(t*0.37);                   // projector sweep
}

// -------------------------------------------------------- primitives
float sdBox(vec2 p, vec2 b){
    vec2 d = abs(p)-b;
    return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}
float B(vec2 p, float cx, float cy, float hx, float hy, float r){
    return sdBox(p-vec2(cx,cy), vec2(hx,hy)-r) - r;
}
float sdOct(vec2 p, vec2 b, float ch){          // chamfered box
    return max(sdBox(p,b), dot(abs(p), vec2(0.70711)) - ch);
}
float sdRing(vec2 p, float r, float w){ return abs(length(p)-r) - w; }
float sdTrapezoid(vec2 p, float r1, float r2, float he){
    vec2 k1 = vec2(r2,he), k2 = vec2(r2-r1,2.0*he);
    p.x = abs(p.x);
    vec2 ca = vec2(p.x - min(p.x, (p.y<0.0)?r1:r2), abs(p.y)-he);
    vec2 cb = p - k1 + k2*clamp(dot(k1-p,k2)/dot(k2,k2), 0.0, 1.0);
    float s = (cb.x<0.0 && ca.y<0.0) ? -1.0 : 1.0;
    return s*sqrt(min(dot(ca,ca), dot(cb,cb)));
}
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }

// =================== EMISSIVE PANELS =================================
float sdEmissive(vec2 p){
    vec2 q = vec2(abs(p.x), p.y);
    float d = 1e9;

    float k  = floor((q.x - COL0)/PITCH + 0.5);          // column index
    float dc = abs(q.x - (COL0 + k*PITCH)) - COLW;

    // --- crown piers, staggered tops and feet
    float top = 0.850 - 0.058*mod(k,2.0) - 0.022*mod(k,3.0);
    float bot = 0.545 + 0.026*mod(k+1.0,2.0);
    d = min(d, max(dc, max(p.y-top, bot-p.y)));

    // --- readout strip riding the brow ledge
    d = min(d, B(q, 0.360, 0.4875, 0.360, 0.0165, 0.004));

    // --- ocular assembly ------------------------------------------
    float row = max(dc, abs(p.y-0.338)-0.116);           // blocks either side
    vec2  le  = q - vec2(0.330, 0.352);
    le.y /= max(1.0 - 0.95*gBlink, 0.05);
    float rr   = length(le*vec2(1.0,1.04));
    float lens = rr - (0.152 + 0.020*gMid);
    d = min(d, max(row, -lens));
    float arc = max(abs(rr - 0.130) - 0.017, le.y + mix(0.075,-0.112,gMid));
    d = min(d, arc + gBlink*0.60);                       // sweeping arc
    float iris = min(sdRing(le, 0.098, 0.006), sdRing(le, 0.060, 0.004));
    d = min(d, iris + gBlink*0.60);                      // iris rings
    d = min(d, max(B(le, 0.0, 0.0, 0.010, 0.046 - 0.030*gMid, 0.005),
                   gBlink*0.60));                        // pupil slit
    vec2 tk = rot(gT*0.35)*le;                           // bezel index ticks
    // atan(0,0) is undefined — nudge the exact eye-centre pixel off zero.
    tk = vec2(length(tk), atan(tk.y, tk.x + (abs(tk.x) + abs(tk.y) < 1e-6 ? 1e-5 : 0.0))*0.1592);
    d = min(d, max(abs(tk.x - 0.176) - 0.010,
                   abs(mod(tk.y*12.0 + 0.5, 1.0) - 0.5) - 0.14) + gBlink*0.6);

    // --- cheek band, chamfered ends, notched by the nose
    vec2  m  = vec2(q.x, p.y - BOW*q.x*q.x);
    float cb = max(B(m, 0.0, 0.082, 0.960, 0.066, 0.016),
                   dot(abs(m-vec2(0.0,0.082)), vec2(0.70711)) - 0.715);
    cb = max(cb, -sdTrapezoid(p - vec2(0.0,0.140), 0.215, 0.080, 0.165));
    d = min(d, cb);

    // --- mandible : two lips that part on gLow
    d = min(d, B(m, 0.0, -0.1775 + gOpenU, 0.610, 0.0475, 0.018));
    d = min(d, B(m, 0.0, -0.2525 - gOpenL, 0.610, 0.0475, 0.018));
    // corner pistons, extending as the jaw drops
    d = min(d, B(m, 0.660 + 0.5*gOpenL, -0.215, 0.030 + 0.5*gOpenL, 0.012, 0.006));

    // --- throat : stacked plates that spread on gLow
    for(int i=0;i<3;i++){
        float fi = float(i);
        d = min(d, B(q, 0.0, -0.335 - fi*0.062 - gOpenL*(0.35+fi*0.45),
                     0.235 - fi*0.045, 0.0115, 0.005));
    }

    // --- palms + manipulator digits
    d = min(d, max(max(dc, abs(p.y+0.430)-0.140), 2.5-k));
    float sub  = step(0.0, q.x - (COL0 + k*PITCH));
    float fcx  = COL0 + k*PITCH + (sub*2.0 - 1.0)*0.031;
    float fidx = k*2.0 + sub;
    float prof = 0.78 + 0.22*sin(3.1416*(fidx-5.0)/3.0);
    float ftop = -0.290 + 0.26*prof*fingerLevel(fidx);
    d = min(d, max(B(q, fcx, 0.5*(ftop-0.340), 0.028, 0.5*(ftop+0.340), 0.014), 2.5-k));
    return d;
}

// ===================== CHASSIS (metal) ===============================
float sdShell(vec2 p){
    float d = sdOct(p - vec2(0.0, 0.115), vec2(1.010, 0.775), 1.185);
    d = min(d, B(vec2(abs(p.x),p.y), 0.500, 0.502, 1.030, 0.046, 0.010));  // brow ledge
    d = min(d, sdOct(p - vec2(0.0,-0.470), vec2(0.700, 0.175), 0.735));    // chin plate
    return d;
}
float sdInset(vec2 p){                      // raised inner plate
    return sdOct(p - vec2(0.0, 0.150), vec2(0.845, 0.615), 1.005);
}

// ================== GREEBLES (interior masks) ========================
// perforations + teeth on the mandible
float perf(vec2 p, float px){
    vec2 m = vec2(abs(p.x), p.y - BOW*p.x*p.x);
    float cx = (floor(m.x/0.0860)+0.5)*0.0860;
    float k = 1.0;
    for(int i=0;i<2;i++){
        float ry = (float(i) < 0.5) ? (-0.186 + gOpenU) : (-0.244 - gOpenL);
        k = min(k, smoothstep(-px, px, length(m-vec2(cx,ry)) - 0.0135));
    }
    return mix(1.0, k, step(m.x, 0.575));
}
// dark cut-lines, bolts and slats drilled into the lit panels
float emissiveDetail(vec2 p, float px){
    vec2  q = vec2(abs(p.x), p.y);
    float base = perf(p, px);
    float k = base;
    if(gCheap) return k;

    k *= 0.90 + 0.10*wave(p.y*150.0, px*150.0);            // diffuser scanlines
    k *= mix(1.0, 0.85, 1.0-hairline(p.y, 0.0940, 0.0032, px));   // horizontal seams
    k *= mix(1.0, 0.90, 1.0-hairline(q.x, 0.1000, 0.0026, px));   // vertical seams

    // readout strip : segments lit by level
    float inStrip = step(abs(p.y-0.4875), 0.0165);
    float seg     = floor(q.x/0.0500);
    k *= mix(1.0, 0.62*(0.12 + 0.88*step(0.35, stripLevel(seg + sign(p.x)*17.0))), inStrip);

    // knuckle gaps across the digits
    k *= mix(1.0, 0.45, (1.0-hairline(p.y+0.06, 0.0720, 0.0040, px))
                        * step(0.63, q.x) * step(p.y, -0.250));
    // bolt heads on the wide bands
    vec2  bc = (floor(vec2(q.x,p.y)/vec2(0.100,0.100))+0.5)*vec2(0.100,0.100);
    float bd = length(vec2(q.x,p.y)-bc) - 0.0075;
    k *= mix(1.0, 0.5 + 0.5*smoothstep(-px,px,bd), step(abs(p.y-0.082+BOW*p.x*p.x), 0.050));
    return mix(base, k, gDetail);                          // detail -> bare plate
}
// plate seams, bolts and vents cut into the chassis
float metalDetail(vec2 p, float px, out float seamLit){
    vec2 q = vec2(abs(p.x), p.y);
    seamLit = 0.0;
    if(gCheap) return 1.0;

    float sv = hairline(q.x + 0.100, PITCH, 0.0055, px);
    float sh = hairline(p.y - 0.070, 0.2600, 0.0055, px);
    float s  = min(sv, sh);
    seamLit  = ((1.0-hairline(q.x + 0.0885, PITCH, 0.0030, px)) * 0.5
             + (1.0-hairline(p.y - 0.0585, 0.2600, 0.0030, px)) * 0.5) * gDetail;
    float k  = mix(0.45, 1.0, s);

    // bolts at the plate corners
    vec2  bc = vec2((floor((q.x+0.100)/PITCH)+0.5)*PITCH - 0.100,
                    (floor((p.y-0.070)/0.26)+0.5)*0.26 + 0.070);
    float bd = length(vec2(q.x,p.y)-bc) - 0.011;
    k *= 0.55 + 0.45*smoothstep(-px, px*1.5, bd);

    // nasal vent slats + the grille inside the dark mouth gap
    float slat = 1.0-hairline(p.y, 0.0300, 0.0075, px);
    k *= mix(1.0, 0.25, slat*step(abs(p.x), 0.150)*step(abs(p.y-0.130), 0.150));
    k *= mix(1.0, 0.35, slat*step(q.x, 0.480)*step(abs(p.y+0.060), 0.055));
    return mix(1.0, k, gDetail);                           // detail -> bare plate
}


// interior seen through the cavities: a second module, scaled about the
// centre so it reads as receded.  Parallax without a single ray.
vec3 deepColor(vec2 p, float px, float glow){
    vec2 pd = p*1.32 + vec2(0.0,-0.035);
    vec2 q  = vec2(abs(pd.x), pd.y);
    float rib = abs(q.x - (floor(q.x/0.085 + 0.5))*0.085) - 0.026;
    float brc = abs(mod(pd.y + 0.05, 0.160) - 0.080) - 0.013;
    float ins = smoothstep(px*1.6, -px*1.6, min(rib, brc));
    float lit = smoothstep(px*1.6, -px*1.6, min(rib+0.012, brc+0.012));
    vec3  c   = vec3(0.005,0.006,0.008);
    c += vec3(0.017,0.019,0.024)*ins + vec3(0.010,0.011,0.014)*lit;
    c += glow*vec3(0.11,0.12,0.16)*(0.25 + 0.75*ins);
    return c;
}
// cable runs slung across the jaw: dark cord, lit along the top
float cables(vec2 p, out float lit){
    vec2  q = vec2(abs(p.x), p.y);
    float d = 1e9; lit = 0.0;
    for(int i=0;i<2;i++){
        float fi = float(i);
        float t  = clamp((q.x - 0.26)/0.70, 0.0, 1.0);
        float yc = -0.325 - fi*0.075 - (0.085 + 0.05*fi)*sin(3.1416*t);
        float dc = max(abs(p.y - yc) - 0.0095, abs(q.x - 0.61) - 0.35);
        d   = min(d, dc);
        lit = max(lit, smoothstep(0.012, 0.0, abs(p.y - yc - 0.008))
                     * step(abs(q.x-0.61), 0.35));
    }
    return d;
}

// ======================== SHADING ====================================
vec3 wallColor(vec2 p, float px){
    // --- fields
    float dE = sdEmissive(p);
    float dM = sdShell(p);
    float dI = sdInset(p);

    // --- bounce light from the panels (also the metal's key light)
    float dd   = max(dE, 0.0);
    float glow = 0.52*exp(-dd*50.0) + 0.22*exp(-dd*15.0) + 0.072*exp(-dd*3.8);
    glow *= gGain;

    // --- raw wall behind the machine
    float blot  = fbm(p*2.6 + 5.0);
    vec3  col   = vec3(0.020 + 0.032*blot + 0.014*fbm(p*24.0));
    col *= 1.0 - 0.45*smoothstep(0.010, 0.001,
              min(abs(fract(p.x/0.36+0.5)-0.5)*0.36, abs(fract(p.y/0.46+0.5)-0.5)*0.46));

    // --- chassis
    float insM = smoothstep(px, -px, dI);
    float seamLit;
    float mk = metalDetail(p, px, seamLit);
    vec2  g  = vec2(0.0);
    if(!gCheap){                                   // bevel from the field gradient
        float h = 0.006;
        g = vec2(sdShell(p+vec2(h,0.0)) - dM, sdShell(p+vec2(0.0,h)) - dM)/h;
        g += 0.55*vec2(sdInset(p+vec2(h,0.0)) - dI, sdInset(p+vec2(0.0,h)) - dI)/h * insM;
    }
    float bev = 1.0 - smoothstep(0.0, 0.045, -dM);
    vec3  n   = normalize(vec3(g*bev*1.9, 1.0));
    float key = max(dot(n, normalize(vec3(-0.42, 0.62, 0.66))), 0.0);
    float fil = max(dot(n, normalize(vec3( 0.58,-0.30, 0.76))), 0.0);
    float spc = pow(key, 30.0)*0.85 + pow(fil, 46.0)*0.40;

    vec3 metal = vec3(0.019,0.021,0.026) * (0.32 + 0.90*key + 0.26*fil)
               * (0.82 + 0.30*smoothstep(-0.55, 0.85, p.y));      // lit from above
    metal *= mix(1.0, 1.10, insM);                          // raised plate reads brighter
    metal += vec3(0.011,0.012,0.015)*seamLit;               // machined seam highlight
    metal *= mk;
    metal += glow*vec3(0.40,0.44,0.55);                     // panel bounce
    metal += spc*(0.020 + 1.15*glow)*vec3(0.80,0.86,1.0);   // specular
    metal += 0.026*smoothstep(0.013, 0.0, abs(dM))*vec3(0.70,0.78,0.95);  // silhouette rim
    metal += 0.012*exp(-abs(p.y-gScanY)*70.0)*(0.35+0.65*gMid);   // projector sweep

    // cavities: swap the plate for the receded interior structure
    float my  = p.y - BOW*p.x*p.x;
    float cav = max(step(abs(my + 0.060), 0.074) * step(abs(p.x), 0.600),
                    step(abs(p.y + 0.360), 0.075) * step(abs(p.x), 0.560));
    if(!gCheap && cav > 0.0) metal = mix(metal, deepColor(p, px, glow), cav);
    else                     metal *= mix(1.0, 0.42, cav);

    // cable runs across the jaw
    if(!gCheap){
        float cl; float dcab = cables(p, cl);
        metal *= mix(1.0, 0.30, smoothstep(px,-px,dcab));
        metal += (0.020 + 0.9*glow)*cl*vec3(0.72,0.78,0.92);
    }

    // socket recess around each lens
    float sock = length(vec2(abs(p.x),p.y) - vec2(0.330,0.352)) - 0.235;
    metal *= mix(1.0, 0.62, smoothstep(0.012,-0.02, sock));
    metal += 0.008*smoothstep(0.014, 0.0, abs(sock));

    // contact shadow of the chassis on the wall
    if(!gCheap) col *= mix(1.0, 0.35, smoothstep(px, -px, sdShell(p + vec2(0.020,0.030))));
    col  = mix(col, metal, smoothstep(px, -px, dM));

    // --- emissive panels on top
    float ins = smoothstep(px, -px, dE);
    float rim = smoothstep(0.0, 0.011, -dE);
    if(!gCheap) col *= mix(1.0, 0.30, smoothstep(px,-px, sdEmissive(p+vec2(0.016,0.024))) * (1.0-ins));
    col += glow*vec3(0.66,0.72,0.86)*0.26;   // airy halo in front of everything
    float lum = (0.88 + 0.11*fbm(p*22.0)) * mix(0.24, 1.00, rim) * gGain;
    lum *= emissiveDetail(p, px);
    col = mix(col, vec3(0.93,0.965,1.0)*lum, ins);
    return col;
}

vec3 floorColor(vec2 p, float px){
    float t  = HOR - p.y;
    vec2  rp = vec2(p.x, HOR + t*(1.0 + 2.2*t));
    float blur = 0.008 + t*0.42;

    bool keep = gCheap; gCheap = true;                 // cheap path for reflections
    vec3 r = vec3(0.0);
    for(int i=0;i<4;i++){
        float fi = float(i) - 1.5;
        float j  = h21(vec2(fi, floor(p.y*512.0))) - 0.5;
        r += wallColor(rp + vec2(j*blur*0.25, (fi+j)*blur*0.9), px + blur*0.5);
    }
    gCheap = keep;
    r *= 0.25;

    float fade   = exp(-t*2.6);
    float streak = 0.72 + 0.50*vnoise(vec2(p.x*34.0, 3.0));
    vec3  col    = vec3(0.011,0.012,0.015) + vec3(0.020)*fbm(p*vec2(3.0,9.0));
    col += r*fade*streak*0.88;
    col *= 0.55 + 0.45*smoothstep(0.0, 0.040, t);
    return col;
}

vec3 renderScene(vec2 frag){
    vec2 uv = (frag - 0.5*uRes) / uRes.y;
    float zoom = 2.10 / max(uZoom, 0.05);
    vec2 p  = uv*zoom - vec2(0.0, 0.03);
    p.x += uTilt * 0.09;                                  // signed framing offset
    float px = zoom / uRes.y;

    // rare horizontal tear on the high band
    float gl = step(0.86, h21(vec2(floor(gT*7.0), floor(p.y*22.0))));
    p.x += gl*gHigh*0.010*(h21(vec2(floor(p.y*22.0), 5.0))-0.5);

    gCheap = false;
    vec3 col = (p.y > HOR) ? wallColor(p,px) : floorColor(p,px);

    col += vec3(0.016,0.018,0.023)*exp(-abs(p.y-HOR)*4.5)*(0.6+0.5*gLow);

    float v = length(uv*vec2(1.05,1.25));
    col *= 1.0 - 0.68*smoothstep(0.28, 1.02, v);
    col = pow(max(col,0.0), vec3(0.95))*1.02;
    col += (h21(frag*1.7) - 0.5)*0.022;

    // palette tint: pull the fixed cold blue-white lighting toward the live
    // five-slot palette hue, brightness preserved.
    vec3 acc = max(uAccent, vec3(0.0)) + 1e-3;
    vec3 glw = max(uGlow, vec3(0.0)) + 1e-3;
    vec3 pt = mix(normalize(acc), normalize(glw), 0.5) * 1.7320508;
    col *= mix(vec3(1.0), pt, clamp(uPalMix, 0.0, 1.0));

    // Sanitise: a NaN anywhere upstream makes clamp() undefined and some GPUs
    // resolve it to 1.0 — i.e. a white screen. NaN fails both comparisons.
    if (!(col.x >= 0.0) && !(col.x <= 0.0)) col = vec3(0.0);
    if (!(col.y >= 0.0) && !(col.y <= 0.0)) col = vec3(0.0);
    if (!(col.z >= 0.0) && !(col.z <= 0.0)) col = vec3(0.0);
    return clamp(min(col, vec3(64.0)), 0.0, 1.0);
}

void main(){
    driveInit(uT);
    vec3 acc = vec3(0.0);
    for(int m=0;m<AA;m++)
    for(int n=0;n<AA;n++){
        vec2 o = (vec2(float(m),float(n))+0.5)/float(AA) - 0.5;
        acc += renderScene(gl_FragCoord.xy + o);
    }
    gl_FragColor = vec4(acc/float(AA*AA) * uFade, 1.0);
}
`

interface LumenMaskState {
  /** Motion clock, accumulated so a changing `speed` stays continuous. */
  t: number
}

export const LumenMaskScene = createShaderScene<LumenMaskState>({
  id: 'lumen',
  frag: FRAG,
  state: () => ({ t: 0 }),
  blending: THREE.AdditiveBlending,
  // Heavy: fbm x several, 4-tap floor reflection re-running wallColor, ~40 SDF
  // ops per pixel across wall + reflection. Render offscreen and upscale.
  pixelBudget: 1.5,
  uniforms: () => ({
    uT: { value: 0 },
    uBass: { value: 0 },
    uMids: { value: 0 },
    uHighs: { value: 0 },
    uEnergy: { value: 0 },
    uZoom: { value: 1 },
    uGlowGain: { value: 1 },
    uDetail: { value: 0.95 },
    uTilt: { value: 0 },
    uPalMix: { value: 0.55 },
  }),
  update({ u, s, P, st, dt }) {
    // Source's authored clock ran at 1x on iTime; keep that as the neutral rate.
    st.t += dt * drastic(P.speed)
    u.uT.value = st.t

    // gLow drives the jaw — lead with the kick envelope so it pumps on the
    // downbeat, with a floor from sub so a sustained low still parts the lips.
    u.uBass.value = Math.min(1, s.kick * 0.85 + s.onKick * 0.35 + s.sub * 0.25)
    // gMid -> ocular assemblies (lens dilation, iris, sweeping arc).
    u.uMids.value = Math.min(1, s.mids + s.onMid * 0.3)
    // gHigh -> manipulator digits + the readout strip shimmer.
    u.uHighs.value = Math.min(1, s.highs * 0.9 + s.air * 0.3 + s.onHigh * 0.3)
    u.uEnergy.value = s.energy

    // Neutral (0.5) reproduces the source exactly: zoom -> the original 2.10,
    // gain -> 1.0, detail -> full.
    u.uZoom.value = 0.55 + P.fill * 0.9 // 0.55..1.45 -> zoom 3.8..1.45
    u.uGlowGain.value = 0.45 + P.contrast * 1.1 // 0.45..1.55
    u.uDetail.value = Math.min(1, 0.5 + P.complexity) // <0.5 thins the greebles
    u.uTilt.value = bipolar(P.tilt, 1) // signed framing offset, +/-0.09 in p-space
  },
})
