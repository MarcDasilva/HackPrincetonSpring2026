import 'dotenv/config';

import { Redis } from '@upstash/redis';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type AgentRole = 'miner' | 'crafter' | 'scout';
type AgentState = 'idle' | 'busy' | 'offline';
type MessageType = 'user' | 'agent' | 'system';

interface Coords {
  x: number;
  y: number;
  z: number;
}

interface CliOptions {
  command: string;
  keepData: boolean;
  loadDocs: boolean;
}

interface AgentSpec {
  agentId: string;
  displayName: string;
  role: AgentRole;
  claimDelayMs: number;
}

interface TestContext {
  runId: string;
  command: string;
  jobId: string;
  seededWorldObjectIds: string[];
  seededAgentIds: string[];
}

interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

interface WorldObjectRow {
  id: string;
  name: string;
  object_type: string;
  coords: Coords;
  metadata: Record<string, unknown> | null;
}

interface AgentMemoryRow {
  id: string;
  agent_id: string;
  memory_type: string;
  content: Record<string, unknown>;
}

interface JobRow {
  id: string;
  job_id: string;
  assigned_agent: string | null;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

const DEFAULT_COMMAND = 'mine iron ore and store it in the nearest chest';
const AGENTS_MD_PATH = resolve(process.cwd(), 'docs/agents.md');

function printUsage() {
  console.log(`
Mock end-to-end test for the 6-table multi-agent coordination flow.

Usage:
  npm run test:agent-flow
  npm run test:agent-flow -- --load-docs
  npm run test:agent-flow -- --command "mine iron ore near spawn" --keep-data

Flags:
  --command <text>  User command to simulate
  --load-docs       Re-embed and upsert docs/agents.md before the test
  --keep-data       Keep seeded rows in Supabase for inspection
  --help, -h        Show this message
`.trim());
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: DEFAULT_COMMAND,
    keepData: false,
    loadDocs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--command') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('Missing value for --command');
      }
      options.command = value;
      index += 1;
      continue;
    }

    if (arg === '--keep-data') {
      options.keepData = true;
      continue;
    }

    if (arg === '--load-docs') {
      options.loadDocs = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function makeRunId() {
  return `agent-flow-${timestampId()}`;
}

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function getSupabase() {
  return createClient(getRequiredEnv('SUPABASE_URL'), getRequiredEnv('SUPABASE_KEY'));
}

function getRedis() {
  return new Redis({
    url: getRequiredEnv('UPSTASH_REDIS_URL'),
    token: getRequiredEnv('UPSTASH_REDIS_TOKEN'),
  });
}

async function embedTextWithOpenAI(text: string): Promise<number[]> {
  const apiKey = getRequiredEnv('OPENAI_API_KEY');

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to embed text with OpenAI: ${response.status} ${errorBody}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding: number[] }>;
  };

  const embedding = data.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error('OpenAI embeddings response did not include an embedding');
  }

  return embedding;
}

