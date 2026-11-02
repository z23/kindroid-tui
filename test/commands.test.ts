import { describe, expect, test } from "bun:test"
import { parseComposerInput } from "../src/ui/commands"

describe("parseComposerInput", () => {
  test("ordinary text is a message", () => {
    expect(parseComposerInput("hello there")).toEqual({ kind: "message", text: "hello there" })
    expect(parseComposerInput("/ not a command")).toEqual({ kind: "message", text: "/ not a command" })
    expect(parseComposerInput("/123")).toEqual({ kind: "message", text: "/123" })
  })

  test("// sends a literal slash", () => {
    expect(parseComposerInput("//shrug")).toEqual({ kind: "message", text: "/shrug" })
    expect(parseComposerInput("  //scene is a word  ")).toEqual({ kind: "message", text: "/scene is a word" })
  })

  test("/scene with and without text", () => {
    expect(parseComposerInput("/scene")).toEqual({ kind: "scene" })
    expect(parseComposerInput("/Scene   On a night train\nto Lisbon ")).toEqual({ kind: "scene", text: "On a night train\nto Lisbon" })
  })

  test("/undo with an optional count", () => {
    expect(parseComposerInput("/undo")).toEqual({ kind: "undo", steps: 1 })
    expect(parseComposerInput("/undo 3")).toEqual({ kind: "undo", steps: 3 })
    expect(parseComposerInput("/undo three").kind).toBe("invalid")
    expect(parseComposerInput("/undo 0").kind).toBe("invalid")
  })

  test("help and unknown commands", () => {
    expect(parseComposerInput("/help")).toEqual({ kind: "help" })
    expect(parseComposerInput("/selfie please")).toEqual({ kind: "unknown", name: "selfie" })
  })
})
