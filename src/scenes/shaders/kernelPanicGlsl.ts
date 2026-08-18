/* ==========================================================================
 * ██  NON-COMMERCIAL — DO NOT SHIP  ████████████████████████████████████████
 *
 * Verbatim GLSL of an unlicensed Shadertoy work. Shadertoy's default licence is
 * CC BY-NC-SA 3.0, so absent an explicit grant this is NonCommercial and must
 * not appear in any commercial build. See KernelPanicScene.tsx for the full
 * notice and docs/HANDOFF.md for the release blocker.
 *
 * Ported AS-IS at the author's request: the original uint hashing, the three
 * 1200-entry character tables, the 40-second timeline and the five-stage buffer
 * chain are all reproduced unchanged. That requires GLSL ES 3.00 — `uint`,
 * bitwise ops, `floatBitsToUint`, array constructors, `textureSize`,
 * `textureLod` — so these materials are the only ones in the project built with
 * `glslVersion: THREE.GLSL3`.
 *
 * Three.js's GLSL3 prelude defines `attribute`->`in`, `varying`->`out`/`in`,
 * `texture2D`->`texture` and `gl_FragColor`->`pc_fragColor`, so the shared
 * FULLSCREEN_VERT works unchanged and the fragment bodies below need no
 * rewriting.
 * ========================================================================== */

/** Shadertoy uniform surface, declared once and prepended to every pass. */
const SHADERTOY_UNIFORMS = /* glsl */ `
  precision highp float;
  precision highp int;
  varying vec2 vUv;

  uniform vec3 iResolution;
  uniform float iTime;
  uniform int iFrame;
  uniform vec4 iMouse;
  uniform vec3 iChannelResolution[4];
  uniform sampler2D iChannel0;
  uniform sampler2D iChannel1;
  uniform sampler2D iChannel2;
  uniform sampler2D iChannel3;
`

export const COMMON_GLSL = /* glsl */ `
//note: from https://www.shadertoy.com/view/WttXWX , bias: 0.020888578919738908 = minimal theoretic limit
uint hash(uint x)
{
    x ^= x >> 17;
    x *= 0xed5ad4bbU;
    x ^= x >> 11;
    x *= 0xac4c1b51U;
    x ^= x >> 15;
    x *= 0x31848babU;
    x ^= x >> 14;
    return x;
}

float toFloat( uint x )
{
    return float(x) / 4294967296.0;
}
float hashf( uint x )
{
    return toFloat( hash( x ) );
}

float hashf( float x )
{
    return hashf( floatBitsToUint( x ) );
}

float remap( float x, float imn, float imx, float omn, float omx )
{
    return omn + (omx-omn)*clamp(x-imn, 0.0, 1.0) / (imx-imn);
}

vec2 uv43_from_fragcoord( vec2 fc, vec2 res )
{
    const float target_aspect = 4.0/3.0;
    vec2 target_res = vec2( res.y * target_aspect, res.y );
    vec2 target_uv = fc.xy / target_res;

    return target_uv;
}

float mytrunc( float x, float num_levels )
{
	return floor(x*num_levels) / num_levels;
}
vec2 mytrunc( vec2 x, float num_levels )
{
	return floor(x*num_levels) / num_levels;
}

vec2 mytrunc( vec2 x, vec2 num_levels )
{
	return floor(x*num_levels+0.5) / num_levels;
}

//note: input [0;1]
vec3 spectrum_offset_rgb( float t )
{
    float t0 = 3.0 * t - 1.5;
	return clamp( vec3( -t0, 1.0-abs(t0), t0), 0.0, 1.0);
}

float sat( float t ) {
	return clamp( t, 0.0, 1.0 );
}

vec2 sat( vec2 t ) {
	return clamp( t, 0.0, 1.0 );
}

//remaps inteval [a;b] to [0;1]
float remap  ( float t, float a, float b ) {
	return sat( (t - a) / (b - a) );
}

//note: /\\ t=[0;0.5;1], y=[0;1;0]
float linterp( float t ) {
	return sat( 1.0 - abs( 2.0*t - 1.0 ) );
}

//note: [0;1]
float rand( vec2 n ) {
  return fract(sin(dot(n.xy, vec2(12.9898, 78.233)))* 43758.5453);
}

//note: [-1;1]
float srand( vec2 n ) {
	return rand(n) * 2.0 - 1.0;
}
`

