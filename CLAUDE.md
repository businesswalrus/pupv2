# pup.ai v2

## What It Is
Slack bot that responds to mentions/DMs, remembers facts about users, reads conversation context, and can search the web. Has an "active mode" where it participates in conversations organically.

## Tech Stack
- **Runtime**: Node.js + TypeScript
- **Slack**: Bolt Framework (HTTP webhooks on `/slack/events`)
- **Database**: Supabase with pgvector for user facts + embeddings
- **AI**: OpenAI GPT-5-mini via Responses API, text-embedding-3-small for vectors
- **Deployment**: Railway

## Core Behavior

### Two Modes
1. **Inactive (default)**: Only responds to @mentions and DMs
2. **Active**: Reads all messages, uses AI judgment to decide when to chime in

### Activation
- `@pup activate` - Turn on active mode in channel
- `@pup deactivate` - Turn off, go back to mention-only
- Active channels tracked in memory (`activeChannels` Set)

### When Active
1. Fetches last 15 messages via Slack API for context
2. Asks AI: "Should I respond to this?" (not every message)
3. Only responds if it has something valuable to add

## File Structure
```
src/
├── index.ts              # Main handler - Slack events, activate/deactivate, response logic
├── services/
│   ├── openai.ts         # GPT-5-mini responses, embeddings, fact extraction, web search
│   └── supabase.ts       # User facts storage, vector similarity search
└── utils/
    └── logger.ts         # Winston logging
supabase/
└── schema.sql            # Database schema (users, user_facts with pgvector)
```

## Key Functions (index.ts)

- `fetchChannelHistory(client, channelId, limit)` - Get recent messages for context
- `shouldRespondOrganically(recentMessages, currentMessage, userFacts)` - AI decides if to respond
- `extractAndStoreFacts(text, userId, channelId)` - Background fact extraction after responses

## Key Functions (openai.ts)

- `generateResponse(options)` - Main response generation via GPT-5-mini Responses API
- `generateEmbedding(text)` - Create 1536-dim vector for fact storage
- `extractFacts(conversationText, userSlackId)` - Extract memorable facts from conversation
- `shouldUseWebSearch(text)` - Detect if web search needed (prices, news, dates, etc.)

## Key Functions (supabase.ts)

- `ensureUser(slackId, displayName)` - Create/update user record
- `storeFact(userSlackId, fact, embedding, sourceChannel)` - Store fact with vector
- `getUserFacts(userSlackId, limit)` - Get recent facts about a user
- `searchFacts(queryEmbedding, options)` - Vector similarity search
- `deleteUserData(slackId)` - GDPR deletion

## Database Schema (Supabase)

```sql
-- Users
users (id, slack_id UNIQUE, display_name, created_at, updated_at)

-- Facts with vectors
user_facts (id, user_slack_id FK, fact, embedding vector(1536), source_channel, created_at)

-- Vector search function
search_user_facts(query_embedding, match_threshold, match_count, target_user_slack_id)
```

## Slash Commands

- `/pup status` - Shows users, facts count, active channels, uptime
- `/pup privacy` - Shows facts stored about the user
- `/pup forget me` - Deletes all user data
- `/pup help` - Command list

## Environment Variables

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...
PORT=3000
```

## Message Flow

1. Message received → skip if bot/duplicate/from self
2. Check if activate/deactivate command → handle and return
3. Determine response type: DM, mention, or organic (if active)
4. If organic: AI decides whether to respond
5. Fetch channel history for context (15 messages)
6. Get user facts from Supabase
7. Generate response via GPT-5-mini (with optional web search)
8. Send response
9. Extract new facts in background

## Bot Personality

Direct, cunning, helpful with dry humor. Matter-of-fact, cuts through fluff. Defined in `SYSTEM_PROMPT` in `openai.ts`.

## Anti-Loop Protections

- Skip messages with `bot_id`, `subtype`, or from `botUserId`
- Deduplicate using `channel-ts` in `processedMessages` Set
- Clean up Set when > 1000 entries

## Web Search

Triggers automatically on patterns like:
- "what's the latest/current..."
- "today", "this week/month/year"
- "price of", "weather", "stock", "score"
- "look up", "search for", "find"

Uses GPT-5-mini with `web_search_preview` tool via Responses API.
