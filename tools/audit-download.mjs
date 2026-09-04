console.log('audit wrapper argv', process.argv)
process.argv = [process.argv[0], ...process.argv.slice(2)]
await import('./dl.ts')