/** Wraps a Shadertoy `mainImage` body into a GLSL3 fragment entry point. */
const wrap = (body: string) => `${SHADERTOY_UNIFORMS}
${COMMON_GLSL}
${body}
void main(){
  vec4 c;
  mainImage( c, vUv * iResolution.xy );
  gl_FragColor = c;
}
`

const BUF_A_BODY = /* glsl */ `
const uint texw = 16u;
const uint texh = 16u;

vec2 idx_to_ofs( uint idx )
{
    return vec2( float(idx % texw)/float(texw), float(idx/texw)/float(texh) );
}

#define _A (11*16+1)
#define _B (11*16+2)
#define _C (11*16+3)
#define _D (11*16+4)
#define _E (11*16+5)
#define _F (11*16+6)
#define _G (11*16+7)
#define _H (11*16+8)
#define _I (11*16+9)
#define _J (11*16+10)
#define _K (11*16+11)
#define _L (11*16+12)
#define _M (11*16+13)
#define _N (11*16+14)
#define _O (11*16+15)
#define _P (10*16+0)
#define _Q (10*16+1)
#define _R (10*16+2)
#define _S (10*16+3)
#define _T (10*16+4)
#define _U (10*16+5)
#define _V (10*16+6)
#define _W (10*16+7)
#define _X (10*16+8)
#define _Y (10*16+9)
#define _Z (10*16+10)

#define _h (13*16+3)

#define __ (16*5+13)

#define _0 (16*12+0)
#define _1 (16*12+1)
#define _2 (16*12+2)
#define _3 (16*12+3)
#define _4 (16*12+4)
#define _5 (16*12+5)
#define _6 (16*12+6)
#define _7 (16*12+7)
#define _8 (16*12+8)
#define _9 (16*12+9)

uint map_idx( int screen_idx, float time )
{
    int luterr[40*30] = int[](
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        _h,__,_A,_N,__,_E,_X,_C,_E,_P,_T,_I,_O,_N,__,_O,_C,_C,_U,_R,_R,_E,_D,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,_C,_P,_U,__,__,__,__,_T,_Y,_R,_E,_L,_L,_C,_O,_R,_E,_2,_0,_2,_0,__,__,__,__,__,__,__,
        __,_E,_X,_C,_E,_P,_T,_I,_O,_N,__,_T,_Y,_P,_E,__,__,__,__,_P,_R,_E,_F,_E,_T,_C,_H,__,_A,_B,_O,_R,_T,__,__,__,__,__,__,__,
        __,__,__,_F,_A,_U,_L,_T,__,_S,_T,_A,_T,_U,_S,__,__,__,__,_D,_E,_B,_U,_G,__,_E,_V,_E,_N,_T,__,__,__,__,__,__,__,__,__,__,
        _C,_U,_R,_R,_E,_N,_T,__,_P,_R,_O,_C,_E,_S,_S,__,__,__,__,_F,_S,__,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,_0,__,__,
        _h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,__,
        _R,_0,__,__,__,__,__,__,__,__,_0,_0,_0,_0,_0,_2,_0,_0,__,__,__,_R,_1,__,__,__,__,__,__,__,_1,_F,_F,_8,_2,_5,_8,_0,__,__,
        _R,_2,__,__,__,__,__,__,__,__,_0,_0,_1,_5,_0,_A,_A,_0,__,__,__,_R,_3,__,__,__,__,__,__,__,_0,_0,_6,_4,_2,_5,_9,_8,__,__,
        _R,_4,__,__,__,__,__,__,__,__,_1,_F,_F,_8,_2,_4,_8,_0,__,__,__,_R,_5,__,__,__,__,__,__,__,_0,_0,_0,_0,_0,_0,_0,_0,__,__,
        _R,_6,__,__,__,__,__,__,__,__,_F,_F,_F,_7,_B,_B,_5,_C,__,__,__,_R,_7,__,__,__,__,__,__,__,_0,_0,_0,_0,_0,_0,_0,_2,__,__,
        _R,_8,__,__,__,__,__,__,__,__,_0,_0,_0,_0,_0,_0,_2,_4,__,__,__,_S,_P,__,__,__,__,__,__,__,_F,_F,_4,_0,_F,_C,_B,_0,__,__,
        _L,_R,__,__,__,__,__,__,__,__,_F,_F,_F,_2,_3,_B,_4,_C,__,__,__,_P,_C,__,__,__,__,__,__,__,_D,_E,_A,_D,_B,_E,_E,_F,__,__,
        _C,_P,_S,_R,__,__,__,__,__,__,_8,_0,_0,_0,_0,_1,_1,_3,__,__,__,_F,_P,_E,_X,_C,__,__,__,__,_0,_0,_0,_0,_0,_0,_0,_0,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        _S,_T,_A,_C,_K,_D,_U,_M,_P,__,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_B,_0,__,__,_D,_8,__,_0,_0,__,_0,_0,__,_0,_0,__,_0,_1,__,_0,_0,__,_0,_0,__,_0,_0,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_B,_8,__,__,_0,_1,__,_0,_0,__,_0,_0,__,_0,_0,__,_9,_C,__,_0,_1,__,_F,_2,__,_F,_F,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_C,_0,__,__,_F,_F,__,_6,_F,__,_0,_0,__,_0,_4,__,_4,_C,__,_C,_1,__,_F,_9,__,_F,_F,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_C,_8,__,__,_C,_4,__,_F,_C,__,_4,_0,__,_0,_0,__,_1,_8,__,_5,_C,__,_F,_7,__,_F,_F,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_D,_0,__,__,_0,_0,__,_0,_0,__,_0,_0,__,_0,_0,__,_0,_0,__,_F,_D,__,_4,_0,__,_F,_F,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_D,_8,__,__,_4,_C,__,_5,_C,__,_F,_7,__,_E,_E,__,_8,_0,__,_0,_0,__,_0,_0,__,_0,_0,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_E,_0,__,__,_0,_0,__,_7,_0,__,_0,_0,__,_2,_E,__,_0,_A,__,_4,_0,__,_D,_5,__,_E,_E,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_E,_8,__,__,_F,_8,__,_B,_0,__,_1,_8,__,_F,_F,__,_0,_0,__,_0,_0,__,_0,_0,__,_0,_0,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_F,_0,__,__,_0,_0,__,_0,_0,__,_0,_0,__,_F,_F,__,_0,_0,__,_0,_0,__,_0,_0,__,_0,_0,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_C,_F,_8,__,__,_0,_0,__,_0,_0,__,_0,_0,__,_1,_F,__,_4,_C,__,_1,_0,__,_0,_0,__,_0,_0,__,__,__,__,__,
        _h,__,_F,_F,_4,_0,_F,_D,_0,_0,__,__,_0,_1,__,_0,_0,__,_0,_0,__,_0,_0,__,_1,_C,__,_5,_C,__,_F,_7,__,_F,_F,__,__,__,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__
    );

    int lut[40*30] = int[](
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __
    );

	//note: https://www.dafont.com/5x5.font
    int lut_cancelled[40*30] = int[] (
        _C,_Y,_B,_E,_R,_P,_U,_N,_K,__, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K,__, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K,__, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        _h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,
        _h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        __,__,__,__,__,__,__,__,__,__,_h,_h,__,__,_h,_h,_h,__,_h,_h,__,__,_h,_h,_h,__,_h,__,_h,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,__,__,__,__,__,__,__,__,_h,__,_h,__,_h,__,_h,__,_h,__,_h,__,__,_h,__,__,_h,__,_h,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,__,__,__,__,__,__,__,__,_h,_h,__,__,_h,__,_h,__,_h,_h,__,__,__,_h,__,__,__,_h,__,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,__,__,__,__,__,__,__,__,_h,__,__,__,_h,_h,_h,__,_h,__,_h,__,__,_h,__,__,__,_h,__,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,__,__,__,__,__,__,__,__,_h,__,__,__,_h,__,_h,__,_h,__,_h,__,__,_h,__,__,__,_h,__,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
    	__,__,_h,_h,_h,__,_h,_h,_h,__,_h,__,__,_h,__,_h,_h,_h,__,_h,_h,_h,__,_h,__,__,__,_h,__,__,__,_h,_h,_h,__,_h,_h,_h,__,__,
    	__,__,_h,__,__,__,_h,__,_h,__,_h,_h,__,_h,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,_h,__,
    	__,__,_h,__,__,__,_h,__,_h,__,_h,__,_h,_h,__,_h,__,__,__,_h,_h,__,__,_h,__,__,__,_h,__,__,__,_h,_h,__,__,_h,__,__,_h,__,
    	__,__,_h,__,__,__,_h,_h,_h,__,_h,__,_h,_h,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,__,_h,__,__,_h,__,
    	__,__,_h,_h,_h,__,_h,__,_h,__,_h,__,__,_h,__,_h,_h,_h,__,_h,_h,_h,__,_h,_h,_h,__,_h,_h,_h,__,_h,_h,_h,__,_h,_h,_h,__,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        _h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,
        _h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,_h,__,
        __,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,__,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __,
        _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __, _C,_Y,_B,_E,_R,_P,_U,_N,_K, __
    );

    int ii = screen_idx % (40*30);
    uint i0 = uint( luterr[ ii ] );
    uint i1 = uint( lut[ ii ] );

    float t0 = clamp( time-30.0 + 0.25*float(screen_idx)/(40.0*30.0), 0.0, 1.0 );
    uint idx = uint( mix( float(i0), float(i1), t0 ) );

    float t1 = clamp( time-32.0 + 0.25*float(screen_idx)/(40.0*30.0), 0.0, 1.0 );
    idx = uint( mix( float(idx), float(__), t1 ) );

    return idx;
}

vec4 render_text( vec2 ssuv, vec2 fragCoord )
{
    vec4 fragColor = vec4(0.0);

    float in_time = mod( iTime, 40.0 );

    const uint w = 40u;
    const uint h = 30u;
    int idx = int( ssuv.x * float(w) ) + int(w) * int((1.0-ssuv.y)*float(h));

    vec2 luv = fract( ssuv * vec2(w,h) );
    luv = luv / vec2(texw, texh);

    float frq = 10.0 + 5.0 * hashf( uint(idx) );

    uint rnd_idx_u = hash( uint(idx) + hash( uint(idx) + uint(float(iFrame+1000)/frq)) );
    float rnd_idx = toFloat( rnd_idx_u );

    float rnd_t = hashf( uint(1337.0*in_time) );

    float timeScale = 0.5;
    uint rnd = hash( uint(idx) + uint( timeScale * in_time ) );
    float rndf = toFloat( rnd );

    uint scl = texw*texh;
    uint letteridx = map_idx(idx, in_time);

    float time_total_s = 20.0;
    float time_per_idx_s = float(w*h) / time_total_s;
    const float speed = 175.0;
    float time = (in_time+0.75)*speed;

    int curidx = min( int(time), int(w*h + 80u) );
    float curidx_t = float(curidx) * time_per_idx_s;

    float idx_t = float(idx) * time_per_idx_s;

    float dt = curidx_t - idx_t;

    float glitchmask = dt / (80.0*time_per_idx_s);

    glitchmask = min( glitchmask, 0.995 );

    float glitch = step( glitchmask, rnd_idx );

    float m_visible = (dt>-0.5) ? 1.0 : 0.0;

    if ( glitch > 0.5 )
    {
        letteridx = hash( uint(idx*1337) + uint(iFrame/2) ) % (w*h);

        m_visible += step(rnd_idx, 0.001);
    }

    vec2 ofs = idx_to_ofs( letteridx );

    vec3 s = textureLod( iChannel0, ofs + luv, 0.0 ).rgb;
    float txtmask = remap( s.x, 0.0, 0.8, 1.0, 0.0 );

    float v = txtmask;

    float p0 = 0.0;
    {
        const float PI = 3.1415926435;
        const float waves = 44.0;
        const int NUM_ITER = 8;
        //note: approx square-wave
        for ( int i=1; i<NUM_ITER; i+=2 )
             p0 += (float(i)/float(NUM_ITER)) * sin(float(i)*PI * (waves*ssuv.y) );
        p0 = remap( p0, 0.0, 1.0, 0.6, 1.0 );
    }

    v = 1.0 - v;
    v = min( v, p0 );

    if ( dt <= 3.5 && dt > -0.1 )
    {
        v = 1.0 - v * mix( 0.1, 1.0, rnd_t );
        v *= 2.0;
    }

    v *= m_visible;

    vec4 c = vec4( vec3(v), 1.0 );

    //note: feedback
    if ( iFrame > 0 )
    {
        vec4 prev = texture( iChannel1, fragCoord.xy/iResolution.xy );
        c = mix( c, prev, 0.5 );
    }

    fragColor = c;

    return fragColor;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 target_uv = uv43_from_fragcoord( fragCoord.xy, iResolution.xy );
    if ( target_uv.x > 1.0 )
    {
        fragColor = vec4(0,0,0,1); return;
    }

    vec2 ssuv = target_uv;

    fragColor = render_text( ssuv, fragCoord );
}
`

