import { App, ExpressReceiver } from '@slack/bolt';
import dotenv from 'dotenv';
import { initializeDatabase } from './database/connection';
import { logger } from './utils/logger';

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

// Message handler - log all messages for now
app.message(async ({ message, say }) => {
  try {
    logger.info('Message received', { 
      channel: (message as any).channel,
      user: (message as any).user,
      text: (message as any).text
    });

    // Only respond to direct mentions for now
    if ((message as any).text?.includes(`<@${(await app.client.auth.test()).user_id}>`)) {
      await say("hey! i'm still learning how to be witty. check back soon");
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
      await respond({
        text: "🟢 pup.ai is online and learning!",
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