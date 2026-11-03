/** Accept a bare ID or a pasted web URL (…/chat/group/<id>, or any URL ending in the ID). */
export function normalizeId(raw: string): string {
  const t = raw.trim()
  if (!/^https?:\/\//i.test(t) && !t.includes("/")) return t
  const path = t.replace(/[?#].*$/, "").replace(/\/+$/, "")
  return path.slice(path.lastIndexOf("/") + 1)
}
