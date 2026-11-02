/** A message as returned by GET /get-chat-messages. Absent fields are omitted by the API. */
export interface ChatMessage {
  id: string
  sender: string
  sender_type: string
  display_name?: string
  timestamp: number
  message: string
  image_urls?: string[] | null
  image_description?: string
  video_description?: string
  internet_response?: string
  link_url?: string
  link_description?: string
}

export interface Pagination {
  hasMore: boolean
  lastTimestamp: number
  limit: number
}

export interface ChatMessagesResponse {
  messages: ChatMessage[]
  pagination: Pagination
}

export interface RewindResult {
  deleted_message_ids?: string[]
  deleted_record_ids?: string[]
  new_latest_message_id?: string
  rewind_floor_record_id?: string
}

export type ConversationKind = "kin" | "group"

export interface ConversationRef {
  kind: ConversationKind
  id: string
}

export const convKey = (ref: ConversationRef): string => `${ref.kind}:${ref.id}`
