-- Add per-agent scratchpad memory.
ALTER TABLE agents
ADD COLUMN working_memory TEXT NOT NULL DEFAULT '';

