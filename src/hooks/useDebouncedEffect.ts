import { useEffect, useRef } from 'react'

export function useDebouncedEffect(callback: () => void, deps: unknown[], delayMs: number): void {
  const isFirstRun = useRef(true)

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      callback()
      return
    }
    const id = setTimeout(callback, delayMs)
    return () => clearTimeout(id)
  }, deps)
}
