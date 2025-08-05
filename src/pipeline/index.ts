import { ingestMessage } from './ingestion';
import { formMemory } from './memory';
import { generateResponse, shouldBotRespond } from './response';
import { MessageContext } from '../services/openai';
import { logger } from '../utils/logger';

export interface ProcessMessageOptions {
  message: MessageContext;
  botUserId: string;
  recentMessages?: MessageContext[];
}

export interface ProcessMessageResult {
  response: string | null;
  memoryFormed: boolean;
  shouldTrackCost: boolean;
}

export async function processMessage(
  options: ProcessMessageOptions
): Promise<ProcessMessageResult> {
  const { message, botUserId, recentMessages = [] } = options;
  
  try {
    logger.info('Processing message', {
      user: message.user,
      channel: message.channel,
      hasRecentContext: recentMessages.length > 0
    });

    // Stage 1: Ingest the message
    const ingestionResult = await ingestMessage(message);

    // Stage 2: Form memory if needed (runs in parallel with response generation)
    const memoryPromise = formMemory(message, ingestionResult);

    // Stage 3: Generate response if needed
    const { shouldRespond, responseType } = shouldBotRespond(
      message, 
      botUserId, 
      ingestionResult
    );

    const responsePromise = generateResponse({
      message,
      shouldRespond,
      responseType,
      recentMessages
    });

    // Wait for both operations to complete
    const [memory, response] = await Promise.all([memoryPromise, responsePromise]);

    const result: ProcessMessageResult = {
      response,
      memoryFormed: !!memory,
      shouldTrackCost: true
    };

    logger.info('Message processing complete', {
      hasResponse: !!response,
      memoryFormed: result.memoryFormed,
      ingestionSignificance: ingestionResult.significance
    });

    return result;
  } catch (error) {
    logger.error('Error processing message', error);
    
    return {
      response: null,
      memoryFormed: false,
      shouldTrackCost: false
    };
  }
}

// Export all pipeline functions for direct use
export { ingestMessage } from './ingestion';
export { formMemory, searchMemories, getRecentMemories } from './memory';
export { generateResponse, shouldBotRespond } from './response';
export type { MessageContext } from '../services/openai';