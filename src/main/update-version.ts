export function compareVersions(left: string, right: string): number {
  const parts = (value: string): { release: number[]; prerelease: string[] } => {
    const [core, ...suffix] = value.split('+', 1)[0].split('-')
    return { release: core.split('.').map(Number), prerelease: suffix.length ? suffix.join('-').split('.') : [] }
  }
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index++) {
    if ((a.release[index] ?? 0) !== (b.release[index] ?? 0)) return (a.release[index] ?? 0) > (b.release[index] ?? 0) ? 1 : -1
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : BigInt(x) < BigInt(y) ? -1 : 0
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
