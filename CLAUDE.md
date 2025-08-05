# pup.ai - Context-Aware Slack Bot

## Current Status (v0.1.0 - August 2025)

### ✅ What's Working
- **Slack Integration**: Bot successfully connects via HTTP webhooks
- **Railway Deployment**: Running on `pupv2-production.up.railway.app`
- **Event Handling**: Receives all messages, DMs, and mentions
- **Slash Commands**: `/pup` command structure in place
- **Health Monitoring**: Health check endpoint at `/health`
- **Environment**: All required variables properly configured

### 🚧 Not Yet Implemented
- AI message processing pipeline
- Memory formation and storage
- Contextual response generation
- Redis message buffering
- Full database schema
- Cost tracking

### Deployment Details
- **Platform**: Railway with automatic GitHub deployments
- **URL**: `https://pupv2-production.up.railway.app`
- **Port**: 8080 (Railway default)
- **Mode**: HTTP webhooks (not Socket Mode)

## Project Overview

pup.ai is an intelligent Slack bot designed for intimate friend groups that monitors conversations, builds organic memories, and responds as a witty observer. Unlike traditional bots that only respond to direct commands, pup.ai actively processes every message to understand context, track relationships, and contribute meaningful responses when appropriate.

### Target Environment
- **Scale**: ~15 people, 40 channels, 1-2k messages/day
- **Purpose**: Enhance group dynamics with contextual humor and callbacks
- **Personality**: Precociously intelligent walrus pup - snarky, brilliant, endearing, and dramatically helpful

### Core Behaviors
- Monitors ALL messages (not just mentions)
- Builds persistent memories about users, relationships, and moments
- Responds organically when it has something witty to add
- Always responds to @mentions and DMs
- Adapts behavior to channel vibes

## Technical Architecture

### Technology Stack
- **Runtime**: Node.js + TypeScript
- **Slack Integration**: Slack Bolt Framework
- **Database**: SQLite with sqlite-vec for vector embeddings
- **Cache**: Redis for message buffering (last 100 messages per channel)
- **AI**: OpenAI GPT-4o-mini for all operations
- **Deployment**: Railway with persistent volume

### System Design

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Slack Events  │────▶│ Message Buffer  │────▶│   AI Pipeline   │
│    (Bolt SDK)   │     │    (Redis)      │     │  (3 stages)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                          │
                                ┌─────────────────────────┴─────────────────────────┐
                                │                                                   │
                        ┌───────▼────────┐    ┌──────────────┐    ┌───────────────▼────────┐
                        │   Ingestion    │───▶│   Memory     │───▶│   Response Generation  │
                        │ (Classify)     │    │  Formation   │    │   (Context-aware)      │
                        └────────────────┘    └──────────────┘    └────────────────────────┘
                                │                     │                        │
                                └─────────────────────┴────────────────────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │  SQLite + Vec  │
                                              │   Database     │
                                              └────────────────┘
