// test.ts
import dotenv from 'dotenv';
import 'dotenv/config';
dotenv.config();

import { WorldStateService } from './WorldStateService.js';
import { JobQueueService } from './JobQueueService.js';
import { AgentMemoryService } from './AgentMemoryService.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function testWorldState() {
  console.log('\n=== WorldStateService ===');
  const world = new WorldStateService();

  const obj = await world.createObject(
    'Test Chest',
    'chest',
    { x: 10, y: 64, z: 5 },
    { items: ['pickaxe', 'wood'] },
    'agent-1'
  );
  assert(obj && obj.name === 'Test Chest', 'createObject returns created object');

  const fetched = await world.getObjectsByType('chest');
  assert(Array.isArray(fetched) && fetched.length > 0, 'getObjectsByType returns results');

  const single = await world.getObject(obj.id);
  assert(single.id === obj.id, 'getObject by id matches');

  await world.updateObjectState(obj.id, 'agent-1', { items: ['pickaxe', 'wood', 'diamond'] });
  const updated = await world.getObject(obj.id);
  assert(updated.metadata.items.length === 3, 'updateObjectState persists new metadata');

  await world.deleteObject(obj.id);
  const afterDelete = await world.getObjectsByType('chest');
  const found = afterDelete?.find((o: any) => o.id === obj.id);
  assert(!found, 'deleteObject removes the object');
}

async function testJobQueue() {
  console.log('\n=== JobQueueService (Redis) ===');
  const jobs = new JobQueueService();
  const testJobId = `test-job-${Date.now()}`;

  // Clean slate
  await jobs.releaseJob(testJobId);

  // Claim a job
  const claimed = await jobs.claimJob(testJobId, 'agent-1');
  assert(claimed === true, 'first agent can claim an unclaimed job');

  // Check holder
  const holder = await jobs.getJobHolder(testJobId);
  assert(holder === 'agent-1', 'getJobHolder returns the claiming agent');

  // Second agent tries to claim the same job
  const claimedAgain = await jobs.claimJob(testJobId, 'agent-2');
  assert(claimedAgain === false, 'second agent cannot claim an already-locked job');

  // Holder unchanged after failed claim
  const stillHolder = await jobs.getJobHolder(testJobId);
  assert(stillHolder === 'agent-1', 'holder unchanged after contested claim');

  // Release and re-claim
  await jobs.releaseJob(testJobId);
  const holderAfterRelease = await jobs.getJobHolder(testJobId);
  assert(holderAfterRelease === null, 'getJobHolder returns null after release');

  const reclaimedByTwo = await jobs.claimJob(testJobId, 'agent-2');
  assert(reclaimedByTwo === true, 'another agent can claim after release');

  // Cleanup
  await jobs.releaseJob(testJobId);
}

async function testAgentMemory() {
  console.log('\n=== AgentMemoryService ===');
  const memory = new AgentMemoryService();
  const testAgent = `test-agent-${Date.now()}`;

  // Start clean
  await memory.clearMemories(testAgent);

  // Add memories of different types
  const obs = await memory.addMemory(testAgent, 'observation', {
    text: 'Found iron ore vein',
    location: { x: 50, y: 12, z: 100 },
  });
  assert(obs && obs.memory_type === 'observation', 'addMemory returns observation');

  const plan = await memory.addMemory(testAgent, 'plan', {
    text: 'Mine iron then smelt into ingots',
    steps: ['mine', 'smelt'],
  });
  assert(plan && plan.memory_type === 'plan', 'addMemory returns plan');

  await memory.addMemory(testAgent, 'reflection', {
    text: 'Mining took longer than expected',
  });

  // Get all memories
  const all = await memory.getMemories(testAgent);
  assert(all.length === 3, 'getMemories returns all 3 memories');

  // Filter by type
  const observations = await memory.getMemories(testAgent, 'observation');
  assert(observations.length === 1, 'getMemories filters by type');
  assert(observations[0].content.text === 'Found iron ore vein', 'filtered memory has correct content');

  // Limit
  const limited = await memory.getMemories(testAgent, undefined, 2);
  assert(limited.length === 2, 'getMemories respects limit');

  // Build context string
  const context = await memory.buildContextForAgent(testAgent, 10);
  assert(context.includes('[observation]'), 'context string includes observation tag');
  assert(context.includes('[plan]'), 'context string includes plan tag');
  assert(context.includes('Found iron ore vein'), 'context string includes memory content');

  // Empty context for unknown agent
  const emptyCtx = await memory.buildContextForAgent('nonexistent-agent-xyz');
  assert(emptyCtx === 'No prior memories.', 'buildContext returns fallback for unknown agent');

  // Clear and verify
  await memory.clearMemories(testAgent);
  const afterClear = await memory.getMemories(testAgent);
  assert(afterClear.length === 0, 'clearMemories removes all memories');
}

async function main() {
  console.log('Running integration tests...');

  await testWorldState();
  await testJobQueue();
  await testAgentMemory();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});