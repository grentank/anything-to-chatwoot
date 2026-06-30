import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance, isAxiosError } from 'axios';
import FormData from 'form-data';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/config.schema';
import { withRetry } from '../../common/retry';
import {
  ChatwootContactRef,
  ChatwootMessageRef,
  ChatwootPort,
  ContactFilterQuery,
  CreateIncomingMessageInput,
  EnsureContactInput,
  EnsureConversationInput,
} from '../../domain/ports';
import {
  ChatwootContact,
  ChatwootContactConversationsResponse,
  ChatwootContactInbox,
  ChatwootCreateContactResponse,
  ChatwootFilterContactsResponse,
  ChatwootMessageResponse,
} from './chatwoot.types';

const REUSABLE_STATUSES = new Set(['open', 'pending', 'snoozed']);

/**
 * HTTP client for the Chatwoot Application API. Implements the {@link ChatwootPort}
 * the application layer depends on. Only the operations the bridge needs are
 * implemented (contacts, conversations, incoming messages, attachment download).
 */
@Injectable()
export class ChatwootClient implements ChatwootPort {
  private readonly logger = new Logger(ChatwootClient.name);
  private readonly http: AxiosInstance;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.http = axios.create({
      baseURL: `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`,
      headers: {
        api_access_token: config.chatwoot.apiAccessToken,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    });
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  async ensureContact(input: EnsureContactInput): Promise<ChatwootContactRef> {
    const existing = await this.findContact(input.spec.lookup);
    if (existing) {
      // Keep the contact's own `identifier` (it may be a CRM auth_id) untouched;
      // only make sure it is reachable from our inbox via a contact_inbox.
      const sourceId = await this.ensureContactInbox(existing, input.inboxId, input.spec.sourceId);
      return { id: existing.id, sourceId };
    }
    return this.createContact(input);
  }

  /** Try each lookup predicate via `POST /contacts/filter`; first match wins. */
  private async findContact(lookup: ContactFilterQuery[]): Promise<ChatwootContact | undefined> {
    for (const query of lookup) {
      const match = await this.filterContacts(query);
      if (match) return match;
    }
    return undefined;
  }

  private async filterContacts(query: ContactFilterQuery): Promise<ChatwootContact | undefined> {
    const res = await this.request<ChatwootFilterContactsResponse>(() =>
      this.http.post('/contacts/filter', {
        payload: [
          {
            attribute_key: query.attributeKey,
            filter_operator: query.filterOperator,
            values: query.values,
            query_operator: null,
          },
        ],
      }),
    );
    return res.payload?.[0];
  }

  private async createContact(input: EnsureContactInput): Promise<ChatwootContactRef> {
    const { spec } = input;
    const res = await this.request<ChatwootCreateContactResponse>(() =>
      this.http.post('/contacts', {
        inbox_id: input.inboxId,
        source_id: spec.sourceId,
        name: spec.name,
        identifier: spec.identifier,
        custom_attributes: spec.customAttributes,
        additional_attributes: spec.additionalAttributes,
      }),
    );

    const contact = res.payload?.contact;
    if (!contact?.id) {
      throw new Error('Chatwoot did not return a contact id on contact creation');
    }

    // Passing `inbox_id` + `source_id` makes Chatwoot create the contact_inbox; we
    // fall back to the source id we requested if the response omits it.
    const sourceId =
      res.payload?.contact_inbox?.source_id ??
      this.extractSourceId(contact.contact_inboxes, input.inboxId) ??
      spec.sourceId;

    return { id: contact.id, sourceId };
  }

  private async ensureContactInbox(
    contact: ChatwootContact,
    inboxId: number,
    desiredSourceId: string,
  ): Promise<string> {
    const existing = this.extractSourceId(contact.contact_inboxes, inboxId);
    if (existing) return existing;

    // Tie this contact to our inbox using our stable source id (e.g. the user id).
    const res = await this.request<ChatwootContactInbox & { payload?: ChatwootContactInbox }>(() =>
      this.http.post(`/contacts/${contact.id}/contact_inboxes`, {
        inbox_id: inboxId,
        source_id: desiredSourceId,
      }),
    );
    return res.source_id ?? res.payload?.source_id ?? desiredSourceId;
  }

  private extractSourceId(
    inboxes: ChatwootContactInbox[] | undefined,
    inboxId: number,
  ): string | undefined {
    const match = (inboxes ?? []).find((ci) => ci.inbox?.id === inboxId || ci.inbox_id === inboxId);
    return match?.source_id;
  }

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  async ensureConversation(input: EnsureConversationInput): Promise<number> {
    const reusable = await this.findReusableConversation(input.contactId, input.inboxId);
    if (reusable) return reusable;

    const res = await this.request<{ id: number }>(() =>
      this.http.post('/conversations', {
        inbox_id: input.inboxId,
        contact_id: input.contactId,
        source_id: input.sourceId,
      }),
    );
    if (!res.id) {
      throw new Error('Chatwoot did not return a conversation id on creation');
    }
    return res.id;
  }

  private async findReusableConversation(
    contactId: number,
    inboxId: number,
  ): Promise<number | undefined> {
    const res = await this.request<ChatwootContactConversationsResponse>(() =>
      this.http.get(`/contacts/${contactId}/conversations`),
    );
    const conversations = res.payload ?? [];
    const match = conversations
      .filter((c) => c.inbox_id === inboxId && REUSABLE_STATUSES.has(c.status ?? ''))
      .sort((a, b) => b.id - a.id)[0];
    return match?.id;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async createIncomingMessage(input: CreateIncomingMessageInput): Promise<ChatwootMessageRef> {
    const path = `/conversations/${input.conversationId}/messages`;

    if (input.attachments && input.attachments.length > 0) {
      return this.createMultipartMessage(path, input);
    }

    const body: Record<string, unknown> = {
      content: input.content ?? '',
      message_type: 'incoming',
    };
    if (input.inReplyTo) {
      body.content_attributes = { in_reply_to: input.inReplyTo };
    }

    const res = await this.request<ChatwootMessageResponse>(() => this.http.post(path, body));
    return { id: res.id };
  }

  private async createMultipartMessage(
    path: string,
    input: CreateIncomingMessageInput,
  ): Promise<ChatwootMessageRef> {
    const res = await this.request<ChatwootMessageResponse>(() => {
      // Rebuild the form per attempt: streams/buffers can only be consumed once.
      const form = new FormData();
      form.append('message_type', 'incoming');
      if (input.content) form.append('content', input.content);
      if (input.inReplyTo) {
        form.append('content_attributes', JSON.stringify({ in_reply_to: input.inReplyTo }));
      }
      for (const att of input.attachments ?? []) {
        form.append('attachments[]', att.data, {
          filename: att.filename,
          contentType: att.contentType,
        });
      }
      return this.http.post(path, form, { headers: form.getHeaders() });
    });
    return { id: res.id };
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async fetchAttachment(url: string): Promise<Buffer> {
    const res = await withRetry(
      () =>
        axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          // Chatwoot ActiveStorage URLs may require the access token.
          headers: { api_access_token: this.config.chatwoot.apiAccessToken },
          timeout: 60_000,
        }),
      { retries: 2, shouldRetry: isRetryableError },
    );
    return Buffer.from(res.data);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async request<T>(call: () => Promise<{ data: T }>): Promise<T> {
    const res = await withRetry(call, {
      retries: 3,
      shouldRetry: isRetryableError,
      onRetry: (error, attempt, delay) =>
        this.logger.warn(
          `Chatwoot request failed (attempt ${attempt}), retrying in ${delay}ms: ${describeError(error)}`,
        ),
    });
    return res.data;
  }
}

/** Retry on network errors, 429, and 5xx; never on other 4xx. */
function isRetryableError(error: unknown): boolean {
  if (!isAxiosError(error)) return true; // non-HTTP (network) errors are retryable
  const status = error.response?.status;
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500;
}

function describeError(error: unknown): string {
  if (isAxiosError(error)) {
    const e = error as AxiosError;
    return `${e.response?.status ?? 'ERR'} ${JSON.stringify(e.response?.data ?? e.message)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