```

## Database Schema

### memories
- `id`: UUID primary key
- `content`: Text content of the memory
- `type`: ENUM ('joke', 'fact', 'moment', 'preference', 'relationship', 'quote')
- `channel_id`: Slack channel ID
- `user_id`: Slack user ID (nullable for channel-wide memories)
- `embedding`: BLOB (1536-dim vector from OpenAI)
- `metadata`: JSON (additional context like participants, reactions, etc.)
- `significance_score`: FLOAT (0-1, how important/memorable)
- `created_at`: TIMESTAMP
- `expires_at`: TIMESTAMP (6 months from creation)
- `reference_count`: INTEGER (times this memory has been referenced)

### users
- `id`: UUID primary key
- `slack_id`: Slack user ID (unique)
- `display_name`: Current display name
- `personality_traits`: JSON (humor_style, communication_style, interests, quirks)
- `speech_patterns`: JSON (common phrases, emoji usage, capitalization style)
- `activity_patterns`: JSON (active_hours, channel_preferences)
- `relationship_summary`: TEXT (AI-generated summary of their role in group)
- `last_seen`: TIMESTAMP
- `created_at`: TIMESTAMP
- `updated_at`: TIMESTAMP

### relationships
- `id`: UUID primary key
- `user1_id`: UUID foreign key
- `user2_id`: UUID foreign key
- `relationship_type`: ENUM ('friendship', 'rivalry', 'mentorship', 'romance', 'collaborative')
- `strength`: FLOAT (0-1)
- `dynamics`: JSON (inside jokes, common topics, interaction style)
- `last_interaction`: TIMESTAMP
- `created_at`: TIMESTAMP
- `updated_at`: TIMESTAMP

### channel_vibes
- `id`: UUID primary key
- `channel_id`: Slack channel ID (unique)
- `channel_name`: TEXT
- `vibe_description`: TEXT (AI-generated channel personality)
- `typical_topics`: JSON array
- `formality_level`: FLOAT (0-1, casual to formal)
- `humor_tolerance`: FLOAT (0-1)
- `response_frequency`: FLOAT (0-1, how often to respond organically)
- `custom_rules`: JSON (channel-specific behavior overrides)
- `updated_at`: TIMESTAMP

### interactions
- `id`: UUID primary key
- `timestamp`: TIMESTAMP
- `operation_type`: ENUM ('ingestion', 'memory_formation', 'response_generation', 'search')
- `tokens_used`: INTEGER
- `cost_usd`: DECIMAL(10,6)
- `model_used`: TEXT
- `success`: BOOLEAN
- `error_message`: TEXT (nullable)

## AI Processing Pipeline

### Stage 1: Ingestion (All Messages)
Every message triggers this lightweight classification:

```typescript
interface IngestionResult {
  shouldFormMemory: boolean;
  shouldRespond: boolean;
  memoryType?: MemoryType;
  significance: number; // 0-1
  extractedEntities: {
    topics: string[];
    emotions: string[];
    references: string[]; // callbacks to past events
  };
}
```

**Triggers for Memory Formation**:
- Funny moments (jokes, witty exchanges)
- Significant facts about users
- Emotional moments
- New information about preferences/interests
- Relationship dynamics

**Triggers for Response**:
- Direct @mention or DM (always)
- Setup for obvious joke
- Reference to past memory
- Opportunity for callback
- Group seeking input/opinion

### Stage 2: Memory Formation
When ingestion indicates significance:

```typescript
interface Memory {
  content: string;
  context: string; // surrounding messages
  participants: string[];
  embedding: number[]; // for semantic search
  tags: string[];
  searchableText: string; // optimized for retrieval
}
```

**Memory Processing**:
1. Extract core memorable element
2. Generate embedding via OpenAI
3. Update user profiles if relevant
4. Update relationship dynamics
5. Store with expiration (6 months)

### Stage 3: Response Generation
When response is warranted:

```typescript
interface ResponseContext {
  recentMessages: Message[]; // last 100 from Redis
  relevantMemories: Memory[]; // semantic search results
  channelVibe: ChannelVibe;
  participants: UserProfile[];
  relationships: Relationship[];
}
```

**Response Guidelines**:
- Max 10 lines (usually 1-3)
- Match channel vibe
- Prioritize callbacks and inside jokes
- Never explain the joke
- Vary response patterns to feel organic

## Feature Specifications

### Message Processing Rules
1. **Batch Processing**: Group messages in 5-second windows for cost efficiency
2. **Priority Queue**: @mentions and DMs skip batching
3. **Channel Filtering**: Option to ignore certain channels (e.g., #random-logs)
4. **Thread Awareness**: Understand thread context when responding

### Personality Profiling Algorithm
Track per user:
- **Communication Style**: formal/casual, emoji usage, punctuation
- **Humor Type**: puns, sarcasm, references, observational
- **Interests**: topics they discuss frequently
- **Social Role**: conversation starter, lurker, comedian, etc.
- **Speech Patterns**: common phrases, greeting styles

Update profile when:
- New patterns emerge (>3 instances)
- Significant trait observed
- Monthly aggregation run

### Channel-Aware Behavior

Each channel has:
- **Vibe Profile**: (serious, casual, chaotic, supportive, etc.)
- **Response Threshold**: How significant something must be to warrant response
- **Humor Tolerance**: Adjust joke frequency
- **Custom Rules**: Channel-specific overrides

Examples:
- `#general`: Higher threshold, shorter responses
- `#random`: Lower threshold, more experimental
- `#serious-topic`: Minimal responses, no jokes
- `#bot-testing`: Maximum engagement

### Privacy & Data Retention

