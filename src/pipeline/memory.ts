import { getOpenAIService, MessageContext, IngestionResult, Memory } from '../services/openai';
import { logger } from '../utils/logger';
// Database imports will be added when database is set up

export async function formMemory(
  message: MessageContext, 
  ingestionResult: IngestionResult
): Promise<Memory | null> {
  if (!ingestionResult.shouldFormMemory) {
    logger.debug('Message does not warrant memory formation');
    return null;
  }

  const openai = getOpenAIService();
  
  try {
    logger.info('Forming memory', { 
      type: ingestionResult.memoryType,
      significance: ingestionResult.significance 
    });

    const memory = await openai.formMemory(message, ingestionResult);
    
    if (memory) {
      // TODO: Save to database
      logger.info('Memory formed successfully', {
        type: memory.type,
        contentLength: memory.content.length,
        tags: memory.tags
      });
      
      // For now, just return the memory
      // In production, this would save to SQLite with vector embedding
    }

    return memory;
  } catch (error) {
    logger.error('Error in memory formation pipeline', error);
    return null;
  }
}

export async function searchMemories(
  query: string, 
  limit: number = 5
): Promise<Memory[]> {
  // TODO: Implement vector similarity search using sqlite-vec
  logger.debug('Memory search requested', { query, limit });
  
  // Placeholder for now
  return [];
}

export async function getRecentMemories(
  channelId: string, 
  limit: number = 10
): Promise<Memory[]> {
  // TODO: Implement database query
  logger.debug('Recent memories requested', { channelId, limit });
  
  // Placeholder for now
  return [];
}