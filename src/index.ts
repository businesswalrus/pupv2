import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { initializeOpenAI, generateResponse, generateEmbedding, extractFacts, shouldUseWebSearch, Message } from './services/openai';
import { initializeSupabase, ensureUser, storeFact, getUserFacts, deleteUserData, getStats } from './services/supabase';
import { buildContext, resolveUserNames, formatMessagesForPrompt } from './services/context';

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

// Check if message is directed at the bot (mention or DM)
function isDirectedAtBot(text: string, channelId: string, botId: string): { directed: boolean; type: 'mention' | 'dm' | null } {
  // DM channels start with 'D'
  if (channelId.startsWith('D')) {
    return { directed: true, type: 'dm' };
  }

  // Check for @mention
  if (text && text.includes(`<@${botId}>`)) {
    return { directed: true, type: 'mention' };
  }

  return { directed: false, type: null };
}

// Message handler - only responds to mentions and DMs
app.message(async ({ message, say, client }) => {
  try {
    const msg = message as any;

    // Skip messages from bots (multiple checks to be safe)
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

    // Skip messages from ourselves
    if (msg.user === botUserId) {
      return;
    }

    // Check if this message is directed at the bot
    const { directed, type } = isDirectedAtBot(msg.text || '', msg.channel, botUserId);

    if (!directed) {
      // Not directed at us - ignore
      return;
    }

    logger.info('Message received', {
      channel: msg.channel,
      user: msg.user,
      type,
      text: msg.text?.substring(0, 100),
    });

    // Ensure user exists in database
    try {
      const userInfo = await client.users.info({ user: msg.user });
      const displayName = userInfo.user?.profile?.display_name || userInfo.user?.name;
      await ensureUser(msg.user, displayName);
    } catch (error) {
      logger.warn('Failed to ensure user exists', { error });
    }

    // Build conversation context
    const context = await buildContext(
      client,
      msg.channel,
      msg.thread_ts,
      msg.text
    );

    // Resolve user names for better context
    const userMap = await resolveUserNames(client, context.participants);

    // Format recent messages
    const formattedHistory = formatMessagesForPrompt(context.recentMessages, userMap);

    // Remove bot mention from the text for cleaner input
    const cleanedText = (msg.text || '').replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();

    // Build messages for AI
    const messages: Message[] = [];

    // Add conversation history as context
    if (formattedHistory) {
      messages.push({
        role: 'user',
        content: `Recent conversation:\n${formattedHistory}\n\nNow respond to: ${cleanedText}`,
      });
    } else {
      messages.push({
        role: 'user',
        content: cleanedText,
      });
    }

    // Determine if web search is needed
    const useWebSearch = shouldUseWebSearch(cleanedText);

    // Generate response
    const response = await generateResponse({
      messages,
      userFacts: context.relevantFacts,
      enableWebSearch: useWebSearch,
    });

    // Send response
    await say({
      text: response,
      thread_ts: msg.thread_ts, // Respond in thread if message was in thread
    });

    logger.info('Response sent', {
      type,
      webSearchUsed: useWebSearch,
      responseLength: response.length,
    });

    // After responding, extract and store any new facts (async, don't block)
    extractAndStoreFacts(cleanedText, msg.user, msg.channel).catch((error) => {
      logger.error('Failed to extract/store facts', { error });
    });
  } catch (error) {
    logger.error('Error handling message', error);
  }
});

// Extract facts from conversation and store them
async function extractAndStoreFacts(text: string, userId: string, channelId: string): Promise<void> {
  try {
    const facts = await extractFacts(text, userId);

    if (facts.length === 0) {
      return;
    }

    // Store each fact with embedding
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
        await respond({
          text: `pup.ai v2 is online

*Database:*
- Users: ${stats.users}
- Facts stored: ${stats.facts}

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
- \`/pup help\` - This message

*How I work:*
- Mention me (@pup) or DM me to chat
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
    // Initialize services
    logger.info('Initializing services...');
    initializeOpenAI();
    initializeSupabase();

    // Start Slack app
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
