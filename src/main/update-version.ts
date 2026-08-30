export function compareVersions(left: string, right: string): number {
  const numbers = (value: string): number[] => value.split(/[+-]/, 1)[0].split('.').map(Number)
  const a = numbers(left)
  const b = numbers(right)
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1
  }
  return 0
}
