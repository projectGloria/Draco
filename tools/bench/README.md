# Renderer list baseline

Run `npm run bench:list -- --output=tools/bench/results/new-run.json` from the repository root. The fixture constructs 1, 10, 100, and 1,000 tasks and measures name sorting, numeric sorting, and one changed progress update. It records the CPU, Node version, memory, CPU time, and event-loop delay. Each case uses 12 rounds of 250 operations; the first two rounds warm up the JIT. Keep the same fixture and machine when comparing results.

The recorded Windows baseline uses an Intel i7-11800H with 16 logical CPUs and Node 26.9.0:

| 1,000 tasks, median per operation | Before | Reused collator |
| --- | ---: | ---: |
| Natural name sort | 8.16 ms | 0.44 ms |
| Speed sort | 0.030 ms | 0.028 ms |
| One-task progress update | 0.039 ms | 0.037 ms |

See `results/list-baseline.json` and `results/list-collator.json` for raw output. Name sorting was the measured hotspot; the progress map is small enough here that replacing the whole state structure would be premature. The event-loop delay figures include deliberately long synchronous benchmark rounds, so they do not represent ordinary UI latency.

This script excludes React rendering, browser layout and paint, filesystem writes, and transfer traffic. The plan still needs a browser UI responsiveness fixture, sustained HTTP transfers, large HLS pieces, and multiple torrents before release budgets can be set.

## Local HTTP transfer baseline

Run `npm run bench:http -- --output=tools/bench/results/new-http-run.json`. It starts a local range-capable server, downloads a fixed 8 MiB body through the real `DownloadManager` at 1, 2, 4, and 8 concurrent tasks, checks every completed file's SHA-256, and removes its isolated temporary directory. The server sends 64 KiB chunks every 3 ms per response so cancellation of an adaptive split can stop its old range.

The i7-11800H baseline in `results/http-baseline.json` reached roughly 11, 27, 59, and 113 MiB/s of verified output respectively. At eight tasks, the server handed about 69 MiB of body data to its sockets for 64 MiB of finished files. This count includes probe bytes and in-flight split overlap; it is not a packet-level network measurement. Each run records CPU time, peak process heap/RSS, event-loop lag, request ranges, and output bytes. The 8 MiB fixture emphasizes startup and scheduling; a larger sustained transfer, disk-write instrumentation, HLS, and torrent cases remain to be measured.
