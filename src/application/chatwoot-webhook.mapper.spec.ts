import { describe, expect, it } from 'vitest';
import { ChatwootWebhookEvent } from '../infra/chatwoot/chatwoot.types';
import { mapAttachmentType, normalizeMessageType, planOutbound } from './chatwoot-webhook.mapper';

const base = (over: Partial<ChatwootWebhookEvent>): ChatwootWebhookEvent => ({
  event: 'message_created',
  id: 1,
  message_type: 'outgoing',
  ...over,
});

describe('normalizeMessageType', () => {
  it('maps numeric types', () => {
    expect(normalizeMessageType(0)).toBe('incoming');
    expect(normalizeMessageType(1)).toBe('outgoing');
    expect(normalizeMessageType(2)).toBe('activity');
  });
  it('passes through strings', () => {
    expect(normalizeMessageType('outgoing')).toBe('outgoing');
  });
});

describe('mapAttachmentType', () => {
  it('maps known types and falls back to file', () => {
    expect(mapAttachmentType('image')).toBe('image');
    expect(mapAttachmentType('audio')).toBe('audio');
    expect(mapAttachmentType('video')).toBe('video');
    expect(mapAttachmentType('something')).toBe('file');
    expect(mapAttachmentType(undefined)).toBe('file');
  });
});

describe('planOutbound', () => {
  const opts = { forwardSystemMessages: false };

  it('skips non message_created events', () => {
    expect(planOutbound(base({ event: 'conversation_updated' }), opts).kind).toBe('skip');
  });

  it('skips private notes', () => {
    expect(planOutbound(base({ private: true, content: 'note' }), opts).kind).toBe('skip');
  });

  it('skips incoming echoes', () => {
    expect(planOutbound(base({ message_type: 'incoming', content: 'hi' }), opts).kind).toBe('skip');
  });

  it('skips activity messages when disabled', () => {
    expect(planOutbound(base({ message_type: 'activity', content: 'resolved' }), opts).kind).toBe(
      'skip',
    );
  });

  it('forwards activity messages when enabled', () => {
    const plan = planOutbound(base({ message_type: 'activity', content: 'resolved' }), {
      forwardSystemMessages: true,
    });
    expect(plan.kind).toBe('text');
    expect(plan.text).toBe('resolved');
  });

  it('produces a text plan with rendered markdown', () => {
    const plan = planOutbound(base({ content: 'hello **bob**' }), opts);
    expect(plan.kind).toBe('text');
    expect(plan.text).toBe('hello <b>bob</b>');
  });

  it('produces a media plan with attachments', () => {
    const plan = planOutbound(
      base({
        content: 'see photo',
        attachments: [{ file_type: 'image', data_url: 'https://x/y.jpg' }],
      }),
      opts,
    );
    expect(plan.kind).toBe('media');
    expect(plan.attachments).toEqual([{ type: 'image', url: 'https://x/y.jpg' }]);
    expect(plan.text).toBe('see photo');
  });

  it('carries the reply target', () => {
    const plan = planOutbound(
      base({ content: 'ok', content_attributes: { in_reply_to: 42 } }),
      opts,
    );
    expect(plan.inReplyTo).toBe(42);
  });

  it('maps input_select to an interactive plan', () => {
    const plan = planOutbound(
      base({
        content: 'pick one',
        content_type: 'input_select',
        content_attributes: {
          items: [
            { title: 'Yes', value: 'yes' },
            { title: 'No', value: 'no' },
          ],
        },
      }),
      opts,
    );
    expect(plan.kind).toBe('interactive');
    expect(plan.interactive?.buttons).toEqual([
      { title: 'Yes', value: 'yes' },
      { title: 'No', value: 'no' },
    ]);
  });

  it('skips when there is nothing to deliver', () => {
    expect(planOutbound(base({ content: '' }), opts).kind).toBe('skip');
  });
});
