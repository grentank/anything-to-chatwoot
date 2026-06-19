import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../../config/config.schema';
import { InboundMessage } from '../../domain/message';
import { TelegramAdapter } from './telegram.adapter';

/**
 * These tests exercise the inline-keyboard lifecycle directly (sendInteractive +
 * handleCallbackQuery) without spinning up Telegraf's network layer: the bot's
 * `telegram` client is replaced with spies and the private callback handler is
 * invoked with a hand-built context.
 */
function buildConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'error',
    forwardSystemMessages: false,
    chatwoot: { baseUrl: 'https://cw.test', apiAccessToken: 't', accountId: 1, webhookSecret: '' },
    telegram: { botToken: '123:abc', inboxId: 7, mode: 'polling', webhookSecret: '' },
  };
}

function makeAdapter() {
  const adapter = new TelegramAdapter(buildConfig());
  const sendMessage = vi.fn().mockResolvedValue({ message_id: 42 });
  // Replace the real Telegram client with spies.
  (adapter as any).bot.telegram = { sendMessage };
  return { adapter, sendMessage };
}

function makeCtx(data: string | undefined, overrides: Record<string, any> = {}) {
  return {
    callbackQuery: {
      data,
      from: { id: 555, first_name: 'Ann', username: 'ann' },
      message: { message_id: 42, chat: { id: 100 } },
    },
    answerCbQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('TelegramAdapter interactive keyboards', () => {
  let adapter: TelegramAdapter;
  let sendMessage: ReturnType<typeof vi.fn>;
  let received: InboundMessage[];

  beforeEach(async () => {
    ({ adapter, sendMessage } = makeAdapter());
    received = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });

    await adapter.sendInteractive('100', {
      text: 'How was it?',
      buttons: [
        { title: 'Great', value: '5' },
        { title: 'Bad', value: '1' },
      ],
    });
  });

  it('renders one callback button per choice', () => {
    const [, , extra] = sendMessage.mock.calls[0];
    const keyboard = extra.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0][0].text).toBe('Great');
    expect(typeof keyboard[0][0].callback_data).toBe('string');
  });

  it('collapses the keyboard and reflects the chosen option on tap', async () => {
    const [, , extra] = sendMessage.mock.calls[0];
    const token: string = extra.reply_markup.inline_keyboard[0][0].callback_data;

    const ctx = makeCtx(token);
    await (adapter as any).handleCallbackQuery(ctx);

    // Acknowledged, keyboard collapsed via edited text (no reply_markup re-sent).
    expect(ctx.answerCbQuery).toHaveBeenCalledOnce();
    expect(ctx.editMessageText).toHaveBeenCalledOnce();
    const [newText, editExtra] = ctx.editMessageText.mock.calls[0];
    expect(newText).toContain('How was it?');
    expect(newText).toContain('\u2705 Great');
    expect(editExtra).toMatchObject({ parse_mode: 'HTML' });

    // The chosen value is relayed back to Chatwoot.
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe('5');
  });

  it('ignores a second tap once the prompt has been answered', async () => {
    const [, , extra] = sendMessage.mock.calls[0];
    const token: string = extra.reply_markup.inline_keyboard[0][0].callback_data;

    await (adapter as any).handleCallbackQuery(makeCtx(token));
    const second = makeCtx(token);
    await (adapter as any).handleCallbackQuery(second);

    // Second tap: token forgotten, so we only strip a possibly-stale keyboard and
    // do not post a duplicate reply to Chatwoot.
    expect(second.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: [] });
    expect(second.editMessageText).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
  });

  it('escapes HTML in the chosen option label', async () => {
    sendMessage.mockResolvedValue({ message_id: 77 });
    await adapter.sendInteractive('100', {
      text: '',
      buttons: [{ title: '<b>x</b> & y', value: 'v' }],
    });
    const lastCall = sendMessage.mock.calls.at(-1)!;
    const token: string = lastCall[2].reply_markup.inline_keyboard[0][0].callback_data;

    const ctx = makeCtx(token, {
      callbackQuery: {
        data: token,
        from: { id: 555, first_name: 'Ann' },
        message: { message_id: 77, chat: { id: 100 } },
      },
    });
    await (adapter as any).handleCallbackQuery(ctx);

    const [newText] = ctx.editMessageText.mock.calls[0];
    expect(newText).toBe('\u2705 &lt;b&gt;x&lt;/b&gt; &amp; y');
  });

  it('drops the keyboard for an unknown/stale token without relaying', async () => {
    const ctx = makeCtx('a2c:does-not-exist');
    await (adapter as any).handleCallbackQuery(ctx);

    expect(ctx.editMessageReplyMarkup).toHaveBeenCalledWith({ inline_keyboard: [] });
    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
});
