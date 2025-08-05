import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { initializeDatabase } from './database/connection';
import { logger } from './utils/logger';
import { processMessage, MessageContext } from './pipeline';
import { getOpenAIService } from './services/openai';

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
receiver.router.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    mode: 'http',
  });
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

    // Build message context
    const messageContext: MessageContext = {
      text: msg.text || '',
      user: msg.user,
      channel: msg.channel,
      timestamp: msg.ts,
      thread_ts: msg.thread_ts,
      recentMessages: [] // TODO: Get from Redis buffer
    };

    // Process message through AI pipeline
    // Include the current message in recentMessages so the bot knows what was said
    const result = await processMessage({
      message: messageContext,
      botUserId: botUserId!,
      recentMessages: [messageContext] // Include current message until Redis is implemented
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
  
  const subcommand = command.text.split(' ')[0];
  
  switch (subcommand) {
    case 'status':
      const openai = getOpenAIService();
      const stats = openai.getUsageStats();
      await respond({
        text: `🟢 pup.ai is online and learning!\n\n*OpenAI Usage:*\n• Tokens: ${stats.totalTokensUsed.toLocaleString()}\n• Cost: ${stats.costInUSD}`,
        response_type: 'ephemeral'
      });
      break;
    case 'help':
      await respond({
        text: `*pup.ai commands:*
• \`/pup status\` - Check if I'm online
• \`/pup privacy\` - See what I know about you (coming soon)
• \`/pup forget\` - Make me forget something (coming soon)
• \`/pup pause\` - Pause processing your messages (coming soon)`,
        response_type: 'ephemeral'
      });
      break;
    default:
      await respond({
        text: "I don't know that command yet. Try `/pup help`",
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
  await app.stop();
  process.exit(0);
});

start();