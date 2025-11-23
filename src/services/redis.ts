import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { MessageContext } from './openai';

export class RedisService {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor(redisUrl?: string) {
    const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';

    this.client = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => {
          // Exponential backoff: 50ms, 100ms, 200ms, ..., max 3000ms
          const delay = Math.min(50 * Math.pow(2, retries), 3000);
          logger.debug(`Redis reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        }
      }
    });

    // Error handling
    this.client.on('error', (err) => {
      logger.error('Redis client error', err);
      this.connected = false;
    });

    this.client.on('connect', () => {
      logger.info('Redis client connected');
      this.connected = true;
    });

    this.client.on('ready', () => {
      logger.info('Redis client ready');
      this.connected = true;
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis client reconnecting...');
      this.connected = false;
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      logger.info('Redis service initialized');
    } catch (error) {
      logger.error('Failed to connect to Redis', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
      logger.info('Redis client disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ==========================================
  // MESSAGE BUFFERING
  // ==========================================

  /**
   * Add a message to the channel's buffer
   * Keeps last 100 messages per channel using a capped list
   */
  async bufferMessage(channelId: string, message: MessageContext): Promise<void> {
    if (!this.connected) {
      logger.warn('Redis not connected, skipping message buffer');
      return;
    }

    try {
      const key = `channel:${channelId}:messages`;
      const messageData = JSON.stringify({
        text: message.text,
        user: message.user,
        timestamp: message.timestamp,
        thread_ts: message.thread_ts
      });

      // Add to beginning of list (most recent first)
      await this.client.lPush(key, messageData);

      // Trim to keep only last 100 messages
      await this.client.lTrim(key, 0, 99);

      // Set expiration to 24 hours (messages older than this get cleaned up)
      await this.client.expire(key, 86400);

      logger.debug('Message buffered', { channelId, messagesInBuffer: await this.getBufferSize(channelId) });
    } catch (error) {
      logger.error('Failed to buffer message', error);
      // Don't throw - graceful degradation
    }
  }

  /**
   * Get recent messages from channel buffer
   */
  async getRecentMessages(channelId: string, limit: number = 100): Promise<MessageContext[]> {
    if (!this.connected) {
      logger.warn('Redis not connected, returning empty message buffer');
      return [];
    }

    try {
      const key = `channel:${channelId}:messages`;
      const messages = await this.client.lRange(key, 0, limit - 1);

      return messages.map(msg => JSON.parse(msg));
    } catch (error) {
      logger.error('Failed to retrieve message buffer', error);
      return [];
    }
  }

  /**
   * Get buffer size for a channel
   */
  async getBufferSize(channelId: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      const key = `channel:${channelId}:messages`;
      return await this.client.lLen(key);
    } catch (error) {
      return 0;
    }
  }

  // ==========================================
  // CACHING LAYER
  // ==========================================

  /**
   * Cache user profile with TTL
   */
  async cacheUserProfile(userId: string, profile: any, ttlSeconds: number = 3600): Promise<void> {
    if (!this.connected) return;

    try {
      const key = `user:${userId}:profile`;
      await this.client.setEx(key, ttlSeconds, JSON.stringify(profile));
      logger.debug('User profile cached', { userId, ttl: ttlSeconds });
    } catch (error) {
      logger.error('Failed to cache user profile', error);
    }
  }

  /**
   * Get cached user profile
   */
  async getCachedUserProfile(userId: string): Promise<any | null> {
    if (!this.connected) return null;

    try {
      const key = `user:${userId}:profile`;
      const cached = await this.client.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached user profile', error);
      return null;
    }
  }

  /**
   * Cache channel vibe with TTL
   */
  async cacheChannelVibe(channelId: string, vibe: any, ttlSeconds: number = 3600): Promise<void> {
    if (!this.connected) return;

    try {
      const key = `channel:${channelId}:vibe`;
      await this.client.setEx(key, ttlSeconds, JSON.stringify(vibe));
      logger.debug('Channel vibe cached', { channelId, ttl: ttlSeconds });
    } catch (error) {
      logger.error('Failed to cache channel vibe', error);
    }
  }

  /**
   * Get cached channel vibe
   */
  async getCachedChannelVibe(channelId: string): Promise<any | null> {
    if (!this.connected) return null;

    try {
      const key = `channel:${channelId}:vibe`;
      const cached = await this.client.get(key);
      return cached ? JSON.parse(cached) : null;
    } catch (error) {
      logger.error('Failed to get cached channel vibe', error);
      return null;
    }
  }

  /**
   * Invalidate cache for a specific key pattern
   */
  async invalidateCache(pattern: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) return 0;

      await this.client.del(keys);
      logger.info('Cache invalidated', { pattern, keysDeleted: keys.length });
      return keys.length;
    } catch (error) {
      logger.error('Failed to invalidate cache', error);
      return 0;
    }
  }

  /**
   * Clear all cached data (use sparingly)
   */
  async flushAll(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.flushAll();
      logger.warn('All Redis cache flushed');
    } catch (error) {
      logger.error('Failed to flush cache', error);
    }
  }

  // ==========================================
  // UTILITY FUNCTIONS
  // ==========================================

  /**
   * Get cache statistics
   */
  async getCacheStats(): Promise<any> {
    if (!this.connected) {
      return { connected: false };
    }

    try {
      const info = await this.client.info('stats');
      const memory = await this.client.info('memory');

      return {
        connected: true,
        info,
        memory
      };
    } catch (error) {
      logger.error('Failed to get cache stats', error);
      return { connected: true, error: 'Failed to retrieve stats' };
    }
  }
}

// Singleton instance
let redisService: RedisService | null = null;

export function getRedisService(): RedisService {
  if (!redisService) {
    throw new Error('Redis service not initialized. Call initializeRedis() first.');
  }
  return redisService;
}

export async function initializeRedis(url?: string): Promise<RedisService> {
  if (redisService) {
    logger.warn('Redis service already initialized');
    return redisService;
  }

  redisService = new RedisService(url);
  await redisService.connect();
  return redisService;
}

export async function shutdownRedis(): Promise<void> {
  if (redisService) {
    await redisService.disconnect();
    redisService = null;
  }
}
