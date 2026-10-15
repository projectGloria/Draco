// dl.ts reads its arguments with `process.argv.slice(2)`, so the rewrite here
// must keep argv[1] (this script) in place or the first user argument is
// silently swallowed as it becomes the "script" slot.
console.log('audit wrapper argv', process.argv)
process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(2)]
await import('./dl.ts')
