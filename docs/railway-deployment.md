# Railway Deployment Guide

## Prerequisites

1. Railway account with CLI installed
2. GitHub repo connected to Railway
3. Environment variables configured

## Volume Setup

The bot requires persistent storage for the SQLite database. Railway provides volumes for this purpose.

### Creating a Volume

1. Go to your Railway project
2. Navigate to the service (pupv2-production)
3. Click "Variables" tab
4. Add a new Volume:
   - **Mount Path**: `/app/data`
   - **Size**: 1GB (sufficient for ~100k messages worth of memories)

### Environment Variables

Required variables in Railway dashboard:

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret
OPENAI_API_KEY=sk-your-key

# Optional (Railway provides managed Redis)
REDIS_URL=redis://default:password@hostname:port

# Database - should be on the volume
DATABASE_URL=file:/app/data/pup.db

# Application Settings
NODE_ENV=production
PORT=8080
LOG_LEVEL=info

# Cost Control
MAX_TOKENS_PER_MESSAGE=150
MEMORY_EXPIRATION_DAYS=180
COST_LIMIT_DAILY_USD=2.00

# Batch Processing
BATCH_WINDOW_MS=5000
BATCH_SIZE_MAX=10

# Cache TTL
USER_PROFILE_CACHE_TTL=3600
CHANNEL_VIBE_CACHE_TTL=3600
```

## Deployment Process

1. **Push to main branch**
   ```bash
   git push origin main
   ```

2. **Railway auto-deploys** from GitHub

3. **Verify health check**
   - Visit: `https://your-app.up.railway.app/health`
   - Should return: `{ "status": "healthy", ... }`

4. **Monitor logs**
   ```bash
   railway logs
   ```

   Look for:
   - ✓ Database initialized
   - ✓ Redis connected
   - ✓ sqlite-vec extension loaded
   - ⚡️ pup.ai is running on port 8080

## Volume Verification

After first deploy, verify the volume is working:

```bash
# SSH into Railway container
railway run bash

# Check volume is mounted
ls -la /app/data

# Should see:
# pup.db
# pup.db-shm
# pup.db-wal
```

## Database Persistence

The SQLite database at `/app/data/pup.db` persists across deployments because it's on the volume. All tables, memories, and user profiles survive restarts.

## Backup Strategy

Railway volumes are backed up automatically, but you can also:

1. **Download database** (via SSH):
   ```bash
   railway run bash
   cat /app/data/pup.db > /tmp/backup.db
   exit
   ```

2. **Schedule periodic dumps** (future enhancement):
   - Add cron job to export memories to JSON
   - Upload to S3/cloud storage weekly

## Scaling Notes

- **Single replica only**: SQLite doesn't support multiple concurrent writers
- For scaling, migrate to PostgreSQL with pgvector
- Current setup handles ~15 users, 40 channels, 2k msg/day easily

## Troubleshooting

### Volume not persisting

1. Check `railway.json` has `"volumeMountPath": "/app/data"`
2. Verify DATABASE_URL points to `/app/data/pup.db`
3. Check Railway dashboard shows volume attached

### Database locked errors

- SQLite uses WAL mode for better concurrency
- If errors persist, check file permissions:
  ```bash
  ls -la /app/data/pup.db*
  ```

### Out of space

- Check volume usage in Railway dashboard
- Clean up old memories: bot auto-expires after 180 days
- Increase volume size if needed

## Monitoring

Health endpoint provides system status:
```bash
curl https://your-app.up.railway.app/health
```

For detailed stats:
```
/pup status  # Shows OpenAI usage
/pup health  # (Future) Full system metrics
```
