/** Exact area footprints in native pixel-edge coordinates; centers stay at i + 0.5. */
export function areaContributions(native: number, reduced: number): [number, number][][] {
  const scale = native / reduced
  return Array.from({ length: native }, (_, i) => {
    const first = Math.floor(i / scale)
    const last = Math.min(reduced - 1, Math.ceil((i + 1) / scale) - 1)
    const result: [number, number][] = []
    for (let cell = first; cell <= last; cell++) {
      const weight = Math.min(i + 1, (cell + 1) * scale) - Math.max(i, cell * scale)
      if (weight > 1e-10) result.push([cell, weight])
    }
    return result
  })
}
