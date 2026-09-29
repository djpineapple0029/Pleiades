import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { hash32 } from './random.js'
import { LANE_POINTS } from './lanes.js'

// Widths are in CSS pixels, which is what LineMaterial's `resolution` holds.
// The widest an edge is ever drawn, and the width it is picked at.
export const EDGE_WIDTH = 2.5
// The hovered edge, whatever its distance.
const EDGE_HOVER_WIDTH = 3.5
// An edge is as wide as a line EDGE_WORLD_WIDTH world units across would look
// at its distance, kept between EDGE_MIN_WIDTH and EDGE_WIDTH. Below the
// minimum it is drawn at the minimum and fainter, by the square root of the
// share of it the real width would cover, so a far, dense tangle thins to a
// haze instead of a solid block of lines. In an 800 px tall window an edge is
// full width out to ~230 units, one pixel at ~570, and 70% strength at ~1140.
const EDGE_WORLD_WIDTH = 1
const EDGE_MIN_WIDTH = 1
const EDGE_OPACITY = 0.8

const EDGE_COLOR = new THREE.Color(0x557aa3)
const EDGE_HOVER_COLOR = new THREE.Color(0xffbe6b)
const MOTE_COLOR = new THREE.Color(0xa9c8ea)

// Connection heat (`heat.js`): each end of a line takes its own star's heat and
// the colour runs between them, so a link from a hub to a lone star is hot at
// the hub's end. Cool is the plain edge colour, so a quiet map looks as it
// always did; hot runs through violet and magenta to a coral red. Yellow and
// amber are left out: amber is the hover colour.
const HEAT_RAMP = [0x557aa3, 0x8a6ad6, 0xd455b4, 0xff5a4f].map((hex) => new THREE.Color(hex))
// A hot line is also stronger and fogs out less, so the busy parts of a map
// still read from the overview.
const HEAT_OPACITY_GAIN = 0.25
const HEAT_FOG_FLOOR = 0.55
// Seconds for heat to ease on or off, and for a focus to settle.
const LOOK_EASE = 0.15
// Click-to-focus: a line outside the focus keeps this much of its light.
const FOCUS_DIM = 0.1
// Portals (prototype): a long link between two groups drawn only as a stub
// this long (world units, from each star's centre) at each end, pointing at
// the star at the other end, until it is hovered or lit by a focus.
const PORTAL_STUB = 46

// Depth fog. It runs across the map's own depth as seen from the camera —
// the near and far side of the edges' bounding sphere — rather than a fixed
// range, so the near half of the map reads over the far half from inside it
// and from outside it alike; a fixed range fogs a whole map viewed from
// outside down to nothing. It never starts closer than FOG_NEAR_MIN, and
// spans at least FOG_SPAN_MIN, so a small map doesn't fade across one edge.
// It bottoms out at FOG_FLOOR rather than zero. A hovered edge ignores it.
const FOG_NEAR_MIN = 200
const FOG_SPAN_MIN = 800
const FOG_FLOOR = 0.25
// Near each end an edge fades out, from full at END_FULL radii of that node to
// nothing at END_CLEAR, so it joins the star's glow rather than running into
// its core. Every edge at a hub would otherwise meet in one spiky knot.
const END_CLEAR = 1.1
const END_FULL = 2.4

// Drift: motes carried along every edge. An undirected edge carries a stream
// each way, a directed one a single stream from `from` to `to`. DRIFT_SLOTS
// motes at most per edge; one per DRIFT_SPACING world units of length.
const DRIFT_SLOTS = 16
const DRIFT_SPACING = 40
const DRIFT_SPEED = 9 // world units per second
// Mote diameter in world units, drawn between MOTE_MIN_PX and MOTE_MAX_PX (CSS
// px), and fainter by area below the minimum, like the edges.
const MOTE_SIZE = 1.2
const MOTE_MIN_PX = 1.5
const MOTE_MAX_PX = 6
// Motes are detail: they fog out well before the edges do.
const MOTE_FOG_NEAR = 150
const MOTE_FOG_FAR = 700

const glslFloat = (value) => value.toFixed(4)

const EDGE_DEFINES = {
  EDGE_WORLD_WIDTH: glslFloat(EDGE_WORLD_WIDTH),
  EDGE_MIN_WIDTH: glslFloat(EDGE_MIN_WIDTH),
  EDGE_HOVER_WIDTH: glslFloat(EDGE_HOVER_WIDTH),
  FOG_FLOOR: glslFloat(FOG_FLOOR),
  HEAT_FOG_FLOOR: glslFloat(HEAT_FOG_FLOOR),
  HEAT_OPACITY_GAIN: glslFloat(HEAT_OPACITY_GAIN),
  END_CLEAR: glslFloat(END_CLEAR),
  END_FULL: glslFloat(END_FULL),
  PORTAL_STUB: glslFloat(PORTAL_STUB),
}

