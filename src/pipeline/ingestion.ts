import { getOpenAIService, MessageContext, IngestionResult } from '../services/openai';
import { logger } from '../utils/logger';

export async function ingestMessage(message: MessageContext): Promise<IngestionResult> {
  const openai = getOpenAIService();
  
  try {
    logger.debug('Ingesting message', { 
      user: message.user, 
      channel: message.channel,
      text: message.text.substring(0, 50) 
    });

    const result = await openai.ingestMessage(message);
    
    logger.info('Ingestion complete', {
      shouldFormMemory: result.shouldFormMemory,
      shouldRespond: result.shouldRespond,
      memoryType: result.memoryType,
      significance: result.significance
    });

    return result;
  } catch (error) {
    logger.error('Error in ingestion pipeline', error);
    throw error;
  }
}