async function ensureAgentsDocumentLoaded(loadDocs: boolean) {
  const supabase = getSupabase();

  if (loadDocs) {
    const content = await readFile(AGENTS_MD_PATH, 'utf8');
    const embedding = await embedTextWithOpenAI(content);
    const { data: existingRows, error: existingError } = await supabase
      .from('md_documents')
      .select('id')
      .eq('filename', 'agents.md')
      .eq('doc_type', 'agents')
      .limit(1);

    if (existingError) {
      throw new Error(`Failed to check md_documents: ${existingError.message}`);
    }

    const payload = {
      filename: 'agents.md',
      doc_type: 'agents',
      content,
      embedding,
      updated_at: new Date().toISOString(),
    };

    let error;
    if (existingRows && existingRows.length > 0) {
      ({ error } = await supabase
        .from('md_documents')
        .update(payload)
        .eq('id', existingRows[0].id));
    } else {
      ({ error } = await supabase
        .from('md_documents')
        .insert(payload));
    }

    if (error) {
      throw new Error(`Failed to load docs/agents.md: ${error.message}`);
    }

    console.log('Loaded docs/agents.md into md_documents');
    return;
  }

  const { data, error } = await supabase
    .from('md_documents')
    .select('id')
    .eq('doc_type', 'agents')
    .eq('filename', 'agents.md')
    .limit(1);

  if (error) {
    throw new Error(`Failed to check md_documents: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error('agents.md is not loaded in md_documents. Run `npm run load:md-docs` or rerun with `--load-docs`.');
  }
}

async function queryAgentDirectives(query: string) {
  const supabase = getSupabase();
  const queryEmbedding = await embedTextWithOpenAI(query);

  const { data, error } = await supabase.rpc('match_md_documents', {
    query_embedding: queryEmbedding,
    doc_type: 'agents',
    match_count: 3,
  }) as QueryResult<Array<{ filename: string; content: string; similarity: number }>>;

  if (error) {
    throw new Error(`Failed to query md_documents: ${error.message}`);
  }

  return data ?? [];
}

async function seedWorld(context: TestContext) {
  const supabase = getSupabase();
  const rows = [
    {
      name: `[${context.runId}] Home Base`,
      object_type: 'base',
      coords: { x: 0, y: 64, z: 0 },
      metadata: { test_run_id: context.runId, purpose: 'seed-base' },
      last_updated_by: 'test-harness',
    },
    {
      name: `[${context.runId}] Tools Chest`,
      object_type: 'chest',
      coords: { x: 4, y: 64, z: 2 },
      metadata: { test_run_id: context.runId, chest_type: 'tools', items: ['pickaxe', 'coal'] },
      last_updated_by: 'test-harness',
    },
    {
      name: `[${context.runId}] Iron Vein`,
      object_type: 'ore_vein',
      coords: { x: 18, y: 32, z: -6 },
      metadata: { test_run_id: context.runId, resource: 'iron', estimated_blocks: 24 },
      last_updated_by: 'test-harness',
    },
  ];

  const { data, error } = await supabase
    .from('world_objects')
    .insert(rows)
    .select('id');

  if (error) {
    throw new Error(`Failed to seed world_objects: ${error.message}`);
  }

  context.seededWorldObjectIds = (data ?? []).map((row) => row.id);
  console.log(`Seeded ${context.seededWorldObjectIds.length} world_objects rows`);
}

async function registerAgents(context: TestContext, agents: AgentSpec[]) {
  const supabase = getSupabase();
  const rows = agents.map((agent) => ({
    agent_id: agent.agentId,
    display_name: agent.displayName,
    status: 'idle' satisfies AgentState,
    current_task: null,
    last_heartbeat: new Date().toISOString(),
    metadata: { test_run_id: context.runId, role: agent.role },
  }));

  const { error } = await supabase
    .from('agent_status')
    .upsert(rows);

  if (error) {
    throw new Error(`Failed to register test agents: ${error.message}`);
  }

  context.seededAgentIds = agents.map((agent) => agent.agentId);
  console.log(`Registered ${agents.length} agents in agent_status`);
}

async function createUserMessage(context: TestContext) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('chat_messages')
    .insert({
      sender: 'test-user',
      message_type: 'user' satisfies MessageType,
      content: context.command,
      metadata: { test_run_id: context.runId, source: 'test-agent-flow' },
    });

  if (error) {
    throw new Error(`Failed to insert user chat message: ${error.message}`);
  }
}

async function createPendingJob(context: TestContext) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('jobs_history')
    .insert({
      job_id: context.jobId,
      status: 'pending',
      payload: {
        test_run_id: context.runId,
        command: context.command,
        task_type: 'mine',
        requested_by: 'test-user',
      },
      result: null,
    });

  if (error) {
    throw new Error(`Failed to create job: ${error.message}`);
  }
}

async function addAgentMemory(agentId: string, runId: string, memoryType: string, content: Record<string, unknown>) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('agent_memory')
    .insert({
      agent_id: agentId,
      memory_type: memoryType,
      content,
      tags: ['test-agent-flow', runId],
      importance: 6,
    });

  if (error) {
    throw new Error(`Failed to add agent memory: ${error.message}`);
  }
}

function distance(a: Coords, b: Coords) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

async function getNearestWorldObject(type: string, origin: Coords) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('world_objects')
    .select('id, name, object_type, coords, metadata')
    .eq('object_type', type);

  if (error) {
    throw new Error(`Failed to query world_objects (${type}): ${error.message}`);
  }

  const rows = (data ?? []) as WorldObjectRow[];
  assert(rows.length > 0, `expected at least one ${type} row`);

  return rows.reduce((closest, current) => {
    if (!closest) {
      return current;
    }
    return distance(current.coords, origin) < distance(closest.coords, origin) ? current : closest;
  }, rows[0] ?? null as WorldObjectRow | null);
}

async function updateAgentStatus(agentId: string, status: AgentState, currentTask: string | null) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('agent_status')
    .update({
      status,
      current_task: currentTask,
      last_heartbeat: new Date().toISOString(),
    })
    .eq('agent_id', agentId);

  if (error) {
    throw new Error(`Failed to update agent_status for ${agentId}: ${error.message}`);
  }
}

async function assignJob(jobId: string, agentId: string) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('jobs_history')
    .update({
      assigned_agent: agentId,
      status: 'active',
      started_at: new Date().toISOString(),
    })
    .eq('job_id', jobId);

  if (error) {
    throw new Error(`Failed to assign job ${jobId}: ${error.message}`);
  }
}

async function completeJob(jobId: string, result: Record<string, unknown>) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('jobs_history')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
    })
    .eq('job_id', jobId);

  if (error) {
    throw new Error(`Failed to complete job ${jobId}: ${error.message}`);
  }
}

async function sendChatMessage(sender: string, content: string, metadata: Record<string, unknown>) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('chat_messages')
    .insert({
      sender,
      message_type: 'agent' satisfies MessageType,
      content,
      metadata,
    });

  if (error) {
    throw new Error(`Failed to insert agent chat message: ${error.message}`);
  }
}

async function updateWorldAfterMining(runId: string, ore: WorldObjectRow, chest: WorldObjectRow, agentId: string) {
  const supabase = getSupabase();

  const oreMetadata = {
    ...(ore.metadata ?? {}),
    test_run_id: runId,
    estimated_blocks: 0,
    depleted_by: agentId,
    depleted_at: new Date().toISOString(),
  };

  const chestMetadata = {
    ...(chest.metadata ?? {}),
    test_run_id: runId,
    last_deposit_by: agentId,
    last_deposit: {
      resource: 'iron_ore',
      amount: 16,
      at: new Date().toISOString(),
    },
  };

  const oreUpdate = await supabase
    .from('world_objects')
    .update({
      metadata: oreMetadata,
      last_updated_by: agentId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ore.id);

  if (oreUpdate.error) {
    throw new Error(`Failed to update ore metadata: ${oreUpdate.error.message}`);
  }

  const chestUpdate = await supabase
    .from('world_objects')
    .update({
      metadata: chestMetadata,
      last_updated_by: agentId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', chest.id);

  if (chestUpdate.error) {
    throw new Error(`Failed to update chest metadata: ${chestUpdate.error.message}`);
  }
}

async function getRecentAgentMemories(agentId: string, runId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('agent_memory')
    .select('id, agent_id, memory_type, content')
    .eq('agent_id', agentId)
    .contains('tags', [runId]);

  if (error) {
    throw new Error(`Failed to read agent_memory: ${error.message}`);
  }

  return (data ?? []) as AgentMemoryRow[];
}

async function readJob(jobId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('jobs_history')
    .select('id, job_id, assigned_agent, status, payload, result')
    .eq('job_id', jobId)
    .single();

  if (error) {
    throw new Error(`Failed to read jobs_history row: ${error.message}`);
  }

  return data as JobRow;
}

async function readAgentStatuses(agentIds: string[]) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('agent_status')
    .select('*')
    .in('agent_id', agentIds);

  if (error) {
    throw new Error(`Failed to read agent_status rows: ${error.message}`);
  }

  return data ?? [];
}

async function readRunChatMessages(runId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .contains('metadata', { test_run_id: runId })
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to read chat_messages: ${error.message}`);
  }

  return data ?? [];
}

