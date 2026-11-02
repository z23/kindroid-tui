/** Colours tuned for dark terminal themes. Backgrounds stay transparent so the terminal theme shows through. */
export const theme = {
  text: "#c8cde8",
  muted: "#6b7394",
  faint: "#3d4466",
  accent: "#7aa2f7",
  user: "#9ece6a",
  ai: "#bb9af7",
  action: "#e0af68",
  quote: "#e6e9ff",
  error: "#f7768e",
  warn: "#e0af68",
  ok: "#73daca",
  border: "#3b4261",
  borderFocus: "#7aa2f7",
  selectedBg: "#283457",
  hoverBg: "#2a2f45",
  panelBg: "#16161e",
  dialogBg: "#1f2335",
} as const

/** A fixed palette so each AI in a group keeps the same colour. */
const SPEAKER_COLORS = ["#bb9af7", "#7dcfff", "#ff9e64", "#f7768e", "#73daca", "#e0af68", "#9d7cd8", "#2ac3de"]

export function speakerColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return SPEAKER_COLORS[h % SPEAKER_COLORS.length]!
}
