// WebGL2 renderer for the projection simulation.
import { VERT, BLUR, SCENE } from './shaders.js';

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
    if (!this.blurA || this.size[0] !== w || this.size[1] !== h) {
      this._free(this.blurA);
      this._free(this.blurB);
      this.blurA = this._target(w, h, false);
      this.blurB = this._target(w, h, true);
    }
    this.size = [w, h];
    this.sigma = -1;
  }

  _blur(sigma) {
    if (!this.orig) return;
    if (Math.abs(sigma - this.sigma) < 0.03) return;
    this.sigma = sigma;
    const gl = this.gl;
    const { p, u } = this.blurProg;
    const [w, h] = this.size;
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.uSigma, sigma);
    gl.uniform1i(u.uEncode, this.float ? 0 : 1);
    // horizontal: orig -> A
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fb);
    gl.bindTexture(gl.TEXTURE_2D, this.orig);
    gl.uniform2f(u.uDir, 1 / w, 0);
    gl.uniform1i(u.uLinearize, 1);
    gl.uniform1i(u.uDecode, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // vertical: A -> B
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fb);
    gl.bindTexture(gl.TEXTURE_2D, this.blurA.tex);
    gl.uniform2f(u.uDir, 0, 1 / h);
    gl.uniform1i(u.uLinearize, 0);
    gl.uniform1i(u.uDecode, this.float ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.blurB.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
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
    gl.uniform1i(u.uDecode, this.float ? 0 : 1);
    gl.uniform1i(u.uMode, mode);
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
    gl.uniform3fv(u.uStage, U.stage);
    gl.uniform3fv(u.uAdapt, U.adapt || [1, 1, 1]);
  }

  render(U) {
    if (!this.orig) return;
    const gl = this.gl;
    this._blur(U.sigma);
    const w = this.canvas.width, h = this.canvas.height;
    this._sceneUniforms(U, 0, w / h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Render the simulation in slide coordinates and read it back (rows top-to-bottom, RGBA). */
  readSlideSpace(U, w, h) {
    if (!this.orig) return null;
    const gl = this.gl;
    this._blur(U.sigma);
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
