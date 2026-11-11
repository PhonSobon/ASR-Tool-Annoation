"use client";
// The 3D scene of the home page and the sign-in pages (three.js, WebGL), lit like a product shot: speech becomes data.
//   - a glossy waveform ribbon (a surface that moves like a voice) on the left,
//   - glowing data cubes (the annotated clips) flying out of it along a curve,
//   - into a stack of dataset discs on the right, whose top ring lights up when a cube lands,
//   - a field of small stars behind for depth.
// It follows the mouse, takes its colors from the theme (--primary / --violet, re-read when the theme changes), runs
// only while the tab is shown and the canvas is on screen, draws one still frame for "reduce motion", and draws nothing
// without WebGL (the CSS background stays).
// shift: where the scene sits, as a fraction of the canvas from its center ({x: .2} = to the right, {y: .15} = up);
// shiftNarrow is used instead when the canvas is narrower than 900px.
import { useEffect, useRef } from "react";
import * as THREE from "three";

interface Shift { x?: number; y?: number }
const SEG_X = 160, SEG_Z = 10, CUBES = 22, DISCS = 4, STARS = 420;

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    dark: document.documentElement.dataset.theme === "dark",
    a: new THREE.Color(css.getPropertyValue("--primary").trim() || "#2563eb"),
    b: new THREE.Color(css.getPropertyValue("--violet").trim() || "#1e3a8a"),
  };
}

/** speech-like amplitude: words (bursts) with pauses between them, moving along */
function voice(x: number, t: number) {
  const env = Math.max(0, Math.sin(x * 0.9 - t * 1.2)) ** 1.5 * 0.8 + 0.2 * Math.max(0, Math.sin(x * 2.3 + t * 0.7));
  return env * (Math.sin(x * 7 + t * 6) * 0.6 + Math.sin(x * 13 - t * 9) * 0.4);
}