async function cleanupRun(context: TestContext) {
  const supabase = getSupabase();
  const redis = getRedis();

  await redis.del(`job_lock:${context.jobId}`);

  if (context.seededAgentIds.length > 0) {
    await supabase.from('agent_status').delete().in('agent_id', context.seededAgentIds);
    await supabase.from('agent_memory').delete().in('agent_id', context.seededAgentIds);
  }

  if (context.seededWorldObjectIds.length > 0) {
    await supabase.from('world_objects').delete().in('id', context.seededWorldObjectIds);
  }

  await supabase.from('chat_messages').delete().contains('metadata', { test_run_id: context.runId });
  await supabase.from('jobs_history').delete().contains('payload', { test_run_id: context.runId });
}

async function simulateAgent(agent: AgentSpec, context: TestContext) {
  const redis = getRedis();

  await sleep(agent.claimDelayMs);

  const claimed = await redis.set(`job_lock:${context.jobId}`, agent.agentId, { nx: true, ex: 300 });
  if (!claimed) {
    return {
      agentId: agent.agentId,
      role: agent.role,
      claimed: false,
      reason: 'lock-already-held',
    };
  }

  await assignJob(context.jobId, agent.agentId);
  await updateAgentStatus(agent.agentId, 'busy', context.command);
  await addAgentMemory(agent.agentId, context.runId, 'plan', {
    test_run_id: context.runId,
    message: `Claimed job ${context.jobId}`,
    command: context.command,
  });

  const directives = await queryAgentDirectives(`What should the ${agent.role} agent do for: ${context.command}?`);
  assert(directives.length > 0, 'expected RAG results from md_documents');

  const ore = await getNearestWorldObject('ore_vein', { x: 0, y: 64, z: 0 });
  const chest = await getNearestWorldObject('chest', ore.coords);

  await addAgentMemory(agent.agentId, context.runId, 'observation', {
    test_run_id: context.runId,
    ore: { id: ore.id, name: ore.name, coords: ore.coords },
    chest: { id: chest.id, name: chest.name, coords: chest.coords },
    rag_hits: directives.map((directive) => ({
      filename: directive.filename,
      similarity: directive.similarity,
    })),
  });

  await updateWorldAfterMining(context.runId, ore, chest, agent.agentId);

  const result = {
    test_run_id: context.runId,
    simulated_by: agent.agentId,
    role: agent.role,
    command: context.command,
    ore_target: { id: ore.id, name: ore.name, coords: ore.coords },
    storage_target: { id: chest.id, name: chest.name, coords: chest.coords },
    actions: [
      'queried md_documents for directives',
      'queried world_objects for ore and nearest chest',
      'simulated Voyager mining run',
      'updated world_objects to reflect deposit and depletion',
    ],
  };

  await completeJob(context.jobId, result);
  await sendChatMessage(
    agent.agentId,
    `[${agent.displayName}] Completed test job: mined iron from ${ore.name} and stored it in ${chest.name}.`,
    { test_run_id: context.runId, job_id: context.jobId, role: agent.role }
  );
  await addAgentMemory(agent.agentId, context.runId, 'reflection', {
    test_run_id: context.runId,
    message: 'Completed mock Voyager execution successfully',
  });
  await updateAgentStatus(agent.agentId, 'idle', null);

  return {
    agentId: agent.agentId,
    role: agent.role,
    claimed: true,
  };
}

