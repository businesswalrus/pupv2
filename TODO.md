# pup.ai TODO - Next Iteration

## 🎯 Priority 1: Core AI Pipeline
The Slack integration works! Now we need to make pup.ai actually intelligent.

### 1. Database Schema Implementation
- [ ] Create full SQLite schema with migrations
- [ ] Implement sqlite-vec for embeddings
- [ ] Create TypeScript models for all tables
- [ ] Add database seed data for testing

### 2. Redis Message Buffer
- [ ] Connect to Railway Redis instance
- [ ] Implement 100-message buffer per channel
- [ ] Create message queue for batch processing
- [ ] Add cache for user profiles (1hr TTL)

### 3. OpenAI Integration
- [ ] Create OpenAI service with retry logic
- [ ] Implement embedding generation
- [ ] Add completion methods for responses
- [ ] Create cost tracking per operation

### 4. Three-Stage Pipeline
- [ ] **Stage 1: Ingestion**
  - Message classification
  - Significance scoring
  - Entity extraction
- [ ] **Stage 2: Memory Formation**
  - Create memories for significant events
  - Generate and store embeddings
  - Update user profiles
- [ ] **Stage 3: Response Generation**
  - Context aggregation from Redis
  - Semantic search for relevant memories
  - Personality-aware response creation

## 🎯 Priority 2: Essential Features

### 5. Basic Memory System
- [ ] Implement memory creation
- [ ] Add semantic search
- [ ] Create memory expiration (6 months)
- [ ] Build memory recall for responses

### 6. User Profiling
- [ ] Track basic user traits
- [ ] Monitor communication patterns
- [ ] Identify interests from messages
- [ ] Build personality summaries

### 7. Response Logic
- [ ] Always respond to @mentions
- [ ] Implement "should respond" logic
- [ ] Add channel vibe detection
- [ ] Create witty response templates

## 🎯 Priority 3: Privacy & Polish

### 8. Privacy Commands
- [ ] Implement `/pup forget me`
- [ ] Add `/pup privacy` report
- [ ] Create `/pup pause` functionality
- [ ] Build data deletion logic

### 9. Cost Management
- [ ] Track tokens per operation
- [ ] Implement daily cost limits
- [ ] Add batching for efficiency
- [ ] Create cost dashboard

### 10. Testing & Monitoring
- [ ] Add integration tests
- [ ] Create Railway monitoring
- [ ] Implement error alerting
- [ ] Build performance metrics

## 📝 Development Notes

**Next Session Focus**: Start with database schema and OpenAI integration. Once we can store memories and generate embeddings, we can build the pipeline stages.

**Key Decision**: Should we use Railway's Redis or a local SQLite table for message buffering? Redis is better for real-time but adds complexity.

**Remember**: Keep responses under 10 lines and maintain the witty, observer personality!