export function AuthScene({ className = "", shift = {}, shiftNarrow }: { className?: string; shift?: Shift; shiftNarrow?: Shift }) {
  const host = useRef<HTMLDivElement>(null);
  const shifts = useRef({ wide: shift, narrow: shiftNarrow ?? shift });
  shifts.current = { wide: shift, narrow: shiftNarrow ?? shift };

  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch { return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    const world = new THREE.Group();
    scene.add(world);

    // lights: a soft fill, a white key light and two colored rims
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 6, 7);
    const rimA = new THREE.PointLight(0xffffff, 40, 0, 2);
    rimA.position.set(-4, 2.5, 3);
    const rimB = new THREE.PointLight(0xffffff, 40, 0, 2);
    rimB.position.set(4.5, 1.5, 3);
    scene.add(ambient, key, rimA, rimB);

    // the waveform ribbon
    const ribbonGeo = new THREE.PlaneGeometry(6.4, 1.5, SEG_X, SEG_Z);
    ribbonGeo.rotateX(-Math.PI / 2.6);
    const rBase = Float32Array.from(ribbonGeo.attributes.position.array as Float32Array);
    const rColors = new Float32Array(rBase.length);
    ribbonGeo.setAttribute("color", new THREE.BufferAttribute(rColors, 3));
    const ribbonMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.28, side: THREE.DoubleSide });
    const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
    ribbon.position.set(-1.9, 0.1, 0);
    world.add(ribbon);
    const glowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
    const glow = new THREE.Mesh(ribbonGeo, glowMat);
    glow.position.copy(ribbon.position);
    glow.scale.set(1.01, 1.25, 1.01);
    world.add(glow);

    // the dataset stack
    const stack = new THREE.Group();
    stack.position.set(3.35, -1.05, 0);
    world.add(stack);
    const discGeo = new THREE.CylinderGeometry(0.95, 0.95, 0.24, 72);
    const ringGeo = new THREE.TorusGeometry(0.97, 0.025, 12, 96);
    const discMats: THREE.MeshStandardMaterial[] = [], ringMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < DISCS; i++) {
      const dm = new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.22, transparent: true, opacity: 0.92 });
      const disc = new THREE.Mesh(discGeo, dm);
      disc.position.y = i * 0.34;
      const rm = new THREE.MeshBasicMaterial({ transparent: true });
      const ring = new THREE.Mesh(ringGeo, rm);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = i * 0.34 + 0.12;
      stack.add(disc, ring);
      discMats.push(dm); ringMats.push(rm);
    }

    // data cubes flying from the ribbon into the stack
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.0, 0.25, 0.1), new THREE.Vector3(1.9, 1.15, 0.6),
      new THREE.Vector3(2.9, 1.45, 0.25), new THREE.Vector3(3.35, 0.55, 0),
    ]);
    const cubeGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const cubeMat = new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.2, emissiveIntensity: 0.6 });
    const cubes = new THREE.InstancedMesh(cubeGeo, cubeMat, CUBES);
    world.add(cubes);
    const trailGeo = new THREE.TubeGeometry(path, 80, 0.012, 6, false);
    const trailMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false });
    world.add(new THREE.Mesh(trailGeo, trailMat));

    // stars
    const starPos = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 22;
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 12;
      starPos[i * 3 + 2] = -3 - Math.random() * 8;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ size: 0.035, transparent: true, depthWrite: false });
    const stars = new THREE.Points(starGeo, starMat);
    scene.add(stars);

    const paint = () => {
      const { a, b, dark } = themeColors(), mix = new THREE.Color();
      ambient.intensity = dark ? 0.35 : 0.85;
      rimA.color.copy(a); rimB.color.copy(b);
      for (let j = 0; j < rBase.length; j += 3) {              // blue -> violet along the ribbon
        mix.copy(a).lerp(b, (rBase[j] + 3.2) / 6.4);
        rColors[j] = mix.r; rColors[j + 1] = mix.g; rColors[j + 2] = mix.b;
      }
      ribbonGeo.attributes.color.needsUpdate = true;
      glowMat.color.copy(a).lerp(b, 0.5); glowMat.opacity = dark ? 0.2 : 0.12;
      glowMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      const disc = new THREE.Color(dark ? "#1e293b" : "#ffffff");
      discMats.forEach((m, i) => { m.color.copy(disc).lerp(a, 0.18 + i * 0.06); });
      ringMats.forEach((m, i) => { m.color.copy(a).lerp(b, i / (DISCS - 1)); });
      cubeMat.color.copy(a).lerp(b, 0.3); cubeMat.emissive.copy(a).lerp(b, 0.5);
      trailMat.color.copy(a).lerp(b, 0.5);
      starMat.color.copy(dark ? new THREE.Color("#cbd5e1") : a); starMat.opacity = dark ? 0.7 : 0.35;
      [ribbonMat, glowMat, cubeMat, trailMat, starMat, ...discMats, ...ringMats].forEach(m => { m.needsUpdate = true; });
    };
    paint();
    const themeWatch = new MutationObserver(paint);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const frame = (t: number) => {
      // ribbon: height = voice(x), fading toward the long edges and the two ends
      const pos = ribbonGeo.attributes.position.array as Float32Array;
      for (let j = 0; j < pos.length; j += 3) {
        const x = rBase[j], across = 1 - Math.min(1, Math.abs(rBase[j + 1]) / 0.75) ** 2;
        const edge = Math.min(1, (x + 3.2) / 0.8, (3.2 - x) / 0.8);
        const h = voice(x, t) * 0.75 * (0.35 + 0.65 * across) * edge;
        pos[j + 1] = rBase[j + 1] + h * 0.42;
        pos[j + 2] = rBase[j + 2] + h * 0.9;
      }
      ribbonGeo.attributes.position.needsUpdate = true;
      ribbonGeo.computeVertexNormals();
      // cubes: each at its own place on the path, spinning, growing out of the ribbon and shrinking as it lands
      let landed = 0;
      for (let i = 0; i < CUBES; i++) {
        const p = (t * 0.16 + i / CUBES) % 1;
        path.getPointAt(p, v);
        e.set(t * 1.3 + i, t * 1.7 + i * 2, 0);
        const s = p < 0.08 ? p / 0.08 : p > 0.9 ? (1 - p) / 0.1 : 1;
        if (p > 0.95) landed = Math.max(landed, (p - 0.95) / 0.05);
        cubes.setMatrixAt(i, m4.compose(v, q.setFromEuler(e), sc.setScalar(Math.max(0.001, s))));
      }
      cubes.instanceMatrix.needsUpdate = true;
      stack.rotation.y = t * 0.25;
      ringMats.forEach((m, i) => { m.opacity = i === DISCS - 1 ? 0.55 + 0.45 * landed : 0.55 + 0.2 * Math.sin(t * 2 + i); });
      stars.rotation.y = t * 0.01;
    };

    const target = { x: 0, y: 0 };
    const onMove = (ev: PointerEvent) => {
      target.x = (ev.clientX / window.innerWidth - 0.5) * 2;
      target.y = (ev.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1, aspect = w / h;
      renderer.setSize(w, h, false);
      camera.aspect = aspect;
      camera.position.set(0, 0.9, Math.max(9.5, 15 / aspect));        // the whole scene stays in view on tall screens
      camera.lookAt(0, 0, 0);
      const sh = w < 900 ? shifts.current.narrow : shifts.current.wide;
      camera.setViewOffset(w, h, -(sh.x || 0) * w, (sh.y || 0) * h, w, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clock = new THREE.Clock();
    world.rotation.set(0.12, -0.28, 0);
    const tick = () => {
      frame(clock.getElapsedTime());
      world.rotation.y += (-0.28 + target.x * 0.25 - world.rotation.y) * 0.05;
      world.rotation.x += (0.12 + target.y * 0.1 - world.rotation.x) * 0.05;
      renderer.render(scene, camera);
    };
    if (still) { frame(2.4); renderer.render(scene, camera); }

    let onScreen = true;
    const run = () => { if (!still) renderer.setAnimationLoop(document.hidden || !onScreen ? null : tick); };
    run();
    document.addEventListener("visibilitychange", run);
    const seen = new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; run(); });
    seen.observe(el);

    return () => {
      renderer.setAnimationLoop(null);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("pointermove", onMove);
      ro.disconnect(); themeWatch.disconnect(); seen.disconnect();
      [ribbonGeo, discGeo, ringGeo, cubeGeo, trailGeo, starGeo].forEach(g => g.dispose());
      [ribbonMat, glowMat, cubeMat, trailMat, starMat, ...discMats, ...ringMats].forEach(m => m.dispose());
      cubes.dispose(); renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={host} className={`auth-scene ${className}`} aria-hidden="true" />;
}
