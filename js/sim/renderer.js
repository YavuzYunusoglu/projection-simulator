// WebGL2 renderer for the projection simulation.
import { VERT, BLUR, SCENE, RESAMPLE } from './shaders.js';

const toColMajor = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

export class SimRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    this.canvas = canvas;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    this.blurProg = program(gl, BLUR);
    this.sceneProg = program(gl, SCENE);
    this.resampleProg = program(gl, RESAMPLE);
    this.panel = null;      // slide resampled to the projector's panel
    this.work = [1, 1];     // size the blur and the scene work at
    this.pixelate = 0;
    this.blurKey = '';
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.orig = null;
    this.size = [1, 1];
    this.sigma = -1;
    this.blurA = null;
    this.blurB = null;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.ambTex = null;
    this.projTex = null;
    this.origTex = null;
  }

  _tex(w, h, internal, format, type, mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _target(w, h, mip) {
    const gl = this.gl;
    const tex = this.float
      ? this._tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, mip)
      : this._tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, mip);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  _free(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  setSlide(source) {
    const gl = this.gl;
    const w = source.width, h = source.height;
    if (this.orig) gl.deleteTexture(this.orig);
    this.orig = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.orig);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.size = [w, h];
    this.sigma = -1;
    this.blurKey = '';
  }

  _upload(tex, source) {
    const gl = this.gl;
    if (tex) gl.deleteTexture(tex);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Layers of the real-room photo (or null to clear). */
  setPhotoRoom(room) {
    if (!room) {
      if (this.ambTex) this.gl.deleteTexture(this.ambTex);
      if (this.projTex) this.gl.deleteTexture(this.projTex);
      if (this.origTex) this.gl.deleteTexture(this.origTex);
      this.ambTex = this.projTex = this.origTex = null;
      return;
    }
    this.ambTex = this._upload(this.ambTex, room.amb);
    this.projTex = this._upload(this.projTex, room.proj);
    if (room.orig) this.origTex = this._upload(this.origTex, room.orig);
    else if (this.origTex) { this.gl.deleteTexture(this.origTex); this.origTex = null; }
  }

  _ensure(name, w, h, mip) {
    const t = this[name];
    if (t && t.w === w && t.h === h) return t;
    this._free(t);
    this[name] = this._target(w, h, mip);
    return this[name];
  }

  /**
   * Prepare the slide texture the scene samples: resampled to the projector's panel
   * (native = [w, h] pixels, if smaller than the slide), then blurred by sigma (slide pixels).
   */
  _blur(sigma, native) {
    if (!this.orig) return;
    const [w, h] = this.size;
    let nw = w, nh = h;
    if (native && native[0] > 8 && native[0] < w * 0.98) { nw = Math.round(native[0]); nh = Math.max(2, Math.round(native[0] * h / w)); }
    const key = `${nw}x${nh}|${Math.round(sigma * 30)}`;
    if (key === this.blurKey) return;
    this.blurKey = key;
    this.sigma = sigma;
    const gl = this.gl;
    const resampled = nw !== w;
    gl.bindVertexArray(this.vao);
    if (resampled) {
      const t = this._ensure('panel', nw, nh, false);
      const { p, u } = this.resampleProg;
      gl.useProgram(p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, nw, nh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.orig);
      gl.uniform1i(u.uTex, 0);
      gl.uniform2f(u.uSrc, w, h);
      gl.uniform2f(u.uDst, nw, nh);
      gl.uniform1i(u.uEncode, this.float ? 0 : 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const A = this._ensure('blurA', nw, nh, false);
    const B = this._ensure('blurB', nw, nh, true);
    const sig = sigma * (nw / w);
    const { p, u } = this.blurProg;
    gl.useProgram(p);
    gl.viewport(0, 0, nw, nh);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uSigma, sig);
    gl.uniform1i(u.uEncode, this.float ? 0 : 1);
    // horizontal: source -> A
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fb);
    gl.bindTexture(gl.TEXTURE_2D, resampled ? this.panel.tex : this.orig);
    gl.uniform2f(u.uDir, 1 / nw, 0);
    gl.uniform1i(u.uLinearize, resampled ? 0 : 1);
    gl.uniform1i(u.uDecode, resampled && !this.float ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // vertical: A -> B
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform2f(u.uDir, 0, 1 / nh);
    gl.uniform1i(u.uLinearize, 0);
    gl.uniform1i(u.uDecode, this.float ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, B.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.work = [nw, nh];
    this.pixelate = resampled ? 1 : 0;
  }

  _sceneUniforms(U, mode, aspect) {
    const gl = this.gl;
    const { p, u } = this.sceneProg;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurB ? this.blurB.tex : null);
    gl.uniform1i(u.uSlide, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.orig);
    gl.uniform1i(u.uOrig, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.ambTex);
    gl.uniform1i(u.uAmbTex, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.projTex);
    gl.uniform1i(u.uProjTex, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.origTex);
    gl.uniform1i(u.uOrigTex, 4);
    gl.uniform1i(u.uHasOrig, this.origTex ? 1 : 0);
    gl.uniform1f(u.uOpacity, U.photoOpacity ?? 1);
    gl.uniform1f(u.uOrigRef, U.origRef ?? 1);
    gl.uniform2f(u.uPhotoSize, U.photoSize ? U.photoSize[0] : 1, U.photoSize ? U.photoSize[1] : 1);
    gl.uniform1f(u.uKA, U.kA ?? 1);
    gl.uniform2f(u.uCenter, U.center ? U.center[0] : 0, U.center ? U.center[1] : 0);
    gl.uniform1f(u.uKP, U.kP ?? 1);
    gl.uniform1f(u.uPhotoRef, U.photoRef ?? 1);
    gl.uniform1i(u.uDecode, this.float ? 0 : 1);
    gl.uniform1i(u.uMode, mode === 0 && U.photoMode && this.ambTex ? 2 : mode);
    gl.uniform3f(u.uCam, U.cam[0], U.cam[1], U.cam[2]);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniformMatrix3fv(u.uHinv, false, toColMajor(U.Hinv));
    gl.uniformMatrix3fv(u.uH, false, toColMajor(U.H));
    gl.uniform2f(u.uScreen, U.screenW / 2, U.screenH / 2);
    gl.uniform1f(u.uSlideAspect, U.slideAspect);
    gl.uniform1f(u.uEpw, U.Epw);
    gl.uniform1f(u.uEpb, U.Epb);
    gl.uniform1f(u.uEa, U.Ea);
    gl.uniform1f(u.uGain, U.gain);
    gl.uniform1f(u.uWarm, U.warm);
    gl.uniform1f(u.uGamma, U.gamma);
    gl.uniform1f(u.uTime, U.time || 0);
    gl.uniform1f(u.uRoom, U.room);
    gl.uniform1f(u.uSplit, mode === 0 ? U.split : -1);
    gl.uniform1f(u.uCurtain, U.curtain);
    gl.uniform3fv(u.uAmbCol, U.ambCol);
    gl.uniformMatrix3fv(u.uProj, false, toColMajor(U.proj));
    gl.uniform4fv(u.uWB, U.wb);
    gl.uniform4fv(u.uWin, U.win);
    gl.uniform1f(u.uCeil, U.ceil);
    gl.uniform1f(u.uTrunk, U.trunk);
    gl.uniform1f(u.uFloor, U.floor ?? 100);
    gl.uniform4fv(u.uDesk, U.desk || [1e4, 1e4, 1e4 + 1, 1e4 + 1]);
    gl.uniform3fv(u.uWall, U.wallAlb || [0.8, 0.795, 0.78]);
    gl.uniform1i(u.uSurface, U.surface || 0);
    gl.uniform3fv(u.uStage, U.stage);
    gl.uniform3fv(u.uAdapt, U.adapt || [1, 1, 1]);
    gl.uniform1f(u.uFlareK, U.flareK ?? 0);
    gl.uniform1f(u.uFalloff, U.falloff ?? 0.2);
    const md = Math.max(this.work[0], this.work[1]);
    gl.uniform1f(u.uLodLocal, Math.max(0, Math.log2(md / 24)));
    gl.uniform1f(u.uLodGlobal, Math.ceil(Math.log2(md)) + 1);
    gl.uniform2f(u.uTexel, this.work[0], this.work[1]);
    gl.uniform1i(u.uPixelate, this.pixelate);
    gl.uniform3f(u.uLens, 0, 0, 0);
  }

  render(U) {
    if (!this.orig) return;
    const gl = this.gl;
    this._blur(U.sigma, U.native);
    const w = this.canvas.width, h = this.canvas.height;
    this._sceneUniforms(U, 0, w / h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const L = U.lens;
    if (L && L.r > 0 && !(U.split >= 0)) {
      // magnifier: the same scene, zoomed around the cursor, inside a circle
      const u0 = L.x / w, v0 = L.y / h;
      const z = U.cam[2], zz = z / L.zoom;
      const px = U.cam[0] + (u0 - 0.5) * 2 * z, py = U.cam[1] + (v0 - 0.5) * 2 * z / (w / h);
      const cam = [px - (u0 - 0.5) * 2 * zz, py - (v0 - 0.5) * 2 * zz / (w / h), zz];
      gl.uniform3f(this.sceneProg.u.uCam, cam[0], cam[1], cam[2]);
      gl.uniform3f(this.sceneProg.u.uLens, L.x, h - L.y, L.r);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** Render the simulation in slide coordinates and read it back (rows top-to-bottom, RGBA). */
  readSlideSpace(U, w, h) {
    if (!this.orig) return null;
    const gl = this.gl;
    this._blur(U.sigma, U.native);
    const tex = this._tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, false);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this._sceneUniforms(U, 1, w / h);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // flip rows: GL row 0 is the bottom of the slide
    const out = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}