// Shared by the lines and the motes: the ramp, from HEAT_RAMP's four stops.
const HEAT_GLSL = /* glsl */ `
uniform vec3 heatRamp[4];
vec3 heatColour(float t) {
  float x = clamp(t, 0.0, 1.0) * 3.0;
  if (x < 1.0) return mix(heatRamp[0], heatRamp[1], x);
  if (x < 2.0) return mix(heatRamp[1], heatRamp[2], x - 1.0);
  return mix(heatRamp[2], heatRamp[3], x - 2.0);
}
`

// Every edge instance carries instanceStart/instanceEnd (shared with the drift
// motes), instanceEdge = [from radius, to radius, drift phase, seed], seed
// in [0, 1) plus 1 for a directed edge, and instanceLook = [heat at the from
// end, heat at the to end, focus light, focus lift]: light is 1, or down to
// FOCUS_DIM outside a focus, and lift is 1 inside one, where the line ignores
// distance the way a hovered line does. gl_InstanceID is the edge's index.
// instanceHide is 1 for a link drawn as a lane (`lanes.js`): its straight line
// only shows hovered or inside a focus. 2 is a portal: only a PORTAL_STUB at
// each end shows, and the whole line when hovered or inside a focus. The lanes themselves are the same
// shader with LANE defined, one instance per piece of a lane, and give way to
// the straight line where it shows.

// three's screen-space line shader (LineMaterial, `worldUnits` off) with a
// width that follows distance, and with everything needed to fade the edge
// by distance and near its ends. Dashes, world units, vertex colours and
// caps are dropped: the ends fade out inside their stars, so a cap would never
// show.
const EDGE_VERTEX = /* glsl */ `
#include <common>
uniform float linewidth; // the widest an edge is drawn
uniform vec2 resolution;
uniform float hovered; // index of the hovered edge, or -1
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec4 instanceEdge;
attribute vec4 instanceLook;
attribute float instanceHide;
varying vec2 vUv;
varying vec4 vLook;
varying float vHide;
varying vec3 vView; // the point on the edge, in view space
varying float vAlong; // world distance from the start
varying float vLength;
varying vec2 vRadii;
varying float vPxScale; // px per world unit at a depth of 1
varying float vHover;

// Moves end to where the segment crosses (a conservative estimate of) the near
// plane, for segments that pass behind the camera. From LineMaterial.
void trimSegment(const in vec4 start, inout vec4 end) {
  float a = projectionMatrix[2][2];
  float b = projectionMatrix[3][2];
  float nearEstimate = -0.5 * b / a;
  float alpha = (nearEstimate - start.z) / (end.z - start.z);
  end.xyz = mix(start.xyz, end.xyz, alpha);
}

void main() {
  vHover = float(gl_InstanceID) == hovered ? 1.0 : 0.0;
  vRadii = instanceEdge.xy;
  vLook = instanceLook;
  vHide = instanceHide;
  vUv = uv;
  float aspect = resolution.x / resolution.y;

  vec4 start = modelViewMatrix * vec4(instanceStart, 1.0);
  vec4 end = modelViewMatrix * vec4(instanceEnd, 1.0);
  vec3 origin = start.xyz;
  vLength = distance(start.xyz, end.xyz);

  bool perspective = projectionMatrix[2][3] == -1.0;
  if (perspective) {
    if (start.z < 0.0 && end.z >= 0.0) trimSegment(start, end);
    else if (end.z < 0.0 && start.z >= 0.0) trimSegment(end, start);
  }

  vec4 clipStart = projectionMatrix * start;
  vec4 clipEnd = projectionMatrix * end;
  vec2 ndcStart = clipStart.xy / clipStart.w;
  vec2 ndcEnd = clipEnd.xy / clipEnd.w;
  vec2 dir = ndcEnd - ndcStart;
  dir.x *= aspect;
  dir = normalize(dir);
  vec2 offset = vec2(dir.y, -dir.x);
  offset.x /= aspect;
  if (position.x < 0.0) offset *= -1.0;

  bool atStart = position.y < 0.5;
  vec4 point = atStart ? start : end;
  vec4 clip = atStart ? clipStart : clipEnd;

  // Each end gets its own width, so an edge running into the distance tapers.
  vPxScale = 0.5 * resolution.y * projectionMatrix[1][1];
  float width = clamp(EDGE_WORLD_WIDTH * vPxScale / clip.w, EDGE_MIN_WIDTH, linewidth);
  width = mix(width, EDGE_HOVER_WIDTH, vHover);
  // To clip space: a full width of 'width' px across both sides.
  clip.xy += offset * width / resolution.y * clip.w;
  gl_Position = clip;

  // Both interpolate perspective-correctly along the segment, so the fragment
  // shader gets the true point on the edge and its true distance from the start.
  vView = point.xyz;
  vAlong = distance(origin, point.xyz);
}
`

