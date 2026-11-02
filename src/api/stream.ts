import { KindroidError, isAbort, type KindroidErrorKind } from "./errors"

/** Prefix of a 200 body whose generation failed. Only meaningful at the start of the reply. */
export const ERROR_MARKER = "<<ERROR>>"
/** Marks an HTTP-level failure after the 200 was already sent. Can appear anywhere in the stream. */
export const HTTP_ERROR_MARKER = "<<HTTP_ERROR>>"

const START_MARKERS: ReadonlyArray<readonly [string, KindroidErrorKind]> = [
  [HTTP_ERROR_MARKER, "stream"],
  [ERROR_MARKER, "generation"],
]

/** Length of the longest suffix of `text` that is a proper prefix of `marker`. */
export function partialMarkerSuffix(text: string, marker: string): number {
  for (let n = Math.min(text.length, marker.length - 1); n > 0; n--) {
    if (marker.startsWith(text.slice(text.length - n))) return n
  }
  return 0
}

/**
 * Turn a Kindroid streaming body (plain text chunks, not SSE) into an async sequence of text chunks.
 *
 * - Leading whitespace keep-alive bytes are dropped.
 * - A reply that starts with `<<ERROR>>` or `<<HTTP_ERROR>>` throws instead of yielding, even when the
 *   marker is split across network chunks.
 * - `<<HTTP_ERROR>>` anywhere later throws a `stream` error carrying the text already yielded.
 * - An abort or network failure mid-stream throws with the partial text attached.
 */
export async function* parseKindroidStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let phase: "leading" | "probing" | "body" = "leading"
  let pending = ""
  let emitted = ""
  let finished = false

  const readRest = async (): Promise<string> => {
    let rest = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return rest + decoder.decode()
      rest += decoder.decode(value, { stream: true })
    }
  }

  try {
    for (;;) {
      let result: Awaited<ReturnType<typeof reader.read>>
      try {
        result = await reader.read()
      } catch (err) {
        finished = true
        if (isAbort(err)) throw new KindroidError("aborted", { partial: emitted + pending })
        throw new KindroidError("stream", { detail: String((err as Error)?.message ?? err), partial: emitted + pending })
      }
      const done = result.done
      let chunk = done ? decoder.decode() : decoder.decode(result.value, { stream: true })

      if (phase === "leading") {
        chunk = chunk.replace(/^\s+/, "")
        if (chunk.length === 0) {
          if (done) {
            finished = true
            return
          }
          continue
        }
        phase = "probing"
      }

      pending += chunk

      if (phase === "probing") {
        for (const [marker, kind] of START_MARKERS) {
          if (pending.startsWith(marker)) {
            const rest = pending.slice(marker.length) + (done ? "" : await readRest())
            finished = true
            throw new KindroidError(kind, { detail: rest.trim() || undefined })
          }
        }
        const mightBeMarker = START_MARKERS.some(([marker]) => marker.startsWith(pending))
        if (mightBeMarker && !done) continue
        phase = "body"
      }

      const idx = pending.indexOf(HTTP_ERROR_MARKER)
      if (idx >= 0) {
        const before = pending.slice(0, idx)
        if (before) {
          emitted += before
          yield before
        }
        const rest = pending.slice(idx + HTTP_ERROR_MARKER.length) + (done ? "" : await readRest())
        finished = true
        throw new KindroidError("stream", { detail: rest.trim() || undefined, partial: emitted })
      }

      const hold = done ? 0 : partialMarkerSuffix(pending, HTTP_ERROR_MARKER)
      const out = pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      if (out) {
        emitted += out
        yield out
      }
      if (done) {
        finished = true
        return
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Consume a reply stream, reporting each chunk, and resolve with the full text. */
export async function collectStream(chunks: AsyncIterable<string>, onChunk?: (chunk: string, soFar: string) => void): Promise<string> {
  let text = ""
  for await (const chunk of chunks) {
    text += chunk
    onChunk?.(chunk, text)
  }
  return text
}
