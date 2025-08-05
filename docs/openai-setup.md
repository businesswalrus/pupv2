# OpenAI Integration Setup

## Overview
The bot uses OpenAI's GPT-4o-mini model for all AI operations, with three main processing stages:

1. **Message Ingestion** - Analyzes every message to determine if it should form a memory or trigger a response
2. **Memory Formation** - Creates structured memories from significant messages
3. **Response Generation** - Generates contextual, witty responses when appropriate

## Configuration

Add your OpenAI API key to the `.env` file:
```
OPENAI_API_KEY=sk-your-actual-api-key-here
```

## Cost Optimization

The system is designed to stay under $50/month for typical usage (1-2k messages/day):
- Uses GPT-4o-mini for all operations (very cost-effective)
- Implements token limits per message
- Tracks usage and costs in real-time
- Batches messages when possible (5-second window)

## Prompts Structure

### Ingestion Prompt
- Determines if message should form memory
- Decides if bot should respond
- Extracts entities (topics, emotions, references)
- Returns structured JSON response

### Memory Formation Prompt
- Creates concise, searchable memories
- Generates embeddings for semantic search
- Tags memories for easy retrieval
- Focuses on callbacks and humor

### Response Generation Prompt
- Personality: witty observer, not assistant
- Prioritizes callbacks and inside jokes
- Adapts to channel vibe
- Keeps responses brief (1-3 lines typically)

## Usage Tracking

Check current usage with:
```
/pup status
```

The bot logs usage stats periodically and tracks:
- Total tokens used
- Total cost in USD
- Cost per operation type

## Testing the Integration

1. Start the bot in dev mode:
   ```bash
   npm run dev
   ```

2. Send a message in Slack that mentions the bot
3. Check logs for AI processing steps
4. Use `/pup status` to see token usage

## Customizing Prompts

To adjust the bot's personality or behavior, modify the system prompts in:
- `src/services/openai.ts` - Core prompts for each stage
- Adjust temperature settings for more/less creativity
- Modify token limits for longer/shorter responses

## Next Steps

1. Implement Redis message buffering for context
2. Set up SQLite database for memory storage
3. Add vector search for memory retrieval
4. Implement batch processing for cost savings