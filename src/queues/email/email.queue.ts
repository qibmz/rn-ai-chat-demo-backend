import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE } from '../queue.constants.js';

export interface EmailJobPayload {
  to: string;
  subject: string;
  body: string;
  html?: string;
}

@Injectable()
export class EmailQueue {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue) {}

  async enqueue(payload: EmailJobPayload): Promise<string | undefined> {
    const job = await this.queue.add('send', payload, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    });
    return job.id;
  }
}
