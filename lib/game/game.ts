import * as THREE from 'three'
import {
  type AnswerResponse,
  type FailReason,
  type RoundDTO,
  START_RUNUP,
  TRACK_HALF,
  doorwayWidth,
  laneCenter,
  roundLayout,
} from '@/lib/shared/game'
import { ApiError, api } from './api'
import { AudioEngine } from './audio'
import { Input } from './input'
import { ResolutionScaler, TIERS, downgrade, guessTier } from './quality'
import { type TrackGate, type TrackRound, sToZ } from './render/track'
import { World } from './render/world'
import {
  type GameStore,
  type Phase,
  type QualitySetting,
  RUNNING_PHASES,
  type Tier,
  createStore,
  initialUIState,
} from './store'
import { telegram } from './telegram'

const QUALITY_KEY = 'skywalk-quality'
const RUNNER_RADIUS = 0.2
const STEER_LIMIT = TRACK_HALF - 0.3
const START_S = -4

const DEMO_ROUND: TrackRound['dto'] = {
  level: 1,
  sequence: ['smile', 'angry', 'frown'],
  displayMs: 3000,
  layout: roundLayout(1, 3),
  steps: [
    { faces: ['smile', 'frown'], preSwap: null },
    { faces: ['flat', 'angry'], preSwap: null },
    { faces: ['frown', 'smile'], preSwap: null },
  ],
  modifiers: { decoys: false, fakeSign: null, blackouts: [] },
}

interface FallState {
  kind: 'trap' | 'wall'
  t: number
  vx: number
  vy: number
  forward: number
  grounded: boolean
  spin: number
  hapticStep: number
  anchorS: number
  laneX: number
}

class BootCancelled extends Error {}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const smooth = (t: number) => t * t * (3 - 2 * t)
const damp = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt))

export class Game {
  store: GameStore = createStore({ ...initialUIState })
  private world!: World
  private audio = new AudioEngine()
  private input = new Input()
  private scaler!: ResolutionScaler

  private phase: Phase = 'LOADING'
  private raf = 0
  private last = 0
  private time = 0
  private destroyed = false

  private runId: string | null = null
  private runEpoch = 0
  private serverChain: Promise<void> = Promise.resolve()
  private runClockMs = 0
  private activeRound: TrackRound | null = null
  private entered = new Set<TrackRound>()
  private signTimer = 0
  private blackoutLeft = 0
  private bannerLeft = 0
  private pruneTimer = 0

  private player = { s: START_S, x: 0, targetX: 0, vx: 0, y: 0, speed: 0, stepPhase: 0 }
  private camState = { pos: new THREE.Vector3(4.5, 2.4, 4), look: new THREE.Vector3(0, 1.4, -12), fov: 66, roll: 0 }
  private fall: FallState | null = null
  private stress = 0
  private fade = 1
  private fadeTarget = 0
  private uiAccum = 0
  private bench: { frames: number; target: number; time: number; resolve: (ms: number) => void } | null = null
  private qualitySetting: QualitySetting = 'auto'
  private finalResult: { result: AnswerResponse & { result: 'wrong' } } | null = null

  async boot(container: HTMLElement) {
    const inTelegram = telegram.init()
    this.store.set({ inTelegram, groupLaunch: Boolean(telegram.startParam) })
    try {
      this.qualitySetting = (localStorage.getItem(QUALITY_KEY) as QualitySetting | null) ?? 'auto'
    } catch {
      this.qualitySetting = 'auto'
    }

    const progress = async (fraction: number, label: string) => {
      this.store.set({ loadingProgress: fraction, loadingLabel: label })
      // Yield so the loading screen can paint between heavy steps.
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      if (this.destroyed) throw new BootCancelled()
    }

    try {
      await this.bootSteps(container, progress)
    } catch (error) {
      if (error instanceof BootCancelled) return
      console.error('[skywalk] boot failed', error)
      this.store.set({ error: error instanceof Error ? error.message : 'Failed to start the game' })
    }
  }

