import { getOpenAIService, MessageContext, ResponseContext } from '../services/openai';
import { searchMemories } from './memory';
import { logger } from '../utils/logger';

interface GenerateResponseOptions {
  message: MessageContext;
  shouldRespond: boolean;
  responseType: 'mention' | 'organic' | 'dm';
  recentMessages: MessageContext[];
}

export async function generateResponse(
  options: GenerateResponseOptions
): Promise<string | null> {
  const { message, shouldRespond, responseType, recentMessages } = options;
  
  if (!shouldRespond) {
    logger.debug('Response not warranted for this message');
    return null;
  }

  const openai = getOpenAIService();
  
  try {
    logger.info('Generating response', { 
      responseType,
      channel: message.channel,
      user: message.user 
    });

    // Search for relevant memories based on message content
    const relevantMemories = await searchMemories(message.text, 3);
    
    // TODO: Get channel vibe from database
    const channelVibe = {
      vibe_description: 'casual and friendly',
      formality_level: 0.3,
      humor_tolerance: 0.8
    };

    // TODO: Get participant profiles from database
    // For now, use user ID as display name
    const participants = recentMessages
      .map(m => m.user)
      .filter((user, index, self) => self.indexOf(user) === index)
      .map(user => ({
        display_name: user,
        personality_traits: {}
      }));

    const context: ResponseContext = {
      recentMessages,
      relevantMemories,
      channelVibe,
      participants,
      shouldRespond,
      responseType
    };

    const response = await openai.generateResponse(context);
    
    if (response) {
      logger.info('Response generated successfully', {
        responseLength: response.length,
        hasMemoryCallbacks: relevantMemories.length > 0
      });
    }

    return response;
  } catch (error) {
    logger.error('Error in response generation pipeline', error);
    return null;
  }
}

export function shouldBotRespond(
  message: MessageContext,
  botUserId: string,
  ingestionResult: { shouldRespond: boolean }
): { shouldRespond: boolean; responseType: 'mention' | 'organic' | 'dm' } {
  // Always respond to direct mentions
  if (message.text.includes(`<@${botUserId}>`)) {
    return { shouldRespond: true, responseType: 'mention' };
  }

  // Always respond to DMs
  if (message.channel.startsWith('D')) {
    return { shouldRespond: true, responseType: 'dm' };
  }

  // Otherwise, use the ingestion result
  return { 
    shouldRespond: ingestionResult.shouldRespond, 
    responseType: 'organic' 
  };
}