async function runAssertions(context: TestContext, agents: AgentSpec[]) {
  const redis = getRedis();
  const job = await readJob(context.jobId);
  const lockHolder = await redis.get(`job_lock:${context.jobId}`);
  const statuses = await readAgentStatuses(agents.map((agent) => agent.agentId));
  const chatMessages = await readRunChatMessages(context.runId);
  const winnerMemories = job.assigned_agent
    ? await getRecentAgentMemories(job.assigned_agent, context.runId)
    : [];

  assert(job.status === 'completed', 'job should be completed');
  assert(job.assigned_agent === agents[0]?.agentId, 'miner should win the deterministic claim race');
  assert(lockHolder === job.assigned_agent, 'Redis lock holder should match assigned_agent');
  assert(chatMessages.length >= 2, 'run should include user + agent chat messages');
  assert(winnerMemories.length >= 3, 'winning agent should write plan, observation, and reflection memories');

  const idleStatuses = statuses.filter((row) => row.status === 'idle');
  assert(idleStatuses.length === agents.length, 'all agents should end idle');

  const winningMessage = chatMessages.find((row) => row.sender === job.assigned_agent);
  assert(Boolean(winningMessage), 'winner should report back into chat_messages');

  const resultActions = Array.isArray(job.result?.actions) ? job.result.actions : [];
  assert(resultActions.includes('queried md_documents for directives'), 'job result should show RAG lookup');
  assert(resultActions.includes('queried world_objects for ore and nearest chest'), 'job result should show direct world query');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const context: TestContext = {
    runId: makeRunId(),
    command: options.command,
    jobId: `job-${makeRunId()}`,
    seededWorldObjectIds: [],
    seededAgentIds: [],
  };

  const agents: AgentSpec[] = [
    {
      agentId: `test-agent-1-${context.runId}`,
      displayName: 'Agent 1 Miner',
      role: 'miner',
      claimDelayMs: 0,
    },
    {
      agentId: `test-agent-2-${context.runId}`,
      displayName: 'Agent 2 Crafter',
      role: 'crafter',
      claimDelayMs: 25,
    },
    {
      agentId: `test-agent-3-${context.runId}`,
      displayName: 'Agent 3 Scout',
      role: 'scout',
      claimDelayMs: 50,
    },
  ];

  console.log(`Run ID: ${context.runId}`);
  console.log(`Command: ${context.command}`);

  try {
    await ensureAgentsDocumentLoaded(options.loadDocs);
    await seedWorld(context);
    await registerAgents(context, agents);
    await createUserMessage(context);
    await createPendingJob(context);

    console.log('Starting mock agent race...');
    const results = await Promise.all(agents.map((agent) => simulateAgent(agent, context)));
    const winners = results.filter((result) => result.claimed);

    assert(winners.length === 1, 'exactly one agent should claim the job');

    console.log('Agent outcomes:');
    for (const result of results) {
      console.log(`  ${result.agentId} (${result.role}) -> ${result.claimed ? 'claimed' : 'skipped'}`);
    }

    await runAssertions(context, agents);

    console.log('\nAll assertions passed.');
    console.log(`Job ID: ${context.jobId}`);
    console.log(`Winning agent: ${winners[0]?.agentId}`);

    if (options.keepData) {
      console.log('Keeping seeded rows for inspection because --keep-data was set.');
      return;
    }
  } finally {
    if (!options.keepData) {
      await cleanupRun(context).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Cleanup failed: ${message}`);
      });
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
