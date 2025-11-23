import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { z } from 'zod';
import { runQuery } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';

// Schema definitions for OpenAI responses
export const IngestionResultSchema = z.object({
  shouldFormMemory: z.boolean(),
  shouldRespond: z.boolean(),
  memoryType: z.enum(['joke', 'fact', 'moment', 'preference', 'relationship', 'quote']).optional(),
  significance: z.number().min(0).max(1),
  extractedEntities: z.object({
    topics: z.array(z.string()),
    emotions: z.array(z.string()),
    references: z.array(z.string()),
  }),
});

export type IngestionResult = z.infer<typeof IngestionResultSchema>;

export interface MessageContext {
  text: string;
  user: string;
  channel: string;
  timestamp: string;
  thread_ts?: string;
  recentMessages?: Array<{
    text: string;
    user: string;
    timestamp: string;
  }>;
}

export interface Memory {
  content: string;
  context: string;
  participants: string[];
  embedding?: number[];
  tags: string[];
  searchableText: string;
  type: string;
  significance: number;
}

export interface ResponseContext {
  recentMessages: MessageContext[];
  relevantMemories: Memory[];
  channelVibe?: {
    vibe_description: string;
    formality_level: number;
    humor_tolerance: number;
  };
  participants: Array<{
    display_name: string;
    personality_traits?: any;
  }>;
  shouldRespond: boolean;
  responseType: 'mention' | 'organic' | 'dm';
}

