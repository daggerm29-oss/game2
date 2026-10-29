# SKYWALK – progress log

Resume from here if a chat runs out of credits. Keep this file updated.

## Goal of the current change
Turn the door-choosing game into an **endless Temple-Run style runner**:
- Player auto-runs forever on an endless steel deck above the city (third-person, chained runner).
- A sign on the LEFT of the walkway shows a new emoji sequence each round while running, then goes dark.
- Gates (2 doorways, 3 from level 5) rush at the player; steer (swipe/drag, A/D, arrows) into the doorway whose face matches sequence[N].
- Correct -> door opens + flash, keep running. After the last gate the next round's sign appears ahead
  with a NEW sequence (emoji keep changing), longer + faster. No fades / stops between levels -> never ends
  until the player picks a wrong door (trap floor fall) or hits the wall between doorways (collision fall).
- No CHOOSE state, no LEFT/RIGHT buttons, no countdown bar. HUD = level + gate dots + level-1 "swipe to steer".

## Architecture decisions
- `lib/shared/game.ts` holds `runnerSpeed`, `gateGap`, `signLead` etc. so client and server agree on timing.
- Server (`lib/server/runs.ts`) still generates sequence + gate lane layouts and signs a round token.
  Client posts `{ step, lane, clientMs }` per gate (queued, sequential). Server verifies lane vs face and
  rejects impossible timings. When the final gate of a round is verified the response includes the
  NEXT round (`next`), so the track can be extended without any pause.
- `lib/server/redis.ts` falls back to an in-memory store when Upstash credentials are missing (dev/preview only).
- `lib/game/render/track.ts` (replaces level.ts) = endless track: appends round segments (sign + gates) ahead,
  filler deck when the next round has not arrived, disposes segments far behind.
- `lib/game/render/runner.ts` = low-poly runner figure + verlet chain trailing behind.
- City + fog layers follow the player so the world never runs out.

## Status
- [x] Repo copied from GitHub into the v0 project
- [x] shared/game.ts runner timing + DTO changes
- [x] server rounds/runs/answer route + redis memory fallback (next round delivered on gate 0 of each round)
- [x] render/track.ts, render/runner.ts, world.ts updates (level.ts deleted)
- [x] input.ts steering, store.ts (touch-controls.tsx deleted)
- [x] game.ts rewrite (state machine: LOADING, MENU, SIGN_PHASE, GATE_PHASE, LEVEL_COMPLETE, FALL, RESULT)
- [x] hud.tsx, game-root.tsx, result/menu copy
- [x] typecheck + browser test (level 1 -> level 2 with a new sequence, wrong door -> fall -> server-verified RESULT)

## Removed
- `lib/game/render/level.ts` (replaced by `render/track.ts`)
- `components/game/touch-controls.tsx` (hold-to-walk + LEFT/RIGHT door buttons)
- Game: `CHOOSE`/`MEMORIZE`/`RUN` phases, `chooseSlot`, `setWalkButton`, `handleChoice`, `handleTap`, `submit`,
  `updateChoose`, door countdown/timer bar; shared `stepTimeMs`, `doorCountRange`; server `issueRound`, `submitAnswer`.

## Possible next steps
- Tune difficulty numbers in `lib/shared/game.ts` (speed, gate gap, display time).
- Optional tilt steering via DeviceOrientation.
