import { SetMetadata } from '@nestjs/common';

/** Marks a handler that writes AI SDK UI Message Stream (skip JSON Transform). */
export const AI_UI_STREAM_KEY = 'aiUiStream';

export const AiUiStream = () => SetMetadata(AI_UI_STREAM_KEY, true);