const BUF_B_BODY = /* glsl */ `
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 ssuv = fragCoord.xy / iResolution.xy;

    float rnd = hashf( uint(1337*iFrame) + uint(fragCoord.y) + hash(uint(fragCoord.x)) );

    const int NUM_SAMPLES = 8;
    float blurdist_px = 2.0 * float( textureSize(iChannel0, 0).y );
    vec2 blurdir_px = vec2(0,blurdist_px);
    vec2 stepvec_px = blurdir_px / float(NUM_SAMPLES);

    vec2 p = fragCoord.xy;
    p -= 0.5 * blurdir_px;
    p += blurdir_px * rnd / float(NUM_SAMPLES);

    vec3 sumc = vec3(0.0);
    float sumw = 0.0;
    for ( int i=0; i<NUM_SAMPLES; ++i )
    {
        vec2 uv = p / iResolution.xy;
        float w = 1.0;
    	sumc += w * texture( iChannel0, uv ).rgb;
        sumw += w;
        p += stepvec_px;
    }
    sumc /= sumw;

    //note: feedback
    if ( iFrame > 0 )
    {
        vec3 prev = texture( iChannel1, ssuv ).rgb;
        sumc = mix( sumc, prev, 0.9 );
    }

    fragColor = vec4(sumc, 1.0);
}
`

