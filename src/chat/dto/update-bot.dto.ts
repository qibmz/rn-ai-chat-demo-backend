export class UpdateBotDto {
  name?: string;
  faceColor?: string;
  faceShape?: 'circle' | 'oval' | 'squircle';
  systemPrompt?: string;
  deleted?: boolean;
}
