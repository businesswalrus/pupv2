# pup.ai - Context-Aware Slack Bot

A witty Slack bot that monitors conversations, builds organic memories, and responds with contextual humor.

## Quick Deploy to Railway

### 1. Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Create new project and link
railway init
railway link

# Add Redis plugin in Railway dashboard
# Go to your project dashboard and add Redis from the plugin marketplace

# Deploy
railway up
```

### 2. Set Environment Variables in Railway

Go to your Railway project dashboard and add these variables:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
OPENAI_API_KEY=sk-your-openai-key
```

### 3. Get Your Railway URL

After deploying, Railway will provide a public URL like:
```
https://your-app-name.up.railway.app
```

You'll need this URL for Slack configuration.

### 4. Configure Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create a new app "From scratch"
3. Name it "pup.ai" and select your workspace

#### Event Subscriptions
- Go to **Event Subscriptions** in the left sidebar
- Enable Events
- Set Request URL to: `https://your-app-name.up.railway.app/slack/events`
- It should verify successfully
- Subscribe to bot events:
  - `message.channels`
  - `message.groups`
  - `message.im`
  - `app_mention`

#### OAuth & Permissions
- Go to **OAuth & Permissions**
- Add these Bot Token Scopes:
  - `app_mentions:read` - Read mentions
  - `channels:history` - Read channel messages
  - `channels:read` - List channels
  - `chat:write` - Send messages
  - `commands` - Handle slash commands
  - `groups:history` - Read private channel messages
  - `groups:read` - List private channels
  - `im:history` - Read DMs
  - `im:read` - List DMs
  - `im:write` - Send DMs
  - `users:read` - Get user info
- Install to your workspace
- Copy the Bot User OAuth Token as `SLACK_BOT_TOKEN`

#### Basic Information
- Copy the Signing Secret as `SLACK_SIGNING_SECRET`

#### Slash Commands
- Create a new command: `/pup`
- Set Request URL to: `https://your-app-name.up.railway.app/slack/events`
- Add a short description: "Interact with pup.ai"
- Save the command

### 5. Invite Bot to Channels

After deployment, invite pup.ai to your channels:
```
/invite @pup.ai
```

## Local Development

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your values

# Run in development
npm run dev
```

## Current Features

- ✅ Connects to Slack
- ✅ Responds to @mentions
- ✅ Basic /pup commands
- ✅ Health check endpoint
- ✅ SQLite database setup
- 🚧 Memory formation (coming soon)
- 🚧 Contextual responses (coming soon)
- 🚧 Personality profiling (coming soon)

## Architecture

See [CLAUDE.md](CLAUDE.md) for detailed architecture and implementation details.