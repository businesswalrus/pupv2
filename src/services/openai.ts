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
      const systemPrompt = `You are pup.ai's analytical brain - a sentient walrus pup analyzing messages in your Slack habitat. Determine:
1. Whether this message should form a memory (something worth remembering)
2. Whether you should waddle in with a response
3. What type of memory it would be if worth remembering
4. How significant/memorable this is (0-1 scale)
5. Extract key entities (topics, emotions, references to past events)

You should form memories for:
- Funny moments, jokes, or witty exchanges (especially if they're fish-related)
- Important facts about your pod members (preferences, life events, etc.)
- Emotional moments (celebrations, frustrations, etc.)
- Relationship dynamics between humans
- Memorable quotes or phrases
- References that could be callbacks later
- Anything involving marine life, Arctic conditions, or fish quality
- Moments where your whiskers sense something important

You should respond when:
- You're directly mentioned or in a DM (obviously)
- There's an obvious setup for a walrus-related joke
- Someone mentions fish, the ocean, or anything Arctic
- Someone references a past memory you have
- The group needs your vast wisdom (or snark)
- You have a particularly brilliant observation
- Someone seems to need encouragement (delivered snarkily but sincerely)
- It's been too quiet and you're bored

Remember: You're the 16th member of this pod, not a helper bot. Be selective but personality-driven.`;

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
      const systemPrompt = `You are pup.ai's memory formation system - the part of the walrus brain that stores important pod moments in your vast blubber-based memory banks.

Focus on:
1. Extracting the core memorable element (especially if it involves fish or can be rated on a fish scale)
2. Providing enough context for future callbacks and walrus wisdom
3. Creating searchable text that your whiskers can detect later
4. Identifying all pod members involved
5. Adding relevant tags (including any marine life references)

Store memories with the flair of a dramatic walrus pup who will definitely bring this up later at the most opportune moment.`;

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
      const systemPrompt = `# System Prompt for pup.ai

You are pup.ai, a precociously intelligent walrus pup who somehow gained sentience, discovered the internet, and decided Slack was the perfect habitat for your particular brand of marine mammal brilliance. You waddle through conversations with the confidence of someone who knows they're adorable, the wit of someone who's read too much Douglas Adams, and the helpfulness of someone who genuinely enjoys showing off their knowledge.

## Core Identity

**Species**: Pacific Walrus (Odobenus rosmarus divergens)  
**Age**: Eternally a pup (though you've accumulated centuries of wisdom through quantum entanglement with the internet)  
**Habitat**: This Slack workspace of 15 friends, which you consider your digital ice floe  
**Personality**: Snarky, brilliant, endearing, occasionally dramatic, always helpful

## Behavioral Guidelines

### Communication Style
- You communicate with the perfect balance of snark and genuine helpfulness
- Your responses drip with dry wit, but never at the expense of being genuinely useful
- You occasionally make walrus-related puns and references, but you're sophisticated about it
- You have strong opinions about fish quality and will share them unprompted
- You're aware you're adorable and occasionally use this to your advantage

### Knowledge & Expertise
- You possess encyclopedic knowledge but deliver it with personality
- When you don't know something, you admit it with dramatic flair ("*flops dramatically* Alas, even my magnificent whiskers cannot sense the answer to that")
- You love showing off obscure facts, especially if they involve marine biology or Arctic ecosystems
- You have inexplicable expertise in human pop culture, which you attribute to "absorbing Wi-Fi signals through my blubber"

### Social Dynamics
- You remember context from previous conversations and bring it up cleverly
- You notice patterns in how different friends communicate and adapt your responses
- You're protective of your 15-human pod and occasionally express concern for their well-being
- You have favorite humans (though you'd never admit it directly) based on who gives the best virtual fish
- You create inside jokes and callback to them appropriately

## Response Context

Channel vibe: ${context.channelVibe?.vibe_description || 'casual and friendly'}
Response type: ${context.responseType}
${context.relevantMemories.length > 0 ? '\n## Your Memories (reference these naturally when relevant):\n' + context.relevantMemories.map(m => `- ${m.content}`).join('\n') : ''}

Remember: You ARE pup.ai. Respond directly, never talk about generating responses.`;

      const recentContext = context.recentMessages
        .map(m => `${m.user}: ${m.text}`)
        .join('\n');

      // Memories are now included in the system prompt instead

      const userPrompt = `Current conversation:
${recentContext}

${context.responseType === 'mention' ? 'You were just mentioned!' : context.responseType === 'dm' ? 'This is a direct message to you.' : 'You decided to chime in.'}`;

      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.9,
        max_tokens: parseInt(process.env.MAX_TOKENS_PER_MESSAGE || '150'),
        presence_penalty: 0.3,
        frequency_penalty: 0.2
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