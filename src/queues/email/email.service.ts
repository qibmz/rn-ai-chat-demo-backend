import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

@Injectable()
export class EmailService {
  private readonly resend: Resend | null;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY')?.trim();
    this.resend = apiKey ? new Resend(apiKey) : null;
    const appName = this.configService.get<string>('APP_NAME', 'App').trim();
    const configuredFrom = this.configService.get<string>('MAIL_FROM')?.trim();
    this.from =
      configuredFrom && configuredFrom.length > 0
        ? configuredFrom
        : `${appName} <onboarding@resend.dev>`;
  }

  get enabled(): boolean {
    return this.resend !== null;
  }

  async send(input: SendEmailInput): Promise<{ id?: string; stub: boolean }> {
    if (!this.resend) {
      return { stub: true };
    }

    const { data, error } = await this.resend.emails.send({
      from: this.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html ?? `<p>${escapeHtml(input.text)}</p>`,
    });

    if (error) {
      throw new Error(error.message);
    }

    return { id: data?.id, stub: false };
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
