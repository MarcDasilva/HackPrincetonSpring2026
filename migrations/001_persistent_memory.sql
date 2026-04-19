-- ============================================================================
-- Persistent Memory System - Supabase Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================================

-- 1. World Events: append-only log of everything that happens in the world
CREATE TABLE IF NOT EXISTS world_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('destroyed', 'created', 'modified', 'discovered', 'depleted')),
  object_type TEXT, -- chest, house, ore_vein, cave, farm, etc.
  object_name TEXT,
  object_id UUID REFERENCES world_objects(id) ON DELETE SET NULL,
  coords JSONB, -- {x, y, z}
  caused_by TEXT, -- 'creeper', 'agent', 'player', 'fire', 'tnt', etc.
  agent_id TEXT, -- which agent recorded this event
  description TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_world_events_type ON world_events(event_type);
CREATE INDEX idx_world_events_object_type ON world_events(object_type);
CREATE INDEX idx_world_events_agent ON world_events(agent_id);
CREATE INDEX idx_world_events_created ON world_events(created_at DESC);

-- 2. Task Runs: history of every task the agents have executed
CREATE TABLE IF NOT EXISTS task_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (task_type IN ('mine', 'build', 'explore', 'gather', 'craft', 'plan', 'fight', 'travel', 'other')),
  command TEXT NOT NULL, -- original user text
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
  outcome TEXT, -- what happened (free text summary)
  locations_discovered JSONB DEFAULT '[]'::jsonb, -- [{name, coords, type}]
  resources_gathered JSONB DEFAULT '{}'::jsonb, -- {item: count}
  route_taken JSONB DEFAULT '[]'::jsonb, -- [{x,y,z}] breadcrumb trail
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_task_runs_type ON task_runs(task_type);
CREATE INDEX idx_task_runs_agent ON task_runs(agent_id);
CREATE INDEX idx_task_runs_status ON task_runs(status);
CREATE INDEX idx_task_runs_started ON task_runs(started_at DESC);

-- Full-text search on commands for task recall
ALTER TABLE task_runs ADD COLUMN command_tsv TSVECTOR
  GENERATED ALWAYS AS (to_tsvector('english', command)) STORED;
CREATE INDEX idx_task_runs_command_fts ON task_runs USING GIN(command_tsv);

-- 3. Known Locations: persistent spatial memory
CREATE TABLE IF NOT EXISTS known_locations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  location_type TEXT NOT NULL CHECK (location_type IN ('cave', 'base', 'village', 'farm', 'ore_deposit', 'structure', 'landmark', 'danger_zone', 'water', 'nether_portal', 'other')),
  coords JSONB NOT NULL, -- {x, y, z}
  discovered_by TEXT, -- agent_id
  discovered_during UUID REFERENCES task_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroyed', 'depleted', 'unknown')),
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_known_locations_type ON known_locations(location_type);
CREATE INDEX idx_known_locations_status ON known_locations(status);
CREATE INDEX idx_known_locations_tags ON known_locations USING GIN(tags);

-- 4. Enhance agent_memory with tags, task linking, location, importance
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES task_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS location JSONB;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS importance INTEGER DEFAULT 5 CHECK (importance BETWEEN 1 AND 10);

CREATE INDEX IF NOT EXISTS idx_agent_memory_tags ON agent_memory USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_agent_memory_task ON agent_memory(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_importance ON agent_memory(importance DESC);

-- 5. Enable realtime on new tables
ALTER PUBLICATION supabase_realtime ADD TABLE world_events;
ALTER PUBLICATION supabase_realtime ADD TABLE known_locations;

-- 6. Helper: function to find nearby locations (within a radius)
CREATE OR REPLACE FUNCTION find_nearby_locations(
  target_x DOUBLE PRECISION,
  target_y DOUBLE PRECISION,
  target_z DOUBLE PRECISION,
  radius DOUBLE PRECISION DEFAULT 100
)
RETURNS SETOF known_locations AS $$
  SELECT *
  FROM known_locations
  WHERE status = 'active'
    AND sqrt(
      power((coords->>'x')::float - target_x, 2) +
      power((coords->>'y')::float - target_y, 2) +
      power((coords->>'z')::float - target_z, 2)
    ) <= radius
  ORDER BY sqrt(
    power((coords->>'x')::float - target_x, 2) +
    power((coords->>'y')::float - target_y, 2) +
    power((coords->>'z')::float - target_z, 2)
  );
$$ LANGUAGE sql STABLE;
