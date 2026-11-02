import { describe, expect, test } from "bun:test"
import { KindroidError } from "../src/api/errors"
import { collectStream, parseKindroidStream, partialMarkerSuffix } from "../src/api/stream"

const enc = new TextEncoder()

function bodyOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c)
      controller.close()
    },
  })
}

async function run(chunks: Array<string | Uint8Array>) {
  const seen: string[] = []
  const text = await collectStream(parseKindroidStream(bodyOf(chunks)), (c) => seen.push(c))
  return { text, seen }
}

async function failure(chunks: Array<string | Uint8Array>): Promise<KindroidError> {
  try {
    await run(chunks)
  } catch (err) {
    expect(err).toBeInstanceOf(KindroidError)
    return err as KindroidError
  }
  throw new Error("expected the stream to fail")
}

describe("partialMarkerSuffix", () => {
  test("finds the longest proper prefix at the end", () => {
    expect(partialMarkerSuffix("hello <<HT", "<<HTTP_ERROR>>")).toBe(4)
    expect(partialMarkerSuffix("hello <", "<<HTTP_ERROR>>")).toBe(1)
    expect(partialMarkerSuffix("hello", "<<HTTP_ERROR>>")).toBe(0)
  })
})

describe("parseKindroidStream", () => {
  test("passes plain chunks through", async () => {
    const { text, seen } = await run(["Hi ", "there", "!"])
    expect(text).toBe("Hi there!")
    expect(seen.length).toBe(3)
  })

  test("drops leading whitespace keep-alives", async () => {
    const { text } = await run([" ", "\n ", "  ", "Hello", " world"])
    expect(text).toBe("Hello world")
  })

  test("keeps whitespace inside the reply", async () => {
    const { text } = await run(["Hello", "  ", "\n\nworld "])
    expect(text).toBe("Hello  \n\nworld ")
  })

  test("whitespace-only body yields nothing", async () => {
    const { text } = await run([" ", " "])
    expect(text).toBe("")
  })

  test("<<ERROR>> prefix throws a generation error", async () => {
    const err = await failure(["<<ERROR>> model overloaded"])
    expect(err.kind).toBe("generation")
    expect(err.detail).toBe("model overloaded")
  })

  test("<<ERROR>> prefix split across chunks after keep-alives", async () => {
    const err = await failure(["  ", "<<E", "RR", "OR>>", " boom"])
    expect(err.kind).toBe("generation")
    expect(err.detail).toBe("boom")
  })

  test("<<HTTP_ERROR>> at the start throws a stream error", async () => {
    const err = await failure(["<<HTTP_", "ERROR>>500"])
    expect(err.kind).toBe("stream")
    expect(err.detail).toBe("500")
  })

  test("text that merely starts with << is not an error", async () => {
    const { text } = await run(["<<", "wink>> hi"])
    expect(text).toBe("<<wink>> hi")
  })

  test("short reply that is a marker prefix is still delivered", async () => {
    const { text } = await run(["<<"])
    expect(text).toBe("<<")
  })

  test("mid-stream <<HTTP_ERROR>> keeps the partial text", async () => {
    const err = await failure(["Once upon ", "a time<<HTTP_ER", "ROR>>upstream reset"])
    expect(err.kind).toBe("stream")
    expect(err.partial).toBe("Once upon a time")
    expect(err.detail).toBe("upstream reset")
  })

  test("a held-back marker prefix is released when it turns out to be text", async () => {
    const { text, seen } = await run(["a <<HT", "ML>> b"])
    expect(text).toBe("a <<HTML>> b")
    expect(seen[0]).toBe("a ")
  })

  test("multi-byte characters split across chunks decode correctly", async () => {
    const bytes = enc.encode("café ☕")
    const { text } = await run([bytes.slice(0, 4), bytes.slice(4, 7), bytes.slice(7)])
    expect(text).toBe("café ☕")
  })

  test("a mid-stream network failure keeps the partial text", async () => {
    let n = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(enc.encode("partial"))
        else controller.error(new TypeError("socket hang up"))
      },
    })
    const chunks: string[] = []
    try {
      for await (const c of parseKindroidStream(body)) chunks.push(c)
      throw new Error("expected failure")
    } catch (err) {
      expect((err as KindroidError).kind).toBe("stream")
      expect((err as KindroidError).partial).toBe("partial")
    }
  })

  test("an abort mid-stream reports aborted with partial text", async () => {
    let n = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n++ === 0) controller.enqueue(enc.encode("so far"))
        else controller.error(new DOMException("aborted", "AbortError"))
      },
    })
    try {
      for await (const _ of parseKindroidStream(body)) {
      }
      throw new Error("expected failure")
    } catch (err) {
      expect((err as KindroidError).kind).toBe("aborted")
      expect((err as KindroidError).partial).toBe("so far")
    }
  })
})
