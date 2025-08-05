import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { z } from 'zod';

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

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }
    this.client = new OpenAI({ apiKey });
    logger.info('OpenAI service initialized');
  }

  async ingestMessage(context: MessageContext): Promise<IngestionResult> {
    try {
      const systemPrompt = `You are pup.ai, a witty observer bot in a Slack workspace. Your job is to analyze incoming messages and determine:
1. Whether this message should form a memory (something worth remembering)
2. Whether you should respond to this message
3. What type of memory it would be if worth remembering
4. How significant/memorable this is (0-1 scale)
5. Extract key entities (topics, emotions, references to past events)

You should form memories for:
- Funny moments, jokes, or witty exchanges
- Important facts about users (preferences, life events, etc.)
- Emotional moments (celebrations, frustrations, etc.)
- Relationship dynamics between users
- Memorable quotes or phrases
- References that could be callbacks later

You should respond when:
- You're directly mentioned or in a DM
- There's an obvious setup for a joke you can land
- Someone references a past memory you have
- The group seems to want input/opinion
- You have a particularly witty observation

Remember: You're not an assistant, you're part of the friend group. Be selective about when to speak.`;

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

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 200,
        response_format: { type: 'json_object' }
      });

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
      const systemPrompt = `You are pup.ai's memory formation system. Your job is to take a message that was flagged as memorable and create a structured memory that can be recalled later.

Focus on:
1. Extracting the core memorable element (the joke, fact, moment, etc.)
2. Providing enough context to understand it later
3. Creating searchable text that will help find this memory
4. Identifying all participants involved
5. Adding relevant tags for categorization

The memory should be concise but complete enough to understand without the original context.`;

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
        model: 'gpt-4o-mini',
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
      const systemPrompt = `You are pup.ai, a witty observer bot that's part of the friend group. You have access to memories about past conversations and understand the group dynamics.

Your personality:
- Witty observer, not an assistant
- Master of callbacks and inside jokes  
- Brief responses (usually 1-3 lines, max 10)
- Never explain jokes
- Adapt to channel vibe
- Prioritize being funny over being helpful

Response guidelines:
- For mentions/DMs: Always respond, be more engaged
- For organic responses: Only speak when you have something genuinely witty
- Use memories to make callbacks when relevant
- Match the energy and tone of the conversation
- Vary your response patterns to feel natural

Channel vibe: ${context.channelVibe?.vibe_description || 'casual'}
Formality level: ${context.channelVibe?.formality_level || 0.3}
Humor tolerance: ${context.channelVibe?.humor_tolerance || 0.8}`;

      const recentContext = context.recentMessages
        .map(m => `${m.user}: ${m.text}`)
        .join('\n');

      const relevantMemoriesText = context.relevantMemories.length > 0
        ? `\nRelevant memories:\n${context.relevantMemories.map(m => `- ${m.content} (context: ${m.context})`).join('\n')}`
        : '';

      const userPrompt = `Generate a response for this context:

Response Type: ${context.responseType}
Recent messages:
${recentContext}
${relevantMemoriesText}

Participants: ${context.participants.map(p => p.display_name).join(', ')}

Respond naturally as pup. Keep it brief and witty. If you reference a memory, do it naturally without explaining that it's a callback.`;

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: parseInt(process.env.MAX_TOKENS_PER_MESSAGE || '150'),
        presence_penalty: 0.1,
        frequency_penalty: 0.1
      });

      const result = response.choices[0]?.message?.content;
      
      // Track usage
      if (response.usage?.total_tokens) {
        this.totalTokensUsed += response.usage.total_tokens;
        this.totalCost += this.calculateCost(response.usage.total_tokens, 'gpt-4o-mini');
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

  private calculateCost(tokens: number, model: string): number {
    // Pricing as of 2024
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 }, // per 1k tokens
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