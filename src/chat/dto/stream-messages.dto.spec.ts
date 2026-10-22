import { ValidationPipe } from '@nestjs/common';
import { StreamMessagesDto } from './stream-messages.dto.js';

describe('StreamMessagesDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  it('accepts AI SDK UIMessage list under production ValidationPipe options', async () => {
    const plain = {
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'ping' }],
        },
      ],
    };

    const dto = (await pipe.transform(plain, {
      type: 'body',
      metatype: StreamMessagesDto,
    })) as StreamMessagesDto;

    expect(Array.isArray(dto.messages[0])).toBe(false);
    expect(dto.messages[0]?.role).toBe('user');
    expect(dto.messages[0]?.parts?.[0]).toMatchObject({
      type: 'text',
      text: 'ping',
    });
  });

  it('accepts DefaultChatTransport envelope (id/trigger/messageId/metadata)', async () => {
    const plain = {
      id: 'bot-482c78b2',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'hi' }],
          metadata: { source: 'test' },
        },
      ],
    };

    const dto = (await pipe.transform(plain, {
      type: 'body',
      metatype: StreamMessagesDto,
    })) as StreamMessagesDto;

    expect(dto.id).toBe('bot-482c78b2');
    expect(dto.trigger).toBe('submit-message');
    expect(dto.messages[0]?.metadata).toEqual({ source: 'test' });
  });

  it('rejects empty messages', async () => {
    await expect(
      pipe.transform(
        { messages: [] },
        { type: 'body', metatype: StreamMessagesDto },
      ),
    ).rejects.toMatchObject({
      response: {
        message: expect.arrayContaining([expect.stringMatching(/messages/i)]),
      },
    });
  });
});
