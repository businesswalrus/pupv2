import { logger } from '../utils/logger';
import { searchFacts, getUserFacts } from './supabase';
import { generateEmbedding } from './openai';

// Use generic type for Slack client to avoid version conflicts between bolt and web-api
type SlackClient = {
  conversations: {
    history: (args: { channel: string; limit: number }) => Promise<any>;
    replies: (args: { channel: string; ts: string; limit: number }) => Promise<any>;
  };
  users: {
    info: (args: { user: string }) => Promise<any>;
  };
};

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

export interface ConversationContext {
  recentMessages: SlackMessage[];
  relevantFacts: string[];
  participants: Set<string>;
}

// Fetch recent messages from a channel using Slack API
export async function fetchChannelHistory(
  client: SlackClient,
  channelId: string,
  limit = 20
): Promise<SlackMessage[]> {
  try {
    const result = await client.conversations.history({
      channel: channelId,
      limit,
    });

    if (!result.messages) {
      return [];
    }

    // Filter out bot messages and map to our format
    const messages = result.messages
      .filter((m: any) => !m.bot_id && m.text && m.user)
      .map((m: any) => ({
        user: m.user,
        text: m.text,
        ts: m.ts,
        thread_ts: m.thread_ts,
      }))
      .reverse(); // Oldest first

    logger.debug('Fetched channel history', { channelId, count: messages.length });
    return messages;
  } catch (error) {
    logger.error('Failed to fetch channel history', { channelId, error });
    return [];
  }
}

// Fetch messages from a thread
export async function fetchThreadHistory(
  client: SlackClient,
  channelId: string,
  threadTs: string,
  limit = 20
): Promise<SlackMessage[]> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit,
    });

    if (!result.messages) {
      return [];
    }

    const messages = result.messages
      .filter((m: any) => !m.bot_id && m.text && m.user)
      .map((m: any) => ({
        user: m.user,
        text: m.text,
        ts: m.ts,
        thread_ts: m.thread_ts,
      }));

    logger.debug('Fetched thread history', { channelId, threadTs, count: messages.length });
    return messages;
  } catch (error) {
    logger.error('Failed to fetch thread history', { channelId, threadTs, error });
    return [];
  }
}

// Build full conversation context
export async function buildContext(
  client: SlackClient,
  channelId: string,
  threadTs?: string,
  currentMessage?: string
): Promise<ConversationContext> {
  // Fetch appropriate message history
  const recentMessages = threadTs
    ? await fetchThreadHistory(client, channelId, threadTs)
    : await fetchChannelHistory(client, channelId);

  // Get unique participants
  const participants = new Set<string>();
  for (const msg of recentMessages) {
    participants.add(msg.user);
  }

  // Search for relevant facts based on conversation content
  let relevantFacts: string[] = [];

  // Build search text from recent messages
  const searchText = currentMessage || recentMessages.map(m => m.text).join(' ');

  if (searchText.trim()) {
    try {
      // Generate embedding for similarity search
      const embedding = await generateEmbedding(searchText);

      // Search for relevant facts across all participants
      const searchResults = await searchFacts(embedding, {
        threshold: 0.6,
        limit: 10,
      });

      // Filter to facts about participants
      relevantFacts = searchResults
        .filter(r => participants.has(r.user_slack_id))
        .map(r => `${r.user_slack_id}: ${r.fact}`);

      // Also get direct facts about participants if we didn't find many through similarity
      if (relevantFacts.length < 5) {
        for (const userId of participants) {
          const userFacts = await getUserFacts(userId, 5);
          const additionalFacts = userFacts
            .map(f => `${userId}: ${f.fact}`)
            .filter(f => !relevantFacts.includes(f));
          relevantFacts.push(...additionalFacts.slice(0, 3));
        }
      }
    } catch (error) {
      logger.error('Failed to retrieve relevant facts', { error });
    }
  }

  logger.debug('Built conversation context', {
    messageCount: recentMessages.length,
    participantCount: participants.size,
    factCount: relevantFacts.length,
  });

  return {
    recentMessages,
    relevantFacts,
    participants,
  };
}

// Format messages for the AI prompt
export function formatMessagesForPrompt(
  messages: SlackMessage[],
  userMap: Map<string, string> // Map of user ID to display name
): string {
  return messages
    .map(m => {
      const name = userMap.get(m.user) || m.user;
      return `${name}: ${m.text}`;
    })
    .join('\n');
}

// Resolve user IDs to display names
export async function resolveUserNames(
  client: SlackClient,
  userIds: Set<string>
): Promise<Map<string, string>> {
  const userMap = new Map<string, string>();

  for (const userId of userIds) {
    try {
      const result = await client.users.info({ user: userId });
      if (result.user) {
        const displayName = result.user.profile?.display_name
          || result.user.profile?.real_name
          || result.user.name
          || userId;
        userMap.set(userId, displayName);
      }
    } catch (error) {
      logger.debug('Failed to resolve user name', { userId });
      userMap.set(userId, userId);
    }
  }

  return userMap;
}
