import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { initializeOpenAI, generateResponse, generateEmbedding, extractFacts, shouldUseWebSearch, Message } from './services/openai';
import { initializeSupabase, ensureUser, storeFact, getUserFacts, deleteUserData, getStats } from './services/supabase';

// Load environment variables - only in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Validate required environment variables
const requiredEnvVars = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`${envVar} is not set!`);
    process.exit(1);
  }
}

// Create an Express receiver for HTTP mode
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  processBeforeResponse: true,
});

// Initialize Slack app with HTTP receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// Add health check endpoint
receiver.router.get('/health', async (_req, res) => {
  try {
    const stats = await getStats();
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      services: {
        slack: 'connected',
        supabase: 'connected',
        openai: 'connected',
      },
      stats,
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

// Root endpoint
receiver.router.get('/', (_req, res) => {
  res.send('pup.ai v2 is running');
});

// Store bot user ID for mention detection
let botUserId: string | null = null;

// Track processed messages to prevent duplicates
const processedMessages = new Set<string>();

// Track activated channels - when active, bot participates in conversation
const activeChannels = new Set<string>();

// Fetch recent channel messages for context
async function fetchChannelHistory(client: any, channelId: string, limit = 15): Promise<string[]> {
  try {
    const result = await client.conversations.history({
      channel: channelId,
      limit,
    });

    if (!result.messages) return [];

    // Get messages, filter bots, reverse to chronological order
    const messages = result.messages
      .filter((m: any) => !m.bot_id && m.text && m.user)
      .reverse()
      .map((m: any) => `${m.user}: ${m.text}`);

    return messages;
  } catch (error) {
    logger.error('Failed to fetch channel history', { channelId, error });
    return [];
  }
}

// Ask AI if we should respond to this message (when in active mode)
async function shouldRespondOrganically(
  recentMessages: string[],
  currentMessage: string,
  userFacts: string[]
): Promise<{ shouldRespond: boolean; reason: string }> {
  const prompt = `You are pup.ai monitoring a Slack conversation. Based on the context, decide if you should chime in.

RESPOND if:
- Someone asks a question you can help with
- There's an opportunity for a helpful or witty comment
- The conversation would benefit from your input
- Someone seems stuck or confused

DON'T RESPOND if:
- People are just chatting casually and don't need input
- The conversation is flowing fine without you
- It would be interrupting
- You have nothing valuable to add

Recent conversation:
${recentMessages.slice(-10).join('\n')}

Latest message: ${currentMessage}

${userFacts.length > 0 ? `Facts you know: ${userFacts.join(', ')}` : ''}

Respond with JSON: {"shouldRespond": true/false, "reason": "brief explanation"}`;

  try {
    const response = await generateResponse({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 100,
    });

    const parsed = JSON.parse(response);
    return {
      shouldRespond: parsed.shouldRespond === true,
      reason: parsed.reason || '',
    };
  } catch (error) {
    logger.debug('Failed to determine if should respond', { error });
    return { shouldRespond: false, reason: 'parse error' };
  }
}

// Message handler
app.message(async ({ message, say, client }) => {
  try {
    const msg = message as any;

    // Skip bot messages
    if (msg.bot_id || msg.subtype === 'bot_message' || msg.subtype) {
      return;
    }

    // Get bot user ID if not cached
    if (!botUserId) {
      const authResult = await client.auth.test();
      botUserId = authResult.user_id || null;
      logger.info('Bot user ID resolved', { botUserId });
    }

    if (!botUserId) {
      logger.error('Could not determine bot user ID');
      return;
    }

    // Skip our own messages
    if (msg.user === botUserId) {
      return;
    }

    // Deduplicate
    const messageId = `${msg.channel}-${msg.ts}`;
    if (processedMessages.has(messageId)) {
      return;
    }
    processedMessages.add(messageId);

    // Cleanup old entries
    if (processedMessages.size > 1000) {
      const entries = Array.from(processedMessages);
      entries.slice(0, 500).forEach(id => processedMessages.delete(id));
    }

    const text = msg.text || '';
    const textLower = text.toLowerCase().trim();
    const isDM = msg.channel.startsWith('D');
    const isMention = text.includes(`<@${botUserId}>`);
    const isActive = activeChannels.has(msg.channel);

    // Handle activate/deactivate commands
    if (isMention || isDM) {
      if (textLower.includes('activate')) {
        activeChannels.add(msg.channel);
        await say({
          text: "I'm now active in this channel. I'll read along and chime in when I have something useful to add. Say \"deactivate\" to turn me off.",
          thread_ts: msg.thread_ts,
        });
        logger.info('Channel activated', { channel: msg.channel });
        return;
      }

      if (textLower.includes('deactivate')) {
        activeChannels.delete(msg.channel);
        await say({
          text: "Got it, going quiet. Mention me if you need me.",
          thread_ts: msg.thread_ts,
        });
        logger.info('Channel deactivated', { channel: msg.channel });
        return;
      }
    }

    // Determine if we should respond
    let shouldRespond = false;
    let responseType: 'mention' | 'dm' | 'organic' = 'organic';

    if (isDM) {
      shouldRespond = true;
      responseType = 'dm';
    } else if (isMention) {
      shouldRespond = true;
      responseType = 'mention';
    } else if (isActive) {
      // In active mode - check if we should respond organically
      // Don't respond to every message, use judgment
      responseType = 'organic';
    } else {
      // Not active and not mentioned - ignore
      return;
    }

    // Get user facts
    let userFacts: string[] = [];
    try {
      const facts = await getUserFacts(msg.user, 5);
      userFacts = facts.map(f => f.fact);
    } catch (error) {
      logger.debug('Could not fetch user facts', { error });
    }

    // Get channel history for context
    let recentMessages: string[] = [];
    if (isActive || isMention) {
      recentMessages = await fetchChannelHistory(client, msg.channel, 15);
    }

    // If in organic mode, ask AI if we should respond
    if (responseType === 'organic' && isActive) {
      const decision = await shouldRespondOrganically(recentMessages, text, userFacts);
      if (!decision.shouldRespond) {
        logger.debug('Decided not to respond organically', { reason: decision.reason });
        return;
      }
      shouldRespond = true;
    }

    if (!shouldRespond) {
      return;
    }

    // Ensure user exists
    try {
      const userInfo = await client.users.info({ user: msg.user });
      const displayName = userInfo.user?.profile?.display_name || userInfo.user?.name;
      await ensureUser(msg.user, displayName);
    } catch (error) {
      logger.warn('Failed to ensure user exists', { error });
    }

    // Clean the text
    const cleanedText = text.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();

    if (!cleanedText && !isActive) {
      return;
    }

    logger.info('Processing message', {
      channel: msg.channel,
      user: msg.user,
      type: responseType,
      isActive,
    });

    // Build prompt with context
    let promptContent: string;
    if (recentMessages.length > 0) {
      promptContent = `Recent conversation:\n${recentMessages.join('\n')}\n\nRespond to the latest message: ${cleanedText || '(they just mentioned you)'}`;
    } else {
      promptContent = cleanedText || 'Hello';
    }

    const messages: Message[] = [{ role: 'user', content: promptContent }];

    // Check for web search
    const useWebSearch = shouldUseWebSearch(cleanedText);

    // Generate response
    const response = await generateResponse({
      messages,
      userFacts,
      enableWebSearch: useWebSearch,
    });

    // Send response
    await say({
      text: response,
      thread_ts: msg.thread_ts,
    });

    logger.info('Response sent', {
      type: responseType,
      webSearchUsed: useWebSearch,
      responseLength: response.length,
    });

    // Extract facts in background
    if (cleanedText) {
      extractAndStoreFacts(cleanedText, msg.user, msg.channel).catch((error) => {
        logger.error('Failed to extract/store facts', { error });
      });
    }
  } catch (error) {
    logger.error('Error handling message', error);
  }
});

// Extract and store facts
async function extractAndStoreFacts(text: string, userId: string, channelId: string): Promise<void> {
  try {
    const facts = await extractFacts(text, userId);
    if (facts.length === 0) return;

    for (const fact of facts) {
      const embedding = await generateEmbedding(fact);
      await storeFact(userId, fact, embedding, channelId);
    }

    logger.info('Stored new facts', { userId, count: facts.length });
  } catch (error) {
    logger.error('Failed to extract/store facts', { error });
  }
}

// Slash command handler
app.command('/pup', async ({ command, ack, respond }) => {
  await ack();

  const parts = command.text.split(' ');
  const subcommand = parts[0];

  try {
    switch (subcommand) {
      case 'status':
        const stats = await getStats();
        const activeCount = activeChannels.size;
        await respond({
          text: `pup.ai v2 is online

*Database:*
- Users: ${stats.users}
- Facts stored: ${stats.facts}

*Active channels:* ${activeCount}
*Uptime:* ${Math.round(process.uptime() / 60)} minutes`,
          response_type: 'ephemeral',
        });
        break;

      case 'privacy':
        const userFacts = await getUserFacts(command.user_id);
        const factsList = userFacts.length > 0
          ? userFacts.map((f) => `- ${f.fact}`).join('\n')
          : 'No facts stored about you yet.';

        await respond({
          text: `*What I know about you:*

${factsList}

Use \`/pup forget me\` to delete all your data.`,
          response_type: 'ephemeral',
        });
        break;

      case 'forget':
        if (parts[1] === 'me') {
          await deleteUserData(command.user_id);
          await respond({
            text: `Done. All your data has been deleted.`,
            response_type: 'ephemeral',
          });
        } else {
          await respond({
            text: `Use \`/pup forget me\` to delete all your data. This is permanent.`,
            response_type: 'ephemeral',
          });
        }
        break;

      case 'help':
      default:
        await respond({
          text: `*pup.ai commands:*
- \`/pup status\` - Check system status
- \`/pup privacy\` - See what I know about you
- \`/pup forget me\` - Delete all your data

*Activation:*
- Say "activate" to make me active in a channel (I'll participate in conversations)
- Say "deactivate" to make me go quiet (mention-only mode)

*How I work:*
- When active: I read the conversation and chime in when helpful
- When inactive: I only respond to @mentions and DMs
- I remember facts about you to be more helpful
- I can search the web for current information`,
          response_type: 'ephemeral',
        });
    }
  } catch (error) {
    logger.error('Error handling slash command', { command: command.text, error });
    await respond({
      text: 'Something went wrong. Try again later.',
      response_type: 'ephemeral',
    });
  }
});

// Start the app
async function start() {
  try {
    logger.info('Initializing services...');
    initializeOpenAI();
    initializeSupabase();

    const PORT = process.env.PORT || 3000;
    await app.start(PORT);

    logger.info('='.repeat(50));
    logger.info(`pup.ai v2 is running on port ${PORT}`);
    logger.info('='.repeat(50));
  } catch (error) {
    logger.error('Failed to start app', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  await app.stop();
  process.exit(0);
});

start();
