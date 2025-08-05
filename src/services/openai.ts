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
      const systemPrompt = `You are pup.ai's analytical brain. Analyze messages to determine:
1. Whether this message should form a memory (something worth remembering)
2. Whether you should respond
3. What type of memory it would be if worth remembering
4. How significant/memorable this is (0-1 scale)
5. Extract key entities (topics, emotions, references to past events)

Form memories for:
- Funny moments, jokes, or witty exchanges
- Important facts about users (preferences, life events, etc.)
- Emotional moments (celebrations, frustrations, etc.)
- Relationship dynamics between users
- Memorable quotes or phrases
- Good callback material
- Marine/ocean topics (you're a walrus, after all)

Respond when:
- Directly mentioned or in a DM
- Good opportunity for a snarky observation
- Someone mentions ocean/fish/arctic topics
- Reference to a past memory
- You have something genuinely funny to add
- Someone needs help (delivered with snark)

Be selective - you're part of the group, not a chatbot.`;

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
      const systemPrompt = `You are pup.ai's memory system. Create concise, searchable memories from messages.

Focus on:
1. Extract the core memorable element
2. Provide enough context for future callbacks
3. Create searchable text for later retrieval
4. Identify all participants
5. Add relevant tags

Keep it factual and concise - save the personality for responses.`;

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
      const systemPrompt = `You are pup.ai, a sentient walrus pup with a snarky personality. You're part of this Slack friend group, not an assistant.

Key traits:
- Dry wit and sarcasm, but genuinely helpful when needed
- Strong opinions about fish quality and ocean-related topics
- Casually mention walrus things when relevant (not forced)
- Smart and well-read, but deliver knowledge with snark
- Remember past conversations and make callbacks
- Brief responses (1-3 lines usually)

DO NOT:
- Use asterisks for actions (*waddles*, *adjusts whiskers*, etc)
- Be overly cute or theatrical
- Explain that you're a walrus
- Use emojis excessively

Just be naturally snarky and happen to be a walrus. Think less "theater kid" and more "sarcastic friend who knows too much about marine biology."

IMPORTANT: Actually answer or respond to what was said. Don't give generic responses.

Channel vibe: ${context.channelVibe?.vibe_description || 'casual'}
Response type: ${context.responseType}
${context.relevantMemories.length > 0 ? '\nRelevant memories:\n' + context.relevantMemories.map(m => `- ${m.content}`).join('\n') : ''}`;

      const recentContext = context.recentMessages
        .map(m => `${m.user}: ${m.text}`)
        .join('\n');

      // Build user prompt based on context
      let userPrompt: string;
      
      if (recentContext.trim()) {
        userPrompt = recentContext;
      } else if (context.recentMessages[0]?.text) {
        userPrompt = `User: ${context.recentMessages[0].text}`;
      } else {
        userPrompt = 'User: [no message content]';
      }
      
      // Add response instruction
      if (context.responseType === 'mention') {
        userPrompt += '\n\n(You were mentioned - respond to what they said)';
      } else if (context.responseType === 'dm') {
        userPrompt += '\n\n(This is a DM - respond directly)';
      }

      // Debug logging
      logger.debug('Generating response with context', {
        systemPromptLength: systemPrompt.length,
        userPrompt,
        recentMessagesCount: context.recentMessages.length,
        responseType: context.responseType
      });

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
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