export class OpenAIService {
  private client: OpenAI;
  private totalTokensUsed: number = 0;
  private totalCost: number = 0;
  private consecutiveFailures: number = 0;
  private circuitBreakerOpen: boolean = false;
  private circuitBreakerResetTime?: Date;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.client = new OpenAI({ apiKey });
    logger.info('OpenAI service initialized');
  }

  /**
   * Retry wrapper with exponential backoff for API calls
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 3
  ): Promise<T> {
    // Check circuit breaker
    if (this.circuitBreakerOpen) {
      if (this.circuitBreakerResetTime && new Date() > this.circuitBreakerResetTime) {
        logger.info('Circuit breaker reset attempt', { operationName });
        this.circuitBreakerOpen = false;
        this.consecutiveFailures = 0;
      } else {
        const error = new Error('Circuit breaker is open - too many consecutive failures');
        logger.error('Circuit breaker preventing API call', { operationName });
        throw error;
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();

        // Success - reset failure counter
        if (this.consecutiveFailures > 0) {
          logger.info('OpenAI call succeeded after previous failures', {
            operationName,
            previousFailures: this.consecutiveFailures
          });
        }
        this.consecutiveFailures = 0;

        return result;
      } catch (error: any) {
        const isLastAttempt = attempt === maxRetries;
        const isRateLimitError = error.status === 429;
        const isServerError = error.status >= 500;
        const shouldRetry = (isRateLimitError || isServerError) && !isLastAttempt;

        if (shouldRetry) {
          // Exponential backoff: 1s, 2s, 4s
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          logger.warn('OpenAI API call failed, retrying', {
            operationName,
            attempt: attempt + 1,
            maxRetries,
            backoffMs,
            error: error.message,
            status: error.status
          });

          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        // Final failure or non-retryable error
        this.consecutiveFailures++;

        logger.error('OpenAI API call failed', {
          operationName,
          attempt: attempt + 1,
          consecutiveFailures: this.consecutiveFailures,
          error: error.message,
          status: error.status
        });

        // Open circuit breaker after 5 consecutive failures
        if (this.consecutiveFailures >= 5) {
          this.circuitBreakerOpen = true;
          this.circuitBreakerResetTime = new Date(Date.now() + 60000); // Reset after 1 minute
          logger.error('Circuit breaker opened after consecutive failures', {
            consecutiveFailures: this.consecutiveFailures,
            resetTime: this.circuitBreakerResetTime
          });
        }

        throw error;
      }
    }

    throw new Error('Retry logic error - should not reach here');
  }

  async ingestMessage(context: MessageContext): Promise<IngestionResult> {
    try {
      const systemPrompt = `You are an analytical system for a Slack assistant. Analyze messages to determine:
1. Whether this message should form a memory (something worth remembering)
2. Whether the assistant should respond
3. What type of memory it would be if worth remembering
4. How significant/memorable this is (0-1 scale)
5. Extract key entities (topics, emotions, references to past events)

Form memories for:
- Important facts about users (preferences, life events, etc.)
- Key decisions or action items
- Significant events or milestones
- Helpful information shared
- Questions that might come up again
- Relationship dynamics between users

Respond when:
- Directly mentioned or in a DM
- A question is asked that the assistant can help with
- Clarification or assistance is needed
- Important information should be confirmed

Be selective - only respond when genuinely helpful.`;

      const userPrompt = `Analyze this message and return a JSON response:

Message: "${context.text}"
User: ${context.user}
Channel: ${context.channel}
Time: ${context.timestamp}
${context.recentMessages ? `\nRecent context:\n${context.recentMessages.map(m => `${m.user}: ${m.text}`).join('\n')}` : ''}

Respond with JSON matching this structure:
{
  "shouldFormMemory": boolean,
  "shouldRespond": boolean,
  "memoryType": "joke" | "fact" | "moment" | "preference" | "relationship" | "quote" | null,
  "significance": number (0-1),
  "extractedEntities": {
    "topics": string[],
    "emotions": string[],
    "references": string[]
  }
}`;

      const response = await this.retryWithBackoff(
        () => this.client.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 200,
          response_format: { type: 'json_object' }
        }),
        'ingestMessage'
      );

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(result);
      const validated = IngestionResultSchema.parse(parsed);

      // Track usage
      if (response.usage?.total_tokens) {
        this.totalTokensUsed += response.usage.total_tokens;
        this.totalCost += this.calculateCost(response.usage.total_tokens, 'gpt-4o-mini');

        // Record to database
        await this.recordInteraction(
          'ingestion',
          response.usage.total_tokens,
          'gpt-4o',
          true,
          context.channel,
          context.user
        );
      }

      logger.debug('Message ingestion result', {
        messageText: context.text.substring(0, 50),
        result: validated
      });

      return validated;
    } catch (error) {
      logger.error('Error in message ingestion', error);
      // Return safe defaults on error
      return {
        shouldFormMemory: false,
        shouldRespond: false,
        significance: 0,
        extractedEntities: {
          topics: [],
          emotions: [],
          references: []
        }
      };
    }
  }

  async formMemory(context: MessageContext, ingestionResult: IngestionResult): Promise<Memory | null> {
    if (!ingestionResult.shouldFormMemory || !ingestionResult.memoryType) {
      return null;
    }

    try {
      const systemPrompt = `You are a memory system for a Slack assistant. Create concise, searchable memories from messages.

Focus on:
1. Extract the core memorable element
2. Provide enough context for future reference
3. Create searchable text for later retrieval
4. Identify all participants
5. Add relevant tags

Keep it factual and concise.`;

      const userPrompt = `Create a memory from this message:

Message: "${context.text}"
User: ${context.user}
Channel: ${context.channel}
Memory Type: ${ingestionResult.memoryType}
Significance: ${ingestionResult.significance}
Extracted Entities: ${JSON.stringify(ingestionResult.extractedEntities)}
${context.recentMessages ? `\nRecent context:\n${context.recentMessages.map(m => `${m.user}: ${m.text}`).join('\n')}` : ''}

Respond with JSON:
{
  "content": "The core memorable element",
  "context": "Brief context to understand the memory",
  "participants": ["user1", "user2"],
  "tags": ["tag1", "tag2"],
  "searchableText": "Text optimized for semantic search"
}`;

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.6,
        max_tokens: 300,
        response_format: { type: 'json_object' }
      });

      const result = response.choices[0]?.message?.content;
      if (!result) {
        throw new Error('No response from OpenAI');
      }

      const parsed = JSON.parse(result);
      
      // Generate embedding for the memory
      const embedding = await this.generateEmbedding(parsed.searchableText || parsed.content);

      const memory: Memory = {
        ...parsed,
        embedding,
        type: ingestionResult.memoryType,
        significance: ingestionResult.significance
      };

      // Track usage
      if (response.usage?.total_tokens) {
        this.totalTokensUsed += response.usage.total_tokens;
        this.totalCost += this.calculateCost(response.usage.total_tokens, 'gpt-4o-mini');

        // Record to database
        await this.recordInteraction(
          'memory_formation',
          response.usage.total_tokens,
          'gpt-4o',
          true,
          context.channel,
          context.user
        );
      }

      logger.info('Memory formed', {
        type: memory.type,
        significance: memory.significance,
        content: memory.content.substring(0, 50)
      });

      return memory;
    } catch (error) {
      logger.error('Error forming memory', error);
      return null;
    }
  }

  async generateResponse(context: ResponseContext): Promise<string | null> {
    if (!context.shouldRespond) {
      return null;
    }

    try {
      // Build conversation context
      const recentContext = context.recentMessages
        .map(m => `${m.user}: ${m.text}`)
        .join('\n');

      // Build input with context
      let input: string;

      if (recentContext.trim()) {
        input = `You are a helpful assistant in a Slack workspace. Respond naturally and helpfully to the conversation.

Channel context: ${context.channelVibe?.vibe_description || 'casual conversation'}
${context.relevantMemories.length > 0 ? '\nRelevant context from past conversations:\n' + context.relevantMemories.map(m => `- ${m.content}`).join('\n') : ''}

Recent conversation:
${recentContext}

Provide a helpful, direct response.`;
      } else if (context.recentMessages[0]?.text) {
        input = `You are a helpful assistant. The user said: "${context.recentMessages[0].text}". Provide a helpful response.`;
      } else {
        input = 'Provide a brief helpful response.';
      }

      // Debug logging
      logger.debug('Generating response with context', {
        inputLength: input.length,
        recentMessagesCount: context.recentMessages.length,
        responseType: context.responseType
      });

      const response = await this.client.responses.create({
        model: 'gpt-5.1',
        input: input
      });

      const result = response.output_text;

      // Track usage
      if (response.usage?.total_tokens) {
        this.totalTokensUsed += response.usage.total_tokens;
        this.totalCost += this.calculateCost(response.usage.total_tokens, 'gpt-5.1');

        // Record to database - use first recent message for channel/user context
        const firstMessage = context.recentMessages[context.recentMessages.length - 1];
        await this.recordInteraction(
          'response_generation',
          response.usage.total_tokens,
          'gpt-5.1',
          true,
          firstMessage?.channel,
          firstMessage?.user
        );
      }

      logger.info('Response generated', {
        type: context.responseType,
        responseLength: result?.length || 0
      });

      return result || null;
    } catch (error) {
      logger.error('Error generating response', error);
      return null;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });

      return response.data[0]?.embedding || [];
    } catch (error) {
      logger.error('Error generating embedding', error);
      return [];
    }
  }

  /**
   * Record an API interaction to the database for cost tracking
   */
  private async recordInteraction(
    operationType: string,
    tokensUsed: number,
    modelUsed: string,
    success: boolean,
    channelId?: string,
    userId?: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      const cost = this.calculateCost(tokensUsed, modelUsed);

      await runQuery(`
        INSERT INTO interactions (
          id, timestamp, operation_type, tokens_used,
          cost_usd, model_used, success, error_message,
          channel_id, user_id
        ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uuidv4(),
        operationType,
        tokensUsed,
        cost,
        modelUsed,
        success ? 1 : 0,
        errorMessage || null,
        channelId || null,
        userId || null
      ]);

      logger.debug('Interaction recorded', { operationType, tokensUsed, cost, success });
    } catch (error) {
      logger.warn('Failed to record interaction to database', error);
      // Don't throw - this is a non-critical failure
    }
  }

  private calculateCost(tokens: number, model: string): number {
    // Pricing as of 2024-2025
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 0.0025, output: 0.01 }, // per 1k tokens
      'gpt-5.1': { input: 0.0025, output: 0.01 }, // per 1k tokens (estimated)
      'text-embedding-3-small': { input: 0.00002, output: 0 } // per 1k tokens
    };

    const modelPricing = pricing[model];
    if (!modelPricing) {
      return 0;
    }

    // Rough estimate: assume 60/40 split for input/output tokens
    const inputTokens = tokens * 0.6;
    const outputTokens = tokens * 0.4;

    return (inputTokens * modelPricing.input + outputTokens * modelPricing.output) / 1000;
  }

  getUsageStats() {
    return {
      totalTokensUsed: this.totalTokensUsed,
      totalCost: this.totalCost.toFixed(4),
      costInUSD: `$${this.totalCost.toFixed(4)}`
    };
  }

  resetUsageStats() {
    this.totalTokensUsed = 0;
    this.totalCost = 0;
  }
}

// Singleton instance
let openaiService: OpenAIService | null = null;

export function getOpenAIService(): OpenAIService {
  if (!openaiService) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    openaiService = new OpenAIService(apiKey);
  }
  return openaiService;
}