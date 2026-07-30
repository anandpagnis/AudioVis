import { useEffect } from 'react'

/**
 * Frees GPU resources when a scene unmounts. R3F auto-disposes JSX-created
 * geometries, but materials/geometries we construct ourselves (useMemo +
 * <primitive>) are our responsibility — without this, every scene switch
 * would leak shader programs and vertex buffers.
 */
export function useDispose(...items: Array<{ dispose: () => void }>) {
  useEffect(() => {
    return () => {
      for (const item of items) item.dispose()
    }
    // The items come from useMemo(..., []) — stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