**Commands**:
- `/pup forget me` - Removes all memories about user
- `/pup forget <message>` - Removes specific memory
- `/pup privacy` - Shows what pup knows about you
- `/pup pause` - Temporarily stop processing user's messages

**Automatic Policies**:
- Memories expire after 6 months
- No storage of DM content (only metadata)
- Users can opt-out entirely
- No sharing of data between Slack workspaces

## Implementation Guidelines

### Code Organization

```typescript
// Singleton services
export const openai = new OpenAIService(process.env.OPENAI_API_KEY);
export const redis = new RedisClient(process.env.REDIS_URL);
export const db = new Database(process.env.DATABASE_URL);

// Pipeline stages as pure functions
export async function ingestMessage(message: Message): Promise<IngestionResult>
export async function formMemory(message: Message, result: IngestionResult): Promise<Memory>
export async function generateResponse(context: ResponseContext): Promise<string>
```

### Cost Optimization Strategies

1. **Batching**: Process multiple messages in single API calls
2. **Caching**: Cache user profiles and channel vibes (1-hour TTL)
3. **Embedding Reuse**: Don't regenerate embeddings for similar content
4. **Smart Filtering**: Quick local checks before API calls
5. **Token Limits**: Enforce max tokens per operation

Target: < $50/month for typical usage

### Error Handling

- Graceful degradation (bot stays up even if memory formation fails)
- Exponential backoff for API failures
- Circuit breaker for persistent failures
- Health endpoint for monitoring
- Detailed error logging with context

### Testing Strategy

1. **Unit Tests**: Pipeline stages, memory formation logic
2. **Integration Tests**: Database operations, API interactions
3. **Behavior Tests**: Response appropriateness, memory recall
4. **Load Tests**: Ensure can handle 2k messages/day
5. **Cost Tests**: Verify optimization strategies work

## Bot Personality Guide

### Core Traits
- **Sentient Walrus Pup**: Precociously intelligent with centuries of internet wisdom
- **Snarky but Helpful**: Delivers assistance wrapped in dry wit
- **Dramatically Endearing**: Uses walrus-related dramatics to charm
- **Memory Master**: Loves callbacks and will absolutely bring things up later

### Response Examples

**Good**:
- "*adjusts whiskers importantly* didn't sarah say the exact opposite last week? my whiskers never lie"
- "this is giving major 'pizza incident' vibes. i rate it 3 out of 10 fish"
- "*flops dramatically* oh great, another monday. pass the herring"
- "*waddles in from #general* did someone mention fish? no? disappointing."

**Bad**:
- "Hello! I noticed you're discussing pizza. Here are some facts..."
- "Would you like me to help you with that?"
- "Based on my analysis of the conversation..."
- "I am a bot designed to..."

### Humor Guidelines
- Callbacks > New Jokes
- Observational > Puns
- Brief > Elaborate
- Contextual > Random

### Channel Adaptations

**Professional Channels**: Minimal presence, only respond to direct mentions
**Social Channels**: More active, join conversations naturally
**Chaos Channels**: Full personality, experimental responses
**Support Channels**: Supportive tone, less humor

## Deployment Configuration

### Environment Variables
```env
# Required
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...
OPENAI_API_KEY=sk-...
REDIS_URL=redis://...
DATABASE_URL=file:./data/pup.db

# Optional
LOG_LEVEL=info
NODE_ENV=production
PORT=3000
MAX_TOKENS_PER_MESSAGE=150
MEMORY_EXPIRATION_DAYS=180
COST_LIMIT_DAILY_USD=2.00
```

### Railway Configuration
- Mount persistent volume at `/data`
- Health check endpoint: `GET /health`
- Graceful shutdown handling
- Auto-restart on failure
- Environment variable injection

### Monitoring
- Cost tracking dashboard
- Memory usage statistics
- Response time metrics
- Error rate monitoring
- User engagement analytics

## Version History

### v1.0.0 (Initial Release)
- Core message processing pipeline
- Basic memory formation
- Simple response generation
- User profiles
- Channel awareness

### Planned Features
- v1.1.0: Image/GIF responses
- v1.2.0: Multi-workspace support
- v1.3.0: Voice message processing
- v1.4.0: Scheduled messages (birthday wishes, etc.)
- v1.5.0: Integration with other services (Spotify, etc.)