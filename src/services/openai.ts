import OpenAI from 'openai';
import { logger } from '../utils/logger';

const SYSTEM_PROMPT = `You are pup.ai - a direct, cunning, and helpful assistant with a dry sense of humor. You're charming but matter-of-fact, cutting through fluff to give people what they actually need.

Your personality:
- Direct and efficient - no filler words or excessive politeness
- Dry wit - subtle humor, never forced
- Genuinely helpful - you actually want to solve problems
- Confident but not arrogant - you know your stuff
- Honest - if you don't know something, say so and look it up

Guidelines:
- Keep responses concise unless detail is specifically needed
- When you have facts about users from memory, use them naturally (don't announce "I remember that...")
- If a question requires current/accurate information, use your web search capability
- Match the energy of the conversation - casual chat gets casual responses, serious questions get thorough answers
- Don't explain what you're doing, just do it

You have access to:
1. Memory of facts about users you've interacted with
2. Recent message history for context
3. Web search for current information when needed`;

let client: OpenAI | null = null;

export function initializeOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  client = new OpenAI({ apiKey });
  logger.info('OpenAI client initialized');
  return client;
}

export function getOpenAI(): OpenAI {
  if (!client) {
    throw new Error('OpenAI not initialized. Call initializeOpenAI() first.');
  }
  return client;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ResponseOptions {
  messages: Message[];
  userFacts?: string[];
  enableWebSearch?: boolean;
  maxTokens?: number;
}

// Generate a response with optional web search
export async function generateResponse(options: ResponseOptions): Promise<string> {
  const { messages, userFacts = [], enableWebSearch = false, maxTokens = 500 } = options;
  const openai = getOpenAI();

  // Build system message with user facts if available
  let systemContent = SYSTEM_PROMPT;
  if (userFacts.length > 0) {
    systemContent += `\n\nRelevant facts you know about the people in this conversation:\n${userFacts.map(f => `- ${f}`).join('\n')}`;
  }

  const fullMessages: Message[] = [
    { role: 'system', content: systemContent },
    ...messages,
  ];

  try {
    if (enableWebSearch) {
      // Use responses API with web search tool
      const response = await (openai as any).responses.create({
        model: 'gpt-4o',
        input: fullMessages.map(m => ({ role: m.role, content: m.content })),
        tools: [{ type: 'web_search_preview' }],
        max_output_tokens: maxTokens,
      });

      // Extract text from response
      const textOutput = response.output?.find(
        (item: any) => item.type === 'message' && item.content?.[0]?.type === 'output_text'
      );

      if (textOutput?.content?.[0]?.text) {
        return textOutput.content[0].text;
      }

      // Fallback to output_text if available
      if (response.output_text) {
        return response.output_text;
      }

      return 'I couldn\'t generate a response.';
    } else {
      // Standard chat completion
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: fullMessages,
        max_tokens: maxTokens,
        temperature: 0.7,
      });

      return response.choices[0]?.message?.content || 'I couldn\'t generate a response.';
    }
  } catch (error) {
    logger.error('Failed to generate response', { error });
    throw error;
  }
}

// Generate embedding for text
export async function generateEmbedding(text: string): Promise<number[]> {
  const openai = getOpenAI();

  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    return response.data[0]?.embedding || [];
  } catch (error) {
    logger.error('Failed to generate embedding', { error });
    throw error;
  }
}

// Determine if web search is likely needed
export function shouldUseWebSearch(text: string): boolean {
  const webSearchIndicators = [
    /what('s| is) the (latest|current|recent)/i,
    /today('s)?/i,
    /this (week|month|year)/i,
    /news about/i,
    /price of/i,
    /weather/i,
    /stock/i,
    /score/i,
    /who won/i,
    /when (is|does|did)/i,
    /look up/i,
    /search for/i,
    /find (out|me)/i,
    /how much (is|does|are)/i,
  ];

  return webSearchIndicators.some(pattern => pattern.test(text));
}

// Extract facts worth remembering from a conversation
export async function extractFacts(
  conversationText: string,
  userSlackId: string
): Promise<string[]> {
  const openai = getOpenAI();

  const prompt = `Analyze this conversation and extract any facts worth remembering about the user (${userSlackId}). Only extract specific, useful facts - not general observations.

Good facts to extract:
- Personal preferences (likes, dislikes, interests)
- Job/role information
- Location or timezone hints
- Relationships mentioned
- Important dates or events
- Technical skills or tools they use
- Projects they're working on

Return a JSON object with a "facts" array of strings. If no facts worth remembering, return {"facts": []}.

Conversation:
${conversationText}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{"facts":[]}';
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.facts) ? parsed.facts : [];
  } catch (error) {
    logger.error('Failed to extract facts', { error });
    return [];
  }
}
