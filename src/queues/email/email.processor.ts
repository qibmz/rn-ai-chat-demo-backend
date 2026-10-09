import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { EMAIL_QUEUE } from '../queue.constants.js';
import { EmailJobPayload } from './email.queue.js';
import { EmailService } from './email.service.js';

@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  constructor(
    private readonly emailService: EmailService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<EmailJobPayload>): Promise<void> {
    const result = await this.emailService.send({
      to: job.data.to,
      subject: job.data.subject,
      text: job.data.body,
      html: job.data.html,
    });

    this.logger.info(
      result.stub ? 'Email job stubbed (no RESEND_API_KEY)' : 'Email sent',
      {
        context: EmailProcessor.name,
        jobId: job.id,
        to: job.data.to,
        subject: job.data.subject,
        providerId: result.id,
        stub: result.stub,
      },
    );
  }
}
