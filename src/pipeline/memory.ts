import { getOpenAIService, MessageContext, IngestionResult, Memory } from '../services/openai';
import { logger } from '../utils/logger';
import { runQuery, allQuery } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';

export async function formMemory(
  message: MessageContext, 
  ingestionResult: IngestionResult
): Promise<Memory | null> {
  if (!ingestionResult.shouldFormMemory) {
    logger.debug('Message does not warrant memory formation');
    return null;
  }

  const openai = getOpenAIService();
  
  try {
    logger.info('Forming memory', { 
      type: ingestionResult.memoryType,
      significance: ingestionResult.significance 
    });

    const memory = await openai.formMemory(message, ingestionResult);

    if (memory) {
      // Save memory to database
      const memoryId = uuidv4();
      const expirationDays = parseInt(process.env.MEMORY_EXPIRATION_DAYS || '180');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + expirationDays);

      try {
        // Convert embedding to binary blob for storage
        const embeddingBlob = memory.embedding
          ? Buffer.from(new Float32Array(memory.embedding).buffer)
          : null;

        // Insert into memories table
        await runQuery(`
          INSERT INTO memories (
            id, content, type, channel_id, user_id, embedding,
            metadata, significance_score, expires_at, searchable_text,
            tags, context, participants
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          memoryId,
          memory.content,
          memory.type,
          message.channel,
          message.user,
          embeddingBlob,
          JSON.stringify({ timestamp: message.timestamp, thread: message.thread_ts }),
          memory.significance,
          expiresAt.toISOString(),
          memory.searchableText,
          JSON.stringify(memory.tags),
          memory.context,
          JSON.stringify(memory.participants)
        ]);

        // Insert embedding into vector search table if available
        if (memory.embedding && memory.embedding.length === 1536) {
          await runQuery(`
            INSERT INTO vec_memories (memory_id, embedding)
            VALUES (?, ?)
          `, [memoryId, JSON.stringify(memory.embedding)]);
        }

        logger.info('Memory saved to database', {
          id: memoryId,
          type: memory.type,
          contentLength: memory.content.length,
          tags: memory.tags,
          expiresAt: expiresAt.toISOString()
        });
      } catch (dbError) {
        logger.error('Failed to save memory to database', dbError);
        // Don't throw - allow memory formation to continue even if DB fails
      }
    }

    return memory;
  } catch (error) {
    logger.error('Error in memory formation pipeline', error);
    return null;
  }
}

export async function searchMemories(
  query: string,
  limit: number = 5,
  channelId?: string
): Promise<Memory[]> {
  try {
    logger.debug('Memory search requested', { query, limit, channelId });

    // Generate embedding for the search query
    const openai = getOpenAIService();
    const queryEmbedding = await openai.generateEmbedding(query);

    if (!queryEmbedding || queryEmbedding.length !== 1536) {
      logger.warn('Failed to generate query embedding for memory search');
      return [];
    }

    // Perform vector similarity search using sqlite-vec
    // This finds the most similar memories based on cosine similarity
    let searchQuery = `
      SELECT
        m.id, m.content, m.type, m.channel_id, m.user_id,
        m.metadata, m.significance_score, m.created_at,
        m.searchable_text, m.tags, m.context, m.participants,
        vec.distance
      FROM vec_memories vec
      JOIN memories m ON vec.memory_id = m.id
      WHERE vec.embedding MATCH ?
        AND (m.expires_at IS NULL OR m.expires_at > datetime('now'))
    `;

    const params: any[] = [JSON.stringify(queryEmbedding)];

    // Optionally filter by channel
    if (channelId) {
      searchQuery += ' AND m.channel_id = ?';
      params.push(channelId);
    }

    searchQuery += `
      ORDER BY vec.distance ASC
      LIMIT ?
    `;
    params.push(limit);

    const results = await allQuery(searchQuery, params);

    // Update reference count for retrieved memories
    const memoryIds = results.map((r: any) => r.id);
    if (memoryIds.length > 0) {
      await runQuery(`
        UPDATE memories
        SET reference_count = reference_count + 1
        WHERE id IN (${memoryIds.map(() => '?').join(',')})
      `, memoryIds);
    }

    // Convert database rows to Memory objects
    const memories: Memory[] = results.map((row: any) => ({
      content: row.content,
      context: row.context,
      participants: JSON.parse(row.participants || '[]'),
      embedding: undefined, // Don't load full embedding for response
      tags: JSON.parse(row.tags || '[]'),
      searchableText: row.searchable_text,
      type: row.type,
      significance: row.significance_score
    }));

    logger.info('Memory search completed', {
      query: query.substring(0, 50),
      resultsFound: memories.length,
      channelFilter: channelId || 'all'
    });

    return memories;
  } catch (error) {
    logger.error('Error in memory search', error);
    return []; // Graceful degradation
  }
}

export async function getRecentMemories(
  channelId: string,
  limit: number = 10
): Promise<Memory[]> {
  try {
    logger.debug('Recent memories requested', { channelId, limit });

    const results = await allQuery(`
      SELECT
        id, content, type, channel_id, user_id, metadata,
        significance_score, created_at, searchable_text,
        tags, context, participants
      FROM memories
      WHERE channel_id = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at DESC, significance_score DESC
      LIMIT ?
    `, [channelId, limit]);

    const memories: Memory[] = results.map((row: any) => ({
      content: row.content,
      context: row.context,
      participants: JSON.parse(row.participants || '[]'),
      embedding: undefined,
      tags: JSON.parse(row.tags || '[]'),
      searchableText: row.searchable_text,
      type: row.type,
      significance: row.significance_score
    }));

    logger.debug('Recent memories retrieved', {
      channelId,
      count: memories.length
    });

    return memories;
  } catch (error) {
    logger.error('Error retrieving recent memories', error);
    return [];
  }
}