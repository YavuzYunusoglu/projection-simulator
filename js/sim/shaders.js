// GLSL ES 3.0 shaders.

export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vRaw;   // 0..1, y up (texture orientation for FBO passes)
out vec2 vUv;    // 0..1, y down (screen orientation)
void main() {
  vRaw = aPos * 0.5 + 0.5;
  vUv = vec2(vRaw.x, 1.0 - vRaw.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Separable gaussian blur. First pass linearises the sRGB source.
export const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uSigma;
uniform int uLinearize;
uniform int uEncode;   // 1: store sqrt-encoded (8-bit fallback)
uniform int uDecode;   // 1: input is sqrt-encoded
in vec2 vRaw;
out vec4 outColor;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 fetchC(vec2 uv) {
  vec3 c = texture(uTex, uv).rgb;
  if (uLinearize == 1) c = toLin(c);
  if (uDecode == 1) c = c * c;
  return c;
}
void main() {
  vec3 acc;
  if (uSigma < 0.35) {
    acc = fetchC(vRaw);
  } else {
    float stp = max(1.0, uSigma / 6.0);
    float wsum = 0.0;
    acc = vec3(0.0);
    for (int i = -20; i <= 20; i++) {
      float x = float(i) * stp;
      if (abs(x) > 3.0 * uSigma + stp) continue;
      float w = exp(-0.5 * x * x / (uSigma * uSigma));
      acc += fetchC(vRaw + uDir * x) * w;
      wsum += w;
    }
    acc /= wsum;
  }
  if (uEncode == 1) acc = sqrt(max(acc, 0.0));
  outColor = vec4(acc, 1.0);
}`;

// Scene compositor: wall, screen, whiteboard, window and the projected light.
export const SCENE = `#version 300 es
precision highp float;
uniform sampler2D uSlide;     // blurred, linear (maybe sqrt-encoded)
uniform sampler2D uOrig;      // original sRGB
uniform int uDecode;
uniform int uMode;            // 0 wall view, 1 slide space
uniform vec3 uCam;            // centre x, centre y, half width (metres)
uniform float uAspect;        // canvas aspect
uniform mat3 uHinv;           // wall -> slide uv
uniform mat3 uH;              // slide uv -> wall
uniform vec2 uScreen;         // half width/height of matte surface
uniform float uSlideAspect;
uniform float uEpw, uEpb, uEa, uGain, uWarm, uGamma, uTime, uRoom, uSplit, uCurtain;
uniform vec3 uAmbCol;
uniform mat3 uProj;           // projector colour matrix (tint/calibration)
uniform vec4 uWB;             // whiteboard rect x0,y0,x1,y1
uniform vec4 uWin;            // window rect
uniform float uCeil;          // ceiling y
uniform float uTrunk;         // cable trunking y
uniform vec3 uStage;          // background for compare panel (sRGB)
uniform vec3 uAdapt;          // viewer's chromatic adaptation white
in vec2 vUv;
out vec4 outColor;

vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
bool inRect(vec2 p, vec4 r) { return p.x >= r.x && p.x <= r.z && p.y >= r.y && p.y <= r.w; }
vec3 tonemap(vec3 x) {
  vec3 k = 0.82 + 0.18 * (1.0 - exp(-(x - 0.82) / 0.18));
  return mix(x, k, step(0.82, x));
}

// Projected light (lux, per channel) arriving at wall point p.
vec3 projected(vec2 p, out float inside, out vec2 uv) {
  vec3 q = uHinv * vec3(p, 1.0);
  uv = q.xy / q.z;
  vec2 fw = max(fwidth(uv), vec2(1e-5));
  vec2 e = smoothstep(vec2(0.0), fw, uv) * smoothstep(vec2(0.0), fw, 1.0 - uv);
  inside = (q.z > 0.0) ? e.x * e.y : 0.0;
  if (inside <= 0.0) return vec3(0.0);
  vec3 s = texture(uSlide, clamp(uv, 0.0, 1.0)).rgb;
  if (uDecode == 1) s = s * s;
  s = pow(max(s, 0.0), vec3(uGamma));
  vec3 col = max(uProj * s, 0.0);
  vec3 blackTint = uProj * vec3(1.0);
  vec2 d = (uv - 0.5) * vec2(1.0, 1.0 / uSlideAspect) * 1.6;
  float falloff = 1.0 - 0.22 * dot(d, d);
  vec3 E = (uEpb * blackTint + (uEpw - uEpb) * col) * falloff * uWarm;
  return E * inside;
}

void surface(vec2 p, out vec3 albedo, out float spec, out vec3 emit) {
  spec = 0.0;
  emit = vec3(0.0);
  vec2 hs = uScreen;
  // matte screen
  if (abs(p.x) <= hs.x && abs(p.y) <= hs.y) {
    float tex = 0.985 + 0.015 * vnoise(p * 900.0);
    albedo = vec3(0.96, 0.96, 0.955) * uGain * tex;
    return;
  }
  // black screen border
  if (abs(p.x) <= hs.x + 0.035 && p.y >= -hs.y - 0.06 && p.y <= hs.y + 0.035) {
    albedo = vec3(0.035);
    return;
  }
  // bottom bar
  if (abs(p.x) <= hs.x + 0.06 && p.y > hs.y + 0.035 && p.y <= hs.y + 0.055) {
    albedo = vec3(0.03);
    return;
  }
  // roller housing
  float top = -hs.y - 0.06;
  if (abs(p.x) <= hs.x + 0.09 && p.y < top && p.y >= top - 0.085) {
    float t = (p.y - (top - 0.085)) / 0.085;
    albedo = vec3(0.025 + 0.05 * pow(sin(t * 3.14159), 4.0));
    if (abs(p.x) > hs.x + 0.06) albedo = vec3(0.06);
    return;
  }
  // whiteboard
  if (inRect(p, uWB)) {
    vec4 inner = uWB + vec4(0.03, 0.03, -0.03, -0.03);
    if (inRect(p, inner)) {
      albedo = vec3(0.86, 0.87, 0.87);
      spec = 1.0;
    } else {
      albedo = vec3(0.6, 0.61, 0.62);
    }
    return;
  }
  // window with curtain
  if (uRoom > 0.0 && inRect(p, uWin)) {
    vec4 inner = uWin + vec4(0.05, 0.05, -0.05, -0.05);
    float w = uWin.z - uWin.x;
    float cover = uCurtain * 0.5 * w;
    bool curtain = p.x < uWin.x + cover || p.x > uWin.z - cover;
    if (curtain) {
      float folds = 0.82 + 0.18 * sin(p.x * 70.0);
      albedo = vec3(0.62, 0.58, 0.5) * folds;
      emit = vec3(1.0, 0.98, 0.94) * uEa * 0.25 * (1.0 - uCurtain * 0.6);
    } else if (inRect(p, inner)) {
      albedo = vec3(0.0);
      float sky = mix(1.0, 0.7, (p.y - inner.y) / (inner.w - inner.y));
      float bar = step(abs(p.x - (inner.x + inner.z) * 0.5), 0.02);
      emit = mix(vec3(0.85, 0.93, 1.0) * uEa * 3.2 * sky, vec3(uEa * 0.5), bar);
    } else {
      albedo = vec3(0.8);
    }
    return;
  }
  // ceiling
  if (p.y < uCeil) {
    albedo = vec3(0.84, 0.84, 0.83);
    return;
  }
  // cable trunking
  if (p.y > uTrunk && p.y < uTrunk + 0.06) {
    float t = (p.y - uTrunk) / 0.06;
    albedo = vec3(0.9) * (0.85 + 0.15 * smoothstep(0.0, 0.3, t) - 0.1 * smoothstep(0.7, 1.0, t));
    return;
  }
  float n = vnoise(p * 60.0) * 0.5 + vnoise(p * 210.0) * 0.5;
  albedo = vec3(0.8, 0.795, 0.78) * (0.975 + 0.05 * n);
}

vec3 shade(vec2 p) {
  vec3 albedo, emit;
  float spec;
  surface(p, albedo, spec, emit);
  // ambient: slightly darker towards the ceiling corner, brighter near the window
  float amb = 1.0;
  if (uRoom > 0.0) {
    amb *= 0.9 + 0.1 * smoothstep(uCeil - 0.2, uCeil + 0.8, p.y);
    float dw = abs(p.x - (uWin.x + uWin.z) * 0.5);
    amb *= 1.0 + 0.25 * (1.0 - uCurtain) * exp(-dw * 0.9);
  }
  float inside;
  vec2 uv;
  vec3 P = projected(p, inside, uv);
  vec3 L = albedo * (uEa * uAmbCol * amb + P) + emit;
  if (spec > 0.0 && inside > 0.0) {
    // glossy whiteboard hotspot: mirror image of the lens
    vec3 cc = uH * vec3(0.5, 0.5, 1.0);
    vec2 c = vec2(uWB.x + (uWB.z - uWB.x) * 0.3, cc.y / cc.z);
    float h = exp(-dot(p - c, p - c) / 0.09);
    L += P * 0.55 * h;
  }
  return L;
}

void main() {
  float ref = uGain * (uEpw + uEa) * 0.96;
  if (uMode == 1) {
    vec3 w = uH * vec3(vUv, 1.0);
    vec2 p = w.xy / w.z;
    vec3 L = shade(p) / ref / uAdapt;
    outColor = vec4(toSrgb(clamp(tonemap(L), 0.0, 1.0)), 1.0);
    return;
  }
  vec2 p = uCam.xy + (vUv - 0.5) * vec2(2.0 * uCam.z, 2.0 * uCam.z / uAspect);
  if (vUv.x < uSplit) {
    // "on your laptop": the original slide fitted into the screen rectangle
    vec2 hs = uScreen;
    float sa = hs.x / hs.y;
    vec2 half_ = sa > uSlideAspect ? vec2(hs.y * uSlideAspect, hs.y) : vec2(hs.x, hs.x / uSlideAspect);
    vec2 uv = (p + half_) / (2.0 * half_);
    vec3 c = uStage;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) c = texture(uOrig, uv).rgb;
    outColor = vec4(c, 1.0);
    return;
  }
  vec3 L = shade(p) / ref / uAdapt;
  outColor = vec4(toSrgb(clamp(tonemap(L), 0.0, 1.0)), 1.0);
}`;