const EDGE_FRAGMENT = /* glsl */ `
uniform vec3 diffuse;
uniform vec3 hoverColor;
uniform float opacity;
uniform float heat; // 1 with connection heat on, 0 off, easing between
uniform vec2 fogRange; // distances from the camera where the fog starts and bottoms out
${HEAT_GLSL}
varying vec2 vUv;
varying vec4 vLook;
varying float vHide;
varying vec3 vView;
varying float vAlong;
varying float vLength;
varying vec2 vRadii;
varying float vPxScale;
varying float vHover;

void main() {
  if (abs(vUv.y) > 1.0) discard; // cap triangles

  // The share of a minimum-width line the edge's real width would cover,
  // softened: taken as is, a whole map seen from outside loses its web.
  float trueWidth = EDGE_WORLD_WIDTH * vPxScale / max(-vView.z, 1e-3);
  float coverage = sqrt(min(1.0, trueWidth / EDGE_MIN_WIDTH));
  // This point's heat, between its two ends' (see HEAT_RAMP).
  float h = heat * mix(vLook.x, vLook.y, clamp(vAlong / max(vLength, 1e-3), 0.0, 1.0));
  float floorLevel = mix(FOG_FLOOR, HEAT_FOG_FLOOR, h);
  float fog = mix(1.0, floorLevel, smoothstep(fogRange.x, fogRange.y, length(vView)));
  float ends = smoothstep(END_CLEAR * vRadii.x, END_FULL * vRadii.x, vAlong)
    * smoothstep(END_CLEAR * vRadii.y, END_FULL * vRadii.y, vLength - vAlong);

  float lift = max(vHover, vLook.w);
#ifdef LANE
  // A lane piece gives way to its link's exact line inside a focus.
  float shown = 1.0 - vLook.w;
  lift = 0.0;
#else
  float stub = 1.0 - smoothstep(PORTAL_STUB * 0.7, PORTAL_STUB, min(vAlong, vLength - vAlong));
  float shown = vHide > 1.5 ? max(lift, stub) : mix(1.0, lift, vHide);
#endif
  float strength = min(1.0, opacity * (1.0 + HEAT_OPACITY_GAIN * h));
  float alpha = shown * strength * ends * vLook.z * mix(coverage * fog, 1.0, lift);
  // The ramp's cool end is the plain edge colour (diffuse), so no heat at all
  // looks exactly as before.
  gl_FragColor = vec4(mix(heatColour(h), hoverColor, vHover), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const DRIFT_DEFINES = {
  DRIFT_SPACING: glslFloat(DRIFT_SPACING),
  MOTE_SIZE: glslFloat(MOTE_SIZE),
  MOTE_MIN_PX: glslFloat(MOTE_MIN_PX),
  MOTE_MAX_PX: glslFloat(MOTE_MAX_PX),
  MOTE_FOG_NEAR: glslFloat(MOTE_FOG_NEAR),
  MOTE_FOG_FAR: glslFloat(MOTE_FOG_FAR),
  END_CLEAR: glslFloat(END_CLEAR),
  END_FULL: glslFloat(END_FULL),
  PORTAL_STUB: glslFloat(PORTAL_STUB),
}

// One point per slot per edge instance; position.x is the slot.
const DRIFT_VERTEX = /* glsl */ `
uniform vec2 resolution; // CSS px, as for the edges
uniform float pixelRatio;
uniform float hovered;
uniform vec3 moteColor;
uniform vec3 hoverColor;
uniform float dim; // 1 normally; lower while a search dims the map
uniform float heat; // as for the lines
${HEAT_GLSL}
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute vec4 instanceEdge;
attribute vec4 instanceLook;
attribute float instanceHide;
varying vec3 vColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  float slot = position.x;
  float seed = fract(instanceEdge.w);
  bool directed = instanceEdge.w >= 1.0;
  // Alternate slots run each way on an undirected edge.
  float back = directed ? 0.0 : mod(slot, 2.0);
  float rank = directed ? slot : floor(slot * 0.5); // within its stream
  float streams = directed ? 1.0 : 2.0;

  float len = distance(instanceStart, instanceEnd);
  // Motes this stream carries at this length. The last one present fades
  // with the fraction, so an edge stretching under physics gains them gradually.
  float present = clamp(len / (DRIFT_SPACING * streams) - rank, 0.0, 1.0);

  // Golden-ratio offsets: however many of a stream's slots are present, they
  // are spread along it rather than bunched. The return stream is shifted by
  // its own amount per edge; unshifted it would mirror the outward one, and
  // every pair of motes would cross exactly at the middle.
  float t = fract(seed * 7.0 + rank * 0.618034 + back * (0.25 + 0.5 * fract(seed * 31.0)) + instanceEdge.z);
  if (back > 0.5) t = 1.0 - t;
  vec3 world = mix(instanceStart, instanceEnd, t);
  float ends = smoothstep(END_CLEAR * instanceEdge.x, END_FULL * instanceEdge.x, t * len)
    * smoothstep(END_CLEAR * instanceEdge.y, END_FULL * instanceEdge.y, (1.0 - t) * len);

  vec4 view = modelViewMatrix * vec4(world, 1.0);
  float size = MOTE_SIZE * 0.5 * resolution.y * projectionMatrix[1][1] / max(-view.z, 1e-3);
  float drawn = clamp(size, MOTE_MIN_PX, MOTE_MAX_PX);
  float coverage = min(1.0, size / MOTE_MIN_PX);
  float fog = 1.0 - smoothstep(MOTE_FOG_NEAR, MOTE_FOG_FAR, length(view.xyz));
  float hover = float(gl_InstanceID) == hovered ? 1.0 : 0.0;

  float light = present * ends * (0.55 + 0.45 * hash12(vec2(seed * 97.0, slot)));
  light *= mix(fog * coverage * coverage, 1.0, max(hover, instanceLook.w)) * dim * instanceLook.z;
  // A lane has no motes (yet); its link's straight line only carries them when
  // shown. A portal carries them along its stubs.
  float lit = max(hover, instanceLook.w);
  float stub = 1.0 - smoothstep(PORTAL_STUB * 0.7, PORTAL_STUB, min(t, 1.0 - t) * len);
  light *= instanceHide > 1.5 ? max(lit, stub) : mix(1.0, lit, instanceHide);
  // A mote on a hot line carries a lighter shade of the line's heat.
  float h = heat * mix(instanceLook.x, instanceLook.y, t);
  vec3 mote = mix(moteColor, mix(heatColour(h), vec3(1.0), 0.35), smoothstep(0.1, 0.5, h));
  vColor = mix(mote, hoverColor, hover) * light;
  gl_PointSize = drawn * pixelRatio;
  gl_Position = projectionMatrix * view;
  // Outside the clip volume: no fragments for a mote that would add nothing.
  if (light <= 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

const DRIFT_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  gl_FragColor = vec4(vColor * exp(-3.0 * r2) * (1.0 - smoothstep(0.7, 1.0, r2)), 1.0);
  #include <colorspace_fragment>
}
`

/**
 * Every edge as one `LineSegments2` plus one `Points` of drift motes, both
 * instanced per edge over the same endpoint buffer: two draw calls whatever
 * the edge count, and one upload when physics moves the nodes.
 *
 * Edges are layer 0 and never bloom. Width follows distance down to a
 * one-pixel floor, then strength does; distance fog fades what is left; and
 * each end fades out inside its node's glow. The hovered edge ignores the
 * distance falloff so it can always be seen.
 *
 * `radiusOf(id)` is the drawn node radius, eased; call `writeRadii` whenever it
 * changes. The index of an edge in both geometries is its position in the
 * order `sync` last built, which is also the line raycast's `faceIndex`.
 */
export function createEdges(graph, parent, renderer, radiusOf) {
  const hovered = { value: -1 }
  const hoverColor = { value: EDGE_HOVER_COLOR }

  const lineMaterial = new LineMaterial({
    color: EDGE_COLOR,
    linewidth: EDGE_WIDTH, // read by LineSegments2.raycast as the pick width
    transparent: true,
    opacity: EDGE_OPACITY,
    depthWrite: false,
  })
  lineMaterial.vertexShader = EDGE_VERTEX
  lineMaterial.fragmentShader = EDGE_FRAGMENT
  Object.assign(lineMaterial.defines, EDGE_DEFINES)
  lineMaterial.uniforms.hovered = hovered
  lineMaterial.uniforms.hoverColor = hoverColor
  // Shared with the motes, like `hovered`.
  const heatUniform = { value: 1 }
  const heatRamp = { value: HEAT_RAMP }
  lineMaterial.uniforms.heat = heatUniform
  lineMaterial.uniforms.heatRamp = heatRamp
  lineMaterial.uniforms.fogRange = { value: new THREE.Vector2(FOG_NEAR_MIN, FOG_NEAR_MIN + FOG_SPAN_MIN) }
  // LineSegments2.onBeforeRender keeps this at the viewport size, in CSS px,
  // from the first frame on; seeded so a raycast before then still lands.
  const viewport = renderer.getViewport(new THREE.Vector4())
  lineMaterial.resolution.set(viewport.z, viewport.w)

  const lines = new LineSegments2(new LineSegmentsGeometry(), lineMaterial)
  lines.name = 'edges'
  lines.frustumCulled = false
  lines.visible = false
  parent.add(lines)

  const sphere = new THREE.Sphere()
  const eye = new THREE.Vector3()
  lines.onBeforeRender = function (r, scene, camera, geometry) {
    LineSegments2.prototype.onBeforeRender.call(this, r) // keeps `resolution` current
    // The fog spans the map's depth from here; see FOG_NEAR_MIN. The bounds are
    // kept current by `sync` and `updatePositions`.
    if (!geometry.boundingSphere) geometry.computeBoundingSphere()
    sphere.copy(geometry.boundingSphere).applyMatrix4(this.matrixWorld)
    const centre = eye.setFromMatrixPosition(camera.matrixWorld).distanceTo(sphere.center)
    const near = Math.max(FOG_NEAR_MIN, centre - sphere.radius)
    lineMaterial.uniforms.fogRange.value.set(near, Math.max(centre + sphere.radius, near + FOG_SPAN_MIN))
  }

  const driftMaterial = new THREE.ShaderMaterial({
    uniforms: {
      resolution: lineMaterial.uniforms.resolution, // same object, kept current by the lines
      pixelRatio: { value: 1 },
      hovered,
      moteColor: { value: MOTE_COLOR },
      hoverColor,
      dim: { value: 1 },
      heat: heatUniform,
      heatRamp,
    },
    defines: DRIFT_DEFINES,
    vertexShader: DRIFT_VERTEX,
    fragmentShader: DRIFT_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const slots = new Float32Array(DRIFT_SLOTS * 3)
  for (let i = 0; i < DRIFT_SLOTS; i++) slots[i * 3] = i
  const slotAttribute = new THREE.BufferAttribute(slots, 3)

  const drift = new THREE.Points(new THREE.InstancedBufferGeometry(), driftMaterial)
  drift.name = 'edge-drift'
  // Positions come from the instance attributes, so the geometry has no bounds.
  drift.frustumCulled = false
  // After the lines: they are normally blended and would dim motes under them.
  drift.renderOrder = 0.5
  drift.visible = false
  drift.onBeforeRender = (r) => {
    driftMaterial.uniforms.pixelRatio.value = r.getPixelRatio()
  }
  parent.add(drift)

  // Lanes: the same line shader over one instance per piece of each lane,
  // sharing the lines' fog, heat, opacity and hover colour. Never hovered by
  // index (a lane piece's instance is not an edge's), never raycast.
  const laneMaterial = new LineMaterial({
    color: EDGE_COLOR,
    linewidth: EDGE_WIDTH,
    transparent: true,
    opacity: EDGE_OPACITY,
    depthWrite: false,
  })
  laneMaterial.vertexShader = EDGE_VERTEX
  laneMaterial.fragmentShader = EDGE_FRAGMENT
  Object.assign(laneMaterial.defines, EDGE_DEFINES, { LANE: '' })
  for (const name of ['hoverColor', 'heat', 'heatRamp', 'fogRange', 'opacity'])
    laneMaterial.uniforms[name] = name === 'hoverColor' ? hoverColor : lineMaterial.uniforms[name]
  laneMaterial.uniforms.heat = heatUniform
  laneMaterial.uniforms.heatRamp = heatRamp
  laneMaterial.uniforms.hovered = { value: -1 }
  laneMaterial.resolution.set(viewport.z, viewport.w)
  const laneLines = new LineSegments2(new LineSegmentsGeometry(), laneMaterial)
  laneLines.name = 'lanes'
  laneLines.frustumCulled = false
  laneLines.visible = false
  parent.add(laneLines)

  let order = [] // index -> edge id
  let fromIds = []
  let toIds = []
  let positions = new Float32Array(0) // per edge: from xyz, to xyz
  let edgeData = new Float32Array(0) // per edge: from radius, to radius, phase, seed
  let edgeAttribute = null
  let phases = new Float64Array(0) // drift phase, in double precision on the CPU
  let hoverId = null
  let look = new Float32Array(0) // per edge: heat from, heat to, focus light, focus lift
  let lookAttribute = null
  let heatOn = true
  let focusIds = null // edge ids a focus keeps lit, or null
  let focusDim = FOCUS_DIM // what a line outside the focus keeps
  let portalIds = null // edge ids drawn as portals, or null
  let lookEasing = false
  let hide = new Float32Array(0) // per edge: 1 if drawn as a lane
  let hideAttribute = null
  let indexOf = new Map() // edge id -> index in `order`
  // Lanes, per piece (LANE_POINTS - 1 of them per lane).
  let routes = null // edge id -> Float32Array route, from setLanes
  let laneIds = [] // lane order -> edge id
  let laneParent = new Int32Array(0) // piece -> its edge's index in `order`
  let lanePositions = new Float32Array(0)
  let laneFrac = new Float32Array(0) // piece: share of the lane's length at its start and end
  let laneData = new Float32Array(0)
  let laneLook = new Float32Array(0)
  let laneLookAttribute = null
  let laneDataAttribute = null
  const PIECES = LANE_POINTS - 1

  function writeEndpoints() {
    for (let i = 0; i < order.length; i++) {
      const from = graph.getNode(fromIds[i])
      const to = graph.getNode(toIds[i])
      const o = i * 6
      positions[o] = from.x
      positions[o + 1] = from.y
      positions[o + 2] = from.z
      positions[o + 3] = to.x
      positions[o + 4] = to.y
      positions[o + 5] = to.z
    }
  }

  /** Endpoint radii from `radiusOf`. Call when drawn node sizes change. */
  function writeRadii() {
    if (!edgeAttribute) return
    for (let i = 0; i < order.length; i++) {
      edgeData[i * 4] = radiusOf(fromIds[i])
      edgeData[i * 4 + 1] = radiusOf(toIds[i])
    }
    edgeAttribute.needsUpdate = true
    writeLaneRadii()
  }

  /** Each end's heat from `graph.heatOf`. Call when the graph's revision moves. */
  function writeHeat() {
    if (!lookAttribute) return
    for (let i = 0; i < order.length; i++) {
      look[i * 4] = graph.heatOf(fromIds[i])
      look[i * 4 + 1] = graph.heatOf(toIds[i])
    }
    lookAttribute.needsUpdate = true
    writeLaneLook()
  }

  const focusLight = (id) => (!focusIds || focusIds.has(id) ? 1 : focusDim)
  const focusLift = (id) => (focusIds?.has(id) ? 1 : 0)

  /** Every edge's focus straight to its target, for a fresh geometry. */
  function snapFocus() {
    for (let i = 0; i < order.length; i++) {
      look[i * 4 + 2] = focusLight(order[i])
      look[i * 4 + 3] = focusLift(order[i])
    }
    writeLaneLook()
  }

  /** One frame of heat on/off and the focus closing on their targets. */
  function easeLook(dt) {
    const keep = Math.exp(-dt / LOOK_EASE)
    const close = (from, to) => {
      const next = to + (from - to) * keep
      return Math.abs(next - to) < 1 / 512 ? to : next
    }
    let moving = false
    const heatWanted = heatOn ? 1 : 0
    if (heatUniform.value !== heatWanted) {
      heatUniform.value = close(heatUniform.value, heatWanted)
      moving ||= heatUniform.value !== heatWanted
    }
    let changed = false
    for (let i = 0; i < order.length; i++) {
      for (const [k, wanted] of [
        [2, focusLight(order[i])],
        [3, focusLift(order[i])],
      ]) {
        const o = i * 4 + k
        if (look[o] === wanted) continue
        look[o] = close(look[o], wanted)
        moving ||= look[o] !== wanted
        changed = true
      }
    }
    if (changed && lookAttribute) lookAttribute.needsUpdate = true
    if (changed) writeLaneLook()
    return moving
  }

  function resolveHover() {
    hovered.value = hoverId === null ? -1 : order.indexOf(hoverId)
  }

  /** Rebuilds both geometries. Call when edges are added or removed. */
  function sync() {
    // Carried across by id, so an edit elsewhere doesn't make every mote jump.
    const previous = new Map(order.map((id, i) => [id, phases[i]]))
    order = [...graph.edges.keys()]
    fromIds = order.map((id) => graph.getEdge(id).from)
    toIds = order.map((id) => graph.getEdge(id).to)
    resolveHover()

    const count = order.length
    const oldLines = lines.geometry
    const oldDrift = drift.geometry
    positions = new Float32Array(count * 6)
    edgeData = new Float32Array(count * 4)
    look = new Float32Array(count * 4)
    phases = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      phases[i] = previous.get(order[i]) ?? 0
      const edge = graph.getEdge(order[i])
      edgeData[i * 4 + 2] = phases[i]
      // From the id, not the index, so an edge keeps its motes through edits.
      edgeData[i * 4 + 3] = hash32(edge.id) / 2 ** 32 + (edge.directed ? 1 : 0)
    }
    // Endpoints must be in place before setPositions: it derives the bounding
    // volumes from whatever the array holds at that moment.
    writeEndpoints()

    const lineGeometry = new LineSegmentsGeometry()
    // Adopted by reference, so later writes only need a needsUpdate flag.
    lineGeometry.setPositions(positions)
    edgeAttribute = new THREE.InstancedBufferAttribute(edgeData, 4)
    edgeAttribute.setUsage(THREE.DynamicDrawUsage) // the drift phase moves every frame
    lineGeometry.setAttribute('instanceEdge', edgeAttribute)
    lookAttribute = new THREE.InstancedBufferAttribute(look, 4)
    lookAttribute.setUsage(THREE.DynamicDrawUsage)
    lineGeometry.setAttribute('instanceLook', lookAttribute)
    hide = new Float32Array(count)
    hideAttribute = new THREE.InstancedBufferAttribute(hide, 1)
    lineGeometry.setAttribute('instanceHide', hideAttribute)
    indexOf = new Map(order.map((id, i) => [id, i]))

    // The motes read the lines' own endpoint buffer: one upload serves both.
    const driftGeometry = new THREE.InstancedBufferGeometry()
    driftGeometry.setAttribute('position', slotAttribute)
    driftGeometry.setAttribute('instanceStart', lineGeometry.getAttribute('instanceStart'))
    driftGeometry.setAttribute('instanceEnd', lineGeometry.getAttribute('instanceEnd'))
    driftGeometry.setAttribute('instanceEdge', edgeAttribute)
    driftGeometry.setAttribute('instanceLook', lookAttribute)
    driftGeometry.setAttribute('instanceHide', hideAttribute)
    driftGeometry.instanceCount = count

    lines.geometry = lineGeometry
    drift.geometry = driftGeometry
    // After the swap: disposing frees the GPU copies of the old buffers, and the
    // new geometries share none of them. slotAttribute is shared across
    // generations, but three uploads it again on first use after a dispose.
    oldLines.dispose()
    oldDrift.dispose()
    // Lanes are indexed by edge, so they rebuild with the edges.
    laneIds = []
    buildLanes()
    writeRadii()
    writeHeat()
    snapFocus()

    lines.visible = drift.visible = count > 0
  }

  /**
   * Lane routes for the links drawn as lanes (`lanes.computeLanes`), or null
   * for none. Call whenever positions or colours change. The geometry is only
   * rebuilt when the set of lanes changes; otherwise the points are rewritten
   * in place.
   */
  function setLanes(next) {
    routes = next
    const ids = order.filter((id) => routes?.has(id))
    const same = ids.length === laneIds.length && ids.every((id, j) => id === laneIds[j])
    if (!same) {
      buildLanes()
      writeLaneRadii()
      writeLaneLook()
    } else writeLanePositions()
  }

  function buildLanes() {
    laneIds = order.filter((id) => routes?.has(id))
    writeHide()

    const pieces = laneIds.length * PIECES
    laneParent = new Int32Array(pieces)
    lanePositions = new Float32Array(pieces * 6)
    laneFrac = new Float32Array(pieces * 2)
    laneData = new Float32Array(pieces * 4)
    laneLook = new Float32Array(pieces * 4)
    laneIds.forEach((id, j) => {
      const parentIndex = indexOf.get(id)
      for (let s = 0; s < PIECES; s++) {
        const piece = j * PIECES + s
        laneParent[piece] = parentIndex
        laneData[piece * 4 + 3] = edgeData[parentIndex * 4 + 3]
      }
    })
    writeLanePositions(false)

    const old = laneLines.geometry
    const geometry = new LineSegmentsGeometry()
    geometry.setPositions(lanePositions)
    laneDataAttribute = new THREE.InstancedBufferAttribute(laneData, 4)
    geometry.setAttribute('instanceEdge', laneDataAttribute)
    laneLookAttribute = new THREE.InstancedBufferAttribute(laneLook, 4)
    laneLookAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('instanceLook', laneLookAttribute)
    geometry.setAttribute('instanceHide', new THREE.InstancedBufferAttribute(new Float32Array(pieces), 1))
    laneLines.geometry = geometry
    old.dispose()
    laneLines.visible = pieces > 0
  }

  /** Per edge: 1 drawn as a lane, 2 as a portal, 0 as a plain line. */
  function writeHide() {
    const laned = new Set(laneIds)
    for (let i = 0; i < order.length; i++)
      hide[i] = laned.has(order[i]) ? 1 : portalIds?.has(order[i]) ? 2 : 0
    if (hideAttribute) hideAttribute.needsUpdate = true
  }

  /** Edge ids to draw as portals (a Set), or null for none. */
  function setPortals(ids) {
    portalIds = ids ?? null
    writeHide()
  }

  function writeLanePositions(upload = true) {
    laneIds.forEach((id, j) => {
      const route = routes.get(id)
      let total = 0
      for (let s = 0; s < PIECES; s++) {
        const a = s * 3
        total += Math.hypot(route[a + 3] - route[a], route[a + 4] - route[a + 1], route[a + 5] - route[a + 2])
      }
      let run = 0
      for (let s = 0; s < PIECES; s++) {
        const piece = j * PIECES + s
        const a = s * 3
        const o = piece * 6
        for (let k = 0; k < 6; k++) lanePositions[o + k] = route[a + k]
        laneFrac[piece * 2] = total ? run / total : 0
        run += Math.hypot(route[a + 3] - route[a], route[a + 4] - route[a + 1], route[a + 5] - route[a + 2])
        laneFrac[piece * 2 + 1] = total ? run / total : 1
      }
    })
    if (upload && laneIds.length) {
      laneLines.geometry.attributes.instanceStart.data.needsUpdate = true
      writeLaneLook()
    }
  }

  /** A lane fades into its end stars like its line does; its inner joins don't fade. */
  function writeLaneRadii() {
    if (!laneDataAttribute) return
    for (let piece = 0; piece < laneParent.length; piece++) {
      const i = laneParent[piece]
      const s = piece % PIECES
      laneData[piece * 4] = s === 0 ? radiusOf(fromIds[i]) : 1e-3
      laneData[piece * 4 + 1] = s === PIECES - 1 ? radiusOf(toIds[i]) : 1e-3
    }
    laneDataAttribute.needsUpdate = true
  }

  /** Each piece's heat, from its share along the lane, and its link's focus. */
  function writeLaneLook() {
    if (!laneLookAttribute) return
    for (let piece = 0; piece < laneParent.length; piece++) {
      const i = laneParent[piece] * 4
      const o = piece * 4
      const hFrom = look[i]
      const hTo = look[i + 1]
      laneLook[o] = hFrom + (hTo - hFrom) * laneFrac[piece * 2]
      laneLook[o + 1] = hFrom + (hTo - hFrom) * laneFrac[piece * 2 + 1]
      laneLook[o + 2] = look[i + 2]
      laneLook[o + 3] = look[i + 3]
    }
    laneLookAttribute.needsUpdate = true
  }

  /** Rewrites endpoints from current node positions, in place. */
  function updatePositions() {
    if (order.length === 0) return
    writeEndpoints()
    lines.geometry.attributes.instanceStart.data.needsUpdate = true
    // Raycasting gates on these and only recomputes them when they are null,
    // so a moved node has to refresh both or its edges stop being pickable.
    lines.geometry.computeBoundingBox()
    lines.geometry.computeBoundingSphere()
  }

  /** Advances the drift by `dt` seconds, and eases heat and focus. */
  function update(dt) {
    if (lookEasing && dt > 0) lookEasing = easeLook(dt)
    if (order.length === 0 || dt <= 0) return
    for (let i = 0; i < order.length; i++) {
      const o = i * 6
      const length = Math.hypot(
        positions[o + 3] - positions[o],
        positions[o + 4] - positions[o + 1],
        positions[o + 5] - positions[o + 2],
      )
      // Integrated rather than computed from a clock: the speed is fixed in
      // world units, so the phase rate depends on the length, and physics
      // changes lengths. A phase of clock * speed / length would jump every
      // mote at once whenever an edge stretched.
      phases[i] = (phases[i] + (dt * DRIFT_SPEED) / Math.max(length, 1)) % 1
      edgeData[i * 4 + 2] = phases[i]
    }
    edgeAttribute.needsUpdate = true
  }

  /** Edge id to draw hovered, or null. */
  function setHovered(id) {
    hoverId = id ?? null
    resolveHover()
  }

  /** Nearest edge under the ray as `{ id, distance }`, or null. */
  function raycast(raycaster) {
    if (!lines.visible) return null
    const hit = raycaster.intersectObject(lines, false)[0]
    const id = hit ? order[hit.faceIndex] : undefined
    return id ? { id, distance: hit.distance } : null
  }

  function dispose() {
    parent.remove(lines, drift, laneLines)
    lines.geometry.dispose()
    drift.geometry.dispose()
    laneLines.geometry.dispose()
    lineMaterial.dispose()
    driftMaterial.dispose()
    laneMaterial.dispose()
  }

  /** Scales every edge and mote's light: 1 is normal. Search dims the map. */
  function setDim(level) {
    lineMaterial.uniforms.opacity.value = EDGE_OPACITY * level
    driftMaterial.uniforms.dim.value = level
  }

  /** Connection heat colours on or off, easing unless `instant`. */
  function setHeat(on, { instant = false } = {}) {
    heatOn = Boolean(on)
    if (instant) heatUniform.value = heatOn ? 1 : 0
    lookEasing = true
  }

  /**
   * Edge ids a click-to-focus keeps lit (a Set), dimming every other to `dim`
   * of its light; null for none.
   */
  function setFocus(ids, { dim = FOCUS_DIM } = {}) {
    focusIds = ids ?? null
    focusDim = dim
    lookEasing = true
  }

  return {
    sync,
    updatePositions,
    writeRadii,
    writeHeat,
    update,
    setHovered,
    setDim,
    setHeat,
    setFocus,
    setLanes,
    setPortals,
    raycast,
    dispose,
    get heatOn() {
      return heatOn
    },
  }
}
