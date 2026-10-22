import { Injectable } from '@nestjs/common';
import {
  createLanguageModel,
  type CreateLanguageModelParams,
} from './create-language-model.js';

@Injectable()
export class ChatModelFactory {
  create(opts: CreateLanguageModelParams) {
    return createLanguageModel(opts);
  }
}
