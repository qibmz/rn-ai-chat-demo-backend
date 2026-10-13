export class CreateBotDto {
  name!: string;
  faceColor!: string;
  faceShape!: 'circle' | 'oval' | 'squircle';
  systemPrompt?: string;
}
