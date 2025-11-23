import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { initializeDatabase } from './database/connection';
import { logger } from './utils/logger';
import { processMessage, MessageContext } from './pipeline';
import { getOpenAIService } from './services/openai';
import { initializeRedis, getRedisService, shutdownRedis } from './services/redis';
import { ensureUserExists, updateUserActivity, deleteUserData } from './services/users';
import { allQuery, getDatabaseStats } from './database/connection';

// Load environment variables - only in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Validate required environment variables
if (!process.env.SLACK_SIGNING_SECRET) {
  logger.error('SLACK_SIGNING_SECRET is not set!');
  process.exit(1);
}

if (!process.env.SLACK_BOT_TOKEN) {
  logger.error('SLACK_BOT_TOKEN is not set!');
  process.exit(1);
}


// Create an Express receiver for HTTP mode
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true,
  logLevel: process.env.LOG_LEVEL as any || 'debug',
});

// Initialize Slack app with HTTP receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
  logLevel: process.env.LOG_LEVEL as any || 'info',
});

// Add health check endpoint to Express app
receiver.router.get('/health', async (_req, res) => {
  try {
    // Gather comprehensive health metrics
    const dbStats = await getDatabaseStats();
    const openai = getOpenAIService();
    const openaiStats = openai.getUsageStats();

    let redisStatus = 'disconnected';
    try {
      const redis = getRedisService();
      redisStatus = redis.isConnected() ? 'connected' : 'disconnected';
    } catch {
      redisStatus = 'not_initialized';
    }

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      mode: 'http',
      services: {
        database: 'connected',
        redis: redisStatus,
        openai: 'connected'
      },
      stats: {
        database: dbStats,
        openai: {
          tokensUsed: openaiStats.totalTokensUsed,
          cost: openaiStats.costInUSD
        }
      },
      uptime: process.uptime()
    });
  } catch (error) {
    logger.error('Health check failed', error);
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

// Add error handling middleware
receiver.router.use((err: any, req: any, res: any, _next: any) => {
  logger.error('Express error:', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });
  res.status(500).send('Internal Server Error');
});


// Add root endpoint for verification
receiver.router.get('/', (_req, res) => {
  res.send('pup.ai is running! 🐕');
});

// Store bot user ID for mention detection
let botUserId: string | null = null;

// Message handler with AI processing
app.message(async ({ message, say, client }) => {
  try {
    const msg = message as any;
    
    // Skip messages from bots (including ourselves)
    if (msg.bot_id || msg.subtype === 'bot_message') {
      return;
    }

    // Get bot user ID if not cached
    if (!botUserId) {
      const authResult = await client.auth.test();
      botUserId = authResult.user_id || null;
    }

    logger.info('Message received', {
      channel: msg.channel,
      user: msg.user,
      text: msg.text,
      fullMessage: JSON.stringify(msg)
    });

    // Ensure user exists in database and update activity
    try {
      await ensureUserExists(msg.user);
      await updateUserActivity(msg.user, msg.channel);
    } catch (error) {
      logger.warn('Failed to track user activity', error);
    }

    // Build message context
    const messageContext: MessageContext = {
      text: msg.text || '',
      user: msg.user,
      channel: msg.channel,
      timestamp: msg.ts,
      thread_ts: msg.thread_ts
    };

    // Buffer this message to Redis for future context (only if not from bot)
    if (msg.user !== botUserId) {
      try {
        const redis = getRedisService();
        await redis.bufferMessage(msg.channel, messageContext);
      } catch (error) {
        logger.debug('Redis not available for message buffering');
      }
    } else {
      logger.debug('Skipping buffer for bot message');
    }

    // Get recent messages from Redis buffer
    let recentMessages: MessageContext[] = [messageContext]; // Always include current message
    try {
      const redis = getRedisService();
      const buffered = await redis.getRecentMessages(msg.channel, 20); // Get last 20 messages

      // Filter out bot's own messages to prevent response loops
      const filteredBuffered = buffered.filter(m => m.user !== botUserId);

      // Prepend buffered messages (they're already in reverse chronological order)
      recentMessages = [...filteredBuffered.slice(0, 19), messageContext];

      logger.debug('Recent messages filtered', {
        totalBuffered: buffered.length,
        afterFiltering: filteredBuffered.length,
        botUserId
      });
    } catch (error) {
      logger.debug('Using only current message (Redis not available)');
    }

    // Process message through AI pipeline
    const result = await processMessage({
      message: messageContext,
      botUserId: botUserId!,
      recentMessages
    });

    // Send response if generated
    if (result.response) {
      await say({
        text: result.response,
        thread_ts: msg.thread_ts // Respond in thread if message was in thread
      });
    }

    // Log usage stats periodically
    const openai = getOpenAIService();
    const stats = openai.getUsageStats();
    if (stats.totalTokensUsed > 0 && Math.random() < 0.1) { // Log 10% of the time
      logger.info('OpenAI usage stats', stats);
    }
  } catch (error) {
    logger.error('Error handling message', error);
  }
});

