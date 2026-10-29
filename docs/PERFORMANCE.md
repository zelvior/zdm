# How ZDM downloads fast

## Blocks, not fixed segments

A file that supports byte ranges is cut into sequential blocks. Idle connections take the next block, so faster connections
automatically carry more of the file.

| File size | Largest block |
|---|---|
| under 1 GiB | 4 MB |
| from 1 GiB | 16 MB |
| from 16 GiB | 32 MB |
| from 128 GiB | 64 MB |

The smallest block is 2 MB. A 500 GB file needs about 8,000 requests instead of about 125,000. The actual size follows each
connection's speed (about 1.5 seconds of data) and is capped by the memory budget (Options, default 256 MB), which shrinks blocks toward
2 MB when many connections run. A file needs at least 2 MB per connection to use them all; files under 4 MB use temporary part files.

## Memory safety

Each block is aggregated in a `Buffer.allocUnsafe()`-backed buffer. The buffer only hands out its bytes for a disk write after every byte
was overwritten with received data, so uninitialised memory can never reach a file. A connection that dies half-way resumes from the
filled offset; an incomplete block is discarded, never written.

## Writing

Completed blocks wait in an in-memory queue and are written in ascending file order, two at a time, directly into the pre-sized final file.
There are no temporary parts and no merge step. Every write opens its own short-lived handle, so nothing holds the file open when it is
renamed. Progress is checkpointed (flushed to disk) every two seconds; on resume only the gaps are fetched.

## Adaptive behaviour

- **Slow connections** far below their peers are aborted mid-block and replaced; their block goes back to the queue.
- **Mirrors** you add are probed (same size required); faster mirrors get more blocks, slow ones only occasional probes.
- **Stragglers:** when only a few blocks remain, an idle fast connection duplicates the slowest block; the first copy wins.
- **HTTP 429 / 503:** the server's connection count is halved (never below 1), `Retry-After` is honoured, the download moves to one
  multiplexed HTTP/2 session, and connections creep back up once the server stays calm.

## Network

HTTP/1.1 and HTTP/2 are negotiated with ALPN. HTTP/2 sessions use enlarged flow-control windows (8 MB per stream, 64 MB per session);
sockets use keep-alive and `TCP_NODELAY`. DNS answers are cached (5 minutes fresh, 1 hour stale-while-revalidate) and hostnames are
resolved when a download is added. Network and disk work run in worker threads so the window stays responsive. ZDM does not use HTTP/3.

## Integrity

SHA-256 and MD5 are computed in a worker thread over the contiguous, fully written prefix while the download runs, so the digest is ready
the moment the last block lands. A checksum you enter must match, otherwise the file is discarded. A digest announced by the server only
produces a warning.