const BUF_C_BODY = /* glsl */ `
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 ssuv = fragCoord.xy / iResolution.xy;

    float rnd = hashf( uint(1337*iFrame) + uint(fragCoord.y) + hash(uint(fragCoord.x)) );

    const int NUM_SAMPLES = 8;
    float blurdist_px = 50.0;
    vec2 blurdir_px = vec2(0,blurdist_px);
    vec2 stepvec_px = blurdir_px / float(NUM_SAMPLES);

    vec2 p = fragCoord.xy;
    p -= 0.5 * blurdir_px;
    p += blurdir_px * rnd / float(NUM_SAMPLES);

    vec3 sumc = vec3(0.0);
    float sumw = 0.0;
    for ( int i=0; i<NUM_SAMPLES; ++i )
    {
        vec2 uv = p / iResolution.xy;
        float w = 1.0;
    	sumc += w * texture( iChannel0, uv ).rgb;
        sumw += w;
        p += stepvec_px;
    }
    sumc /= sumw;

    fragColor = vec4(sumc, 1.0);
}
`

const BUF_D_BODY = /* glsl */ `
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 ssuv = fragCoord.xy / iResolution.xy;

    float rnd = hashf( uint(1227*iFrame) + uint(fragCoord.y) + hash(uint(fragCoord.x)) );

    const int NUM_SAMPLES = 8;
    float blurdist_px = 100.0;
    vec2 blurdir_px = vec2(blurdist_px, 0);
    vec2 stepvec_px = blurdir_px / float(NUM_SAMPLES);

    vec2 p = fragCoord.xy;
    p -= 0.5 * blurdir_px;
    p += blurdir_px * rnd / float(NUM_SAMPLES);

    vec3 sumc = vec3(0.0);
    float sumw = 0.0;
    for ( int i=0; i<NUM_SAMPLES; ++i )
    {
        vec2 uv = p / iResolution.xy;
        float w = 1.0;
    	sumc += w * texture( iChannel2, uv ).rgb;
        sumw += w;
        p += stepvec_px;
    }
    sumc /= sumw;

    vec3 s = sumc;

    vec3 sA = texture( iChannel0, ssuv).rgb;
    vec3 sB = texture( iChannel1, ssuv).rgb;

    s = sA + sB + sumc;

    fragColor = vec4(s, 1.0);
}
`