  private async bootSteps(container: HTMLElement, progress: (fraction: number, label: string) => Promise<void>) {
    await progress(0.05, 'Checking your device')
    const probe = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
    if (!probe) {
      this.store.set({ error: 'WebGL is not available on this device.' })
      return
    }
    let tier: Tier = this.qualitySetting === 'auto' ? guessTier(probe) : this.qualitySetting
    probe.getExtension('WEBGL_lose_context')?.loseContext()

    this.world = new World(container, tier)
    this.scaler = new ResolutionScaler(TIERS[tier])
    this.world.onLightning = (distance) => {
      this.audio.thunder(distance)
      if (distance < 0.3 && this.phase !== 'MENU') telegram.impact('soft')
    }
    await this.world.init(progress)
    this.buildDemo()

    this.input.attach(container)
    this.input.onAnyGesture = () => this.audio.unlock()

    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)

    if (this.qualitySetting === 'auto') {
      await progress(0.85, 'Benchmarking')
      for (let attempt = 0; attempt < 2 && tier !== 'low'; attempt++) {
        const ms = await this.measure(40)
        const budget = 1000 / (TIERS[tier].targetFps * 0.8)
        if (ms <= budget) break
        tier = downgrade(tier)
        this.world.applyTier(tier)
        this.scaler.setConfig(TIERS[tier])
      }
    }
    this.store.set({ tier, qualitySetting: this.qualitySetting })
    await progress(1, 'Ready')
    this.setPhase('MENU')
  }

  /** Average frame time in ms over `frames` frames, skipping a short warm-up. */
  private measure(frames: number) {
    return new Promise<number>((resolve) => {
      this.bench = { frames: -5, target: frames, time: 0, resolve }
    })
  }

  setQuality(setting: QualitySetting) {
    this.qualitySetting = setting
    try {
      localStorage.setItem(QUALITY_KEY, setting)
    } catch {}
    const tier = setting === 'auto' ? guessTier(this.world.gl) : setting
    this.world.applyTier(tier)
    this.scaler.setConfig(TIERS[tier])
    this.store.set({ qualitySetting: setting, tier })
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted)
  }

  /** Idle scene for the menu: a lit sign and a gate ahead of the waiting runner. */
  private buildDemo() {
    const track = this.world.resetTrack()
    const round = track.appendRound(DEMO_ROUND, START_RUNUP)
    round.sign.target = 0.55
    this.world.activeRound = round
    this.activeRound = null
    this.entered.clear()
    this.player = { s: START_S, x: 0, targetX: 0, vx: 0, y: 0, speed: 0, stepPhase: 0 }
    this.world.runner.reset(0, sToZ(START_S))
    this.world.runner.setVisible(true)
  }

  // ---------- Run flow ----------

  async startRun() {
    if (this.store.get().busy) return
    this.audio.unlock()
    this.store.set({ busy: true, error: null, result: null, overlay: 'none' })
    try {
      const run = await api.startRun()
      if (this.destroyed) return
      this.runEpoch += 1
      this.runId = run.runId
      this.serverChain = Promise.resolve()
      this.finalResult = null
      this.fall = null
      this.runClockMs = 0
      this.store.set({ guest: run.guest, groupLaunch: run.groupLaunch, playerName: run.player.name, level: run.round.level })
      telegram.setClosingConfirmation(true)

      const track = this.world.resetTrack()
      track.appendRound(run.round, START_RUNUP)
      this.entered.clear()
      this.activeRound = null
      this.world.activeRound = null
      this.player = { s: START_S, x: 0, targetX: 0, vx: 0, y: 0, speed: 0, stepPhase: 0 }
      this.world.runner.reset(0, sToZ(START_S))
      this.world.runner.setVisible(true)
      this.input.flush()
      this.input.steeredDistance = 0
      this.clearBlackout()
      this.fadeTarget = 0
      this.showBanner(`Level ${run.round.level}`)
      this.setPhase('LEVEL_COMPLETE')
    } catch (error) {
      this.showError(error)
    } finally {
      this.store.set({ busy: false })
    }
  }

  quitToMenu() {
    if (this.runId && RUNNING_PHASES.includes(this.phase)) {
      const round = this.activeRound ?? this.world.track?.rounds[0]
      if (round?.dto.roundId) this.sendGate(round, round.gates.find((g) => !g.passed)?.index ?? 0, -2)
    }
    this.runId = null
    this.runEpoch += 1
    this.fall = null
    this.clearBlackout()
    telegram.setClosingConfirmation(false)
    this.audio.setMuffled(false)
    this.audio.setHeartRate(0)
    this.buildDemo()
    this.store.set({ result: null, overlay: 'none', banner: '' })
    this.setPhase('MENU')
  }

  private showError(error: unknown) {
    const message = error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong'
    this.store.set({ error: message })
    this.quitToMenu()
  }

  private showBanner(text: string) {
    this.bannerLeft = 1.6
    this.store.set({ banner: text })
  }

  private setPhase(phase: Phase) {
    this.phase = phase
    switch (phase) {
      case 'MENU':
        this.fadeTarget = 0
        this.stress = 0
        this.audio.setHeartRate(0)
        this.audio.setWind(0.35)
        this.store.set({ hint: '', blackout: false, banner: '' })
        break
      case 'SIGN_PHASE':
        this.store.set({ hint: this.store.get().level === 1 && this.input.steeredDistance < 2 ? 'Swipe to steer' : '' })
        break
      case 'GATE_PHASE':
      case 'LEVEL_COMPLETE':
        break
      case 'FALL':
        this.audio.fall()
        telegram.impact('heavy')
        this.store.set({ hint: '', banner: '' })
        break
      case 'RESULT': {
        this.audio.impact()
        telegram.notify('error')
        telegram.setClosingConfirmation(false)
        this.clearBlackout()
        const verdict = this.finalResult?.result
        if (verdict) this.store.set({ result: { ...verdict.final, reason: verdict.reason } })
        this.runId = null
        this.buildDemo()
        this.fadeTarget = 0.35
        break
      }
    }
    this.store.set({ phase })
  }

  private enterRound(round: TrackRound) {
    this.entered.add(round)
    this.activeRound = round
    this.world.activeRound = round
    const { dto } = round
    round.sign.target = 1
    round.sign.flicker = 0
    if (round.fakeSign) {
      round.fakeSign.target = 1
      round.fakeSign.flicker = 1
    }
    this.signTimer = dto.displayMs / 1000
    this.audio.signOn()
    this.audio.setMuffled(true)
    this.audio.setWind(Math.min(1, 0.3 + dto.level * 0.06))
    telegram.impact('heavy')
    if (dto.level !== this.store.get().level) this.showBanner(`Level ${dto.level}`)
    this.store.set({ level: dto.level, stepIndex: 0, stepCount: dto.steps.length })
    this.setPhase('SIGN_PHASE')
  }

  private hideSign(round: TrackRound) {
    round.sign.target = 0
    round.sign.flicker = 0.6
    if (round.fakeSign) round.fakeSign.target = 0
    this.audio.signOff()
    this.audio.setMuffled(false)
    telegram.impact('light')
  }

  private clearBlackout() {
    this.blackoutLeft = 0
    if (this.world) this.world.blackout = false
    this.store.set({ blackout: false })
  }

  // ---------- Server verification ----------

  /** Gate passes are sent strictly in order; the server verifies lane and timing. */
  private sendGate(round: TrackRound, step: number, lane: number) {
    const { roundId, token } = round.dto
    const runId = this.runId
    if (!runId || !roundId || !token) return
    const epoch = this.runEpoch
    const clientMs = Math.round(this.runClockMs)
    this.serverChain = this.serverChain
      .then(async () => {
        const verdict = await api.gate({ runId, roundId, token, step, lane, clientMs })
        if (epoch !== this.runEpoch) return
        this.handleVerdict(verdict)
      })
      .catch((error) => {
        if (epoch !== this.runEpoch) return
        console.error('[skywalk] gate verification failed', error)
        this.showError(error)
      })
  }

  private handleVerdict(verdict: AnswerResponse) {
    const track = this.world.track
    if (verdict.result === 'correct') {
      if (verdict.next && track) track.appendRound(verdict.next, this.player.s + 25)
      return
    }
    this.finalResult = { result: verdict }
    // The server disagreed with a pass the client accepted (e.g. implausible timing): fall anyway.
    if (this.phase !== 'FALL' && this.phase !== 'RESULT') this.startFall(verdict.reason === 'wrong_door' ? 'trap' : 'wall')
  }

  // ---------- Frame loop ----------

  private frame = (now: number) => {
    if (this.destroyed) return
    this.raf = requestAnimationFrame(this.frame)
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000))
    this.last = now
    this.time += dt

    if (this.bench) {
      this.bench.frames += 1
      if (this.bench.frames > 0) this.bench.time += dt
      if (this.bench.frames >= this.bench.target) {
        const ms = (this.bench.time / this.bench.frames) * 1000
        const { resolve } = this.bench
        this.bench = null
        resolve(ms)
      }
    }

    if (RUNNING_PHASES.includes(this.phase)) this.updateRunning(dt)
    else if (this.phase === 'FALL') this.updateFall(dt)
    else {
      this.stress = damp(this.stress, 0, 2, dt)
      this.input.flush()
    }

    this.updateGates(dt)
    this.updateTimers(dt)
    this.updateRunner(dt)
    this.updateCamera(dt)
    this.fade = damp(this.fade, this.fadeTarget, this.fadeTarget > this.fade ? 7 : 3, dt)

    this.world.update(dt, this.time, sToZ(this.player.s))
    this.world.render(this.time, this.stress, this.fade)

    const ratio = this.scaler.sample(dt)
    if (ratio !== null) this.world.setPixelRatio(ratio)
    if (
      this.qualitySetting === 'auto' &&
      this.scaler.slowStreak >= 4 &&
      this.world.tier !== 'low' &&
      (this.phase === 'MENU' || this.phase === 'RESULT' || this.phase === 'LEVEL_COMPLETE')
    ) {
      const tier = downgrade(this.world.tier)
      this.world.applyTier(tier)
      this.scaler.setConfig(TIERS[tier])
      this.store.set({ tier })
    }

    this.uiAccum += dt
    if (this.uiAccum > 0.08) {
      this.uiAccum = 0
      this.store.set({ stress: Math.round(this.stress * 20) / 20, fps: Math.round(this.scaler.fps) })
    }
  }

  private updateTimers(dt: number) {
    if (this.bannerLeft > 0) {
      this.bannerLeft -= dt
      if (this.bannerLeft <= 0) this.store.set({ banner: '' })
    }
    if (this.blackoutLeft > 0) {
      this.blackoutLeft -= dt
      if (this.blackoutLeft <= 0) this.clearBlackout()
    }
  }

  private nextGate(): TrackGate | null {
    return this.activeRound?.gates.find((g) => !g.passed) ?? null
  }

  private laneOf(x: number, lanes: number) {
    const width = (TRACK_HALF * 2) / lanes
    return Math.min(lanes - 1, Math.max(0, Math.floor((x + TRACK_HALF) / width)))
  }

  private updateRunning(dt: number) {
    const track = this.world.track
    if (!track) return
    const p = this.player

    // Constant per-level speed; the first round's speed applies to the run-up too.
    const upcoming = track.rounds.find((r) => !this.entered.has(r))
    const targetSpeed = (this.activeRound ?? upcoming)?.dto.layout.speed ?? 7.5
    p.speed = damp(p.speed, targetSpeed, p.speed < 2 ? 2.4 : 1.2, dt)
    p.s += p.speed * dt
    this.runClockMs += dt * 1000

    const prevX = p.x
    p.targetX = THREE.MathUtils.clamp(p.targetX + this.input.consumeSteer(dt), -STEER_LIMIT, STEER_LIMIT)
    p.x = damp(p.x, p.targetX, 9, dt)
    p.vx = (p.x - prevX) / dt
    if (this.store.get().hint && this.input.steeredDistance > 2.5) this.store.set({ hint: '' })

    if (upcoming && p.s >= upcoming.startS) {
      if (this.activeRound && this.activeRound.sign.target > 0) this.hideSign(this.activeRound)
      this.enterRound(upcoming)
    }

    const round = this.activeRound
    if (this.phase === 'SIGN_PHASE' && round) {
      this.signTimer -= dt
      if (this.signTimer <= 0 || p.s > round.startS + round.dto.layout.signAt + 1) {
        this.hideSign(round)
        this.setPhase('GATE_PHASE')
      }
    }

    const gate = this.nextGate()
    if (gate && round) {
      const dist = gate.s - p.s
      const gap = round.dto.layout.gateGap
      const near = 1 - clamp01(dist / gap)
      this.stress = damp(this.stress, 0.2 + near * 0.6, 3, dt)
      this.audio.setHeartRate(75 + near * 85)

      if (gate.swapT < 1 && !gate.swapping && this.phase === 'GATE_PHASE' && dist < Math.max(16, p.speed * 1.6)) {
        gate.swapping = true
        this.audio.creak(1)
        telegram.impact('rigid')
      }
      const blackout = round.dto.modifiers.blackouts.find((b) => b.step === gate.index)
      if (blackout && !gate.blackoutDone && dist < p.speed * 1.1) {
        gate.blackoutDone = true
        this.blackoutLeft = blackout.durationMs / 1000
        this.world.blackout = true
        this.world.strikeSoon(0.15)
        this.audio.signOff()
        this.store.set({ blackout: true })
        telegram.impact('medium')
      }
      if (p.s >= gate.s) this.resolveGate(round, gate)
    } else {
      this.stress = damp(this.stress, 0.15, 2, dt)
      this.audio.setHeartRate(72)
    }

    track.ensureAhead(p.s)
    this.pruneTimer -= dt
    if (this.pruneTimer <= 0) {
      this.pruneTimer = 1
      track.prune(p.s)
    }
  }

  private resolveGate(round: TrackRound, gate: TrackGate) {
    const p = this.player
    gate.passed = true
    gate.swapT = 1
    gate.swapping = false
    const lane = this.laneOf(p.x, gate.lanes)
    const center = laneCenter(lane, gate.lanes)
    const inDoorway = Math.abs(p.x - center) <= doorwayWidth(gate.lanes) / 2 - RUNNER_RADIUS
    const correct = inDoorway && gate.faces[lane] === round.dto.sequence[gate.index]

    if (!inDoorway) {
      gate.passedLane = -1
      this.sendGate(round, gate.index, -1)
      this.audio.wrong()
      telegram.notify('error')
      this.startFall('wall')
      return
    }

    gate.passedLane = lane
    this.sendGate(round, gate.index, lane)
    if (!correct) {
      gate.traps[lane].t = 0.001
      this.audio.wrong()
      telegram.notify('error')
      this.startFall('trap')
      return
    }

    gate.doors[lane].openT = Math.max(gate.doors[lane].openT, 0.6)
    this.world.pulseDoor(center, sToZ(gate.s))
    this.audio.doorOpen()
    this.audio.correct()
    telegram.impact('light')
    const passed = gate.index + 1
    this.store.set({ stepIndex: passed })
    if (passed >= round.gates.length) {
      telegram.notify('success')
      this.showBanner(`Level ${round.dto.level} clear`)
      this.setPhase('LEVEL_COMPLETE')
    }
  }

  private startFall(kind: FallState['kind']) {
    const p = this.player
    const side = p.x === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(p.x)
    this.fall = {
      kind,
      t: 0,
      vx: kind === 'wall' ? side * 3.4 : p.vx * 0.2,
      vy: kind === 'wall' ? 0 : -0.5,
      forward: kind === 'wall' ? -2.5 : p.speed * 0.55,
      grounded: kind === 'wall',
      spin: (Math.random() - 0.5) * 1.6,
      hapticStep: 0,
      anchorS: p.s,
      laneX: p.x,
    }
    if (kind === 'wall') {
      this.stress = 1
      this.camState.roll += side * 0.08
    }
    this.clearBlackout()
    this.setPhase('FALL')
  }

  private updateFall(dt: number) {
    const f = this.fall
    const track = this.world.track
    if (!f || !track) return
    const p = this.player
    f.t += dt
    this.stress = 1
    p.speed = 0
    p.s += f.forward * dt
    f.forward = damp(f.forward, 0, 2.5, dt)
    if (f.grounded) {
      p.x += f.vx * dt
      f.vx *= 1 + dt * 1.2
      if (Math.abs(p.x) > track.halfWidthAt(p.s) + 0.15) f.grounded = false
    } else {
      f.vy = Math.max(-58, f.vy - 9.81 * 1.25 * dt)
      p.y += f.vy * dt
      p.x += f.vx * dt
    }
    const pulses = [0, 0.5, 1.0, 1.5]
    if (f.hapticStep < pulses.length && f.t >= pulses[f.hapticStep]) {
      telegram.impact(f.hapticStep === 0 ? 'heavy' : 'rigid')
      f.hapticStep += 1
    }
    if (f.t > 2.4) this.fadeTarget = 1
    if (f.t > 3.0 && this.fade > 0.9) {
      if (this.finalResult) {
        this.fall = null
        this.audio.resetAfterFall()
        this.setPhase('RESULT')
      } else if (f.t > 10) {
        this.showError(new Error('Lost connection to the tower. Try again.'))
      }
    }
  }

  /** Door panels, trap floors and lane swaps on every live gate. */
  private updateGates(dt: number) {
    const track = this.world.track
    if (!track) return
    const p = this.player
    const running = RUNNING_PHASES.includes(this.phase)
    for (const round of track.rounds) {
      for (const gate of round.gates) {
        if (gate.swapping) {
          gate.swapT = Math.min(1, gate.swapT + dt / 0.55)
          if (gate.swapT >= 1) gate.swapping = false
        }
        const k = smooth(clamp01(gate.swapT))
        for (const icon of gate.icons) icon.mesh.position.x = THREE.MathUtils.lerp(icon.fromX, icon.x, k)

        const dist = gate.s - p.s
        const lane = this.laneOf(p.x, gate.lanes)
        gate.doors.forEach((door, i) => {
          const open = gate.passed ? i === gate.passedLane : running && i === lane && dist < 7 && dist > -1
          door.openT = damp(door.openT, open ? 1 : 0, open ? 7 : 4, dt)
          door.pivot.rotation.y = smooth(clamp01(door.openT)) * 1.5
        })
        for (const trap of gate.traps) {
          if (trap.t > 0 && trap.t < 1) trap.t = Math.min(1, trap.t + dt / 0.22)
          trap.pivot.rotation.x = -smooth(trap.t) * 1.7
        }
      }
    }
  }

  private updateRunner(dt: number) {
    const p = this.player
    const track = this.world.track
    const airborne = this.phase === 'FALL' && !!this.fall && !this.fall.grounded
    if (p.speed > 1 && RUNNING_PHASES.includes(this.phase)) {
      const before = Math.sign(Math.sin(p.stepPhase))
      p.stepPhase += dt * (3.2 + p.speed * 1.05)
      if (Math.sign(Math.sin(p.stepPhase)) !== before) this.audio.footstep()
    }
    const floorAt = (x: number, z: number) => !!track && Math.abs(x) <= track.halfWidthAt(-z) + 0.05
    const visualSpeed = RUNNING_PHASES.includes(this.phase) ? p.speed : 0
    this.world.runner.update(dt, p.x, p.y, sToZ(p.s), visualSpeed, p.vx, airborne, floorAt)
  }

  private updateCamera(dt: number) {
    const cam = this.world.camera
    const p = this.player
    const c = this.camState
    const level = this.store.get().level
    const wind = Math.min(1, 0.3 + level * 0.06)
    const z = sToZ(p.s)
    const pos = new THREE.Vector3()
    const look = new THREE.Vector3()
    let fov = 66 - this.stress * 9
    let posRate = 6
    let roll = 0

    if (this.phase === 'MENU' || this.phase === 'RESULT' || this.phase === 'LOADING') {
      const sway = Math.sin(this.time * 0.09)
      pos.set(3.4 + sway * 1.2, 2.3 + Math.sin(this.time * 0.13) * 0.2, z + 4.2)
      look.set(-1.2 + sway * 0.8, 1.6, z - 18)
      fov = 64
      posRate = 2
    } else if (this.phase === 'FALL' && this.fall) {
      const f = this.fall
      const k = smooth(clamp01(f.t / 1.2))
      if (f.kind === 'trap') {
        // Stop in the open doorway and look down the hole as the runner drops into the city.
        pos.set(f.laneX, 2.6 - k * 0.4, sToZ(f.anchorS) + 1.4 - k * 0.9)
        look.set(p.x, p.y + 0.6, z - 0.6)
      } else {
        // Knocked back off the wall: hold above the edge and watch them go over.
        pos.set(p.x * 0.5, 3.1, sToZ(f.anchorS) + 4.8)
        look.set(p.x, p.y + 0.8, z)
      }
      c.roll += f.spin * dt * 0.25
      roll = c.roll
      fov = THREE.MathUtils.lerp(66, 92, k)
      posRate = 4
    } else {
      // Kept under the door lintel and inside the runner's doorway so it never clips through a gate wall.
      pos.set(p.x * 0.85, 2.75, z + 6.2)
      look.set(p.x * 0.9, 1.3, z - 9)
      const signLevel = this.activeRound?.sign.intensity ?? 0
      if (this.phase === 'SIGN_PHASE') {
        // Glance toward the sign on the left while it is lit.
        look.x -= 2.2 * signLevel
        look.y += 0.9 * signLevel
      }
      roll = THREE.MathUtils.clamp(-p.vx * 0.012, -0.08, 0.08)
      posRate = 10
    }

    // Wind sway, stronger at higher levels.
    const t = this.time
    const sway = (Math.sin(t * 0.7) * 0.6 + Math.sin(t * 1.9 + 1.2) * 0.3 + Math.sin(t * 4.3) * 0.1) * wind
    roll += sway * 0.012
    pos.x += Math.sin(t * 0.53) * 0.03 * wind

    if (RUNNING_PHASES.includes(this.phase) && this.world.track) {
      const margin = this.world.track.halfWidthAt(p.s) - Math.abs(p.x)
      const edge = clamp01((0.9 - margin) / 0.9)
      const shake = edge * 0.02 + this.stress * 0.006
      pos.x += (Math.random() - 0.5) * shake
      pos.y += (Math.random() - 0.5) * shake
      roll += (Math.random() - 0.5) * shake * 0.5
    }
    if (this.phase === 'FALL') {
      pos.x += (Math.random() - 0.5) * 0.06
      pos.y += (Math.random() - 0.5) * 0.06
    } else {
      c.roll = 0
    }

    // Snap rather than drift on large jumps (run start, return to menu).
    if (c.pos.distanceTo(pos) > 25) c.pos.copy(pos)
    if (c.look.distanceTo(look) > 25) c.look.copy(look)
    const kp = 1 - Math.exp(-posRate * dt)
    c.pos.lerp(pos, kp)
    c.look.lerp(look, 1 - Math.exp(-posRate * 1.2 * dt))
    c.fov = damp(c.fov, fov, 4, dt)
    cam.position.copy(c.pos)
    cam.lookAt(c.look)
    cam.rotateZ(roll)
    if (Math.abs(cam.fov - c.fov) > 0.01) {
      cam.fov = c.fov
      cam.updateProjectionMatrix()
    }
  }

  destroy() {
    this.destroyed = true
    this.runEpoch += 1
    cancelAnimationFrame(this.raf)
    this.input.dispose()
    this.audio.setHeartRate(0)
    this.world?.dispose()
  }
}

export type { FailReason, RoundDTO }
