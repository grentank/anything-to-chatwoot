/** Subset of Chatwoot API/webhook shapes the bridge relies on. */

export interface ChatwootContactInbox {
  source_id: string;
  inbox?: { id: number };
  inbox_id?: number;
}

export interface ChatwootContact {
  id: number;
  name?: string;
  identifier?: string;
  custom_attributes?: Record<string, unknown>;
  additional_attributes?: Record<string, unknown>;
  contact_inboxes?: ChatwootContactInbox[];
}

export interface ChatwootCreateContactResponse {
  payload?: {
    contact?: ChatwootContact;
    contact_inbox?: ChatwootContactInbox;
  };
}

/** Response of `POST /contacts/filter` (shares the contacts list shape). */
export interface ChatwootFilterContactsResponse {
  payload?: ChatwootContact[];
}

export interface ChatwootConversation {
  id: number;
  inbox_id?: number;
  status?: string;
}

export interface ChatwootContactConversationsResponse {
  payload?: ChatwootConversation[];
}

export interface ChatwootMessageResponse {
  id: number;
}

// --- Webhook payload (Chatwoot -> bridge) ---

export interface ChatwootWebhookAttachment {
  id?: number;
  file_type?: string; // image | audio | video | file | ...
  data_url?: string;
  thumb_url?: string;
}

export interface ChatwootWebhookSender {
  id?: number;
  name?: string;
  identifier?: string;
  type?: string; // 'contact' | 'user' | 'agent_bot'
}

export interface ChatwootWebhookConversationMeta {
  sender?: ChatwootWebhookSender;
}

export interface ChatwootWebhookConversation {
  id?: number;
  meta?: ChatwootWebhookConversationMeta;
}

export interface ChatwootWebhookContentAttributes {
  in_reply_to?: number;
  in_reply_to_external_id?: string;
  items?: { title?: string; value?: string }[];
  [key: string]: unknown;
}

export interface ChatwootWebhookEvent {
  event?: string; // 'message_created' | 'message_updated' | ...
  id?: number; // message id
  content?: string;
  content_type?: string; // text | input_select | cards | form | article
  content_attributes?: ChatwootWebhookContentAttributes;
  message_type?: string | number; // 'incoming' | 'outgoing' | 'activity' | 'template'
  private?: boolean;
  source_id?: string;
  attachments?: ChatwootWebhookAttachment[];
  sender?: ChatwootWebhookSender;
  conversation?: ChatwootWebhookConversation;
  inbox?: { id?: number };
  account?: { id?: number };
}
