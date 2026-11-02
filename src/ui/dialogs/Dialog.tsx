import type { JSX } from "@opentui/solid"
import { theme } from "../theme"

/** Centered modal frame drawn over the app. Key handling lives in each dialog's own keymap layer. */
export function Dialog(props: {
  title: string
  width?: number
  danger?: boolean
  footer?: string
  children: JSX.Element
}) {
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={100}
      justifyContent="center"
      alignItems="center"
    >
      <box
        border
        borderStyle="rounded"
        borderColor={props.danger ? theme.error : theme.borderFocus}
        backgroundColor={theme.dialogBg}
        title={` ${props.title} `}
        titleColor={props.danger ? theme.error : theme.accent}
        bottomTitle={props.footer ? ` ${props.footer} ` : undefined}
        bottomTitleAlignment="right"
        width={props.width ?? 60}
        maxWidth="90%"
        maxHeight="95%"
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        {props.children}
      </box>
    </box>
  )
}
