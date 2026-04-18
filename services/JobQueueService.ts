import { Redis } from '@upstash/redis';

const getRedis = () => new Redis({
  url: process.env.UPSTASH_REDIS_URL!,
  token: process.env.UPSTASH_REDIS_TOKEN!,
});

export class JobQueueService {
  /**
   * Agents call this to claim a role.
   * Uses SETNX to ensure only ONE agent can have a specific job key.
   */
  async claimJob(jobId: string, agentId: string): Promise<boolean> {
    const lockKey = `job_lock:${jobId}`;
    const redis = getRedis();
    const acquired = await redis.set(lockKey, agentId, { nx: true, ex: 300 }); // 5 min timeout
    if (acquired) {
      console.log(`[JOBS] Agent ${agentId} successfully claimed ${jobId}`);
      return true;
    }
    console.log(`[JOBS] Agent ${agentId} failed to claim ${jobId} — already locked`);
    return false;
  }

  async releaseJob(jobId: string) {
    const redis = getRedis();
    await redis.del(`job_lock:${jobId}`);
    console.log(`[JOBS] Released lock for ${jobId}`);
  }

  /**
   * Check who currently holds a job lock.
   */
  async getJobHolder(jobId: string): Promise<string | null> {
    const redis = getRedis();
    return await redis.get(`job_lock:${jobId}`);
  }
}