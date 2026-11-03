/* AXON — GPU-облако частиц + жидкость от курсора (three.js r150, UMD) */
(function () {
  'use strict';
  if (!window.THREE) { console.warn('three.js не загрузился'); return; }

  const canvas = document.getElementById('bg');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { console.warn('WebGL недоступен', e); return; }

  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = true;

  const gl = renderer.getContext();
  const caps = renderer.capabilities;
  const ext = renderer.extensions;
  const isMobile = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;

  /* ---------- Возможности: float / half-float рендер-таргеты ---------- */
  let floatRT, halfRT, halfLinear;
  if (caps.isWebGL2) {
    floatRT = ext.has('EXT_color_buffer_float');
    halfRT = floatRT || ext.has('EXT_color_buffer_half_float');
    halfLinear = true;
  } else {
    floatRT = ext.has('OES_texture_float') && ext.has('WEBGL_color_buffer_float');
    halfRT = ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float');
    halfLinear = ext.has('OES_texture_half_float_linear');
  }
  if (!floatRT && !halfRT) { console.warn('Нет float/half-float рендер-таргетов — фон отключён'); return; }
  const SIM_TYPE = floatRT ? THREE.FloatType : THREE.HalfFloatType;
  const FLUID_TYPE = halfRT ? THREE.HalfFloatType : THREE.FloatType;
  const FLUID_FILTER = (FLUID_TYPE === THREE.HalfFloatType ? halfLinear : ext.has('OES_texture_float_linear')) ? THREE.LinearFilter : THREE.NearestFilter;

  // 512×512 = 262 144 точек на десктопе, 128×128 = 16 384 на мобильных; на half-float — меньше
  let SIZE = isMobile ? 128 : 512;
  if (!floatRT) SIZE = Math.min(SIZE, 256);
  const COUNT = SIZE * SIZE;

  /* ---------- Сцена и камера ---------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 1000);
  const camBase = new THREE.Vector3(-1.17, 0, 6);
  const lookAtT = new THREE.Vector3();
  camera.position.copy(camBase);
  camera.lookAt(lookAtT);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const group = new THREE.Group();
  group.position.set(0.343, 0.16, -1);
  const d2r = THREE.MathUtils.degToRad;
  group.rotation.set(d2r(-28.4), d2r(390), d2r(4.92));
  group.scale.set(5, 5, 6);
  scene.add(group);

  /* ---------- Полноэкранный проход ---------- */
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  quadScene.add(quad);
  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  const quadVert = /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  /* ================= ЖИДКОСТЬ ================= */
  const SIM_RES = 256, DYE_RES = 512;
  const FL = { velDiss: 0.98, denDiss: 0.97, presDiss: 0.95, presIter: 5, curl: 30, dt: 1 / 60 };

  function rt(w, h, type, filter) {
    return new THREE.WebGLRenderTarget(w, h, {
      type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
  }
  function double(w, h, type, filter) {
    const o = { read: rt(w, h, type, filter), write: rt(w, h, type, filter),
      swap() { const t = this.read; this.read = this.write; this.write = t; } };
    return o;
  }
  const velocity = double(SIM_RES, SIM_RES, FLUID_TYPE, FLUID_FILTER);
  const density = double(DYE_RES, DYE_RES, FLUID_TYPE, FLUID_FILTER);
  const pressure = double(SIM_RES, SIM_RES, FLUID_TYPE, THREE.NearestFilter);
  const divergenceRT = rt(SIM_RES, SIM_RES, FLUID_TYPE, THREE.NearestFilter);
  const curlRT = rt(SIM_RES, SIM_RES, FLUID_TYPE, THREE.NearestFilter);
  const simTexel = new THREE.Vector2(1 / SIM_RES, 1 / SIM_RES);

  const nbVert = /* glsl */`
    uniform vec2 texelSize;
    varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      vUv = uv;
      vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`;
  const mat = (frag, uniforms, vert) => new THREE.ShaderMaterial({
    vertexShader: vert || nbVert, fragmentShader: frag, uniforms,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });

  const splatMat = mat(/* glsl */`
    uniform sampler2D uTarget; uniform float aspect; uniform vec3 color;
    uniform vec2 p0; uniform vec2 p1; uniform float radius;
    varying vec2 vUv;
    void main(){
      vec2 a = vec2(p0.x * aspect, p0.y), b = vec2(p1.x * aspect, p1.y), p = vec2(vUv.x * aspect, vUv.y);
      vec2 ab = b - a; float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      vec2 d = p - (a + ab * t);
      float s = exp(-dot(d, d) / max(radius * radius, 1e-6));
      gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + s * color, 1.0);
    }`, { uTarget: { value: null }, aspect: { value: 1 }, color: { value: new THREE.Vector3() },
          p0: { value: new THREE.Vector2() }, p1: { value: new THREE.Vector2() }, radius: { value: 0.1 },
          texelSize: { value: simTexel } });

  const curlMat = mat(/* glsl */`
    uniform sampler2D uVelocity; varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      float L = texture2D(uVelocity, vL).y, R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x, B = texture2D(uVelocity, vB).x;
      gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
    }`, { uVelocity: { value: null }, texelSize: { value: simTexel } });

  const vortMat = mat(/* glsl */`
    uniform sampler2D uVelocity, uCurl; uniform float curl, dt; varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      float L = texture2D(uCurl, vL).x, R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x, B = texture2D(uCurl, vB).x, C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
      vec2 v = texture2D(uVelocity, vUv).xy + force * dt;
      v = clamp(v, -1000.0, 1000.0);
      gl_FragColor = vec4(v, 0.0, 1.0);
    }`, { uVelocity: { value: null }, uCurl: { value: null }, curl: { value: FL.curl }, dt: { value: FL.dt }, texelSize: { value: simTexel } });

  const divMat = mat(/* glsl */`
    uniform sampler2D uVelocity; varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      float L = texture2D(uVelocity, vL).x, R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y, B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x;
      if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
      gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
    }`, { uVelocity: { value: null }, texelSize: { value: simTexel } });

  const clearMat = mat(/* glsl */`
    uniform sampler2D uTexture; uniform float value; varying vec2 vUv;
    void main(){ gl_FragColor = value * texture2D(uTexture, vUv); }`,
    { uTexture: { value: null }, value: { value: FL.presDiss }, texelSize: { value: simTexel } });

  const presMat = mat(/* glsl */`
    uniform sampler2D uPressure, uDivergence; varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      float div = texture2D(uDivergence, vUv).x;
      gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
    }`, { uPressure: { value: null }, uDivergence: { value: null }, texelSize: { value: simTexel } });

  const gradMat = mat(/* glsl */`
    uniform sampler2D uPressure, uVelocity; varying vec2 vUv, vL, vR, vT, vB;
    void main(){
      float L = texture2D(uPressure, vL).x, R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x, B = texture2D(uPressure, vB).x;
      vec2 v = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
      gl_FragColor = vec4(v, 0.0, 1.0);
    }`, { uPressure: { value: null }, uVelocity: { value: null }, texelSize: { value: simTexel } });

  const advMat = mat(/* glsl */`
    uniform sampler2D uVelocity, uSource; uniform vec2 velTexel; uniform float dt, dissipation, maxV;
    varying vec2 vUv;
    void main(){
      vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * velTexel;
      vec4 r = dissipation * texture2D(uSource, coord);
      gl_FragColor = clamp(r, -maxV, maxV);
    }`, { uVelocity: { value: null }, uSource: { value: null }, velTexel: { value: simTexel },
          dt: { value: FL.dt }, dissipation: { value: 1 }, maxV: { value: 1000 }, texelSize: { value: simTexel } });

  function splat(p0, p1, color, radiusUV) {
    const aspect = window.innerWidth / window.innerHeight;
    splatMat.uniforms.aspect.value = aspect;
    splatMat.uniforms.p0.value.copy(p0);
    splatMat.uniforms.p1.value.copy(p1);
    splatMat.uniforms.radius.value = radiusUV;
    splatMat.uniforms.uTarget.value = velocity.read.texture;
    splatMat.uniforms.color.value.copy(color);
    pass(splatMat, velocity.write); velocity.swap();
    splatMat.uniforms.uTarget.value = density.read.texture;
    splatMat.uniforms.color.value.set(1, 1, 1);
    pass(splatMat, density.write); density.swap();
  }

  function stepFluid() {
    curlMat.uniforms.uVelocity.value = velocity.read.texture; pass(curlMat, curlRT);
    vortMat.uniforms.uVelocity.value = velocity.read.texture; vortMat.uniforms.uCurl.value = curlRT.texture;
    pass(vortMat, velocity.write); velocity.swap();
    divMat.uniforms.uVelocity.value = velocity.read.texture; pass(divMat, divergenceRT);
    clearMat.uniforms.uTexture.value = pressure.read.texture; pass(clearMat, pressure.write); pressure.swap();
    presMat.uniforms.uDivergence.value = divergenceRT.texture;
    for (let i = 0; i < FL.presIter; i++) {
      presMat.uniforms.uPressure.value = pressure.read.texture; pass(presMat, pressure.write); pressure.swap();
    }
    gradMat.uniforms.uPressure.value = pressure.read.texture; gradMat.uniforms.uVelocity.value = velocity.read.texture;
    pass(gradMat, velocity.write); velocity.swap();
    advMat.uniforms.uVelocity.value = velocity.read.texture; advMat.uniforms.uSource.value = velocity.read.texture;
    advMat.uniforms.dissipation.value = FL.velDiss; advMat.uniforms.maxV.value = 1000;
    pass(advMat, velocity.write); velocity.swap();
    advMat.uniforms.uVelocity.value = velocity.read.texture; advMat.uniforms.uSource.value = density.read.texture;
    advMat.uniforms.dissipation.value = FL.denDiss; advMat.uniforms.maxV.value = 4;
    pass(advMat, density.write); density.swap();
  }

  /* Маска плотности в размер вьюпорта: alpha = max(r,g,b) */
  let maskRT = rt(Math.max(1, Math.floor(window.innerWidth / 2)), Math.max(1, Math.floor(window.innerHeight / 2)), FLUID_TYPE, FLUID_FILTER);
  const maskMat = mat(/* glsl */`
    uniform sampler2D uTexture; varying vec2 vUv;
    void main(){ vec3 c = texture2D(uTexture, vUv).rgb; gl_FragColor = vec4(c, max(c.r, max(c.g, c.b))); }`,
    { uTexture: { value: null } }, quadVert);

  /* ================= СИМУЛЯЦИЯ ЧАСТИЦ ================= */
  const originData = new Float32Array(COUNT * 4);
  const randomData = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    originData[i * 4 + 0] = Math.random() * 2 - 1;
    originData[i * 4 + 1] = Math.random() * 2 - 1;
    originData[i * 4 + 2] = Math.random() * 2 - 1;
    originData[i * 4 + 3] = 1;
    randomData[i * 4 + 0] = Math.random(); randomData[i * 4 + 1] = Math.random();
    randomData[i * 4 + 2] = Math.random(); randomData[i * 4 + 3] = Math.random();
  }
  function dataTex(data) {
    const t = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
  }
  const originTex = dataTex(originData);
  const randomTex = dataTex(randomData);
  const posA = rt(SIZE, SIZE, SIM_TYPE, THREE.NearestFilter);
  const posB = rt(SIZE, SIZE, SIM_TYPE, THREE.NearestFilter);
  const pos = { read: posA, write: posB, swap() { const t = this.read; this.read = this.write; this.write = t; } };

  const copyMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: `uniform sampler2D uTexture; varying vec2 vUv; void main(){ gl_FragColor = texture2D(uTexture, vUv); }`,
    uniforms: { uTexture: { value: originTex } }, depthTest: false, depthWrite: false,
  });
  pass(copyMat, pos.read);

  const SHAPE_GLSL = /* glsl */`
    // Гладкое скрученное кольцо с одним большим отверстием и мягкими «лепестками»
    vec3 qrot(vec4 q, vec3 v){ return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
    float shapeRaw(vec3 p);
    float sdfShape(vec3 p){
      if (length(p) > 0.8) return length(p) - 0.7;
      const float K = 0.54;            // общий масштаб формы (~0.7 ед. в поперечнике)
      return shapeRaw(p / K) * K;
    }
    float shapeRaw(vec3 p){
      p.z = sqrt(p.z * p.z + 0.0215) - sqrt(0.012);
      p = qrot(vec4(0.5, 0.5, 0.5, 0.5), p);
      float a = atan(p.z, p.x);
      // изгиб кольца (седло) и смещение центра — «одно большое отверстие»
      p.y -= 0.07 * sin(2.0 * a + 0.6);
      float R = 0.30 + 0.035 * sin(a + 1.2);
      vec2 q = vec2(length(p.xz) - R, p.y);
      // скрутка сечения вдоль кольца
      float tw = 1.5 * a + 0.4 * sin(3.0 * a);
      float c = cos(tw), s = sin(tw);
      q = mat2(c, -s, s, c) * q;
      // мягкие лепестки: переменная толщина
      float r = 0.115 + 0.04 * sin(3.0 * a + 0.8) + 0.02 * sin(5.0 * a - 1.3);
      return (length(q * vec2(1.0, 1.55)) - r) * 0.75;
    }
    vec3 sdfNormal(vec3 p){
      const float e = 0.001;
      vec3 n = vec3(
        sdfShape(p + vec3(e,0,0)) - sdfShape(p - vec3(e,0,0)),
        sdfShape(p + vec3(0,e,0)) - sdfShape(p - vec3(0,e,0)),
        sdfShape(p + vec3(0,0,e)) - sdfShape(p - vec3(0,0,e)));
      return normalize(n + 1e-9);
    }`;

  const CURL_GLSL = /* glsl */`
    // Аналитический curl трёх синус-потенциалов (в духе Bridson), нормированный
    vec3 potential(vec3 p){
      return vec3(
        sin(p.y * 1.7 + 1.3) + sin(p.z * 2.3 + 0.7) * 0.6 + sin((p.y + p.z) * 3.1) * 0.3,
        sin(p.z * 1.9 + 2.1) + sin(p.x * 2.7 + 0.2) * 0.6 + sin((p.z + p.x) * 2.9) * 0.3,
        sin(p.x * 2.1 + 0.4) + sin(p.y * 1.5 + 1.9) * 0.6 + sin((p.x + p.y) * 3.3) * 0.3);
    }
    vec3 curlNoise(vec3 p){
      const float e = 0.01;
      vec3 dx = vec3(e,0,0), dy = vec3(0,e,0), dz = vec3(0,0,e);
      vec3 px0 = potential(p - dx), px1 = potential(p + dx);
      vec3 py0 = potential(p - dy), py1 = potential(p + dy);
      vec3 pz0 = potential(p - dz), pz1 = potential(p + dz);
      vec3 c = vec3((py1.z - py0.z) - (pz1.y - pz0.y),
                    (pz1.x - pz0.x) - (px1.z - px0.z),
                    (px1.y - px0.y) - (py1.x - py0.x)) / (2.0 * e);
      return normalize(c + 1e-6);
    }`;

  /* «Дом» каждой частицы — проекция её origin на поверхность формы.
     Слабая пружина к дому лечит форму после сильного перемешивания курсором. */
  const homeA = rt(SIZE, SIZE, SIM_TYPE, THREE.NearestFilter);
  const homeB = rt(SIZE, SIZE, SIM_TYPE, THREE.NearestFilter);
  const projMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: /* glsl */`
      uniform sampler2D uTexture; varying vec2 vUv;
      ${SHAPE_GLSL}
      void main(){
        vec3 p = texture2D(uTexture, vUv).xyz;
        p -= sdfNormal(p) * sdfShape(p);
        gl_FragColor = vec4(p, 1.0);
      }`,
    uniforms: { uTexture: { value: null } }, depthTest: false, depthWrite: false,
  });
  copyMat.uniforms.uTexture.value = originTex; pass(copyMat, homeA);
  { let r = homeA, w = homeB;
    for (let i = 0; i < 48; i++) { projMat.uniforms.uTexture.value = r.texture; pass(projMat, w); const t = r; r = w; w = t; }
    var homeRT = r; }

  const simMat = new THREE.ShaderMaterial({
    vertexShader: quadVert,
    fragmentShader: /* glsl */`
      uniform sampler2D tPos, tOrigin, tRandom, tFluidVel, tFluidDen, tHome;
      uniform float uHeal;
      uniform float uMaxPush;
      uniform float time, HZ, uCurlNoiseScale, uCurlTimeScale, uCurlNoiseSpeed, uMouseStrength;
      uniform mat4 uProj, uModel; uniform mat3 uNormal;
      varying vec2 vUv;
      ${SHAPE_GLSL}
      ${CURL_GLSL}
      void main(){
        vec3 pos = texture2D(tPos, vUv).xyz;
        vec3 origin = texture2D(tOrigin, vUv).xyz;
        if (length(pos) > 0.7) pos /= 2.0;
        pos += curlNoise(pos * 0.1 * uCurlNoiseScale + time * 0.1 * uCurlTimeScale) * uCurlNoiseSpeed * 0.0002 * HZ;
        vec3 gradient = sdfNormal(pos);
        float sdf = sdfShape(pos);
        pos += cross(normalize(pos + 1e-6), gradient) * 0.0005;
        pos += -gradient * sdf * 0.5;
        pos += (origin - pos) * 0.0002 * HZ;
        pos += (texture2D(tHome, vUv).xyz - pos) * min(uHeal * HZ, 0.5);
        // жидкость от курсора
        vec4 clip = uProj * uModel * vec4(pos, 1.0);
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
          vec3 flow = uNormal * vec3(texture2D(tFluidVel, suv).xy, 0.0);
          float den = min(texture2D(tFluidDen, suv).a, 1.5);
          vec3 push = flow * 0.0001 * HZ * uMouseStrength * den;
          float pl = length(push);
          if (pl > uMaxPush * HZ) push *= uMaxPush * HZ / pl;   // ограничение, чтобы форма не «схлопывалась»
          pos += push;
        }
        gl_FragColor = vec4(pos, 1.0);
      }`,
    uniforms: {
      tPos: { value: null }, tOrigin: { value: originTex }, tRandom: { value: randomTex },
      tFluidVel: { value: null }, tFluidDen: { value: null },
      time: { value: 0 }, HZ: { value: 1 },
      uCurlNoiseScale: { value: 1 }, uCurlTimeScale: { value: 0.5 }, uCurlNoiseSpeed: { value: 1 },
      uMouseStrength: { value: 0.4 }, uMaxPush: { value: 0.004 }, tHome: { value: homeRT.texture }, uHeal: { value: 0.035 },
      uProj: { value: new THREE.Matrix4() }, uModel: { value: new THREE.Matrix4() }, uNormal: { value: new THREE.Matrix3() },
    },
    depthTest: false, depthWrite: false,
  });

  /* ================= MATCAP (генерируется в коде → data URI) ================= */
  function makeMatcap() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 64, 64);
    const g = x.createRadialGradient(24, 22, 2, 32, 32, 32);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.25, '#d9d9d9'); g.addColorStop(0.6, '#8c8c8c');
    g.addColorStop(0.9, '#3a3a3a'); g.addColorStop(1, '#202020');
    x.fillStyle = g; x.beginPath(); x.arc(32, 32, 32, 0, Math.PI * 2); x.fill();
    const rim = x.createRadialGradient(32, 32, 24, 32, 32, 32);
    rim.addColorStop(0, 'rgba(255,255,255,0)'); rim.addColorStop(1, 'rgba(255,255,255,0.25)');
    x.fillStyle = rim; x.beginPath(); x.arc(32, 32, 32, 0, Math.PI * 2); x.fill();
    return c.toDataURL('image/png');
  }
  const matcapTex = new THREE.TextureLoader().load(makeMatcap());

  /* ================= ТОЧКИ ================= */
  const geo = new THREE.BufferGeometry();
  const uvs = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    uvs[i * 3] = ((i % SIZE) + 0.5) / SIZE;
    uvs[i * 3 + 1] = (Math.floor(i / SIZE) + 0.5) / SIZE;
    uvs[i * 3 + 2] = 0;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(uvs, 3));
  geo.setAttribute('random', new THREE.BufferAttribute(randomData, 4));

  const pointsMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      uniform sampler2D tPos; uniform float DPR;
      attribute vec4 random;
      varying vec4 vRandom; varying float vScale;
      void main(){
        vec3 pos = texture2D(tPos, position.xy).xyz;
        pos *= mix(1.0, 1.5, pow(random.y, 150.0));
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        float dist = length(mv.xyz);
        float scale = smoothstep(3.0, 15.0, dist) * mix(0.5, 1.0, random.z);
        vScale = scale; vRandom = random;
        gl_PointSize = 0.04 * DPR * 2.0 * scale * (1000.0 / dist);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D tMatcap; uniform float time;
      varying vec4 vRandom; varying float vScale;
      vec3 softLight(vec3 a, vec3 b){
        return mix(2.0*a*b + a*a*(1.0-2.0*b), sqrt(a)*(2.0*b-1.0) + 2.0*a*(1.0-b), step(0.5, b));
      }
      vec3 overlayB(vec3 a, vec3 b){
        return mix(2.0*a*b, 1.0 - 2.0*(1.0-a)*(1.0-b), step(0.5, a));
      }
      void main(){
        vec2 uv = gl_PointCoord - 0.5;
        if (length(uv) > 0.5) discard;
        if (vScale < 0.1) discard;
        vec3 col = vec3(mix(0.0, 0.2, vRandom.x));
        col = mix(col, vec3(0.6, 0.45, 1.0), pow(vRandom.z, 100.0));
        col *= 0.5 + (0.4 + sin(time * 4.0 + vRandom.y * 20.0)) * pow(vRandom.z, 10.0) * 2.5;
        float ang = sin(time + vRandom.z * 20.0) * 0.5 + 1.0;
        float c = cos(ang), s = sin(ang);
        vec2 ruv = mat2(c, -s, s, c) * uv + 0.5;
        vec3 mc = texture2D(tMatcap, ruv).rgb;
        col = clamp(col, 0.0, 1.0);
        col = mix(col, softLight(col, mc), 0.8);
        col = mix(col, overlayB(col, mc), 0.2);
        gl_FragColor = vec4(col, 1.0);
      }`,
    uniforms: { tPos: { value: null }, DPR: { value: DPR }, tMatcap: { value: matcapTex }, time: { value: 0 } },
    transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, pointsMat);
  points.frustumCulled = false;
  group.add(points);

  /* ================= ВВОД ================= */
  const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2, px: null, py: null, lastSplat: 0, moved: false };
  function setPointer(x, y) { mouse.x = x; mouse.y = y; mouse.moved = true; }
  window.addEventListener('mousemove', e => setPointer(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchstart', e => { const t = e.touches[0]; if (t) { mouse.px = null; setPointer(t.clientX, t.clientY); } }, { passive: true });
  window.addEventListener('touchmove', e => { const t = e.touches[0]; if (t) setPointer(t.clientX, t.clientY); }, { passive: true });

  const map = (v, a, b, c, d) => c + (d - c) * Math.min(1, Math.max(0, (v - a) / (b - a)));
  const v0 = new THREE.Vector2(), v1 = new THREE.Vector2(), col3 = new THREE.Vector3();

  function handleMouse(now) {
    if (mouse.px === null) { mouse.px = mouse.x; mouse.py = mouse.y; return; }
    const dx = mouse.x - mouse.px, dy = mouse.y - mouse.py;
    const len = Math.hypot(dx, dy);
    if (len > 0.01) {
      const radius = map(len, 0, 5, 0, 60) * 0.6 * (isMobile ? 0.8 : 1);
      const mult = map(len, 0, 15, 0, 10);
      const W = window.innerWidth, H = window.innerHeight;
      const startX = (now - mouse.lastSplat > 50) ? mouse.x : mouse.px;
      const startY = (now - mouse.lastSplat > 50) ? mouse.y : mouse.py;
      v0.set(startX / W, 1 - startY / H);
      v1.set(mouse.x / W, 1 - mouse.y / H);
      col3.set(dx * mult, -dy * mult, 1);
      splat(v0, v1, col3, radius / 200);
      mouse.lastSplat = now;
    }
    mouse.px = mouse.x; mouse.py = mouse.y;
  }

  /* ================= РЕСАЙЗ ================= */
  function onResize() {
    const W = window.innerWidth, H = window.innerHeight;
    renderer.setSize(W, H);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    maskRT.setSize(Math.max(1, Math.floor(W / 2)), Math.max(1, Math.floor(H / 2)));
    fitRing();
  }
  window.addEventListener('resize', onResize);

  /* ---------- Вписываем кольцо в свободную зону экрана ----------
     Берём выборку «домашних» точек формы, проецируем их базовой камерой и
     подбираем zoom + смещение кадра (setViewOffset), чтобы кольцо стояло
     между левой колонкой и текстом справа (на мобильных — над текстом). */
  const fitPts = [];
  (function sampleShape() {
    const n = 48;
    if (SIM_TYPE === THREE.FloatType) {
      try {
        const buf = new Float32Array(n * n * 4);
        renderer.readRenderTargetPixels(homeRT, 0, 0, n, n, buf);
        for (let i = 0; i < n * n; i++) {
          const x = buf[i * 4], y = buf[i * 4 + 1], z = buf[i * 4 + 2];
          if (isFinite(x + y + z)) fitPts.push(new THREE.Vector3(x, y, z));
        }
      } catch (e) { /* упадём на запасной вариант ниже */ }
    }
    if (fitPts.length < 100) {               // half-float: приблизительная сфера формы
      fitPts.length = 0;
      for (let i = 0; i < 400; i++) fitPts.push(new THREE.Vector3().randomDirection().multiplyScalar(0.3));
    }
  })();
  const tmpV = new THREE.Vector3();
  function targetRect(W, H) {
    const about = document.querySelector('.about');
    const left = document.querySelector('.tags');
    const ar = about ? about.getBoundingClientRect() : null;
    if (W > 760) {
      const l = (left ? left.getBoundingClientRect().right : 344) + 40;
      const r = (ar ? ar.left : W - 470) - 40;
      return { l, r, t: 56, b: H - 40 };
    }
    return { l: 12, r: W - 12, t: 84, b: (ar ? ar.top : H * 0.5) - 8 };
  }
  function fitRing() {
    const W = window.innerWidth, H = window.innerHeight;
    camera.clearViewOffset(); camera.zoom = 1;
    camera.position.copy(camBase); camera.lookAt(lookAtT);
    camera.aspect = W / H; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    group.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of fitPts) {
      tmpV.copy(p).applyMatrix4(group.matrixWorld).project(camera);
      const sx = (tmpV.x + 1) * 0.5 * W, sy = (1 - tmpV.y) * 0.5 * H;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    const R = targetRect(W, H);
    const rw = Math.max(120, R.r - R.l), rh = Math.max(120, R.b - R.t);
    // запас ~12% на «дыхание» облака и движение камеры за курсором
    const z = Math.min(1.4, Math.max(0.3, Math.min(rw / (x1 - x0), rh / (y1 - y0)) * 0.88));
    const cx = W / 2 + ((x0 + x1) / 2 - W / 2) * z, cy = H / 2 + ((y0 + y1) / 2 - H / 2) * z;
    const dx = (R.l + R.r) / 2 - cx, dy = (R.t + R.b) / 2 - cy;
    camera.zoom = z;
    camera.setViewOffset(W, H, -dx, -dy, W, H);
    camera.updateProjectionMatrix();
    fitInfo.zoom = z; fitInfo.rect = R;
  }
  const fitInfo = {};
  fitRing();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitRing);
  window.addEventListener('load', () => setTimeout(fitRing, 50));
  window.addEventListener('axon:layout', fitRing);

  /* ================= ЦИКЛ ================= */
  const clock = new THREE.Clock();
  let time = 0;
  const camTarget = new THREE.Vector3();
  const invCam = new THREE.Matrix4();

  function frame() {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    time += dt;
    const HZ = dt * 60;
    const now = performance.now();
    const W = window.innerWidth, H = window.innerHeight;

    // камера «следит» за курсором
    const mx = (mouse.x / W) * 2 - 1, my = (mouse.y / H) * 2 - 1;
    if (reduceMotion) camTarget.copy(camBase);
    else camTarget.set(camBase.x + mx * -1, camBase.y + my * 2, camBase.z);
    camera.position.lerp(camTarget, 0.05);
    camera.lookAt(lookAtT);
    camera.updateMatrixWorld();
    group.updateMatrixWorld();

    // жидкость
    if (!reduceMotion) handleMouse(now);
    stepFluid();
    maskMat.uniforms.uTexture.value = density.read.texture;
    pass(maskMat, maskRT);

    // частицы
    const u = simMat.uniforms;
    u.tPos.value = pos.read.texture;
    u.time.value = time; u.HZ.value = HZ;
    u.tFluidVel.value = velocity.read.texture;
    u.tFluidDen.value = maskRT.texture;
    invCam.copy(camera.matrixWorld).invert();
    u.uProj.value.multiplyMatrices(camera.projectionMatrix, invCam);
    u.uModel.value.copy(group.matrixWorld);
    u.uNormal.value.setFromMatrix4(camera.matrixWorld);
    pass(simMat, pos.write); pos.swap();

    pointsMat.uniforms.tPos.value = pos.read.texture;
    pointsMat.uniforms.time.value = time;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  window.__axon = { count: COUNT, simType: SIM_TYPE === THREE.FloatType ? 'float' : 'half', fluidFilter: FLUID_FILTER === THREE.LinearFilter ? 'linear' : 'nearest', webgl2: caps.isWebGL2, fit: fitInfo, reduceMotion };
  requestAnimationFrame(frame);
})();
