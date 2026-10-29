import { ChevronsLeftRight } from 'lucide-react'
import type { UIState } from '@/lib/game/store'
import { cn } from '@/lib/utils'

export function Hud({ state }: { state: UIState }) {
  return (
    <>
      <div className="safe-pad pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Level</span>
            <span className="text-4xl font-extrabold leading-none tabular-nums">{state.level}</span>
          </div>
          {state.stepCount > 0 && (
            <ol className="flex items-center gap-1.5" aria-label={`${state.stepCount - state.stepIndex} gates left`}>
              {Array.from({ length: state.stepCount }, (_, i) => (
                <li
                  key={i}
                  className={cn(
                    'size-2.5 rounded-full',
                    i < state.stepIndex ? 'bg-primary' : i === state.stepIndex ? 'bg-foreground' : 'bg-foreground/25',
                  )}
                />
              ))}
            </ol>
          )}
        </div>

        <div className="flex min-h-8 justify-center pt-1" aria-live="polite">
          {state.blackout ? (
            <span className="rounded-sm bg-danger/90 px-3 py-1 text-sm font-bold uppercase tracking-[0.3em] text-white">
              Power failure
            </span>
          ) : state.banner ? (
            <span className="animate-in fade-in zoom-in-95 rounded-sm bg-background/60 px-4 py-1 text-xl font-extrabold uppercase tracking-[0.25em] backdrop-blur duration-300">
              {state.banner}
            </span>
          ) : null}
        </div>
      </div>

      {state.hint && (
        <div className="safe-pad pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center pb-10">
          <span className="flex items-center gap-2 rounded-full bg-background/55 px-4 py-2 text-sm font-semibold uppercase tracking-[0.25em] text-foreground/90 backdrop-blur animate-pulse">
            <ChevronsLeftRight className="size-5" aria-hidden />
            {state.hint}
          </span>
        </div>
      )}
    </>
  )
}