// Slash command handler
app.command('/pup', async ({ command, ack, respond }) => {
  await ack();

  const parts = command.text.split(' ');
  const subcommand = parts[0];
  const args = parts.slice(1);

  try {
    switch (subcommand) {
      case 'status':
        const openai = getOpenAIService();
        const stats = openai.getUsageStats();
        const dbStats = await getDatabaseStats();

        await respond({
          text: `🟢 pup.ai is online and learning!

*OpenAI Usage (Current Session):*
• Tokens: ${stats.totalTokensUsed.toLocaleString()}
• Cost: ${stats.costInUSD}

*Database:*
• Users: ${dbStats.users}
• Memories: ${dbStats.memories}
• Channels Tracked: ${dbStats.channels}
• Total Interactions: ${dbStats.interactions}`,
          response_type: 'ephemeral'
        });
        break;

      case 'privacy':
        const userId = command.user_id;

        // Get user profile
        const userProfile = await allQuery(
          'SELECT * FROM users WHERE slack_id = ?',
          [userId]
        );

        // Get user's memories
        const userMemories = await allQuery(
          'SELECT content, type, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
          [userId]
        );

        // Get interaction stats
        const userInteractions = await allQuery(
          'SELECT COUNT(*) as count, SUM(cost_usd) as total_cost FROM interactions WHERE user_id = ?',
          [userId]
        );

        if (!userProfile || userProfile.length === 0) {
          await respond({
            text: `I don't have any data about you yet. Start chatting and I'll learn about you over time!`,
            response_type: 'ephemeral'
          });
          break;
        }

        const profile = userProfile[0];
        const memories = userMemories.map((m: any) => `• [${m.type}] ${m.content.substring(0, 80)}...`).join('\n');
        const interactionStats = userInteractions[0];

        await respond({
          text: `*Your Privacy Report*

*Profile:*
• Display Name: ${profile.display_name}
• First Seen: ${new Date(profile.created_at).toLocaleDateString()}
• Last Seen: ${new Date(profile.last_seen).toLocaleDateString()}

*Memories About You (${userMemories.length} shown):*
${memories || 'No memories yet'}

*Usage:*
• Interactions: ${interactionStats.count || 0}
• Estimated Cost: $${(interactionStats.total_cost || 0).toFixed(4)}

Use \`/pup forget me\` to delete all your data.`,
          response_type: 'ephemeral'
        });
        break;

      case 'forget':
        const forgetUserId = command.user_id;

        if (args[0] === 'me') {
          // Delete all user data
          await deleteUserData(forgetUserId);
          await respond({
            text: `✅ All your data has been permanently deleted. This includes:
• Your user profile
• All memories about you
• All interaction records

You'll be treated as a new user going forward. Thanks for using pup.ai!`,
            response_type: 'ephemeral'
          });
        } else {
          await respond({
            text: `Use \`/pup forget me\` to delete all your data.

Note: This action is permanent and cannot be undone.`,
            response_type: 'ephemeral'
          });
        }
        break;

      case 'pause':
        // For now, just acknowledge - full implementation would need a paused_users table
        await respond({
          text: `Pause functionality coming soon!

This will allow you to temporarily stop pup.ai from:
• Processing your messages
• Forming memories about you
• Responding to you

Your existing data will remain intact.`,
          response_type: 'ephemeral'
        });
        break;

      case 'help':
        await respond({
          text: `*pup.ai commands:*
• \`/pup status\` - Check system status and stats
• \`/pup privacy\` - See what I know about you
• \`/pup forget me\` - Delete all your data
• \`/pup pause\` - Pause processing (coming soon)`,
          response_type: 'ephemeral'
        });
        break;

      default:
        await respond({
          text: "I don't know that command yet. Try `/pup help`",
          response_type: 'ephemeral'
        });
    }
  } catch (error) {
    logger.error('Error handling slash command', { command: command.text, error });
    await respond({
      text: 'Sorry, something went wrong processing that command. The error has been logged.',
      response_type: 'ephemeral'
    });
  }
});

// Start the app
async function start() {
  try {
    // Initialize database
    logger.info('Initializing database...');
    await initializeDatabase();

    // Initialize Redis only if URL is provided
    if (process.env.REDIS_URL) {
      logger.info('Initializing Redis...');
      try {
        await initializeRedis();
        logger.info('✓ Redis connected - message buffering and caching enabled');
      } catch (redisError) {
        logger.warn('Redis connection failed - running without caching layer', redisError);
      }
    } else {
      logger.info('Redis not configured - running without message buffering');
      logger.info('Bot will function but won\'t have conversation context');
    }

    // Start Slack app (Express server)
    const PORT = process.env.PORT || 3000;
    await app.start(PORT);

    logger.info('='.repeat(50));
    logger.info(`⚡️ pup.ai is running on port ${PORT}!`);
    logger.info('='.repeat(50));
  } catch (error) {
    logger.error('Failed to start app', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');

  // Shutdown Redis connection
  try {
    await shutdownRedis();
  } catch (error) {
    logger.warn('Error shutting down Redis', error);
  }

  await app.stop();
  process.exit(0);
});

start();