/**
 * Image pass.
 *
 * Two additions to the original, both required by the host rather than by
 * taste, and both confined to the last two lines of `mainImage`:
 *   uFade         — the engine's crossfade weight. Without it the scene cannot
 *                   transition in or out at all.
 *   U_BRIGHTNESS  — the roster's additive exposure budget.
 * `uGlitchBoost` is added to GLITCH so the scripted ramp still responds to the
 * track; at 0 the behaviour is exactly the original's.
 */
const IMAGE_BODY = /* glsl */ `
uniform float uFade;
uniform float uGlitchBoost;
uniform float U_BRIGHTNESS;

vec4 shampain_glitch( vec2 p, float GLITCH, float rndx )
{
    vec2 ssuv = p.xy;
    p *= iResolution.xy;

    float in_time = mod(iTime,40.0);

    float aspect = iResolution.x / iResolution.y;
	vec2 uv = p.xy / iResolution.xy;

	float time = mod( in_time, 32.0);

	float gnm = sat( GLITCH );
	float rnd0 = rand( mytrunc( vec2(time, time), 6.0 ) );
	float r0 = sat((1.0-gnm)*0.7 + rnd0);
	float rnd1 = rand( vec2(mytrunc( uv.x, 10.0*r0 ), time) ); //horz
	float r1 = 0.5 - 0.5 * gnm + rnd1;
	r1 = 1.0 - max( 0.0, ((r1<1.0) ? r1 : 0.9999999) ); //note: weird ass bug on old drivers
	float rnd2 = rand( vec2(mytrunc( uv.y, 40.0*r1 ), time) ); //vert
	float r2 = sat( rnd2 );

	float rnd3 = rand( vec2(mytrunc( uv.y, 10.0*r0 ), time) );
	float r3 = (1.0-sat(rnd3+0.8)) - 0.1;

	float pxrnd = rand( uv + time );

	float ofs = 0.05 * r2 * GLITCH * ( rnd0 > 0.5 ? 1.0 : -1.0 );
	ofs += 0.5 * pxrnd * ofs;

	uv.y += 0.1 * r3 * GLITCH;

    const int NUM_SAMPLES = 10;
    const float RCP_NUM_SAMPLES_F = 1.0 / float(NUM_SAMPLES);

	vec4 sum = vec4(0.0);
	vec3 wsum = vec3(0.0);
	for( int i=0; i<NUM_SAMPLES; ++i )
	{
		float t = float(i) * RCP_NUM_SAMPLES_F;
		uv.x = sat( uv.x + ofs * t );
		vec4 samplecol = texture( iChannel3, uv, -10.0 );
        if (rndx > 0.7 && rndx < 0.75 )
            samplecol = (2.0-2.0*samplecol) * vec4( 0.1, 0.2*rnd1, 0.5*rnd1, 1.0 );
		vec3 s = spectrum_offset_rgb( t );
		samplecol.rgb = samplecol.rgb * s;
		sum += samplecol;
		wsum += s;
	}
	sum.rgb /= wsum;
	sum.a *= RCP_NUM_SAMPLES_F;

    vec4 outcol;

	outcol.a = sum.a;
	outcol.rgb = sum.rgb;

    return outcol;
}

vec2 calc_glitch_uv( vec2 ssuv, out float rnd0, out float GLITCH )
{
    float in_time = mod(iTime, 40.0 );

    GLITCH = max( 0.1, 10.0 - in_time*in_time );

    if ( in_time > 30.0 )
        GLITCH = clamp( in_time-20.0, 0.0, 20.0 );

    // Host addition: the track pushes the scripted ramp. 0 == original.
    GLITCH += uGlitchBoost;

    float GLITCHs = clamp( GLITCH, 0.0, 1.0);

    if ( iMouse.z > 0.5 )
    	GLITCH = 0.05 + 20.0 * iMouse.x / iResolution.x;

    float time = mytrunc( in_time, 10.0 );
    float ftime = fract( time );

    float rndt = hashf( uint(1337.0*ftime) );

    float sign0 = -1.0 + 2.0 * step( rndt, 0.5 );
    vec2 uv0 = mytrunc( ssuv, vec2(64.0) );
    float seed0 = uv0.y + sign0*3.0/32.0*(1.0+uv0.x)*uv0.y;
    seed0 = mytrunc( seed0, 16.0 );

    rnd0 = hashf( seed0 + fract(0.39*time) );
    float rnd1 = hashf( rnd0 );

    float rnd0v = rnd0;
    rnd0 = mix( 0.0, rnd0, GLITCH );

    float maxofs = 5.0 / iChannelResolution[0].x;
    float mask = step(0.98, rnd0);
    vec2 uv1 = ssuv;

    //note: offset-glitch
    uv1 += maxofs * mask;

    //invert sometimes
    if(rnd0v>(1.0-0.03*GLITCHs))
        uv1 = 1.0 - uv1;

    if (rnd0v>0.1 && rnd0v<(0.1+0.05*GLITCHs) )
    	uv1 *= mix( 1.0, 1.5, GLITCH );

    if (rnd0v>0.5 && rnd0v<0.5+0.05*GLITCHs)
    	uv1 *= mix( 1.0, 0.5, GLITCH );

    return uv1;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 ssuv = fragCoord.xy / iResolution.xy;

    {
        vec2 target_uv = uv43_from_fragcoord( fragCoord.xy, iResolution.xy );
        if ( target_uv.x > 1.0 )
        {
            fragColor = vec4(0,0,0,1); return;
        }
    }

    float rnd0, GLITCH;
    vec2 uv1 = calc_glitch_uv( ssuv, rnd0, GLITCH );

	fragColor = shampain_glitch( uv1, mix( 0.0, rnd0*rnd0, sat(GLITCH-0.2) ), rnd0 );

    // Host: additive exposure budget + engine crossfade weight.
    fragColor = vec4( fragColor.rgb * U_BRIGHTNESS * uFade, 1.0 );
}
`

export const KP_BUF_A = wrap(BUF_A_BODY)
export const KP_BUF_B = wrap(BUF_B_BODY)
export const KP_BUF_C = wrap(BUF_C_BODY)
export const KP_BUF_D = wrap(BUF_D_BODY)
export const KP_IMAGE = wrap(IMAGE_BODY)
