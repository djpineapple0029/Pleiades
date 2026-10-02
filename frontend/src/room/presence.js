/**
 * Presence (context/MOONSHOT.md): where everyone is, sent through Yjs
 * awareness and drawn smoothly rather than exactly (decision 14b: "this
 * isn't an FPS"). Pure — no three.js; avatars.js draws what `sample` returns.
 */
// A jump between two poses longer than this is a teleport (a fly-to, the
// overview): shown as a jump, not a glide across the whole map.
const TELEPORT = 400
const KEEP = 8

const lerp = (a, b, t) => a + (b - a) * t
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t
  return p1.map(
    (_, i) =>
      0.5 *
      (2 * p1[i] +
        (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3),
  )
}

function slerp(a, b, t) {
  let [bx, by, bz, bw] = b
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (dot < 0) {
    dot = -dot
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  if (dot > 0.9995) {
    const q = [lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t)]
    const n = Math.hypot(...q)
    return q.map((v) => v / n)
  }
  const theta = Math.acos(dot)
  const s = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / s
  const wb = Math.sin(t * theta) / s
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]
}

/**
 * One person's recent poses, by arrival time. `sample(now)` shows them
 * `delay` ms in the past, between the two poses that bracket that moment
 * (Catmull-Rom through four where it can, linear otherwise; slerp for the
 * turn); past the newest it carries on for at most `maxExtrapolate` ms, then
 * holds still.
 */
export function createPoseBuffer({ delay = 150, maxExtrapolate = 250 } = {}) {
  const samples = [] // { t, p, q }, oldest first

  function push(pose, arrivedAt) {
    samples.push({ t: arrivedAt, p: pose.p, q: pose.q })
    if (samples.length > KEEP) samples.shift()
  }

  function sample(now) {
    if (!samples.length) return null
    const t = now - delay
    const last = samples.at(-1)
    if (samples.length === 1 || t <= samples[0].t) return { p: samples[0].p, q: samples[0].q }
    if (t >= last.t) {
      const prev = samples.at(-2)
      if (dist(prev.p, last.p) > TELEPORT) return { p: last.p, q: last.q }
      const span = last.t - prev.t || 1
      const ahead = Math.min(t - last.t, maxExtrapolate)
      return { p: lerp3(last.p, lerp3(prev.p, last.p, 2), ahead / span), q: last.q }
    }
    const i = samples.findIndex((s) => s.t > t) - 1
    const a = samples[i]
    const b = samples[i + 1]
    if (dist(a.p, b.p) > TELEPORT) return { p: b.p, q: b.q }
    const k = (t - a.t) / (b.t - a.t || 1)
    const before = samples[i - 1]
    const after = samples[i + 2]
    const p = before && after ? catmullRom(before.p, a.p, b.p, after.p, k) : lerp3(a.p, b.p, k)
    return { p, q: slerp(a.q, b.q, k) }
  }

  return { push, sample }
}

/**
 * Publishes this tab's pose into awareness: at most `movingHz` while it
 * changes (more than 0.01 units or 0.001 rad, or a new mode), `idleHz`
 * otherwise, so a still camera still says it's here.
 */
export function createPosePublisher({ awareness, now = () => performance.now(), movingHz = 10, idleHz = 1 }) {
  let lastSent = -Infinity
  let lastPose = null

  function moved(pose) {
    if (!lastPose) return true
    if (dist(pose.p, lastPose.p) > 0.01) return true
    const dot = Math.abs(pose.q.reduce((sum, v, i) => sum + v * lastPose.q[i], 0))
    return (
      2 * Math.acos(Math.min(1, dot)) > 0.001 ||
      pose.mode !== lastPose.mode ||
      pose.editing !== lastPose.editing
    )
  }

  function publish(pose) {
    const t = now()
    const interval = 1000 / (moved(pose) ? movingHz : idleHz)
    if (t - lastSent < interval) return
    lastSent = t
    lastPose = pose
    awareness.setLocalStateField('pose', { p: pose.p, q: pose.q, mode: pose.mode, editing: pose.editing })
  }

  return { publish }
}
