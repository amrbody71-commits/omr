/* thread.js — the Thread of Light: THE signature element. A single golden
   filament wound along the same helix as the cards, at THREAD_RADIUS =
   RADIUS − 2.6, safely inside the card ring. Amber light FLOWS DOWNWARD
   along it (the descent direction), and the thread is only LIT from birth
   (t = 0) down to the current progress — a hot firefly-gold pulse rides
   the front, and everything beyond it waits as a barely-visible ember.

   The tube is parented INSIDE spiralGroup, so the world-moves rig spins
   and raises it with the cards for free. One THREE.PointLight (the only
   real light in the scene) rides the progress front in group-local
   coordinates — the rig lands it in front of the camera every frame.

   Geometry clearance (cards must never intersect the tube):
     cards are 3.2-wide planes TANGENT to the helix at RADIUS 14 — the
     closest any undisplaced card point comes to the axis is 14.0 (its
     center line; corners sit at √(14² + 1.6²) ≈ 14.09). Card shader
     displacement along the radial normal is ≤ ~0.44 inward at full drag
     velocity (bow 0.383 + ripple 0.05 + breathe 0.008). Tube max radial
     extent = 11.4 + 0.055 = 11.455 (Catmull-Rom sag between the 200
     samples is inward-only, ≈ 0.009). Worst-case clearance ≈
     14.0 − 0.44 − 11.455 ≈ 2.1 world-units. Never touches. */

import * as THREE from 'three';
import { helixAt, RADIUS } from './spiral.js';
import { glslNoiseCommon, glslSnoise2 } from './shaders/chunks.glsl.js';

export const THREAD_RADIUS = RADIUS - 2.6;   // 11.4 — inside the card ring

const SPINE_SAMPLES = 200;    // helixAt() samples into the Catmull-Rom spine
const TUBE_SEGMENTS = 400;
const TUBE_RADIUS = 0.055;
const RADIAL_SEGMENTS = 6;

const threadVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vFogDepth;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mvPosition.xyz;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const threadFragment = /* glsl */ `
uniform float uTime;
uniform float uProgress;
uniform float fogNear;
uniform float fogFar;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPos;
varying float vFogDepth;

${glslNoiseCommon}
${glslSnoise2}

/* Palette pre-converted to linear-sRGB (this runs before ACES + sRGB out). */
const vec3 AMBER = vec3(1.0, 0.4793, 0.1301);  // #FFB865 lamplight amber
const vec3 SPARK = vec3(1.0, 0.8148, 0.6276);  // #FFE9C4 firefly gold

void main() {
  /* TubeGeometry: uv.x runs ALONG the tube — 0 at birth (top) → 1 at NOW
     (bottom). A phase of (along·k − uTime·c) therefore flows DOWNWARD,
     the descent direction, as time advances. */
  float along = vUv.x;

  /* Liquid light: noise wanders the stripe phase so the flow reads as
     molten gold, not a barber pole. */
  float n = snoise2(vec2(along * 34.0 - uTime * 0.85, vUv.y * 3.0 + 7.0));
  float stripe = 0.5 + 0.5 * sin((along * 120.0 - uTime * 3.2) + n * 2.4);
  stripe *= stripe;                              // sharpen the hot bands
  float core = (0.45 + 0.55 * stripe) * (0.8 + 0.3 * n);

  /* Progress reveal: lit from t = 0 down to uProgress; beyond the front
     the tube waits as an 8%-intensity ember — unspent life. */
  float lit = 1.0 - smoothstep(uProgress, uProgress + 0.012, along);
  float intensity = mix(0.08, 1.0, lit);

  /* The leading edge: a hot ~0.02-wide gaussian pulse riding the front. */
  float d = (along - uProgress) / 0.01;
  float pulse = exp(-d * d);

  /* Fresnel falloff: bright core facing the eye, soft at the silhouette. */
  float facing = abs(dot(normalize(vNormal), normalize(-vViewPos)));
  float body = pow(facing, 1.7);

  vec3 col = mix(AMBER, SPARK, 0.25 + 0.5 * stripe) * core * intensity * 1.35;
  col += SPARK * pulse * 2.4;
  col *= body;

  /* Additive fog: fade toward NOTHING with depth — mixing toward fogColor
     would ADD haze light. fogNear/fogFar refresh from scene.fog each frame
     because material.fog = true. */
  col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth) * 0.9;

  gl_FragColor = vec4(col, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/* Builds the thread inside spiralGroup. Returns { update(TIMELINE, dt) }. */
export function initThread(spiralGroup) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motionScale = reduced ? 0 : 1;

  /* Sample the SAME curve the cards sit on — helixAt is the single source
     of truth — pulled in to THREAD_RADIUS. */
  const points = [];
  for (let i = 0; i <= SPINE_SAMPLES; i += 1) {
    const t = i / SPINE_SAMPLES;
    const { angle, y } = helixAt(t);
    points.push(new THREE.Vector3(
      Math.sin(angle) * THREAD_RADIUS,
      y,
      Math.cos(angle) * THREAD_RADIUS,
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  const geometry = new THREE.TubeGeometry(
    curve, TUBE_SEGMENTS, TUBE_RADIUS, RADIAL_SEGMENTS, false);

  const uniforms = {
    /* Non-zero start so a frozen (reduced-motion) thread still has pattern. */
    uTime: { value: 7.31 },
    uProgress: { value: 0 },
    /* fogColor is never read by this shader — it exists only because
       material.fog = true makes the renderer refresh all three from
       scene.fog each frame, and the refresh writes into fogColor.value. */
    fogColor: { value: new THREE.Color('#2A2140') },
    fogNear: { value: 30 },
    fogFar: { value: 76 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: threadVertex,
    fragmentShader: threadFragment,
    uniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: true,
  });

  const tube = new THREE.Mesh(geometry, material);
  /* After the depth-writing cards (renderOrder 0): the tube is correctly
     occluded where it passes behind them, and adds light in front. */
  tube.renderOrder = 1;
  /* Spans the whole helix — always on screen; skip the culling churn. */
  tube.frustumCulled = false;
  spiralGroup.add(tube);

  /* The one real light: amber, riding the progress front so nearby card
     glass edges catch it. Group-LOCAL coordinates — the world rig's
     spin/rise lands it at world y ≈ 0, in front of the camera. */
  const light = new THREE.PointLight(0xFFB865, 2, 12);
  spiralGroup.add(light);

  return {
    update(TIMELINE, dt) {
      uniforms.uTime.value += dt * motionScale;
      uniforms.uProgress.value = TIMELINE.smooth;

      const { angle, y } = helixAt(TIMELINE.smooth);
      light.position.set(
        Math.sin(angle) * THREAD_RADIUS,
        y,
        Math.cos(angle) * THREAD_RADIUS,
      );
      /* A candle breathes; under reduced motion it holds steady. */
      light.intensity = 2 + 0.22 * Math.sin(uniforms.uTime.value * 1.7) * motionScale;
    },
  };
}
