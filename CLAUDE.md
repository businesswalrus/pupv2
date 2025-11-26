# pup.ai v2 - Direct, Helpful Slack Assistant

## Overview

pup.ai is a Slack bot that responds to mentions and DMs with a direct, helpful personality. It remembers facts about users, provides conversation context, and can search the web for current information.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Slack Events   │────▶│  Message Check  │────▶│   AI Response   │
│  (mentions/DMs) │     │  (@ or DM only) │     │  (GPT-4o-mini)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                        ┌───────────────────────────────┴───────────────────────────────┐
                        │                               │                               │
                ┌───────▼────────┐              ┌───────▼────────┐              ┌───────▼────────┐
                │  User Facts    │              │ Message History│              │   Web Search   │
                │  (pgvector)    │              │   (Slack API)  │              │   (on demand)  │
                └────────────────┘              └────────────────┘              └────────────────┘
```

## Key Features

1. **Mention/DM Only**: Only responds when @mentioned or in DMs
2. **User Memory**: Stores facts about users with vector embeddings for semantic recall
3. **Context Aware**: Fetches recent message history via Slack API when called
4. **Web Search**: Uses OpenAI's web search when current information is needed
5. **Privacy Controls**: Users can view and delete their data

## Personality

Direct, cunning, and helpful with a dry sense of humor. Matter-of-fact and efficient - no fluff or excessive politeness. Genuinely wants to solve problems.

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Slack**: Bolt Framework (HTTP webhooks)
- **Database**: Supabase with pgvector
- **AI**: OpenAI GPT-4o-mini (responses), text-embedding-3-small (vectors)
- **Deployment**: Railway

## Project Structure

```
src/
├── index.ts              # Main Slack handler
├── services/
│   ├── openai.ts         # AI responses, embeddings, fact extraction
│   ├── supabase.ts       # Database operations, vector search
│   └── context.ts        # Fetch Slack history, build context
└── utils/
    └── logger.ts         # Winston logging
supabase/
└── schema.sql            # Database schema with pgvector
```

## Database Schema

### users
- `slack_id` - Unique Slack user ID
- `display_name` - User's display name

### user_facts
- `user_slack_id` - Foreign key to users
- `fact` - The fact text
- `embedding` - 1536-dim vector for similarity search
- `source_channel` - Where the fact was learned

## Environment Variables

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=...
PORT=3000
```

## Slash Commands

- `/pup status` - System status
- `/pup privacy` - View stored facts about you
- `/pup forget me` - Delete all your data
- `/pup help` - Available commands

## Flow

1. User @mentions bot or sends DM
2. Bot fetches recent channel/thread history via Slack API
3. Bot searches for relevant stored facts (vector similarity)
4. Bot generates response with context + facts + optional web search
5. After responding, bot extracts any new facts and stores them

## Development

```bash
npm install
npm run dev      # Development with hot reload
npm run build    # Compile TypeScript
npm run start    # Run compiled code
```

## Deployment

1. Create Supabase project, run `supabase/schema.sql`
2. Create Slack app with bot token and event subscriptions
3. Deploy to Railway with environment variables
4. Set Slack event URL to `https://your-app.railway.app/slack/events`
