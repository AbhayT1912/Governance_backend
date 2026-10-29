# Redis Configuration Guide for Cloud Deployment

## Current Issue
Your Heroku/cloud deployment is failing because **Redis is not available** on localhost:6379. The application uses BullMQ for async job processing (repository analysis), which requires Redis.

## Solution Options

### Option 1: Use Heroku Redis Add-on (RECOMMENDED for Heroku)

**Steps:**
1. Add Redis to your Heroku app:
   ```bash
   heroku addons:create heroku-redis:premium-0
   ```

2. Heroku automatically adds `REDIS_URL` to your environment variables

3. Deploy again - the server will now use Redis automatically

4. Verify it's working:
   ```bash
   heroku logs --tail
   # Look for: "✅ Redis queue initialized with REDIS_URL"
   ```

### Option 2: Use Redis Cloud (Works with any cloud provider)

**Steps:**
1. Create a free account at [Redis Cloud](https://redis.com/try-free/)

2. Create a database and copy the connection string (looks like: `redis://default:password@host:port`)

3. Add to your Heroku environment:
   ```bash
   heroku config:set REDIS_URL="redis://default:password@host:port"
   ```

4. Or add to `.env` for local development:
   ```
   REDIS_URL=redis://default:password@host:port
   ```

### Option 3: AWS ElastiCache (Production-grade)

**Steps:**
1. Create AWS ElastiCache Redis cluster
2. Get the connection endpoint
3. Add to environment:
   ```bash
   heroku config:set REDIS_URL="redis://user:password@endpoint:6379"
   ```

### Option 4: Azure Cache for Redis (Production-grade)

**Steps:**
1. Create Azure Cache for Redis instance
2. Get the primary connection string
3. Add to environment:
   ```bash
   heroku config:set REDIS_URL="redis://user:password@endpoint:6379"
   ```

## Local Development Setup

### With Docker (Recommended)
```bash
# Start Redis in Docker
docker run -d -p 6379:6379 redis:7-alpine

# Server will connect to localhost:6379 automatically
npm run dev
```

### Using a managed Redis from your laptop
- Use the provider's **external** connection string in `.env`
- Do not use internal-only hosts such as `redis://red-...:6379` outside the provider network
- If your provider requires allowlisting, add your current public IP or a CIDR such as `0.0.0.0/0` only for temporary testing

### Without Docker
1. Install Redis: https://redis.io/download
2. Start Redis:
   - **Linux/Mac**: `redis-server`
   - **Windows**: Use Windows Subsystem for Linux (WSL) or Windows installers
3. Run your app: `npm run dev`

## Configuration Priority

The application checks for Redis in this order:

1. **Cloud Environment** (`REDIS_URL` env var) - For Heroku/cloud deployments
2. **Local Redis** (localhost:6379) - For development
3. **No Redis** - App still works but repository processing becomes synchronous (without background jobs)

## What Changes Were Made

### Code updates for resilience:
- `env.ts`: Added optional `REDIS_URL` configuration
- `queue.ts`: 
  - Uses `REDIS_URL` if available (cloud deployments)
  - Falls back to localhost:6379 (local development)
  - Gracefully disables queue if Redis unavailable
- `repo.worker.ts`: 
  - Only initializes if Redis is available
  - Doesn't crash server if Redis is down
- `repo.controller.ts`: 
  - Queues jobs only if Redis is available
  - Can work without queue (returns 202 ACCEPTED)

## Testing the Connection

### Before Deployment
```bash
# Local testing with Redis running
npm run dev

# Should see in logs:
# ✅ Redis queue initialized with local Redis
```

### After Deployment
```bash
# Check Heroku logs
heroku logs --tail

# Should see:
# ✅ Redis queue initialized with REDIS_URL
```

## Error Troubleshooting

### Error: "ECONNREFUSED 127.0.0.1:6379"
- **Meaning**: No Redis running locally
- **Solution**: Run Redis locally OR deploy to cloud with Redis add-on

### App starts but no processing happens
- **Meaning**: Redis not configured or unavailable
- **Solution**: Check logs for Redis connection status, add REDIS_URL

### "Job queue disabled" in logs
- **Meaning**: Working as intended - app will work without Redis but slower
- **Solution**: Add Redis for better performance

## Performance Notes

| Scenario | Processing | Speed | Recommended For |
|----------|-----------|-------|-----------------|
| With Redis | Async (background) | Fast | Production, high volume |
| Without Redis | Synchronous | Slow (blocks request) | Dev only |

## Next Steps

1. Choose your Redis option above
2. Set the `REDIS_URL` environment variable
3. Deploy again
4. Verify "✅ Redis queue initialized" in logs
5. Test repository analysis through the UI

## Support

If you encounter issues:
1. Check the logs: `heroku logs --tail`
2. Verify `REDIS_URL` is set: `heroku config`
3. Test Redis connectivity from a tool like RedisInsight
4. Ensure your Redis service is accessible from your app's network
